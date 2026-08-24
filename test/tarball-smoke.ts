/**
 * Tarball consumer smoke test for `@vrsai/mcp` (Phase 20).
 *
 * Builds the real publish tarball with `npm pack`, installs it into an
 * isolated temporary consumer project (no workspace/monorepo resolution),
 * and proves three things that `test/pack-inspect.ts` alone cannot:
 *
 * 1. The published package can actually be installed and its public entry
 *    point imported and constructed from compiled `dist/` output — not
 *    from `src/` under a test runner.
 * 2. The `vrsai-mcp` CLI binary, run from the installed tarball with no
 *    signer configured (discovery-only mode), completes a real MCP stdio
 *    initialize handshake.
 *
 * Deliberately makes no network call and no payment: client construction
 * and the CLI's discovery-only stdio handshake do not require reaching the
 * remote vrsai endpoint (see `client.ts`'s lazy `remoteCaller()`), so this
 * test is safe to run in normal CI with no network access.
 *
 * Two modes:
 * - `node --experimental-strip-types test/tarball-smoke.ts` (no argument):
 *   the local developer path used by `pnpm run check` — builds a fresh
 *   tarball with `npm pack`.
 * - `node --experimental-strip-types test/tarball-smoke.ts <path-to-tgz>`:
 *   the release path used by `release.yml` — installs and smoke-tests the
 *   *exact* already-built candidate tarball, so the bytes qualified are the
 *   same bytes that get staged and published.
 *
 * Invoked directly with `node --experimental-strip-types test/tarball-smoke.ts`
 * (see `package.json`'s `test:tarball` script), matching the style of
 * `test/pack-inspect.ts` and `test/boundary-check.ts`. Assumes `pnpm run
 * build` has already produced `dist/` (as `verify:package` does).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execNpmSync } from "./npm-exec.ts";

const REPO_ROOT = process.cwd();

function packTarball(destDir: string): string {
  const raw = execNpmSync(["pack", "--silent", "--pack-destination", destDir], {
    cwd: REPO_ROOT,
  }).trim();
  const fileName = raw.split("\n").at(-1);
  if (!fileName) throw new Error("npm pack produced no output filename.");
  return join(destDir, fileName);
}

function installIntoConsumer(consumerDir: string, tarballPath: string): void {
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "vrsai-mcp-tarball-smoke", version: "0.0.0", private: true }, null, 2),
  );
  execNpmSync(["install", "--silent", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumerDir,
  });
}

async function verifyEntryPoint(consumerDir: string): Promise<void> {
  const script = `
    import { createVrsaiClient, DEFAULT_MCP_RESOURCE_URL, VrsaiMcpError } from "@vrsai/mcp";
    if (typeof createVrsaiClient !== "function") {
      throw new Error("createVrsaiClient export is missing or not a function.");
    }
    if (typeof VrsaiMcpError !== "function") {
      throw new Error("VrsaiMcpError export is missing or not a function.");
    }
    const client = createVrsaiClient({ endpointUrl: DEFAULT_MCP_RESOURCE_URL });
    if (typeof client.listTools !== "function" || typeof client.call !== "function") {
      throw new Error("Constructed client is missing expected methods.");
    }
    // No network call: close() before any listTools()/call() is a no-op.
    await client.close();
    console.log("tarball-smoke: entry point OK");
  `;
  const scriptPath = join(consumerDir, "entry-check.mjs");
  writeFileSync(scriptPath, script);
  execFileSync(process.execPath, [scriptPath], { cwd: consumerDir, stdio: "inherit" });
}

async function verifyCliStdioHandshake(consumerDir: string): Promise<void> {
  const cliPath = join(consumerDir, "node_modules", "@vrsai", "mcp", "dist", "bin", "vrsai-mcp.js");
  const isolatedHome = mkdtempSync(join(tmpdir(), "vrsai-mcp-smoke-home-"));
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        // Deliberately no VRSAI_MCP_SIGNER_PRIVATE_KEY: discovery-only mode,
        // which never attempts a network connection during the handshake.
      },
    });
    const client = new Client({ name: "vrsai-mcp-tarball-smoke", version: "0.0.0" });
    await client.connect(transport);
    await client.close();
    console.log("tarball-smoke: CLI stdio handshake OK");
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "vrsai-mcp-tarball-smoke-"));
  const consumerDir = join(workDir, "consumer");
  mkdirSync(consumerDir);
  try {
    const providedTarball = process.argv[2];
    const tarballPath = providedTarball
      ? resolve(REPO_ROOT, providedTarball)
      : packTarball(workDir);
    installIntoConsumer(consumerDir, tarballPath);
    await verifyEntryPoint(consumerDir);
    await verifyCliStdioHandshake(consumerDir);
    console.log("@vrsai/mcp tarball-smoke check passed.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("@vrsai/mcp tarball-smoke check failed:\n");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
