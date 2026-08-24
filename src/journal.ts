import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaymentPayload } from "@x402/core/types";
import { stableJson } from "./canonical-json.js";
import { VrsaiJournalError } from "./errors.js";

/** `fs.constants.O_NOFOLLOW` is POSIX-specific: Node/libuv does not honor it
 * on Windows (a symlink at the target path is silently followed rather than
 * rejected). Feature-detect it rather than assume it is always defined, and
 * fall back to `0` (no-op flag) where it is not — the portable defense
 * against symlinks is the explicit `lstat`-based checks below, not this
 * flag. Kept as POSIX defense-in-depth per the journal's design invariants. */
const NOFOLLOW_FLAG = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

/** Default on-disk location for the crash-safe payment journal. Overridable
 * via {@link createFileJournal}'s `directory` argument (e.g. for tests or
 * multi-tenant hosts). */
export function defaultJournalDirectory(): string {
  return join(homedir(), ".vrsai", "mcp", "journal");
}

/** Bumped whenever {@link JournalEntry}'s on-disk shape changes in a way
 * that is not backward-compatible. A journal entry written by a future,
 * incompatible version of this package is refused rather than
 * misinterpreted. */
export const JOURNAL_SCHEMA_VERSION = 1 as const;

/** Bound on-disk journal entry reads so a corrupt or hostile file at the
 * expected path cannot exhaust memory; real entries are well under 8 KiB. */
const MAX_ENTRY_BYTES = 64 * 1024;

/**
 * A journal entry for one logical purchase attempt (identified by
 * {@link computeRequestFingerprint}).
 *
 * - `"pending"` — this fingerprint has been exclusively claimed (see
 *   {@link PaymentJournal.claim}) for a new authorization attempt, but
 *   nothing has been signed yet. Only ever exists for the brief window
 *   between claiming a fingerprint and either signing (which transitions it
 *   to `"authorized"` via {@link PaymentJournal.save}) or aborting (which
 *   removes it via {@link PaymentJournal.remove}).
 * - `"authorized"` — a payment has been signed and durably journaled for
 *   this fingerprint, bound to the exact signer (`signerAddress`) that
 *   created it. Retained only while its economic effect is unresolved:
 *   removed on delivery or on a definitive (non-`UNKNOWN`) failure — never
 *   removed merely because a retry attempt failed to reach the network.
 */
export type JournalEntry =
  | {
      readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
      readonly status: "pending";
      readonly fingerprint: string;
      readonly resourceUrl: string;
      readonly toolName: string;
      readonly createdAt: string;
    }
  | {
      readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
      readonly status: "authorized";
      readonly fingerprint: string;
      readonly resourceUrl: string;
      readonly toolName: string;
      /** Lower-cased `0x` address of the signer that created this
       * authorization. A journal entry may only ever be resumed by the
       * same signer — see `client.ts`'s signer-binding check. */
      readonly signerAddress: string;
      readonly paymentPayload: PaymentPayload;
      readonly createdAt: string;
    };

/** Computes a stable identity for one logical purchase attempt: the exact
 * resource, tool, and arguments being paid for. Reusing this fingerprint
 * across a crash/retry is what lets the journal resume the same
 * authorization instead of risking a duplicate one. */
export function computeRequestFingerprint(
  resourceUrl: string,
  toolName: string,
  args: unknown,
): string {
  return createHash("sha256").update(stableJson({ resourceUrl, toolName, args })).digest("hex");
}

export interface PaymentJournal {
  /**
   * Atomically claims `fingerprint` for a new authorization attempt.
   *
   * Returns `undefined` when this call itself created the claim: the
   * caller now exclusively owns this fingerprint until it calls `save()`
   * (to durably journal a signed authorization) or `remove()` (to abandon
   * the claim, e.g. because signing itself failed). Returns the existing
   * entry (`"pending"` or `"authorized"`) when one already exists — created
   * either by a concurrent in-process call or a concurrent OS process — so
   * the caller can resume/fail-closed instead of creating a second,
   * distinct authorization for the same logical purchase.
   *
   * Implementations MUST make the claim-or-return decision atomically
   * (e.g. `O_CREAT|O_EXCL` on a file backend, or a synchronous
   * check-and-set with no `await` in between on an in-memory backend) —
   * never read-then-write.
   */
  claim(
    fingerprint: string,
    context: { readonly resourceUrl: string; readonly toolName: string },
  ): Promise<JournalEntry | undefined>;
  load(fingerprint: string): Promise<JournalEntry | undefined>;
  /** Transitions a claimed `"pending"` entry to `"authorized"` (or refreshes
   * an already-`"authorized"` one). Only the holder of the corresponding
   * `claim()` may call this for a given fingerprint. */
  save(entry: JournalEntry): Promise<void>;
  remove(fingerprint: string): Promise<void>;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.schemaVersion !== JOURNAL_SCHEMA_VERSION) return false;
  if (
    typeof entry.fingerprint !== "string" ||
    typeof entry.resourceUrl !== "string" ||
    typeof entry.toolName !== "string" ||
    typeof entry.createdAt !== "string"
  ) {
    return false;
  }
  if (entry.status === "pending") return true;
  if (entry.status === "authorized") {
    return (
      typeof entry.signerAddress === "string" &&
      entry.signerAddress.length > 0 &&
      entry.paymentPayload !== undefined &&
      typeof entry.paymentPayload === "object"
    );
  }
  return false;
}

/**
 * Proves, using the strongest portable file-identity fields Node exposes
 * (`dev`+`ino`), that `postOpenLstat` — an `lstat` of a journal entry path
 * taken immediately *after* opening it — still refers to the exact file
 * behind the already-open handle described by `openedHandleStat` (an
 * `fstat` of that handle). This is what closes the TOCTOU window a naive
 * `lstat()` → `readFile(path)` sequence would leave open: `lstat` and
 * `open`/`read` never inspect the same object unless this check also
 * passes.
 *
 * `dev`+`ino` are POSIX inode-identity fields; Node populates equivalent
 * (volume-serial + file-index) values on Windows/NTFS, but that mapping is
 * not guaranteed universal across every platform or filesystem. Rather
 * than pretend it always is, this fails closed — refusing to trust the
 * entry — whenever either value looks degenerate (`0n`) instead of
 * silently skipping the proof.
 *
 * Exported only for this module's own tests (deterministic, without
 * needing to win a real filesystem race) — never part of the package's
 * public API surface (not re-exported from `index.ts`).
 */
export function assertStableFileIdentity(
  openedHandleStat: BigIntStats,
  postOpenLstat: BigIntStats,
): void {
  if (postOpenLstat.isSymbolicLink() || !postOpenLstat.isFile()) {
    throw new VrsaiJournalError(
      "Payment journal entry path no longer refers to a regular file immediately after " +
        "opening it. Refusing to trust it.",
    );
  }
  if (
    openedHandleStat.dev === 0n ||
    openedHandleStat.ino === 0n ||
    postOpenLstat.dev === 0n ||
    postOpenLstat.ino === 0n
  ) {
    throw new VrsaiJournalError(
      "This platform or filesystem does not expose stable file-identity fields for the " +
        "payment journal entry. Refusing to trust it.",
    );
  }
  if (openedHandleStat.dev !== postOpenLstat.dev || openedHandleStat.ino !== postOpenLstat.ino) {
    throw new VrsaiJournalError(
      "Payment journal entry path was replaced between opening it and verifying it " +
        "(possible symlink or file-replacement attack). Refusing to trust it.",
    );
  }
}

/**
 * File-based journal storing at most one entry per fingerprint. Every write
 * — the initial claim and every subsequent update — goes through an
 * OS-atomic primitive so a crash or a racing process can never observe a
 * torn file or create a second authorization for the same fingerprint:
 *
 * - The initial claim uses exclusive creation (`O_CREAT|O_EXCL`): the OS
 *   guarantees at most one caller, in this process or another, ever wins
 *   the create for a given path.
 * - Every subsequent update writes to a fresh, uniquely named sibling file
 *   (also created with `O_CREAT|O_EXCL`) and durably `rename()`s it over
 *   the target, which POSIX guarantees is atomic — readers only ever see
 *   the old complete content or the new complete content, never a mix.
 * - Every read is guarded, portably, against symlinks and non-regular
 *   files: the entry path is `lstat`ed *before* opening (rejecting a
 *   symlink or non-regular dirent outright), opened with `O_NOFOLLOW` as
 *   POSIX defense-in-depth (a no-op flag on Windows, where it is not
 *   honored), then — after opening — the already-open handle is `fstat`ed
 *   and the path is `lstat`ed *again* and compared for stable file
 *   identity (`dev`+`ino`) against the opened handle. This proves the path
 *   still refers to the exact file that was opened without ever trusting a
 *   bare `lstat()` → `readFile(path)` sequence, which would leave an
 *   unguarded TOCTOU window between the check and the read.
 * - Reads are bounded to {@link MAX_ENTRY_BYTES}, using `fstat` on the
 *   already-open file descriptor (no separate `stat`-then-`read` race).
 * - Every write calls `fsync` on the file (and, best-effort, on the
 *   containing directory after a rename) before returning, so a crash
 *   immediately after `save()` resolves cannot lose the write to page
 *   cache.
 *
 * The private key is never part of a journal entry; only the
 * already-signed payment payload is persisted.
 */
export function createFileJournal(directory: string = defaultJournalDirectory()): PaymentJournal {
  const entryPath = (fingerprint: string): string => join(directory, `${fingerprint}.json`);

  async function ensureDirectory(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // `mkdir` only applies `mode` when it creates the directory — it never
    // repairs the permissions of one that already existed. POSIX mode bits
    // are not a meaningful signal on Windows, so this check is skipped
    // there rather than risk a false positive against a directory that is
    // secure under that platform's own ACL model.
    if (process.platform !== "win32") {
      const info = await stat(directory);
      if ((info.mode & 0o077) !== 0) {
        throw new VrsaiJournalError(
          `Payment journal directory "${directory}" is group- or world-accessible ` +
            `(mode ${(info.mode & 0o777).toString(8).padStart(3, "0")}). Refusing to store ` +
            "payment authorizations there — chmod it to 0700 or point PaymentJournal at a private directory.",
        );
      }
    }
  }

  async function fsyncDirectoryBestEffort(): Promise<void> {
    try {
      const dirHandle = await open(directory, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Best-effort only: some platforms/filesystems (notably Windows)
      // cannot open or fsync a directory. The per-file fsync above already
      // makes each file's own contents crash-safe; this only strengthens
      // durability of the directory-entry update itself.
    }
  }

  /** Rejects `stats` (from either `lstat` or an already-open handle's
   * `fstat`) unless it describes a plain regular file — never a symlink,
   * directory, FIFO, device, or anything else. Used both before opening an
   * entry path (via `lstat`) and after opening it (via `fstat` on the
   * handle), so a symlink or non-regular dirent is refused at every point
   * this function is called. */
  function assertRegularNonSymlink(stats: BigIntStats, when: string): void {
    if (stats.isSymbolicLink()) {
      throw new VrsaiJournalError(
        `Payment journal entry path is a symlink, which is never trusted. Refusing to read it (${when}).`,
      );
    }
    if (!stats.isFile()) {
      throw new VrsaiJournalError(
        `Payment journal entry path is not a regular file. Refusing to read it (${when}).`,
      );
    }
  }

  async function readEntryFile(
    path: string,
    expectedFingerprint: string,
  ): Promise<JournalEntry | undefined> {
    let preOpenLstat: BigIntStats;
    try {
      preOpenLstat = await lstat(path, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw new VrsaiJournalError(`Failed to read payment journal entry: ${String(error)}`);
    }
    assertRegularNonSymlink(preOpenLstat, "before opening it");

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (code === "ELOOP") {
        throw new VrsaiJournalError(
          "Payment journal entry path is a symlink, which is never trusted. Refusing to read it.",
        );
      }
      throw new VrsaiJournalError(`Failed to read payment journal entry: ${String(error)}`);
    }
    try {
      const handleStat = await handle.stat({ bigint: true });
      assertRegularNonSymlink(handleStat, "after opening it");

      let postOpenLstat: BigIntStats;
      try {
        postOpenLstat = await lstat(path, { bigint: true });
      } catch (error) {
        throw new VrsaiJournalError(
          "Payment journal entry path disappeared or became unreadable immediately after " +
            `opening it: ${String(error)}`,
        );
      }
      assertStableFileIdentity(handleStat, postOpenLstat);

      if (handleStat.size > BigInt(MAX_ENTRY_BYTES)) {
        throw new VrsaiJournalError(
          `Payment journal entry exceeds the safe read bound of ${MAX_ENTRY_BYTES} bytes.`,
        );
      }
      const buffer = Buffer.alloc(Number(handleStat.size));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const raw = buffer.subarray(0, offset).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new VrsaiJournalError(
          "Payment journal entry is corrupt (invalid JSON). Refusing to proceed — " +
            "manual inspection is required before this fingerprint can be retried.",
        );
      }
      if (!isJournalEntry(parsed) || parsed.fingerprint !== expectedFingerprint) {
        throw new VrsaiJournalError(
          "Payment journal entry is malformed or mismatched. Refusing to proceed.",
        );
      }
      return parsed;
    } finally {
      await handle.close();
    }
  }

  async function writeEntryFileExclusive(path: string, entry: JournalEntry): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new VrsaiJournalError(
        `Failed to create payment journal file (${code ?? "unknown"}): ${String(error)}`,
      );
    }
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  return {
    async claim(fingerprint, context) {
      await ensureDirectory();
      const target = entryPath(fingerprint);
      const pending: JournalEntry = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        status: "pending",
        fingerprint,
        resourceUrl: context.resourceUrl,
        toolName: context.toolName,
        createdAt: new Date().toISOString(),
      };
      try {
        await writeEntryFileExclusive(target, pending);
      } catch (error) {
        // writeEntryFileExclusive always wraps into VrsaiJournalError,
        // annotated with the original errno code — inspect it to
        // distinguish "already claimed" (EEXIST — not a failure, just
        // contention) from a genuine failure.
        if (error instanceof VrsaiJournalError && error.message.includes("(EEXIST)")) {
          return await readEntryFile(target, fingerprint);
        }
        throw error;
      }
      await fsyncDirectoryBestEffort();
      return undefined;
    },

    async load(fingerprint) {
      await ensureDirectory();
      return await readEntryFile(entryPath(fingerprint), fingerprint);
    },

    async save(entry) {
      await ensureDirectory();
      const target = entryPath(entry.fingerprint);
      const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeEntryFileExclusive(temp, entry);
      await rename(temp, target);
      await fsyncDirectoryBestEffort();
    },

    async remove(fingerprint) {
      try {
        await unlink(entryPath(fingerprint));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new VrsaiJournalError(`Failed to remove payment journal entry: ${String(error)}`);
        }
      }
    },
  };
}

/** In-memory journal for tests and for callers who explicitly opt out of
 * on-disk crash safety (single-shot scripts, ephemeral sandboxes).
 * `claim()` is a synchronous check-and-set with no `await` in between, so
 * it is atomic against concurrent in-process callers by Node's
 * single-threaded execution model — it provides no cross-process
 * guarantee, which is why {@link createFileJournal} exists for real use. */
export function createInMemoryJournal(): PaymentJournal {
  const entries = new Map<string, JournalEntry>();
  return {
    async claim(fingerprint, context) {
      const existing = entries.get(fingerprint);
      if (existing) return existing;
      entries.set(fingerprint, {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        status: "pending",
        fingerprint,
        resourceUrl: context.resourceUrl,
        toolName: context.toolName,
        createdAt: new Date().toISOString(),
      });
      return undefined;
    },
    async load(fingerprint) {
      return entries.get(fingerprint);
    },
    async save(entry) {
      entries.set(entry.fingerprint, entry);
    },
    async remove(fingerprint) {
      entries.delete(fingerprint);
    },
  };
}

/** Test/ops utility: deletes the entire journal directory. Not exported
 * from the package's public API — destructive and only meant for harness
 * cleanup. */
export async function _clearJournalDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
