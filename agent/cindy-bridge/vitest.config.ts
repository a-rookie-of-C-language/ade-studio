import { defineConfig } from "vitest/config";

/** cindy-bridge 工程回归测试：translator 纯函数 + NDJSON 回放（假句柄，不碰真实 SDK）。 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
