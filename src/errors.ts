/**
 * Typed error hierarchy for `@vrsai/mcp`. Every failure surfaced to a
 * programmatic caller is one of these classes so callers can branch on
 * `instanceof` rather than parsing message strings.
 */

export type EconomicEffect = "occurred" | "not_occurred" | "unknown";

/**
 * Stable, machine-readable error identifiers. These never change meaning or
 * get repurposed once published — an autonomous caller may safely persist
 * and branch on `code` across package upgrades, unlike `error.message`
 * (free text) or `error.name` (a class identity, not guaranteed stable
 * across a class hierarchy refactor).
 */
export type VrsaiErrorCode =
  | "vrsai/protocol_error"
  | "vrsai/trust_error"
  | "vrsai/spend_policy_error"
  | "vrsai/payment_error"
  | "vrsai/journal_error"
  | "vrsai/tool_error"
  | "vrsai/configuration_error";

/** Base class for every error this package throws. */
export abstract class VrsaiMcpError extends Error {
  abstract override readonly name: string;
  /** Stable machine-readable identifier — see {@link VrsaiErrorCode}. */
  abstract readonly code: VrsaiErrorCode;
}

/** The remote MCP endpoint, transport, or wire format did not match the
 * expected native MCP/x402 contract. Never thrown for ordinary business
 * validation errors coming back from the server. */
export class VrsaiProtocolError extends VrsaiMcpError {
  override readonly name = "VrsaiProtocolError";
  override readonly code = "vrsai/protocol_error" as const;
}

/** A payment challenge or requirement failed buyer-side trust verification
 * (unexpected origin/network/asset/payTo/amount, missing or invalid signed
 * offer, expired offer, or a publisher DID that does not match policy).
 * Fail-closed *before* a payment is signed or sent: rejecting an offer or
 * requirement never signs or submits anything. The one exception is
 * post-settlement portable-receipt verification (`submitPaidCall`'s call to
 * `verifySignedReceipt`), which runs only after delivery and settlement are
 * already proven — a failure there is surfaced as a `VrsaiPaymentError` with
 * `economicEffect: "occurred"`, not as this class, so `VrsaiTrustError`
 * itself always means nothing was signed or sent. */
export class VrsaiTrustError extends VrsaiMcpError {
  override readonly name = "VrsaiTrustError";
  override readonly code = "vrsai/trust_error" as const;
}

/** A payment requirement was within protocol bounds but outside the
 * caller's configured spending policy (disallowed network/asset/origin,
 * per-authorization ceiling, or session budget), or a payment was required
 * but no signer/spend policy was configured on this client at all. Always
 * fail-closed. */
export class VrsaiSpendPolicyError extends VrsaiMcpError {
  override readonly name = "VrsaiSpendPolicyError";
  override readonly code = "vrsai/spend_policy_error" as const;
}

/**
 * A payment authorization was created and/or submitted and the outcome is
 * not a simple "no payment needed" success. `economicEffect` states what is
 * safely knowable:
 *
 * - `"not_occurred"` — the server rejected the offer/requirement before any
 *   authorization was created; no economic effect happened.
 * - `"unknown"` — an authorization may have been submitted but the outcome
 *   could not be confirmed (network/transport failure, ambiguous facilitator
 *   response). The local journal retains the exact authorization so a retry
 *   resumes it rather than creating a replacement.
 * - `"occurred"` — delivery and settlement were already proven (a valid,
 *   requirement-matching settlement response was received) but a
 *   downstream check that runs strictly after that point — currently only
 *   portable-receipt trust verification — failed. The payment happened;
 *   only the receipt's authenticity could not be confirmed.
 */
export class VrsaiPaymentError extends VrsaiMcpError {
  override readonly name = "VrsaiPaymentError";
  override readonly code = "vrsai/payment_error" as const;
  readonly economicEffect: EconomicEffect;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      readonly economicEffect: EconomicEffect;
      readonly retryable: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.economicEffect = options.economicEffect;
    this.retryable = options.retryable;
  }
}

/** The local crash-safe payment journal is unavailable, corrupt, or unsafe
 * to use (e.g. unexpected permissions). Fails closed rather than silently
 * risking a duplicate authorization. */
export class VrsaiJournalError extends VrsaiMcpError {
  override readonly name = "VrsaiJournalError";
  override readonly code = "vrsai/journal_error" as const;
}

/** The remote tool reported an ordinary business-level failure unrelated to
 * payment (`isError: true` with no payment requirement attached). No
 * economic effect occurred — nothing is ever signed or submitted before a
 * tool call is attempted. */
export class VrsaiToolError extends VrsaiMcpError {
  override readonly name = "VrsaiToolError";
  override readonly code = "vrsai/tool_error" as const;
}

/** The client was asked to do something it is not configured for — most
 * commonly, attempting a call that turned out to require payment on a
 * client constructed without a `signer`/`spendPolicy` (discovery-only
 * mode). No economic effect occurred; nothing is ever signed or submitted
 * before this is detected. */
export class VrsaiConfigurationError extends VrsaiMcpError {
  override readonly name = "VrsaiConfigurationError";
  override readonly code = "vrsai/configuration_error" as const;
}
