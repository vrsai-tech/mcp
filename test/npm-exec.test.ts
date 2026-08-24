import { describe, expect, it } from "vitest";
import { quoteForCmd, resolveNpmCommand } from "./npm-exec.ts";

describe("quoteForCmd", () => {
  it("leaves a plain argument unquoted", () => {
    expect(quoteForCmd("pack")).toBe("pack");
  });

  it("quotes an argument containing whitespace", () => {
    expect(quoteForCmd("has space")).toBe('"has space"');
  });

  it("escapes an embedded double quote by doubling it", () => {
    expect(quoteForCmd('a"b')).toBe('"a""b"');
  });

  it("quotes an empty string", () => {
    expect(quoteForCmd("")).toBe('""');
  });

  it("quotes an argument containing a cmd.exe metacharacter", () => {
    expect(quoteForCmd("a&b")).toBe('"a&b"');
  });
});

describe("resolveNpmCommand", () => {
  it("invokes npm directly on POSIX platforms, with no shell", () => {
    const resolved = resolveNpmCommand(["pack", "--dry-run", "--json"], "linux");
    expect(resolved).toEqual({ command: "npm", args: ["pack", "--dry-run", "--json"] });
  });

  it("invokes npm directly on macOS, with no shell", () => {
    const resolved = resolveNpmCommand(["install", "--silent"], "darwin");
    expect(resolved).toEqual({ command: "npm", args: ["install", "--silent"] });
  });

  it("invokes npm through cmd.exe on Windows, never npm.cmd directly", () => {
    const resolved = resolveNpmCommand(["pack", "--dry-run", "--json"], "win32");
    expect(resolved.command).toBe(process.env.ComSpec ?? "cmd.exe");
    expect(resolved.args).toEqual(["/d", "/s", "/c", "npm pack --dry-run --json"]);
  });

  it("quotes a path argument containing whitespace inside the Windows command line", () => {
    const resolved = resolveNpmCommand(["--pack-destination", "C:\\some path\\dest"], "win32");
    expect(resolved.args.at(-1)).toBe('npm --pack-destination "C:\\some path\\dest"');
  });

  it("never delegates to a shell-interpreted string on POSIX regardless of argument content", () => {
    const resolved = resolveNpmCommand(["install", "a package with spaces.tgz"], "linux");
    // Each element stays a discrete argv entry — no command-line string is
    // ever built (and therefore nothing to re-parse) on POSIX.
    expect(resolved.args).toEqual(["install", "a package with spaces.tgz"]);
  });
});
