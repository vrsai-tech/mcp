/**
 * Repository boundary check for `@vrsai/mcp`.
 *
 * This package is a standalone buyer-side client for the vrsai remote MCP
 * server. Per `AGENTS.md`'s capability-isolation doctrine, it must never
 * depend on the server-side repository internals (`src/**`, `scripts/**`)
 * — it talks to the remote server exclusively over the wire (HTTP/MCP/
 * x402), the same way any external consumer would. This is a deliberately
 * lightweight regex-based import scan (same style as
 * `scripts/check-commercial-kernel-boundary.ts`), not a full module
 * resolver.
 *
 * Invoked directly with `node --experimental-strip-types test/boundary-check.ts`
 * (see `package.json`'s `check:boundary` script) rather than through
 * vitest, so it can run as a fast standalone gate without pulling in the
 * vitest runtime, and so vitest's own test-file glob does not try (and
 * fail) to treat this script as a test suite.
 */
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

// Repo-relative (not absolute-filesystem) paths, matching
// `scripts/check-commercial-kernel-boundary.ts`'s style. Assumes this
// script is invoked with `packages/mcp` as the working directory, which is
// how `package.json`'s `check:boundary` script runs it.
const SRC_ROOT = "src";

const IMPORT_SPECIFIER_PATTERN = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

function extractImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function collectTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Pure invariant check, separated from file I/O so it can be exercised with
 * synthetic fixtures if this check ever needs its own unit tests.
 *
 * `path` and every relative import specifier are repo-relative to
 * `packageRoot` (e.g. `"src/client.ts"` importing `"./errors.js"`). A
 * specifier escapes the package boundary once its resolved path climbs
 * above `packageRoot` — i.e. the normalized result starts with `"../"`.
 */
export function checkMcpPackageBoundary(files: ReadonlyMap<string, string>): readonly string[] {
  const failures: string[] = [];
  for (const [path, content] of files) {
    for (const specifier of extractImportSpecifiers(content)) {
      if (!specifier.startsWith(".")) continue; // npm package imports are fine.
      const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (resolved === ".." || resolved.startsWith("../")) {
        failures.push(
          `${path}: imports "${specifier}" (resolves to "${resolved}"), which escapes the ` +
            "package directory. @vrsai/mcp must not depend on the parent repository's " +
            "src/, scripts/, or any other sibling directory — it only talks to the " +
            "remote server over the wire, like any external consumer.",
        );
      }
    }
  }
  return failures;
}

function main(): void {
  const files = new Map<string, string>();
  for (const path of collectTypeScriptFiles(SRC_ROOT)) {
    files.set(path, readFileSync(path, "utf8"));
  }

  const failures = checkMcpPackageBoundary(files);

  if (failures.length > 0) {
    console.error("@vrsai/mcp repository-boundary check failed:\n");
    for (const failure of failures) {
      console.error(`- ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `@vrsai/mcp repository-boundary check passed: ${files.size} file(s) scanned, ` +
      "no import escapes the package directory.",
  );
}

main();
