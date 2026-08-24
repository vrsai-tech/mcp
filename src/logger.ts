/**
 * Stderr-only logger. The stdio bridge (`bin/vrsai-mcp.ts`) speaks the MCP
 * protocol on stdout — anything else written there corrupts the wire
 * stream. Every diagnostic message in this package, including from the
 * programmatic client, goes through here rather than `console.log`.
 */
export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

function write(level: string, message: string, details?: Record<string, unknown>): void {
  const line = details ? `${message} ${JSON.stringify(details)}` : message;
  process.stderr.write(`[vrsai-mcp] ${level}: ${line}\n`);
}

export const stderrLogger: Logger = {
  info: (message, details) => write("info", message, details),
  warn: (message, details) => write("warn", message, details),
  error: (message, details) => write("error", message, details),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
