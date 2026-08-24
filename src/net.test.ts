import { describe, expect, it } from "vitest";
import { VrsaiProtocolError } from "./errors.js";
import { assertHttpsUrl, boundedFetch } from "./net.js";

function textChunks(...parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("boundedFetch", () => {
  it("forwards a small response body through untouched", async () => {
    const fake: typeof fetch = async () =>
      new Response(textChunks("hello", " ", "world"), { status: 200 });
    const bounded = boundedFetch(fake, { maxBytes: 1024, timeoutMs: 1000 });
    const response = await bounded("https://example.test/");
    expect(await response.text()).toBe("hello world");
  });

  it("streams chunks incrementally instead of buffering the whole body before returning", async () => {
    // A source stream whose second chunk never arrives until explicitly
    // released. If `boundedFetch` buffered fully before returning, reading
    // the bounded response's stream would never yield the first chunk
    // before the second is pushed — this test proves the first chunk is
    // observable independently of the second.
    let releaseSecondChunk: (() => void) | undefined;
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first-chunk"));
      },
      pull(controller) {
        return new Promise<void>((resolve) => {
          releaseSecondChunk = () => {
            controller.enqueue(encoder.encode("second-chunk"));
            controller.close();
            resolve();
          };
        });
      },
    });
    const fake: typeof fetch = async () => new Response(source, { status: 200 });
    const bounded = boundedFetch(fake, { maxBytes: 1024, timeoutMs: 5000 });
    const response = await bounded("https://example.test/");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected a body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first-chunk");
    releaseSecondChunk?.();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second-chunk");
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it("rejects a response whose declared content-length exceeds the cap", async () => {
    const fake: typeof fetch = async () =>
      new Response(textChunks("x".repeat(10)), {
        status: 200,
        headers: { "content-length": "999999" },
      });
    const bounded = boundedFetch(fake, { maxBytes: 10, timeoutMs: 1000 });
    await expect(bounded("https://example.test/")).rejects.toThrow(VrsaiProtocolError);
  });

  it("aborts a stream that exceeds the cap mid-flight, even without a declared content-length", async () => {
    const encoder = new TextEncoder();
    const fake: typeof fetch = async () =>
      new Response(textChunks("a".repeat(20)), { status: 200 });
    const bounded = boundedFetch(fake, { maxBytes: 5, timeoutMs: 1000 });
    const response = await bounded("https://example.test/");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected a body");
    await expect(reader.read()).rejects.toThrow(VrsaiProtocolError);
    void encoder;
  });

  it("aborts the underlying request once the timeout elapses", async () => {
    const fake: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const bounded = boundedFetch(fake, { maxBytes: 1024, timeoutMs: 10 });
    await expect(bounded("https://example.test/")).rejects.toThrow();
  });
});

describe("assertHttpsUrl", () => {
  it("accepts an absolute https URL", () => {
    expect(assertHttpsUrl("https://example.test/mcp", "endpointUrl").toString()).toBe(
      "https://example.test/mcp",
    );
  });

  it("rejects http URLs", () => {
    expect(() => assertHttpsUrl("http://example.test/mcp", "endpointUrl")).toThrow(
      VrsaiProtocolError,
    );
  });

  it("rejects malformed URLs", () => {
    expect(() => assertHttpsUrl("not-a-url", "endpointUrl")).toThrow(VrsaiProtocolError);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertHttpsUrl("file:///etc/passwd", "endpointUrl")).toThrow(VrsaiProtocolError);
  });
});
