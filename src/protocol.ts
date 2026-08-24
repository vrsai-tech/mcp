/**
 * Wire-level constants for the vrsai native MCP/x402 contract. These values
 * are protocol facts (stable public wire keys and the canonical remote
 * resource identity), not business logic or pricing/catalog data, so
 * mirroring them here does not violate capability/commercial isolation —
 * this package still never imports server source.
 *
 * If the upstream server ever changes these, this package's own
 * offline/e2e tests will fail loudly against a live smoke test rather than
 * silently drifting.
 */

/** Request `_meta` key carrying an x402 `PaymentPayload` on `tools/call`. */
export const MCP_X402_PAYMENT_META_KEY = "x402/payment" as const;

/** Result `_meta` key carrying an x402 `SettleResponse` on successful
 * delivery. */
export const MCP_X402_PAYMENT_RESPONSE_META_KEY = "x402/payment-response" as const;

/** Canonical remote resource URL identifying the vrsai MCP endpoint for
 * payment-requirement/offer binding checks. */
export const DEFAULT_MCP_RESOURCE_URL = "https://api.vrsai.tech/mcp" as const;

/** MCP protocol revision this package speaks. */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

/** Publisher `did:web` identity used for signed-offer trust verification by
 * default. Callers may override via {@link SpendPolicy.expectedPublisherDid}. */
export const DEFAULT_TRUST_DID = "did:web:vrsai.tech" as const;
