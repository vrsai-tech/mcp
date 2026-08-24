import type { CallToolResult } from "@modelcontextprotocol/client";
import { parsePaymentRequired } from "@x402/core/schemas";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { isJWSSignedReceipt, type JWSSignedReceipt } from "@x402/extensions/offer-receipt";
import { VrsaiProtocolError } from "./errors.js";
import { MCP_X402_PAYMENT_RESPONSE_META_KEY } from "./protocol.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads the first text content block, if any. Every native MCP result on
 * this contract carries a text/structured compatibility pair; this package
 * treats a mismatch between them as a protocol violation rather than
 * silently trusting one representation over the other. */
function firstTextBlock(result: CallToolResult): string | undefined {
  const first = result.content[0];
  return first?.type === "text" ? first.text : undefined;
}

function assertTextMatchesStructured(result: CallToolResult, structuredContent: unknown): void {
  const text = firstTextBlock(result);
  if (text === undefined) {
    throw new VrsaiProtocolError("MCP result lacks the expected text compatibility content.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VrsaiProtocolError("MCP result text content is not valid JSON.");
  }
  if (JSON.stringify(parsed) !== JSON.stringify(structuredContent)) {
    throw new VrsaiProtocolError("MCP result structured and text content diverge.");
  }
}

export type ClassifiedCallToolResult =
  | { readonly kind: "payment-required"; readonly paymentRequired: PaymentRequired }
  | {
      readonly kind: "delivered";
      readonly structuredContent: Record<string, unknown>;
      readonly settlement?: SettleResponse & { readonly success: true };
      readonly portableReceipt?: JWSSignedReceipt;
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * Classifies a `tools/call` result from the vrsai native MCP/x402 contract.
 * Never guesses: a result is only ever `payment-required` when it carries a
 * structurally valid x402 v2 `PaymentRequired` for the expected resource;
 * everything else that is `isError` is a plain `error`, and everything that
 * is not `isError` is `delivered`.
 */
export interface ClassifyCallToolResultOptions {
  /** Set on a *paid* retry (resumed or freshly signed). When true, a result
   * classified as `"delivered"` MUST carry a structurally valid settlement
   * response — otherwise this throws {@link VrsaiProtocolError} rather than
   * treating an unproven "success" as proof of payment (item 7). Never set
   * on the initial, unpaid attempt, where no settlement is expected. */
  readonly requireSettlement?: boolean;
  /** Set on a *paid* retry alongside `requireSettlement` to the exact
   * network (`PaymentRequirements.network`) that was authorized. When a
   * settlement response is present, its `network` must match this value
   * exactly — otherwise this throws {@link VrsaiProtocolError} rather than
   * silently accepting settlement evidence for a different network than
   * the one that was actually authorized and signed for. */
  readonly expectedNetwork?: string;
}

/**
 * Classifies a `tools/call` result from the vrsai native MCP/x402 contract.
 * Never guesses: a result is only ever `payment-required` when it carries a
 * structurally valid x402 v2 `PaymentRequired` for the expected resource;
 * everything else that is `isError` is a plain `error`, and everything that
 * is not `isError` is `delivered`. An x402 v1 challenge is explicitly
 * rejected rather than silently absorbed as a generic error — this package
 * only ever speaks x402 v2 (item 20).
 */
export function classifyCallToolResult(
  result: CallToolResult,
  expectedResourceUrl: string,
  options?: ClassifyCallToolResultOptions,
): ClassifiedCallToolResult {
  if (result.isError === true) {
    const parsed = parsePaymentRequired(result.structuredContent);
    if (parsed.success && parsed.data.x402Version === 1) {
      throw new VrsaiProtocolError(
        "Server responded with an x402 v1 PaymentRequired challenge; this client only speaks x402 v2.",
      );
    }
    if (parsed.success && parsed.data.x402Version === 2) {
      if (parsed.data.resource.url !== expectedResourceUrl) {
        throw new VrsaiProtocolError(
          "PaymentRequired resource URL does not match the configured remote endpoint.",
        );
      }
      assertTextMatchesStructured(result, result.structuredContent);
      return { kind: "payment-required", paymentRequired: parsed.data as PaymentRequired };
    }
    const text = firstTextBlock(result);
    return { kind: "error", message: text ?? "Remote tool call failed." };
  }
  const structuredContent = record(result.structuredContent);
  if (!structuredContent) {
    throw new VrsaiProtocolError("MCP delivery result lacks structured content.");
  }
  assertTextMatchesStructured(result, structuredContent);
  const settlementMeta = record(result._meta?.[MCP_X402_PAYMENT_RESPONSE_META_KEY]);
  let settlement: (SettleResponse & { readonly success: true }) | undefined;
  if (settlementMeta !== undefined) {
    if (
      settlementMeta.success !== true ||
      typeof settlementMeta.transaction !== "string" ||
      typeof settlementMeta.network !== "string" ||
      (settlementMeta.payer !== undefined && typeof settlementMeta.payer !== "string") ||
      (settlementMeta.amount !== undefined && typeof settlementMeta.amount !== "string")
    ) {
      throw new VrsaiProtocolError("MCP delivery carries a malformed settlement response.");
    }
    if (
      options?.expectedNetwork !== undefined &&
      settlementMeta.network !== options.expectedNetwork
    ) {
      throw new VrsaiProtocolError(
        `Settlement response network "${settlementMeta.network}" does not match the authorized network "${options.expectedNetwork}".`,
      );
    }
    settlement = settlementMeta as unknown as SettleResponse & { readonly success: true };
  }
  if (options?.requireSettlement === true && settlement === undefined) {
    throw new VrsaiProtocolError(
      "A paid retry was classified as delivered but carried no settlement response; refusing to treat it as proof of payment.",
    );
  }
  let portableReceipt: JWSSignedReceipt | undefined;
  const offerReceiptExtension = record(record(settlement?.extensions)?.["offer-receipt"]);
  const receipt = record(offerReceiptExtension?.info)?.receipt;
  if (receipt !== undefined && isJWSSignedReceipt(receipt as never)) {
    portableReceipt = receipt as JWSSignedReceipt;
  }
  return {
    kind: "delivered",
    structuredContent,
    ...(settlement !== undefined ? { settlement } : {}),
    ...(portableReceipt !== undefined ? { portableReceipt } : {}),
  };
}
