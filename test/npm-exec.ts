/**
 * Portable helper for invoking the `npm` CLI from Node's `child_process`
 * APIs, shared by this package's release/packaging qualification helpers
 * (`pack-inspect.ts`, `tarball-smoke.ts`).
 *
 * On POSIX, `npm` on `PATH` is a real executable (or a symlink to one) and
 * can be launched directly with `execFileSync`, no shell involved. On
 * Windows, `npm` on `PATH` is `npm.cmd` — a `.cmd` launcher script, which
 * only `cmd.exe` knows how to resolve and execute. Win32's
 * `CreateProcess`-style APIs (what `execFileSync`/`spawnSync` use when
 * `shell` is not set) cannot execute a `.cmd` file directly, which is why
 * `execFileSync("npm", ...)` fails with `ENOENT` on Windows even though
 * `npm` is genuinely on `PATH`.
 *
 * The fix is not `shell: true`: this repository never wants an implicit
 * shell-parsing step, even though every argument these packaging helpers
 * ever pass to `npm` is a repository-owned constant, never user-controlled
 * input. Instead, on Windows, `npm` is invoked explicitly through
 * `cmd.exe /d /s /c`, with the full `npm` command line built and quoted by
 * this module (not left to an implicit shell) before being handed to
 * `execFileSync` as a single argument.
 */
import { execFileSync } from "node:child_process";

/** Quotes one argument for safe inclusion in a `cmd.exe /c` command line.
 * `cmd.exe`'s own parsing (distinct from the `CommandLineToArgvW`
 * convention most native Windows programs use) governs this string:
 * wrapping in double quotes and doubling any embedded double quote is
 * sufficient for the small, repository-owned, constant argument set these
 * packaging helpers ever pass (plain flags and filesystem paths — never
 * attacker- or user-controlled input). */
export function quoteForCmd(value: string): string {
  if (value === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Resolves the concrete `{ command, args }` to hand to `execFileSync` for
 * `npm <args>`, without actually running it — separated from the I/O call
 * so it can be unit-tested deterministically for both platforms regardless
 * of which platform the test itself runs on. `platform` defaults to the
 * real `process.platform` and only needs to be overridden by tests. */
export function resolveNpmCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
  if (platform === "win32") {
    const comSpec = process.env.ComSpec ?? "cmd.exe";
    const commandLine = ["npm", ...args].map(quoteForCmd).join(" ");
    // /d: skip any AutoRun registry command. /s: honor the quoting of the
    // whole command-line string that follows /c verbatim, rather than
    // cmd.exe's usual (surprising) quote-stripping heuristics.
    return { command: comSpec, args: ["/d", "/s", "/c", commandLine] };
  }
  return { command: "npm", args: [...args] };
}

export interface NpmExecOptions {
  readonly cwd?: string;
  readonly stdio?: "pipe" | "inherit";
}

/**
 * Runs `npm <args>` synchronously and returns its captured stdout as a
 * UTF-8 string, portably across POSIX and Windows (see this module's
 * top-of-file doc comment for why a plain `execFileSync("npm", ...)` does
 * not work on Windows).
 */
export function execNpmSync(args: readonly string[], options: NpmExecOptions = {}): string {
  const resolved = resolveNpmCommand(args);
  return execFileSync(resolved.command, [...resolved.args], {
    cwd: options.cwd,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
  });
}
