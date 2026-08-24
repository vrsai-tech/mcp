import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads this package's own `version` field from `package.json` at runtime
 * (never a static JSON module import, so this works identically from
 * `src/` under a test runner and from compiled `dist/` after publish,
 * without special-casing `tsconfig.build.json`'s `rootDir`). This is the
 * single source of truth for the client/bridge identity advertised over
 * the wire — no version string is ever hardcoded a second time.
 */
function readPackageVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(fileURLToPath(packageJsonUrl), "utf8");
  } catch (error) {
    throw new Error(`Failed to read package.json for version discovery: ${String(error)}`);
  }
  const parsed = JSON.parse(raw) as { readonly version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing a valid string 'version' field.");
  }
  return parsed.version;
}

/** This package's own version, as published to npm. Used as the default
 * MCP client/bridge `version` identity instead of a hardcoded string. */
export const PACKAGE_VERSION: string = readPackageVersion();
