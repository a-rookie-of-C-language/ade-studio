import { existsSync } from "node:fs";
import { delimiter, sep } from "node:path";
import type { AgentDeps } from "../../../third-party/cindy-agent/maker-core/agents/base-agent.js";
import type { AgentRuntimeConfig } from "../../../third-party/cindy-agent/maker-core/interfaces/runtime-config.js";
import type { Logger } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";
import { createLocalAuthAdapter } from "./local-auth.js";

/** exit 2 = 环境缺失（供 B4 “找不到时明确报错”，与运行时错误 exit 1 区分）。 */
export const EXIT_MISSING_DEPS = 2;

/**
 * 在 PATH 里找 `claude` CLI。win32 优先可直接执行的后缀：裸名在 npm 目录里是
 * POSIX shell 脚本，SDK spawn 它会直接炸（B4 修：原来 "" 排第一）。只做存在性
 * 检查，不执行它（执行是 SDK 的事）。
 */
export function resolveClaudeBinaryPath(env: Record<string, string | undefined> = process.env): string | null {
  const pathEnv = env.PATH ?? "";
  const override = env.CINDY_CLAUDE_PATH?.trim();
  if (override) {
    try {
      if (existsSync(override)) return override;
    } catch {
      // 落到 PATH 查找。
    }
  }
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
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

/** v0 runtimeConfig：双 memory 全关；magpie 可达时 endpoint 指过去（vendor 按会话
 *  凭证形态自动剥离订阅会话，保持 B2 的直连行为）。无业务 flag。 */
export function createLocalRuntimeConfig(endpoint?: string): AgentRuntimeConfig {
  return {
    memoryEnabled: false,
    makerMemoryEnabled: false,
    ...(endpoint ? { endpoint } : {}),
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
export function buildLocalDeps(logger: Logger, magpieEndpoint?: string): LocalDepsResult {
  const binaryPath = resolveClaudeBinaryPath();
  if (!binaryPath) {
    throw new Error("claude CLI not found in PATH; install it or run `claude login` in your own terminal first");
  }
  if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(binaryPath)) {
    // vendor spawn 不带 shell，.cmd 必 EINVAL；指一条能直接执行的路。
    logger.warn("deps: claude entry is a shell shim and cannot be spawned on Windows", {
      binaryPath,
      hint: "set CINDY_CLAUDE_PATH to a real claude.exe",
    });
  }
  const deps: AgentDeps = {
    auth: createLocalAuthAdapter(logger),
    runtimeConfig: createLocalRuntimeConfig(magpieEndpoint),
    binaryPath,
    logger,
    mcpProviders: [],
  };
  return { deps, binaryPath };
}
