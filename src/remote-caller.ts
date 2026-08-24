import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { assertHttpsUrl, boundedFetch } from "./net.js";
import { MCP_PROTOCOL_VERSION } from "./protocol.js";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Matches the SDK's own default so `listTools()` behavior is explicit
 * rather than an implicit dependency on the SDK's internal default. */
const DEFAULT_LIST_MAX_PAGES = 64;

export interface RemoteCallerOptions {
  /** Absolute `https://` URL of the remote MCP endpoint. */
  readonly endpointUrl: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /** Caps how many `tools/list` pages `listTools()` will auto-aggregate
   * before giving up, bounding worst-case memory/latency against a hostile
   * or misbehaving server that never terminates pagination. `0` disables
   * the cap (only appropriate against a fully trusted endpoint). */
  readonly listMaxPages?: number;
}

/**
 * A connected handle to the remote vrsai MCP endpoint. Every network call
 * goes through a bounded fetch (hard timeout + response-size cap) so a
 * misbehaving or hostile endpoint cannot hang or exhaust memory in this
 * process.
 */
export interface RemoteCaller {
  listTools(): Promise<readonly Tool[]>;
  /** `_meta` mirrors the wire `_meta` envelope on the `tools/call` request —
   * this is where an x402 `PaymentPayload` is attached on a paid retry. */
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    meta?: Record<string, unknown>,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function connectRemoteCaller(options: RemoteCallerOptions): Promise<RemoteCaller> {
  const url = assertHttpsUrl(options.endpointUrl, "endpointUrl");
  const bounded = boundedFetch(options.fetchImplementation ?? fetch, {
    maxBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const transport = new StreamableHTTPClientTransport(url, { fetch: bounded });
  const client = new Client(
    { name: options.clientName ?? "@vrsai/mcp", version: options.clientVersion ?? PACKAGE_VERSION },
    {
      // Hard-pin the protocol revision: `connect()` must negotiate exactly
      // `MCP_PROTOCOL_VERSION` via `server/discover`, with no probe-and-
      // fallback to the legacy 2025 handshake. `supportedProtocolVersions`
      // (a `ProtocolOptions` field) only influences the legacy `initialize`
      // version-offer list, which this pinned mode never uses, so it is
      // deliberately omitted rather than left as dead/misleading config.
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
      listMaxPages: options.listMaxPages ?? DEFAULT_LIST_MAX_PAGES,
    },
  );
  await client.connect(transport);

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools;
    },
    async callTool(name, args, meta) {
      return client.callTool({
        name,
        ...(args !== undefined ? { arguments: args } : {}),
        ...(meta !== undefined ? { _meta: meta } : {}),
      } as never);
    },
    async close() {
      await client.close();
    },
  };
}
