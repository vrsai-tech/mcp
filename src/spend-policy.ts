import { VrsaiSpendPolicyError } from "./errors.js";
import { DEFAULT_TRUST_DID } from "./protocol.js";

/**
 * Buyer-side spending policy. Every accepted payment requirement must pass
 * every configured constraint; anything unmatched fails closed with
 * {@link VrsaiSpendPolicyError}. There is no default-allow behavior — a
 * caller must configure `allowedNetworks`/`allowedAssets` deliberately.
 *
 * Amounts are atomic integer units (matching the x402 wire format) and are
 * always represented as `bigint`; this package never uses floating-point
 * arithmetic for money.
 */
export interface SpendPolicy {
  /** Exact expected origin of the remote resource, e.g.
   * `"https://api.vrsai.tech"`. A payment requirement/offer whose resource
   * URL origin differs is rejected before any signing occurs. */
  readonly allowedOrigin: string;
  /** CAIP-2 network identifiers this client is willing to pay on
   * (e.g. `"eip155:8453"` for Base mainnet). */
  readonly allowedNetworks: readonly string[];
  /** Asset identifiers (contract addresses or ISO-4217 codes) this client is
   * willing to pay with. Compared case-insensitively. */
  readonly allowedAssets: readonly string[];
  /** Maximum atomic amount for a single payment authorization. */
  readonly maxAmountPerAuthorization: bigint;
  /** Optional cumulative cap across every authorization created by one
   * client instance (process lifetime / session). Unset means unbounded
   * beyond the per-authorization ceiling. */
  readonly maxSessionSpend?: bigint;
  /** Optional allow-list of recipient (`payTo`) addresses. Unset accepts any
   * `payTo`, relying on `expectedPublisherDid` (when set) and the resource
   * origin check instead. */
  readonly allowedPayTo?: readonly string[];
  /** Expected `did:web:` publisher identity for signed-offer verification
   * (see {@link ./offer-trust.js}). Every payment requirement must carry a
   * signed offer resolving to this identity.
   *
   * - `undefined` (the default when omitted) — defaults to
   *   {@link DEFAULT_TRUST_DID} (`"did:web:vrsai.tech"`). Signed-offer
   *   verification is required.
   * - a `string` — overrides the default with a different expected
   *   `did:web:` identity.
   * - `false` — explicit opt-out. Only appropriate against x402 servers
   *   that do not yet implement the offer-receipt extension; payment
   *   requirements are accepted without signed-offer verification. */
  readonly expectedPublisherDid?: string | false;
}

/**
 * {@link SpendPolicy} after {@link resolveSpendPolicy} has run: the default
 * has already been applied and the `false` opt-out sentinel has already
 * been resolved away, so `expectedPublisherDid` is either a concrete
 * `did:web:` string or `undefined` (explicit opt-out) — never `false`.
 */
export type ResolvedSpendPolicy = Omit<SpendPolicy, "expectedPublisherDid"> & {
  readonly expectedPublisherDid?: string;
};

/**
 * Resolves {@link SpendPolicy.expectedPublisherDid} to its effective value:
 * `undefined` (omitted) defaults to {@link DEFAULT_TRUST_DID}, `false` is an
 * explicit opt-out (resolves to `undefined`, meaning "skip signed-offer
 * verification"), and an explicit string overrides the default. Called
 * exactly once per client so every downstream consumer of the policy (the
 * spend ledger, `verifyAndSign`) observes the same resolved value.
 */
export function resolveSpendPolicy(policy: SpendPolicy): ResolvedSpendPolicy {
  if (policy.expectedPublisherDid === false) {
    const { expectedPublisherDid: _optOut, ...rest } = policy;
    return rest;
  }
  return { ...policy, expectedPublisherDid: policy.expectedPublisherDid ?? DEFAULT_TRUST_DID };
}

const CAIP2_PATTERN = /^[a-z0-9]+:[A-Za-z0-9-]+$/;

export function normalizeSpendPolicy(policy: SpendPolicy): SpendPolicy {
  if (policy.allowedNetworks.length === 0) {
    throw new VrsaiSpendPolicyError("SpendPolicy.allowedNetworks must not be empty.");
  }
  if (policy.allowedAssets.length === 0) {
    throw new VrsaiSpendPolicyError("SpendPolicy.allowedAssets must not be empty.");
  }
  for (const network of policy.allowedNetworks) {
    if (!CAIP2_PATTERN.test(network)) {
      throw new VrsaiSpendPolicyError(`SpendPolicy network "${network}" is not CAIP-2.`);
    }
  }
  if (policy.maxAmountPerAuthorization <= 0n) {
    throw new VrsaiSpendPolicyError("SpendPolicy.maxAmountPerAuthorization must be positive.");
  }
  if (policy.maxSessionSpend !== undefined && policy.maxSessionSpend <= 0n) {
    throw new VrsaiSpendPolicyError("SpendPolicy.maxSessionSpend must be positive when set.");
  }
  let origin: string;
  try {
    origin = new URL(policy.allowedOrigin).origin;
  } catch {
    throw new VrsaiSpendPolicyError("SpendPolicy.allowedOrigin must be an absolute URL.");
  }
  if (origin !== policy.allowedOrigin) {
    throw new VrsaiSpendPolicyError("SpendPolicy.allowedOrigin must be an exact origin (no path).");
  }
  if (new URL(origin).protocol !== "https:") {
    throw new VrsaiSpendPolicyError("SpendPolicy.allowedOrigin must be https.");
  }
  return {
    ...policy,
    allowedNetworks: policy.allowedNetworks.map((n) => n),
    allowedAssets: policy.allowedAssets.map((a) => a.toLowerCase()),
    ...(policy.allowedPayTo !== undefined
      ? { allowedPayTo: policy.allowedPayTo.map((a) => a.toLowerCase()) }
      : {}),
  };
}

/** Minimal shape of an x402 `PaymentRequirements` entry needed for policy
 * checks, kept local so this module has no dependency on `@x402/core`. */
export interface SpendableRequirement {
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
}

/**
 * Tracks cumulative spend for one client instance and enforces
 * {@link SpendPolicy} against each candidate payment requirement. Fails
 * closed: any requirement outside policy throws before signing.
 */
/**
 * Tracks cumulative spend for one client instance and enforces
 * {@link SpendPolicy} against each candidate payment requirement. Fails
 * closed: any requirement outside policy throws before signing.
 *
 * Concurrency note: {@link SpendLedger.reserve} validates policy AND
 * atomically increments the cumulative spend counter in one synchronous
 * call (no `await` between the check and the increment). Node.js's
 * single-threaded execution model means no other code — including another
 * concurrent `call()`'s own `reserve()` — can interleave inside that
 * synchronous call, so two concurrent calls can never both observe
 * `maxSessionSpend` as "not yet exceeded" for amounts that, combined,
 * exceed it. This is the property `assert()` + a later `record()` around
 * an `await` (e.g. signing) cannot guarantee, because the increment would
 * happen only after the async gap.
 */
export class SpendLedger {
  private spent = 0n;
  private readonly policy: SpendPolicy;

  constructor(policy: SpendPolicy) {
    this.policy = normalizeSpendPolicy(policy);
  }

  private validate(requirement: SpendableRequirement, resourceUrl: string): bigint {
    let resourceOrigin: string;
    try {
      resourceOrigin = new URL(resourceUrl).origin;
    } catch {
      throw new VrsaiSpendPolicyError("Payment resource URL is not a valid absolute URL.");
    }
    if (resourceOrigin !== this.policy.allowedOrigin) {
      throw new VrsaiSpendPolicyError(
        `Payment resource origin "${resourceOrigin}" is not the configured allowed origin.`,
      );
    }
    if (!this.policy.allowedNetworks.includes(requirement.network)) {
      throw new VrsaiSpendPolicyError(`Network "${requirement.network}" is not allow-listed.`);
    }
    if (!this.policy.allowedAssets.includes(requirement.asset.toLowerCase())) {
      throw new VrsaiSpendPolicyError(`Asset "${requirement.asset}" is not allow-listed.`);
    }
    if (
      this.policy.allowedPayTo !== undefined &&
      !this.policy.allowedPayTo.includes(requirement.payTo.toLowerCase())
    ) {
      throw new VrsaiSpendPolicyError(`payTo "${requirement.payTo}" is not allow-listed.`);
    }
    let amount: bigint;
    try {
      amount = BigInt(requirement.amount);
    } catch {
      throw new VrsaiSpendPolicyError("Payment amount is not a valid atomic integer.");
    }
    if (amount <= 0n) throw new VrsaiSpendPolicyError("Payment amount must be positive.");
    if (amount > this.policy.maxAmountPerAuthorization) {
      throw new VrsaiSpendPolicyError(
        `Payment amount ${amount} exceeds maxAmountPerAuthorization ${this.policy.maxAmountPerAuthorization}.`,
      );
    }
    if (
      this.policy.maxSessionSpend !== undefined &&
      this.spent + amount > this.policy.maxSessionSpend
    ) {
      throw new VrsaiSpendPolicyError(
        `Payment amount ${amount} would exceed the remaining session budget.`,
      );
    }
    return amount;
  }

  /** Throws {@link VrsaiSpendPolicyError} if `requirement` is outside policy;
   * otherwise returns the parsed atomic amount. Pure validation — never
   * records spend. Prefer {@link SpendLedger.reserve} around any call that
   * is followed by an `await` (e.g. signing), since `assert()` followed by
   * a later `record()` reopens the race `reserve()` exists to close. */
  assert(requirement: SpendableRequirement, resourceUrl: string): bigint {
    return this.validate(requirement, resourceUrl);
  }

  /**
   * Atomically validates `requirement` against policy AND reserves its
   * amount against the cumulative session budget, in one synchronous call.
   * Callers MUST call this immediately before any `await` (e.g. signing)
   * and must call {@link SpendLedger.release} with the returned amount if —
   * and only if — they can prove no authorization was created (e.g. local
   * signing itself threw, before anything was sent anywhere). Once an
   * authorization may have left the process, never release: budget
   * headroom is retained conservatively rather than restored optimistically.
   */
  reserve(requirement: SpendableRequirement, resourceUrl: string): bigint {
    const amount = this.validate(requirement, resourceUrl);
    this.spent += amount;
    return amount;
  }

  /** Releases a reservation created by {@link SpendLedger.reserve}. Only
   * safe to call when it is certain no authorization was created for that
   * amount — see {@link SpendLedger.reserve}'s contract. */
  release(amount: bigint): void {
    this.spent = this.spent - amount > 0n ? this.spent - amount : 0n;
  }

  /** Records `amount` as spent. Intentionally never rolled back: once an
   * authorization is created its economic effect may be unknown, so budget
   * headroom is reserved conservatively rather than restored optimistically.
   * Kept for backward-compatible standalone use of {@link SpendLedger.assert};
   * new code driven by {@link createVrsaiClient} uses {@link SpendLedger.reserve}
   * instead, which folds this into the same atomic step as the check. */
  record(amount: bigint): void {
    this.spent += amount;
  }

  spentSoFar(): bigint {
    return this.spent;
  }

  readonly policyForInspection = (): SpendPolicy => this.policy;
}
