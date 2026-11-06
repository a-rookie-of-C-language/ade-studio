import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AuthAdapter,
  AuthLoginOptions,
} from "../../../third-party/cindy-agent/maker-core/interfaces/auth-adapter.js";
import type { AuthState } from "../../../third-party/cindy-agent/maker-core/types/common.js";
import type { Logger } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";

/**
 * v0 本地只读 AuthAdapter（spec §4：只读本机已有登录态，零新凭据）。
 *
 * - `getState`：只检查 `~/.claude/.credentials.json` 是否存在，或进程环境是否自带
 *   `ANTHROPIC_API_KEY`。存在性检查，不读文件内容、不输出 token。
 * - `getAuthEnv`：返回 `{}`，让 SDK/子进程直接继承用户终端的进程环境
 *   （用户已经在自己的终端 `claude login` 过，bridge 不注入、不转存任何 secret）。
 * - `triggerLogin`：v0 不拉起任何登录流程，直接返回未认证，提示用户自行登录。
 * - `logout`：空操作。用户自己的登录态归用户所有，bridge 绝不删除。
 */
export function createLocalAuthAdapter(logger: Logger): AuthAdapter {
  return {
    async getState(): Promise<AuthState> {
      const credentialsPath = join(homedir(), ".claude", ".credentials.json");
      const hasFileLogin = existsSync(credentialsPath);
      const hasEnvKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
      const authenticated = hasFileLogin || hasEnvKey;
      if (!authenticated) {
        logger.warn("local-auth: no local claude login found", { hint: "run `claude login` in your own terminal" });
      }
      return {
        authenticated,
        authSource: hasEnvKey && !hasFileLogin ? "api-key" : "oauth",
      };
    },

    async triggerLogin(_opts?: AuthLoginOptions): Promise<AuthState> {
      logger.warn("local-auth: triggerLogin is not supported in v0; user must `claude login` manually");
      return {
        authenticated: false,
        errorReason: "v0 bridge does not drive login; run `claude login` in your own terminal",
      };
    },

    async logout(): Promise<void> {
      // 空操作：用户自己的登录态，bridge 无权删除。
      logger.warn("local-auth: logout is a no-op in v0; user credentials are never touched");
    },

    async getAuthEnv(): Promise<Record<string, string>> {
      return {};
    },
  };
}
