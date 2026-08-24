import type { JsonWebKey } from "node:crypto";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  type DecodedOffer,
  decodeSignedOffers,
  extractJWSHeader,
  extractOffersFromPaymentRequired,
  findAcceptsObjectFromSignedOffer,
  isJWSSignedOffer,
  isJWSSignedReceipt,
  type ReceiptPayload,
  type SignedReceipt,
  verifyOfferSignatureJWS,
  verifyReceiptMatchesOffer,
  verifyReceiptSignatureJWS,
} from "@x402/extensions/offer-receipt";
import { VrsaiTrustError } from "./errors.js";
import { assertHttpsUrl, boundedFetch } from "./net.js";

const DID_MAX_BYTES = 64 * 1024;
const DID_TIMEOUT_MS = 10_000;
/** Default cache lifetime for a resolved `did:web` document. Bounded so a
 * key rotation/revocation on the publisher side is picked up promptly,
 * while avoiding a network round trip on every single payment. */
const DEFAULT_DID_CACHE_TTL_MS = 5 * 60 * 1000;

export interface DidWebDocument {
  readonly id?: string;
  readonly assertionMethod?: readonly unknown[];
  readonly verificationMethod?: readonly {
    readonly id?: string;
    readonly publicKeyJwk?: unknown;
  }[];
}

/**
 * Resolves `did:web:<domain>[:<path>...]` to its document URL per the
 * `did:web` method spec (path segments joined with `/`, `.well-known/did.json`
 * when there are none). Only `https:` URLs are ever produced.
 */
export function didWebDocumentUrl(did: string): URL {
  if (!/^did:web:[a-z0-9.%-]+(:[A-Za-z0-9._%-]+)*$/i.test(did)) {
    throw new VrsaiTrustError(`"${did}" is not a supported did:web identifier.`);
  }
  const components = did.slice("did:web:".length).split(":").map(decodeURIComponent);
  const host = components.shift();
  if (!host) throw new VrsaiTrustError("did:web identity has no host component.");
  const path =
    components.length === 0 ? "/.well-known/did.json" : `/${components.join("/")}/did.json`;
  return assertHttpsUrl(`https://${host}${path}`, "did:web document URL");
}

export interface OfferTrustResolver {
  resolveDidDocument(did: string): Promise<DidWebDocument>;
}

/**
 * Default resolver: fetches the `did:web` document over `https` with a
 * bounded timeout and response size, and hardens the fetch itself:
 *
 * - Redirects are never followed (`redirect: "manual"`) — a `did:web`
 *   document lives at a fixed, spec-defined path; a redirect is either a
 *   misconfiguration or an attempt to steer resolution to a different
 *   origin, and is always rejected.
 * - The response `Content-Type` must declare JSON; anything else is
 *   rejected before the body is even parsed.
 * - Successful resolutions are cached (bounded TTL) to avoid a network
 *   round trip on every payment, but a resolution *failure* never falls
 *   back to a stale cache entry — trust state is always either fresh or
 *   explicitly re-fetched, never silently reused past its lifetime.
 */
export function createHttpOfferTrustResolver(
  fetchImplementation: typeof fetch = fetch,
  options: { readonly cacheTtlMs?: number } = {},
): OfferTrustResolver {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_DID_CACHE_TTL_MS;
  const bounded = boundedFetch(fetchImplementation, {
    maxBytes: DID_MAX_BYTES,
    timeoutMs: DID_TIMEOUT_MS,
  });
  const cache = new Map<
    string,
    { readonly document: DidWebDocument; readonly expiresAt: number }
  >();

  return {
    async resolveDidDocument(did) {
      const cached = cache.get(did);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.document;
      }
      const url = didWebDocumentUrl(did);
      const response = await bounded(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        throw new VrsaiTrustError(
          "did:web document fetch was redirected; redirects are never followed.",
        );
      }
      if (!response.ok) {
        throw new VrsaiTrustError(`did:web document fetch failed with HTTP ${response.status}.`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        throw new VrsaiTrustError(
          `did:web document response has an unexpected content-type "${contentType}".`,
        );
      }
      const body = (await response.json()) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new VrsaiTrustError("did:web document is not a JSON object.");
      }
      const document = body as DidWebDocument;
      cache.set(did, { document, expiresAt: Date.now() + cacheTtlMs });
      return document;
    },
  };
}

function isPublicP256Jwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const jwk = value as JsonWebKey;
  if (jwk.d !== undefined) return false; // never accept private key material
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string"
  );
}

/**
 * Resolves and authorizes the ES256 `did:web` public key behind a JWS
 * `kid`, requiring it to belong to `expectedPublisherDid` and be an
 * authorized `assertionMethod` in that DID's document. Shared by both
 * offer and receipt verification — the trust boundary is identical: only a
 * key the publisher's own `did:web` document vouches for is ever accepted,
 * regardless of what DID a `kid` merely claims.
 */
async function resolveAuthorizedSignerKey(
  kid: string | undefined,
  alg: string,
  expectedPublisherDid: string,
  resolver: OfferTrustResolver,
): Promise<JsonWebKey> {
  if (alg !== "ES256" || typeof kid !== "string") {
    throw new VrsaiTrustError("Signed evidence is not ES256 did:web evidence.");
  }
  if (!kid.startsWith(`${expectedPublisherDid}#`)) {
    throw new VrsaiTrustError("Signed evidence key does not belong to the expected publisher DID.");
  }
  const document = await resolver.resolveDidDocument(expectedPublisherDid);
  if (document.id !== expectedPublisherDid) {
    throw new VrsaiTrustError("Resolved DID document does not identify the expected publisher.");
  }
  if (!document.assertionMethod?.includes(kid)) {
    throw new VrsaiTrustError(
      "Signed evidence key is not an authorized assertion method for the publisher DID.",
    );
  }
  const method = document.verificationMethod?.find((entry) => entry.id === kid);
  if (!method || !isPublicP256Jwk(method.publicKeyJwk)) {
    throw new VrsaiTrustError("Publisher DID document has no usable ES256 verification method.");
  }
  return method.publicKeyJwk;
}

/**
 * Verifies that `paymentRequired` carries at least one signed offer from
 * `expectedPublisherDid` that exactly binds one of its `accepts[]` entries
 * and has not expired, and returns that binding. Every candidate offer is
 * independently signature-verified and expiry-checked — never selected by
 * a naive `accepts[offer.acceptIndex]` index lookup, which would let an
 * attacker-controlled or corrupted (but otherwise structurally valid)
 * `acceptIndex` silently point at a *different*, unverified requirement
 * than the one the signature actually covers.
 *
 * Throws {@link VrsaiTrustError} on any mismatch, missing offer, or invalid
 * signature across every candidate — always fail closed, never
 * best-effort. Returns the verified requirement and decoded offer so
 * callers do not re-derive them independently of the trust check, and so
 * the same offer can later be matched against a settlement receipt (see
 * {@link verifySignedReceipt}).
 */
export async function verifySignedOffer(input: {
  readonly paymentRequired: PaymentRequired;
  readonly expectedPublisherDid: string;
  readonly resolver: OfferTrustResolver;
  readonly nowEpochSeconds?: number;
}): Promise<{ readonly requirement: PaymentRequirements; readonly decodedOffer: DecodedOffer }> {
  if (!/^did:web:[a-z0-9.-]+$/i.test(input.expectedPublisherDid)) {
    throw new VrsaiTrustError("expectedPublisherDid must be a bare did:web:<domain> identifier.");
  }
  const signedOffers = extractOffersFromPaymentRequired(input.paymentRequired);
  if (signedOffers.length === 0) {
    throw new VrsaiTrustError("PaymentRequired has no signed offer to verify.");
  }
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const failures: string[] = [];

  for (const decodedOffer of decodeSignedOffers(signedOffers)) {
    try {
      if (!isJWSSignedOffer(decodedOffer.signedOffer)) {
        failures.push("offer is not JWS-signed");
        continue;
      }
      const header = extractJWSHeader(decodedOffer.signedOffer.signature);
      const publicJwk = await resolveAuthorizedSignerKey(
        header.kid,
        header.alg,
        input.expectedPublisherDid,
        input.resolver,
      );
      // Cryptographically verify the signature — decodeSignedOffers()
      // above only base64-decodes the JWS payload and never checks it.
      await verifyOfferSignatureJWS(decodedOffer.signedOffer, publicJwk as never);
      if (decodedOffer.resourceUrl !== input.paymentRequired.resource.url) {
        failures.push("offer resourceUrl does not match the PaymentRequired resource");
        continue;
      }
      if (decodedOffer.validUntil <= now) {
        failures.push("offer has expired");
        continue;
      }
      const requirement = findAcceptsObjectFromSignedOffer(decodedOffer, [
        ...input.paymentRequired.accepts,
      ]);
      if (!requirement) {
        failures.push("offer does not exactly bind any accepts[] entry");
        continue;
      }
      return { requirement, decodedOffer };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new VrsaiTrustError(
    `No signed offer verified against the expected publisher and a payment requirement: ${failures.join("; ")}`,
  );
}

/**
 * Verifies a settlement receipt (extracted from a delivered result's
 * `_meta["x402/payment-response"]` settlement extension) against the exact
 * offer that was accepted for this payment, cryptographically and against
 * payer/recency. Called only after a paid retry is otherwise classified as
 * delivered — see `client.ts` and `result-parsing.ts`. Fails closed: any
 * mismatch, missing signature, or unauthorized key throws rather than
 * silently accepting an unverified receipt as proof of delivery.
 */
export async function verifySignedReceipt(input: {
  readonly receipt: SignedReceipt;
  readonly decodedOffer: DecodedOffer;
  readonly expectedPublisherDid: string;
  readonly payerAddresses: readonly string[];
  readonly resolver: OfferTrustResolver;
  readonly maxAgeSeconds?: number;
}): Promise<ReceiptPayload> {
  if (!isJWSSignedReceipt(input.receipt)) {
    throw new VrsaiTrustError("Only JWS-signed receipts are supported by this trust verifier.");
  }
  const header = extractJWSHeader(input.receipt.signature);
  const publicJwk = await resolveAuthorizedSignerKey(
    header.kid,
    header.alg,
    input.expectedPublisherDid,
    input.resolver,
  );
  let payload: ReceiptPayload;
  try {
    payload = await verifyReceiptSignatureJWS(input.receipt, publicJwk as never);
  } catch (error) {
    throw new VrsaiTrustError(
      `Signed receipt failed cryptographic verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const matches = verifyReceiptMatchesOffer(
    input.receipt,
    input.decodedOffer,
    [...input.payerAddresses],
    input.maxAgeSeconds,
  );
  if (!matches) {
    throw new VrsaiTrustError(
      "Signed receipt does not match the accepted offer, payer, or recency window.",
    );
  }
  return payload;
}
