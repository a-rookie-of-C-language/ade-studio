import { existsSync } from "node:fs";
import { delimiter, sep } from "node:path";
import type { AgentDeps } from "../../../third-party/cindy-agent/maker-core/agents/base-agent.js";
import type { AgentRuntimeConfig } from "../../../third-party/cindy-agent/maker-core/interfaces/runtime-config.js";
import type { Logger } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";
import { createLocalAuthAdapter } from "./local-auth.js";

/** exit 2 = 环境缺失（供 B4 “找不到时明确报错”，与运行时错误 exit 1 区分）。 */
export const EXIT_MISSING_DEPS = 2;

/**
 * 在 PATH 里找 `claude` CLI。win32 顺带试 `.exe` / `.cmd` 后缀。
 * 只做存在性检查，不执行它（执行是 SDK 的事）。
 */
export function resolveClaudeBinaryPath(): string | null {
  const pathEnv = process.env.PATH ?? "";
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = `${dir}${sep}claude${suffix}`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // 忽略坏 PATH 条目，继续找下一个。
      }
    }
  }
  return null;
}

/** v0 runtimeConfig：双 memory 全关，不覆写 endpoint（走 SDK 默认），无业务 flag。 */
export function createLocalRuntimeConfig(): AgentRuntimeConfig {
  return {
    memoryEnabled: false,
    makerMemoryEnabled: false,
  };
}

export interface LocalDepsResult {
  deps: AgentDeps;
  binaryPath: string;
}

/**
 * 组装 v0 本地依赖。找不到 `claude` 二进制时抛错（调用方以 exit 2 退出并明示）。
 */
// 中文注释：binaryPath 为空时 maker-core 构造期即抛错，v0 选择在组装依赖时就
// fail-fast，把“缺 claude CLI”与其它运行时错误区分开（exit 2，供 B4 明确报错）。
export function buildLocalDeps(logger: Logger): LocalDepsResult {
  const binaryPath = resolveClaudeBinaryPath();
  if (!binaryPath) {
    throw new Error("claude CLI not found in PATH; install it or run `claude login` in your own terminal first");
  }
  const deps: AgentDeps = {
    auth: createLocalAuthAdapter(logger),
    runtimeConfig: createLocalRuntimeConfig(),
    binaryPath,
    logger,
    mcpProviders: [],
  };
  return { deps, binaryPath };
}
