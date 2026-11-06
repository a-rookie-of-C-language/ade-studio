import { createInterface } from "node:readline";
import { ClaudeCodeAgent } from "../../../third-party/cindy-agent/maker-core/agents/claude-code/index.js";
import { CindyBridge, resolvePermissionTimeoutMs } from "./bridge.js";
import { EXIT_MISSING_DEPS, buildLocalDeps } from "./deps.js";
import { createStderrLogger } from "./stderr-logger.js";

/** stdout 写（带背压等待；帧通道，失败直接抛给调用方）。 */
function writeStdout(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    try {
      const ok = process.stdout.write(`${line}\n`, (err) => done(err ?? undefined));
      if (!ok) process.stdout.once("drain", () => done());
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * bridge 入口（被 `index.js` 在注册 raw-loader 后动态 import）。
 * 返回进程退出码：0 正常，2 缺 `claude` CLI（B4 明确报错），1 其它致命错误。
 */
export async function main(): Promise<number> {
  const logger = createStderrLogger();
  let deps: ReturnType<typeof buildLocalDeps>;
  try {
    deps = buildLocalDeps(logger);
  } catch (err) {
    logger.fatal(err instanceof Error ? err.message : String(err));
    return EXIT_MISSING_DEPS;
  }
  logger.info("cindy-bridge starting", { binaryPath: deps.binaryPath });

  const bridge = new CindyBridge({
    createAgent: (agentDeps) => new ClaudeCodeAgent(agentDeps),
    deps: deps.deps,
    logger,
    permissionTimeoutMs: resolvePermissionTimeoutMs(),
    emit: writeStdout,
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      await bridge.handleLine(line);
    }
  } catch (err) {
    logger.error("bridge: stdin loop failed", { error: err instanceof Error ? err.message : String(err) });
    return 1;
  } finally {
    rl.close();
  }
  await bridge.shutdown();
  return 0;
}
