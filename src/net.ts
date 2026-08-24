import { VrsaiProtocolError } from "./errors.js";

/**
 * Wraps `fetch` with a hard response-size cap and timeout so a hostile or
 * misbehaving endpoint (remote MCP server, or a `did:web` document host)
 * cannot exhaust memory or hang the caller indefinitely. Applies to both the
 * MCP transport and buyer-side trust (`did:web`) resolution.
 *
 * Streaming-safe: the size cap is enforced via a `TransformStream` over the
 * live response body, so chunks are forwarded to the caller as they arrive
 * rather than being fully buffered first. This is required for
 * `StreamableHTTPClientTransport`'s `text/event-stream` responses, where a
 * server pushes messages incrementally over what may be a long-lived
 * connection — buffering to completion before returning anything would
 * make the transport hang indefinitely on any such response.
 */
export function boundedFetch(
  fetchImplementation: typeof fetch,
  options: { readonly maxBytes: number; readonly timeoutMs: number },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const combinedSignal = init?.signal
      ? anySignal([init.signal, controller.signal])
      : controller.signal;
    let response: Response;
    try {
      response = await fetchImplementation(input, { ...init, signal: combinedSignal });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > options.maxBytes) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {});
      throw new VrsaiProtocolError("Response exceeds the configured safe size limit.");
    }
    if (!response.body) {
      clearTimeout(timer);
      return response;
    }
    const maxBytes = options.maxBytes;
    let total = 0;
    const bounded = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, streamController) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            streamController.error(
              new VrsaiProtocolError("Response exceeds the configured safe size limit."),
            );
            return;
          }
          streamController.enqueue(chunk);
        },
        flush() {
          clearTimeout(timer);
        },
        cancel() {
          clearTimeout(timer);
        },
      }),
    );
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** Only `https:` URLs are ever fetched by this package (remote MCP endpoint,
 * `did:web` documents). Rejects everything else, including `http:`, closing
 * off SSRF-via-scheme and plaintext downgrade. */
export function assertHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VrsaiProtocolError(`${label} is not a valid absolute URL.`);
  }
  if (url.protocol !== "https:") {
    throw new VrsaiProtocolError(`${label} must use https.`);
  }
  return url;
}
