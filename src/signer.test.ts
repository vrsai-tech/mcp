import { describe, expect, it } from "vitest";
import { VrsaiConfigurationError } from "./errors.js";
import { createPrivateKeySigner } from "./signer.js";

describe("createPrivateKeySigner", () => {
  it("throws VrsaiConfigurationError for a malformed private key", () => {
    expect(() => createPrivateKeySigner("0xnot-a-valid-key" as `0x${string}`)).toThrow(
      VrsaiConfigurationError,
    );
  });

  it("builds a signer with the expected address for a valid private key", () => {
    const privateKey = `0x${"11".repeat(32)}` as `0x${string}`;
    const signer = createPrivateKeySigner(privateKey);
    expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
