import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { VrsaiProtocolError } from "./errors.js";
import { MCP_X402_PAYMENT_RESPONSE_META_KEY } from "./protocol.js";
import { classifyCallToolResult } from "./result-parsing.js";

const RESOURCE_URL = "https://api.vrsai.tech/mcp";

function deliveredResult(
  structuredContent: Record<string, unknown>,
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
    ...(meta !== undefined ? { _meta: meta } : {}),
  } as CallToolResult;
}

function errorResult(structuredContent: unknown, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: true,
  } as CallToolResult;
}

const SETTLEMENT = {
  success: true,
  transaction: "0xdeadbeef",
  network: "eip155:8453",
};

describe("classifyCallToolResult", () => {
  it("classifies a plain success result as delivered", () => {
    const result = deliveredResult({ ok: true });
    const classified = classifyCallToolResult(result, RESOURCE_URL);
    expect(classified).toEqual({ kind: "delivered", structuredContent: { ok: true } });
  });

  it("classifies a non-payment error result as a plain error", () => {
    const result = errorResult({ ok: false }, "boom");
    const classified = classifyCallToolResult(result, RESOURCE_URL);
    expect(classified).toEqual({ kind: "error", message: "boom" });
  });

  it("classifies a valid x402 v2 PaymentRequired error as payment-required", () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "500000",
          payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    };
    const result = errorResult(paymentRequired, JSON.stringify(paymentRequired));
    const classified = classifyCallToolResult(result, RESOURCE_URL);
    expect(classified.kind).toBe("payment-required");
  });

  it("rejects an x402 v1 PaymentRequired challenge rather than treating it as a plain error", () => {
    const paymentRequiredV1 = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          maxAmountRequired: "500000",
          resource: RESOURCE_URL,
          description: "example",
          payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          maxTimeoutSeconds: 60,
          asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      ],
    };
    const result = errorResult(paymentRequiredV1, JSON.stringify(paymentRequiredV1));
    expect(() => classifyCallToolResult(result, RESOURCE_URL)).toThrow(VrsaiProtocolError);
  });

  it("throws when a delivered result carries no structured content", () => {
    const result = {
      content: [{ type: "text", text: "{}" }],
      isError: false,
    } as CallToolResult;
    expect(() => classifyCallToolResult(result, RESOURCE_URL)).toThrow(VrsaiProtocolError);
  });

  it("throws when structured and text content diverge", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ ok: false }) }],
      structuredContent: { ok: true },
      isError: false,
    } as CallToolResult;
    expect(() => classifyCallToolResult(result, RESOURCE_URL)).toThrow(VrsaiProtocolError);
  });

  it("extracts a well-formed settlement response", () => {
    const result = deliveredResult(
      { ok: true },
      { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: SETTLEMENT },
    );
    const classified = classifyCallToolResult(result, RESOURCE_URL);
    expect(classified.kind).toBe("delivered");
    if (classified.kind === "delivered") {
      expect(classified.settlement).toEqual(SETTLEMENT);
    }
  });

  it("throws on a malformed settlement response", () => {
    const result = deliveredResult(
      { ok: true },
      { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true } },
    );
    expect(() => classifyCallToolResult(result, RESOURCE_URL)).toThrow(VrsaiProtocolError);
  });

  it("does not require settlement on an ordinary (unpaid) call", () => {
    const result = deliveredResult({ ok: true });
    expect(() => classifyCallToolResult(result, RESOURCE_URL)).not.toThrow();
  });

  it("requires settlement on a paid retry and throws when it is missing", () => {
    const result = deliveredResult({ ok: true });
    expect(() => classifyCallToolResult(result, RESOURCE_URL, { requireSettlement: true })).toThrow(
      VrsaiProtocolError,
    );
  });

  it("accepts a paid retry that does carry settlement", () => {
    const result = deliveredResult(
      { ok: true },
      { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: SETTLEMENT },
    );
    const classified = classifyCallToolResult(result, RESOURCE_URL, { requireSettlement: true });
    expect(classified.kind).toBe("delivered");
  });
});
