#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createVrsaiClient } from "../client.js";
import { VrsaiMcpError, VrsaiPaymentError } from "../errors.js";
import { stderrLogger } from "../logger.js";
import {
  DEFAULT_MCP_RESOURCE_URL,
  DEFAULT_TRUST_DID,
  MCP_X402_PAYMENT_RESPONSE_META_KEY,
} from "../protocol.js";
import { createPrivateKeySigner, type EvmSigner } from "../signer.js";
import type { SpendPolicy } from "../spend-policy.js";
import { PACKAGE_VERSION } from "../version.js";

const BRIDGE_NAME = "vrsai";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    stderrLogger.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

function parseList(name: string): string[] | undefined {
  const raw = readEnv(name);
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : undefined;
}

function requireBigIntEnv(name: string): bigint {
  const raw = requireEnv(name);
  try {
    const value = BigInt(raw);
    if (value <= 0n) throw new Error("must be positive");
    return value;
  } catch {
    stderrLogger.error(`${name} must be a positive integer atomic amount.`);
    process.exit(1);
  }
}

function buildSpendPolicy(endpointUrl: string): SpendPolicy {
  const allowedNetworks = parseList("VRSAI_MCP_ALLOWED_NETWORKS") ?? ["eip155:8453"];
  const allowedAssets = parseList("VRSAI_MCP_ALLOWED_ASSETS");
  if (!allowedAssets) {
    stderrLogger.error(
      "VRSAI_MCP_ALLOWED_ASSETS must be set to a comma-separated allow-list of asset addresses.",
    );
    process.exit(1);
  }
  const maxAmountPerAuthorization = requireBigIntEnv("VRSAI_MCP_MAX_AMOUNT_PER_AUTHORIZATION");
  const maxSessionSpendRaw = readEnv("VRSAI_MCP_MAX_SESSION_SPEND");
  const expectedPublisherDid = readEnv("VRSAI_MCP_TRUST_DID") ?? DEFAULT_TRUST_DID;
  const allowedPayTo = parseList("VRSAI_MCP_ALLOWED_PAY_TO");

  return {
    allowedOrigin: new URL(endpointUrl).origin,
    allowedNetworks,
    allowedAssets,
    maxAmountPerAuthorization,
    ...(maxSessionSpendRaw !== undefined ? { maxSessionSpend: BigInt(maxSessionSpendRaw) } : {}),
    ...(expectedPublisherDid !== undefined ? { expectedPublisherDid } : {}),
    ...(allowedPayTo !== undefined ? { allowedPayTo } : {}),
  };
}

/**
 * Buyer credentials are optional at the process level (item 15): a bridge
 * started with no `VRSAI_MCP_SIGNER_PRIVATE_KEY` still serves `tools/list`
 * and any free `tools/call` — it only ever fails, per-call, if a specific
 * tool turns out to require payment. This must never `process.exit()`
 * before the server can even start; that would make credential-free
 * discovery impossible.
 */
function buildCredentials(
  endpointUrl: string,
): { readonly signer: EvmSigner; readonly spendPolicy: SpendPolicy } | undefined {
  const privateKey = readEnv("VRSAI_MCP_SIGNER_PRIVATE_KEY");
  if (privateKey === undefined) return undefined;
  const signer = createPrivateKeySigner(privateKey as `0x${string}`);
  const spendPolicy = buildSpendPolicy(endpointUrl);
  return { signer, spendPolicy };
}

/** Converts a thrown {@link VrsaiMcpError} into a structured stdio error
 * result (item 12): `structuredContent` carries the stable machine-readable
 * `code` (and, for payment errors, `economicEffect`/`retryable`) so a
 * programmatic caller downstream of this bridge can branch without parsing
 * free-text `message`. */
function toErrorResult(error: VrsaiMcpError): {
  readonly isError: true;
  readonly content: { type: "text"; text: string }[];
  readonly structuredContent: Record<string, unknown>;
} {
  const structuredContent: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error instanceof VrsaiPaymentError) {
    structuredContent.economicEffect = error.economicEffect;
    structuredContent.retryable = error.retryable;
  }
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent,
  };
}

async function main(): Promise<void> {
  const endpointUrl = readEnv("VRSAI_MCP_ENDPOINT") ?? DEFAULT_MCP_RESOURCE_URL;
  const credentials = buildCredentials(endpointUrl);

  const client = createVrsaiClient({
    endpointUrl,
    ...(credentials !== undefined ? credentials : {}),
  });

  const handle = serveStdio(async () => {
    const server = new Server(
      { name: BRIDGE_NAME, version: PACKAGE_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler("tools/list", async () => {
      const tools = await client.listTools();
      return { tools: tools as never };
    });

    server.setRequestHandler("tools/call", async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const outcome = await client.call(name, args as Record<string, unknown> | undefined);
        return server.projectCallToolResult(
          {
            content: [{ type: "text", text: JSON.stringify(outcome.structuredContent) }],
            structuredContent: outcome.structuredContent,
            // Preserve the full outcome (item 11) — a downstream caller
            // must be able to see settlement/receipt proof and the exact
            // amount paid, not just the tool's own structured content.
            ...(outcome.settlement !== undefined || outcome.amountPaid !== undefined
              ? {
                  _meta: {
                    ...(outcome.settlement !== undefined
                      ? { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: outcome.settlement }
                      : {}),
                    ...(outcome.amountPaid !== undefined
                      ? { "vrsai/amount-paid": outcome.amountPaid.toString() }
                      : {}),
                    ...(outcome.portableReceipt !== undefined
                      ? { "vrsai/portable-receipt": outcome.portableReceipt }
                      : {}),
                  },
                }
              : {}),
          } as never,
          undefined,
        );
      } catch (error) {
        if (error instanceof VrsaiMcpError) {
          stderrLogger.error(error.message, { tool: name, kind: error.name });
          return toErrorResult(error);
        }
        throw error;
      }
    });

    return server;
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handle.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  stderrLogger.error("Fatal bridge error", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
