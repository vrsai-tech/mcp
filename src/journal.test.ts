import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentPayload } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VrsaiJournalError } from "./errors.js";
import {
  _clearJournalDirectory,
  computeRequestFingerprint,
  createFileJournal,
  createInMemoryJournal,
  type JournalEntry,
} from "./journal.js";

const PAYMENT_PAYLOAD: PaymentPayload = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "500000",
    payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    maxTimeoutSeconds: 60,
    extra: {},
  },
  payload: {},
};

const CONTEXT = { resourceUrl: "https://api.vrsai.tech/mcp", toolName: "example-tool" };

function makeAuthorizedEntry(fingerprint: string): JournalEntry {
  return {
    schemaVersion: 1,
    status: "authorized",
    fingerprint,
    resourceUrl: CONTEXT.resourceUrl,
    toolName: CONTEXT.toolName,
    signerAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
    paymentPayload: PAYMENT_PAYLOAD,
    createdAt: new Date().toISOString(),
  };
}

describe("computeRequestFingerprint", () => {
  it("is deterministic for identical inputs regardless of arg key order", () => {
    const a = computeRequestFingerprint("https://api.vrsai.tech/mcp", "tool", { a: 1, b: 2 });
    const b = computeRequestFingerprint("https://api.vrsai.tech/mcp", "tool", { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("differs when the tool name differs", () => {
    const a = computeRequestFingerprint("https://api.vrsai.tech/mcp", "tool-a", { x: 1 });
    const b = computeRequestFingerprint("https://api.vrsai.tech/mcp", "tool-b", { x: 1 });
    expect(a).not.toBe(b);
  });
});

describe("createInMemoryJournal", () => {
  it("round-trips claim/save/load/remove", async () => {
    const journal = createInMemoryJournal();
    const entry = makeAuthorizedEntry("fp-1");
    expect(await journal.load("fp-1")).toBeUndefined();
    expect(await journal.claim("fp-1", CONTEXT)).toBeUndefined();
    await journal.save(entry);
    expect(await journal.load("fp-1")).toEqual(entry);
    await journal.remove("fp-1");
    expect(await journal.load("fp-1")).toBeUndefined();
  });

  it("remove() on a missing fingerprint is a no-op", async () => {
    const journal = createInMemoryJournal();
    await expect(journal.remove("missing")).resolves.toBeUndefined();
  });

  it("returns the existing entry rather than granting a second claim", async () => {
    const journal = createInMemoryJournal();
    expect(await journal.claim("fp-race", CONTEXT)).toBeUndefined();
    const second = await journal.claim("fp-race", CONTEXT);
    expect(second?.status).toBe("pending");
    expect(second?.fingerprint).toBe("fp-race");
  });

  it("prevents two concurrent in-process claims for the same fingerprint from both winning", async () => {
    const journal = createInMemoryJournal();
    const results = await Promise.all([
      journal.claim("fp-concurrent", CONTEXT),
      journal.claim("fp-concurrent", CONTEXT),
    ]);
    const grantedCount = results.filter((r) => r === undefined).length;
    expect(grantedCount).toBe(1);
  });
});

describe("createFileJournal", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vrsai-mcp-journal-"));
  });

  afterEach(async () => {
    await _clearJournalDirectory(directory);
  });

  it("round-trips claim/save/load/remove atomically on disk", async () => {
    const journal = createFileJournal(directory);
    const entry = makeAuthorizedEntry("fp-disk-1");
    expect(await journal.load("fp-disk-1")).toBeUndefined();
    expect(await journal.claim("fp-disk-1", CONTEXT)).toBeUndefined();
    await journal.save(entry);
    expect(await journal.load("fp-disk-1")).toEqual(entry);
    await journal.remove("fp-disk-1");
    expect(await journal.load("fp-disk-1")).toBeUndefined();
  });

  it("leaves no stray temp files after a successful save", async () => {
    const journal = createFileJournal(directory);
    await journal.claim("fp-disk-2", CONTEXT);
    await journal.save(makeAuthorizedEntry("fp-disk-2"));
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(directory);
    expect(files).toEqual(["fp-disk-2.json"]);
  });

  it("a second claim for the same fingerprint returns the pending entry, never a fresh grant", async () => {
    const journal = createFileJournal(directory);
    expect(await journal.claim("fp-pending", CONTEXT)).toBeUndefined();
    const second = await journal.claim("fp-pending", CONTEXT);
    expect(second?.status).toBe("pending");
  });

  it("prevents two concurrent cross-call claims for the same fingerprint from both winning", async () => {
    const journal = createFileJournal(directory);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => journal.claim("fp-contended", CONTEXT)),
    );
    const grantedCount = results.filter((r) => r === undefined).length;
    expect(grantedCount).toBe(1);
  });

  it("refuses a corrupt (invalid JSON) journal entry rather than silently ignoring it", async () => {
    const journal = createFileJournal(directory);
    await writeFile(join(directory, "fp-corrupt.json"), "{not valid json", "utf8");
    await expect(journal.load("fp-corrupt")).rejects.toThrow(VrsaiJournalError);
  });

  it("refuses an entry whose fingerprint field does not match the requested key", async () => {
    const journal = createFileJournal(directory);
    const mismatched = makeAuthorizedEntry("some-other-fingerprint");
    await writeFile(join(directory, "fp-mismatch.json"), JSON.stringify(mismatched), "utf8");
    await expect(journal.load("fp-mismatch")).rejects.toThrow(VrsaiJournalError);
  });

  it("refuses a structurally malformed entry (missing required fields)", async () => {
    const journal = createFileJournal(directory);
    await writeFile(
      join(directory, "fp-malformed.json"),
      JSON.stringify({ fingerprint: "fp-malformed" }),
      "utf8",
    );
    await expect(journal.load("fp-malformed")).rejects.toThrow(VrsaiJournalError);
  });

  it("refuses an entry with an unrecognized schemaVersion", async () => {
    const journal = createFileJournal(directory);
    await writeFile(
      join(directory, "fp-future.json"),
      JSON.stringify({ ...makeAuthorizedEntry("fp-future"), schemaVersion: 999 }),
      "utf8",
    );
    await expect(journal.load("fp-future")).rejects.toThrow(VrsaiJournalError);
  });

  it("refuses to read a symlink placed at the expected entry path", async () => {
    const journal = createFileJournal(directory);
    const decoyTarget = join(directory, "decoy.json");
    await writeFile(decoyTarget, JSON.stringify(makeAuthorizedEntry("fp-symlink")), "utf8");
    await symlink(decoyTarget, join(directory, "fp-symlink.json"));
    await expect(journal.load("fp-symlink")).rejects.toThrow(VrsaiJournalError);
  });

  it("simulates a crash mid-write: a leftover temp file must not be read as a valid entry", async () => {
    const journal = createFileJournal(directory);
    await journal.claim("fp-crash", CONTEXT);
    await journal.save(makeAuthorizedEntry("fp-crash"));
    // Simulate a crash during a subsequent write: temp file exists, rename never happened.
    await writeFile(join(directory, "fp-crash.json.99999.123.tmp"), "garbage", "utf8");
    const loaded = await journal.load("fp-crash");
    expect(loaded?.fingerprint).toBe("fp-crash");
    const raw = await readFile(join(directory, "fp-crash.json"), "utf8");
    expect(JSON.parse(raw).fingerprint).toBe("fp-crash");
  });

  it.skipIf(process.platform === "win32")(
    "refuses to use a pre-existing group- or world-accessible journal directory",
    async () => {
      await chmod(directory, 0o777);
      const journal = createFileJournal(directory);
      await expect(journal.claim("fp-insecure", CONTEXT)).rejects.toThrow(VrsaiJournalError);
    },
  );
});
