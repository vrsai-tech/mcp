/** Deterministic JSON serialization used for fingerprinting and equality
 * checks: object keys are sorted so semantically identical inputs always
 * produce the same digest regardless of property insertion order. Rejects
 * non-finite numbers, matching the x402 wire format's integer-only money
 * discipline. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot canonicalize a non-JSON value.");
}
