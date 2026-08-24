import type { JsonWebKey } from "node:crypto";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createOfferJWS, createReceiptJWS, type SignedOffer } from "@x402/extensions/offer-receipt";
import { describe, expect, it } from "vitest";
import { VrsaiTrustError } from "./errors.js";
import {
  didWebDocumentUrl,
  type OfferTrustResolver,
  verifySignedOffer,
  verifySignedReceipt,
} from "./offer-trust.js";

const PUBLISHER_DID = "did:web:vrsai.tech";
const KEY_ID = `${PUBLISHER_DID}#key-1`;
const RESOURCE_URL = "https://api.vrsai.tech/mcp";
const PAYER_ADDRESS = "0xdddddddddddddddddddddddddddddddddddddddd";

async function generateSigner(): Promise<{
  sign: (payload: Uint8Array) => Promise<string>;
  publicJwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  return {
    publicJwk,
    async sign(payload: Uint8Array) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        payload,
      );
      return Buffer.from(signature).toString("base64url");
    },
  };
}

function buildRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "500000",
    payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

function resolverFor(publicJwk: JsonWebKey): OfferTrustResolver {
  return {
    async resolveDidDocument() {
      return {
        id: PUBLISHER_DID,
        assertionMethod: [KEY_ID],
        verificationMethod: [{ id: KEY_ID, publicKeyJwk: publicJwk }],
      };
    },
  };
}

async function buildOffer(
  signer: {
    sign: (payload: Uint8Array) => Promise<string>;
    algorithm: string;
    kid: string;
    format: "jws";
  },
  requirement: PaymentRequirements,
  offerOverrides: { validUntil?: number; resourceUrl?: string; acceptIndex?: number } = {},
): Promise<SignedOffer> {
  return createOfferJWS(
    offerOverrides.resourceUrl ?? RESOURCE_URL,
    {
      acceptIndex: offerOverrides.acceptIndex ?? 0,
      scheme: requirement.scheme,
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      amount: requirement.amount,
      offerValiditySeconds:
        offerOverrides.validUntil !== undefined
          ? offerOverrides.validUntil - Math.floor(Date.now() / 1000)
          : 300,
    },
    signer,
  );
}

async function buildPaymentRequired(
  signer: {
    sign: (payload: Uint8Array) => Promise<string>;
    algorithm: string;
    kid: string;
    format: "jws";
  },
  requirement: PaymentRequirements,
  offerOverrides: { validUntil?: number; resourceUrl?: string } = {},
): Promise<PaymentRequired> {
  const offer = await buildOffer(signer, requirement, offerOverrides);
  return {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [requirement],
    extensions: { "offer-receipt": { info: { offers: [offer] } } },
  };
}

describe("didWebDocumentUrl", () => {
  it("resolves a bare did:web to its well-known document", () => {
    expect(didWebDocumentUrl("did:web:api.vrsai.tech").toString()).toBe(
      "https://api.vrsai.tech/.well-known/did.json",
    );
  });

  it("resolves a did:web with path segments to a nested document", () => {
    expect(didWebDocumentUrl("did:web:api.vrsai.tech:agents:vrsai").toString()).toBe(
      "https://api.vrsai.tech/agents/vrsai/did.json",
    );
  });

  it("rejects a non-did:web identifier", () => {
    expect(() => didWebDocumentUrl("did:key:abc")).toThrow(VrsaiTrustError);
  });
});

describe("verifySignedOffer", () => {
  it("verifies a correctly signed offer that exactly binds the requirement", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
    );
    const result = await verifySignedOffer({
      paymentRequired,
      expectedPublisherDid: PUBLISHER_DID,
      resolver: resolverFor(publicJwk),
    });
    expect(result.requirement).toEqual(requirement);
    expect(result.decodedOffer.resourceUrl).toBe(RESOURCE_URL);
  });

  it("rejects a payment requirement with no signed offer", async () => {
    const requirement = buildRequirement();
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [requirement],
    };
    await expect(
      verifySignedOffer({
        paymentRequired,
        expectedPublisherDid: PUBLISHER_DID,
        resolver: resolverFor({ kty: "EC", crv: "P-256", x: "a", y: "b" }),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });

  it("rejects when the offer's key does not belong to the expected publisher DID", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: `did:web:someone-else.example#key-1`, format: "jws" },
      requirement,
    );
    await expect(
      verifySignedOffer({
        paymentRequired,
        expectedPublisherDid: PUBLISHER_DID,
        resolver: resolverFor(publicJwk),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });

  it("rejects an offer signed with a key not authorized in the DID document", async () => {
    const { sign } = await generateSigner();
    const { publicJwk: wrongJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
    );
    await expect(
      verifySignedOffer({
        paymentRequired,
        expectedPublisherDid: PUBLISHER_DID,
        resolver: resolverFor(wrongJwk),
      }),
    ).rejects.toThrow();
  });

  it("rejects an offer whose signed payload no longer matches the requirement", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
    );
    // Tamper with the requirement after the offer was signed for the original amount.
    const tampered: PaymentRequired = {
      ...paymentRequired,
      accepts: [buildRequirement({ amount: "999999999" })],
    };
    await expect(
      verifySignedOffer({
        paymentRequired: tampered,
        expectedPublisherDid: PUBLISHER_DID,
        resolver: resolverFor(publicJwk),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });

  it("rejects an expired offer", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
      { validUntil: Math.floor(Date.now() / 1000) - 3600 },
    );
    await expect(
      verifySignedOffer({
        paymentRequired,
        expectedPublisherDid: PUBLISHER_DID,
        resolver: resolverFor(publicJwk),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });

  it("rejects an offer bound to a different resource URL", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
      { resourceUrl: "https://api.vrsai.tech/other-mcp" },
    );
    await expect(
      verifySignedOffer({
        paymentRequired,
        expectedPublisherDid: PUBLISHER_DID,
        resolver: resolverFor(publicJwk),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });

  it("verifies against the second offer when multiple offers are present and the first is stale/expired", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirementA = buildRequirement({ amount: "100" });
    const requirementB = buildRequirement({ amount: "500000" });
    const expiredOffer = await buildOffer(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirementA,
      { validUntil: Math.floor(Date.now() / 1000) - 3600, acceptIndex: 0 },
    );
    const freshOffer = await buildOffer(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirementB,
      { acceptIndex: 1 },
    );
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [requirementA, requirementB],
      extensions: { "offer-receipt": { info: { offers: [expiredOffer, freshOffer] } } },
    };
    const result = await verifySignedOffer({
      paymentRequired,
      expectedPublisherDid: PUBLISHER_DID,
      resolver: resolverFor(publicJwk),
    });
    expect(result.requirement).toEqual(requirementB);
  });
});

describe("verifySignedReceipt", () => {
  it("verifies a receipt that matches the accepted offer and payer", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
    );
    const { decodedOffer } = await verifySignedOffer({
      paymentRequired,
      expectedPublisherDid: PUBLISHER_DID,
      resolver: resolverFor(publicJwk),
    });
    const receipt = await createReceiptJWS(
      {
        resourceUrl: RESOURCE_URL,
        payer: PAYER_ADDRESS,
        network: requirement.network,
        transaction: "0xdeadbeef",
      },
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
    );
    const payload = await verifySignedReceipt({
      receipt,
      decodedOffer,
      expectedPublisherDid: PUBLISHER_DID,
      payerAddresses: [PAYER_ADDRESS],
      resolver: resolverFor(publicJwk),
    });
    expect(payload.payer).toBe(PAYER_ADDRESS);
  });

  it("rejects a receipt signed by an unauthorized key", async () => {
    const { sign, publicJwk } = await generateSigner();
    const { sign: otherSign } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
    );
    const { decodedOffer } = await verifySignedOffer({
      paymentRequired,
      expectedPublisherDid: PUBLISHER_DID,
      resolver: resolverFor(publicJwk),
    });
    const receipt = await createReceiptJWS(
      {
        resourceUrl: RESOURCE_URL,
        payer: PAYER_ADDRESS,
        network: requirement.network,
        transaction: "0xdeadbeef",
      },
      { sign: otherSign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
    );
    await expect(
      verifySignedReceipt({
        receipt,
        decodedOffer,
        expectedPublisherDid: PUBLISHER_DID,
        payerAddresses: [PAYER_ADDRESS],
        resolver: resolverFor(publicJwk),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });

  it("rejects a receipt for a payer that does not match", async () => {
    const { sign, publicJwk } = await generateSigner();
    const requirement = buildRequirement();
    const paymentRequired = await buildPaymentRequired(
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
      requirement,
    );
    const { decodedOffer } = await verifySignedOffer({
      paymentRequired,
      expectedPublisherDid: PUBLISHER_DID,
      resolver: resolverFor(publicJwk),
    });
    const receipt = await createReceiptJWS(
      {
        resourceUrl: RESOURCE_URL,
        payer: "0xffffffffffffffffffffffffffffffffffffffff",
        network: requirement.network,
        transaction: "0xdeadbeef",
      },
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
    );
    await expect(
      verifySignedReceipt({
        receipt,
        decodedOffer,
        expectedPublisherDid: PUBLISHER_DID,
        payerAddresses: [PAYER_ADDRESS],
        resolver: resolverFor(publicJwk),
      }),
    ).rejects.toThrow(VrsaiTrustError);
  });
});
