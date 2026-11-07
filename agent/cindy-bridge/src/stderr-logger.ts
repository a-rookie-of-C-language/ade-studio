import type { Logger, LogLevel } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";

/**
 * bridge 日志：一律写 stderr。stdout 是 NDJSON 帧通道，任何日志混入都会破坏 Rust 侧成帧。
 */
function write(level: LogLevel, scope: string, msg: string, ctx?: Record<string, unknown>): void {
  const line = ctx ? `[${scope}] [${level}] ${msg} ${JSON.stringify(ctx)}` : `[${scope}] [${level}] ${msg}`;
  process.stderr.write(`${line}\n`);
}

export function createStderrLogger(scope = "cindy-bridge"): Logger {
  const make =
    (level: LogLevel) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      write(level, scope, msg, ctx);
    };
  return {
    trace: make("trace"),
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    fatal: make("fatal"),
    child(sub: string): Logger {
      return createStderrLogger(`${scope}/${sub}`);
    },
  };
}
