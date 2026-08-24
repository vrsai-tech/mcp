/**
 * Publish-tarball hygiene check for `@vrsai/mcp` (item 27).
 *
 * Asserts the exact set of files that would ship to npm consumers: only the
 * built `dist/` output, `README.md`, `LICENSE`, and `package.json` — never
 * source `.ts`, test files, or stray repository/dev-tooling artifacts.
 *
 * Two modes:
 * - `node --experimental-strip-types test/pack-inspect.ts` (no argument):
 *   the local developer path used by `pnpm run check` — runs
 *   `npm pack --dry-run --json` against the working directory.
 * - `node --experimental-strip-types test/pack-inspect.ts <path-to-tgz>`:
 *   the release path used by `release.yml` — inspects the *exact*
 *   already-built candidate tarball's real contents (`tar -tzf`) rather
 *   than creating a new pack, so the bytes qualified are the same bytes
 *   that get staged and published.
 */
import { execFileSync } from "node:child_process";

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackedFile[];
}

/** Pure invariant check, separated from the `npm pack` subprocess call so it
 * can be exercised with synthetic fixtures if this check ever needs its own
 * unit tests. */
export function checkPackedFiles(paths: readonly string[]): readonly string[] {
  const failures: string[] = [];
  const allowedRoots = ["dist/", "README.md", "LICENSE", "package.json"];

  for (const path of paths) {
    const allowed = allowedRoots.some((root) => path === root || path.startsWith(root));
    if (!allowed) {
      failures.push(`Unexpected file in published tarball: "${path}".`);
      continue;
    }
    if (/\.test\.(js|d\.ts|ts)$/.test(path)) {
      failures.push(`Test file leaked into published tarball: "${path}".`);
    }
  }

  const requiredFiles = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/bin/vrsai-mcp.js",
    "README.md",
    "LICENSE",
    "package.json",
  ];
  for (const required of requiredFiles) {
    if (!paths.includes(required)) {
      failures.push(`Required file missing from published tarball: "${required}".`);
    }
  }

  return failures;
}

function runNpmPackDryRun(): PackResult {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
  });
  const jsonStart = raw.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`npm pack --dry-run --json produced no JSON output:\n${raw}`);
  }
  const parsed = JSON.parse(raw.slice(jsonStart)) as readonly PackResult[];
  const result = parsed[0];
  if (!result) {
    throw new Error("npm pack --dry-run --json produced an empty result array.");
  }
  return result;
}

/** Lists the real entries of an already-built tarball, without repacking. */
function listFilesFromTarball(tarballPath: string): readonly string[] {
  const raw = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  return (
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // npm tarballs nest every entry under a single "package/" root.
      .map((line) => line.replace(/^package\//, ""))
      .filter((line) => line.length > 0)
  );
}

function main(): void {
  const tarballPath = process.argv[2];
  const paths = tarballPath
    ? listFilesFromTarball(tarballPath)
    : runNpmPackDryRun().files.map((file) => file.path);
  const failures = checkPackedFiles(paths);

  if (failures.length > 0) {
    console.error("@vrsai/mcp pack-inspect check failed:\n");
    for (const failure of failures) {
      console.error(`- ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `@vrsai/mcp pack-inspect check passed: ${paths.length} file(s) in the published tarball.`,
  );
}

main();
