import { describe, expect, it } from "vitest";
import { VrsaiSpendPolicyError } from "./errors.js";
import { DEFAULT_TRUST_DID } from "./protocol.js";
import {
  normalizeSpendPolicy,
  resolveSpendPolicy,
  SpendLedger,
  type SpendPolicy,
} from "./spend-policy.js";

const BASE_POLICY: SpendPolicy = {
  allowedOrigin: "https://api.vrsai.tech",
  allowedNetworks: ["eip155:8453"],
  allowedAssets: ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  maxAmountPerAuthorization: 1_000_000n,
};

describe("normalizeSpendPolicy", () => {
  it("lower-cases assets and allowedPayTo for case-insensitive comparison", () => {
    const normalized = normalizeSpendPolicy({
      ...BASE_POLICY,
      allowedPayTo: ["0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    });
    expect(normalized.allowedAssets).toEqual(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(normalized.allowedPayTo).toEqual(["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
  });

  it("omits allowedPayTo entirely when unset (no undefined property)", () => {
    const normalized = normalizeSpendPolicy(BASE_POLICY);
    expect("allowedPayTo" in normalized).toBe(false);
  });

  it("rejects an empty allowedNetworks list", () => {
    expect(() => normalizeSpendPolicy({ ...BASE_POLICY, allowedNetworks: [] })).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("rejects an empty allowedAssets list", () => {
    expect(() => normalizeSpendPolicy({ ...BASE_POLICY, allowedAssets: [] })).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("rejects a non-CAIP-2 network", () => {
    expect(() => normalizeSpendPolicy({ ...BASE_POLICY, allowedNetworks: ["base"] })).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("rejects a non-positive maxAmountPerAuthorization", () => {
    expect(() => normalizeSpendPolicy({ ...BASE_POLICY, maxAmountPerAuthorization: 0n })).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("rejects a non-https allowedOrigin", () => {
    expect(() =>
      normalizeSpendPolicy({ ...BASE_POLICY, allowedOrigin: "http://api.vrsai.tech" }),
    ).toThrow(VrsaiSpendPolicyError);
  });

  it("rejects an allowedOrigin containing a path", () => {
    expect(() =>
      normalizeSpendPolicy({ ...BASE_POLICY, allowedOrigin: "https://api.vrsai.tech/mcp" }),
    ).toThrow(VrsaiSpendPolicyError);
  });
});

describe("resolveSpendPolicy", () => {
  it("defaults an omitted expectedPublisherDid to DEFAULT_TRUST_DID", () => {
    const resolved = resolveSpendPolicy(BASE_POLICY);
    expect(resolved.expectedPublisherDid).toBe(DEFAULT_TRUST_DID);
  });

  it("preserves an explicit expectedPublisherDid override", () => {
    const resolved = resolveSpendPolicy({
      ...BASE_POLICY,
      expectedPublisherDid: "did:web:example.com",
    });
    expect(resolved.expectedPublisherDid).toBe("did:web:example.com");
  });

  it("treats expectedPublisherDid: false as an explicit opt-out (resolves to undefined)", () => {
    const resolved = resolveSpendPolicy({ ...BASE_POLICY, expectedPublisherDid: false });
    expect(resolved.expectedPublisherDid).toBeUndefined();
    expect("expectedPublisherDid" in resolved).toBe(false);
  });
});

describe("SpendLedger", () => {
  const requirement = {
    network: "eip155:8453",
    asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    amount: "500000",
  };

  it("accepts a requirement that satisfies every constraint", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(ledger.assert(requirement, "https://api.vrsai.tech/mcp")).toBe(500_000n);
  });

  it("rejects a requirement from an unexpected resource origin", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(() => ledger.assert(requirement, "https://evil.example/mcp")).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("rejects a disallowed network", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(() =>
      ledger.assert({ ...requirement, network: "eip155:1" }, "https://api.vrsai.tech/mcp"),
    ).toThrow(VrsaiSpendPolicyError);
  });

  it("rejects a disallowed asset", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(() =>
      ledger.assert(
        { ...requirement, asset: "0xDEADDEADDEADDEADDEADDEADDEADDEADDEADDEAD" },
        "https://api.vrsai.tech/mcp",
      ),
    ).toThrow(VrsaiSpendPolicyError);
  });

  it("rejects a payTo outside an explicit allow-list", () => {
    const ledger = new SpendLedger({
      ...BASE_POLICY,
      allowedPayTo: ["0xffffffffffffffffffffffffffffffffffffffff"],
    });
    expect(() => ledger.assert(requirement, "https://api.vrsai.tech/mcp")).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("rejects an amount above maxAmountPerAuthorization", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(() =>
      ledger.assert({ ...requirement, amount: "2000000" }, "https://api.vrsai.tech/mcp"),
    ).toThrow(VrsaiSpendPolicyError);
  });

  it("rejects a non-integer amount", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(() =>
      ledger.assert({ ...requirement, amount: "not-a-number" }, "https://api.vrsai.tech/mcp"),
    ).toThrow(VrsaiSpendPolicyError);
  });

  it("enforces the cumulative session budget across multiple record() calls", () => {
    const ledger = new SpendLedger({ ...BASE_POLICY, maxSessionSpend: 800_000n });
    const first = ledger.assert(requirement, "https://api.vrsai.tech/mcp");
    ledger.record(first);
    expect(ledger.spentSoFar()).toBe(500_000n);
    expect(() => ledger.assert(requirement, "https://api.vrsai.tech/mcp")).toThrow(
      VrsaiSpendPolicyError,
    );
  });

  it("does not record spend merely by calling assert()", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    ledger.assert(requirement, "https://api.vrsai.tech/mcp");
    expect(ledger.spentSoFar()).toBe(0n);
  });

  it("reserve() validates and records spend atomically in one call", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    const amount = ledger.reserve(requirement, "https://api.vrsai.tech/mcp");
    expect(amount).toBe(500_000n);
    expect(ledger.spentSoFar()).toBe(500_000n);
  });

  it("reserve() throws and does not record spend when policy is violated", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    expect(() =>
      ledger.reserve({ ...requirement, amount: "2000000" }, "https://api.vrsai.tech/mcp"),
    ).toThrow(VrsaiSpendPolicyError);
    expect(ledger.spentSoFar()).toBe(0n);
  });

  it("release() gives back budget reserved by an earlier reserve()", () => {
    const ledger = new SpendLedger({ ...BASE_POLICY, maxSessionSpend: 500_000n });
    const amount = ledger.reserve(requirement, "https://api.vrsai.tech/mcp");
    ledger.release(amount);
    expect(ledger.spentSoFar()).toBe(0n);
    // Budget is available again for a second reservation.
    expect(ledger.reserve(requirement, "https://api.vrsai.tech/mcp")).toBe(500_000n);
  });

  it("release() floors at zero rather than going negative", () => {
    const ledger = new SpendLedger(BASE_POLICY);
    ledger.release(1_000_000n);
    expect(ledger.spentSoFar()).toBe(0n);
  });

  it("prevents two back-to-back reserve() calls from jointly exceeding maxSessionSpend", () => {
    // Simulates the race that assert()+await-sign()+record() could not
    // close: both "concurrent" calls attempt to reserve against a shared
    // budget that only has room for one of them.
    const ledger = new SpendLedger({ ...BASE_POLICY, maxSessionSpend: 800_000n });
    const first = ledger.reserve(requirement, "https://api.vrsai.tech/mcp");
    expect(first).toBe(500_000n);
    expect(() => ledger.reserve(requirement, "https://api.vrsai.tech/mcp")).toThrow(
      VrsaiSpendPolicyError,
    );
    // The failed second reservation must not have recorded any spend.
    expect(ledger.spentSoFar()).toBe(500_000n);
  });
});
