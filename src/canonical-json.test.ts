import { describe, expect, it } from "vitest";
import { stableJson } from "./canonical-json.js";

describe("stableJson", () => {
  it("sorts object keys regardless of insertion order", () => {
    const a = stableJson({ b: 1, a: 2, c: 3 });
    const b = stableJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("recursively canonicalizes nested objects and arrays", () => {
    const value = { z: [{ y: 1, x: 2 }], a: "hi" };
    expect(stableJson(value)).toBe('{"a":"hi","z":[{"x":2,"y":1}]}');
  });

  it("serializes primitives directly", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson(true)).toBe("true");
    expect(stableJson("x")).toBe('"x"');
    expect(stableJson(42)).toBe("42");
  });

  it("rejects non-finite numbers", () => {
    expect(() => stableJson(Number.NaN)).toThrow();
    expect(() => stableJson(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects values with no JSON representation", () => {
    expect(() => stableJson(undefined)).toThrow();
    expect(() => stableJson(() => {})).toThrow();
  });

  it("produces different output for semantically different input", () => {
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
  });
});
