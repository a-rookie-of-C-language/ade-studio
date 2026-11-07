import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AuthAdapter,
  AuthAdapterOptions,
  AuthLoginOptions,
} from "../../../third-party/cindy-agent/maker-core/interfaces/auth-adapter.js";
import type { AuthState } from "../../../third-party/cindy-agent/maker-core/types/common.js";
import type { Logger } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";

/** Local Magpie gateway (B5). Overridable; the loopback default needs no credentials. */
export const DEFAULT_MAGPIE_BASE_URL = "http://127.0.0.1:3425";

export function magpieBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.MAGPIE_BASE_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_MAGPIE_BASE_URL;
}

export function magpieApiKey(env: Record<string, string | undefined> = process.env): string {
  const raw = env.MAGPIE_API_KEY?.trim();
  // The local gateway ignores credentials; the CLI still wants the field set.
  return raw && raw.length > 0 ? raw : "magpie-local";
}

/** A magpie wire id (`auto/…`, `provider/…`); bare SDK aliases route legacy. */
export function isMagpieModelId(model: unknown): boolean {
  return typeof model === "string" && model.includes("/");
}

/** The gateway answers its catalog: enough for an auth check. */
export async function magpieReachable(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * v0 本地只读 AuthAdapter（spec §4：只读本机已有登录态，零新凭据）+ B5 magpie。
 *
 * 路由按模型 id 切分（vendor 的 credentialMode 推导保持原样）：
 * - magpie wire id（含 `/`，如 `auto/gpt-6.1-sol`）→ 网关：authSource `api-key` 触发
 *   vendor 的 gateway-key/host-managed 路由（endpoint 由 runtimeConfig 注入，见 deps）。
 * - 裸别名（`sonnet`…）→ legacy：本机 claude 登录 / ANTHROPIC_API_KEY（B2 行为不变）。
 */
export function createLocalAuthAdapter(logger: Logger): AuthAdapter {
  return {
    async getState(options?: AuthAdapterOptions): Promise<AuthState> {
      // Magpie wire ids never touch the Claude login, even when one exists.
      if (isMagpieModelId(options?.model)) {
        const baseUrl = magpieBaseUrl();
        if (await magpieReachable(baseUrl)) {
          return { authenticated: true, authSource: "api-key" };
        }
        return {
          authenticated: false,
          errorReason: `magpie gateway unreachable at ${baseUrl} (set MAGPIE_BASE_URL or start it)`,
        };
      }
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

    async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
      // 只给鉴权 key；BASE_URL 归 runtimeConfig.endpoint（adapter 接口约定）。
      if (isMagpieModelId(options?.model)) {
        return { ANTHROPIC_API_KEY: magpieApiKey() };
      }
      return {};
    },
  };
}
