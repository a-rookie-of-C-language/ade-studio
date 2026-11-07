# Cindy agent 快照版本

- 上游：<https://github.com/a-rookie-of-C-language/cindy>（Apache-2.0）
- 快照 commit：`5c1ddeeab20476e9fc8fd40a99ad19ac958b7006`
- 快照日期：2026-11-07
- 上游 LICENSE / NOTICE 原文：`UPSTREAM-LICENSE`、`UPSTREAM-NOTICE`
- 快照方法：以 `packages/maker-core/src/agents/claude-code/index.ts` 为根，
  跟随相对 import（含 `import type`、`export ... from` 与动态 `import('...')`
  类型引用，含 `.js` 后缀映射与 `index.ts` 目录映射）计算传递闭包；
  `model-providers` 补 `effortResolution.ts` + `classification.ts` 双根闭包；
  `maker-shared` 按 Claude 链路实际命中的 10 个子路径闭包。`?raw` 的两个 `.md`
  资源单独拷贝。全部文件 sha256 与上游一致（114 个 TS + 2 个 md +
  LICENSE/NOTICE，入库时逐文件比对通过）。
- 本地接线（非快照内容，不入库）：`third-party/cindy-agent/node_modules` 是一个
  junction，指向 `agent/cindy-bridge/node_modules`，让 vendor 文件的裸包导入
  （`@anthropic-ai/*`、`gray-matter`、`better-sqlite3` 类型）能被 tsc 解析。
  已被根 `.gitignore` 的 `node_modules` 覆盖；全新 clone 后重建：
  `node agent/cindy-bridge/scripts/link-vendor-deps.mjs`（B2 脚本，待补）。
- 同步方法：上游修复安全/协议问题时，用同一闭包方法重算文件集，diff 后手动同步
  受影响文件并重跑 B2/B3 验收；不跟随上游 git 历史，不整包升级。
- 层归属（vendor 零修改铁律）：一切让快照在 bridge 侧可编译、可运行的接线——
  tsconfig `paths` 映射、node 运行时 loader（`*.md?raw` + `@cindy/*` 裸包名）、
  类型 ambient（`sharp.d.ts`）、最小接口 shim（`session-controls.ts`）、
  barrel 代 shim（`maker-shared-barrel.ts`）——一律放在 `agent/cindy-bridge/` 侧
  （`src/` + `tsconfig.json` + `tsconfig.build.json`），绝不落进本快照目录。
  vendor 目录只接受“上游原文重算闭包”的变更。
- B1 勘误（诚实记录）：B1 落库时宣称 `tsc --noEmit` 通过，实际在 B2 联调中发现
  三处当时未爆出的缺口——barrel shim 相对路径少一级 `../`（`vendor-shims/` 比
  预想深一层）、可选依赖 `sharp` 缺类型（runtime 按设计降级 noop，但 tsc 不认）、
  `types/context-usage.ts` 的动态类型引用 `@cindy/maker-shared/session-controls`
  未映射。缺口的根因是 B1 只跑了 vendor 闭包自身检查，未在“bridge 真实引用链”
  下验证。修复全部落在 bridge 侧（见下节），vendor 零修改；B2 起验收口径改为
  “bridge 全引用链 `tsc --noEmit` + 构建产物 smoke”，不再单独采信 vendor 闭包
  自查。
- `session-controls` 取舍（已实测上游形状后决定不 vendor）：真文件
  `maker-shared/src/sessionControls.ts` @ 快照 commit 的运行时 import 拖
  `messageNormalize / deviceLinkContract / presentationLocalization` 整条展示链，
  vendoring 会违背 maker-shared“自包含叶子”边界；Claude 链路只消费其中
  `ContextTextEstimate` 这一个可选字段的类型（`{ method: "text-heuristic";
  items: Array<{ source: string; tokens: number }> }`，bridge 自有 shim 按快照
  形状声明，type-only）。快照同步时人工比对该接口即可（字段极少）。
- `sharp` 取舍：`image-resizer.ts` 用 `require('sharp')` 可选加载，host 没装时
  整体降级为 noop（上游注释原话"纯 type-check 跑测试"环境亦如此）；bridge 包
  不装 sharp（native module，v0 只需缩图降级路径），类型由 bridge 侧 ambient
  供给最小链式形状，运行时照旧走 try/require → null。
- 本机登录态教训（ats/lcp 风格 lint 违规的反例）：B2 联调中曾出现过"为让 tsc
  通过而手写 credential-shape"的诱惑（内容凭空编造、BOM 诱导、捷径绕过）。
  铁律：只读本机已有登录态的存在性（`~/.claude/.credentials.json` 存在与否、
  `ANTHROPIC_API_KEY` 是否设置），绝不读取其内容，绝不手写/伪造任何
  credential 形状；缺登录态时 bridge 返回可读错误（本机实测 `no_key` 负路径），
  由用户在自己的终端里 `claude login`。

## Bridge 侧接线清单（非快照内容，属 `agent/cindy-bridge/`）

- `src/vendor-shims/maker-shared-barrel.ts`：裸 `@cindy/maker-shared` 代 shim
  （vendor 闭包里只有类型-only 的这一处引用；真 barrel 重导出 ~90 个无关业务
  模块，不 vendor）。
- `src/vendor-shims/session-controls.ts`：`ContextTextEstimate` 最小接口
  （type-only，见上节取舍）。
- `src/vendor-shims/sharp.d.ts`：`sharp` 最小链式形状 ambient（见上节取舍）。
- `src/raw-loader.ts`：node `--import` loader。两职责：① `*.md?raw` → dist 镜像
  路径映射回源码树读文本（`dist/` 镜像的是仓库根布局，锚点是包目录上两级）；
  ② `@cindy/*` 裸包名运行时映射（kebab→camel 规则，与 tsconfig `paths` 同一张表）。
- `tsconfig.json` `paths`：10 个 maker-shared + 2 个 model-providers 逐条映射
  （静态类型用）；`tsconfig.build.json`：emit 到 `dist/`（镜像仓库根：
  `dist/agent/cindy-bridge/src/index.js`）。

## 文件清单

### `maker-core/`（87 个 TS + 2 个 md）

```text
agents/base-agent.ts
agents/claude-code/auto-review-policy.ts
agents/claude-code/capability-routing.ts
agents/claude-code/claude-projects-fs.ts
agents/claude-code/commands.ts
agents/claude-code/customization-scanner.ts
agents/claude-code/env-builder.ts
agents/claude-code/flag-settings.ts
agents/claude-code/fork-jsonl-repair.ts
agents/claude-code/generation-timing.ts
agents/claude-code/index.ts
agents/claude-code/invalid-resume.ts
agents/claude-code/jsonl-tool-id-normalize.ts
agents/claude-code/local-process-spawn.ts
agents/claude-code/managed-skill-plugins.ts
agents/claude-code/mcp-server-tools.ts
agents/claude-code/model-access-error.ts
agents/claude-code/pinned-skill-invocation.ts
agents/claude-code/subagent-definitions.ts
agents/claude-code/subagent-model-access.ts
agents/claude-code/subagent-model-default.ts
agents/claude-code/system-prompt-append.ts
agents/claude-code/system-prompt-append.md (?raw)
agents/claude-code/transcript-relocation.ts
agents/claude-code/translator.ts
agents/claude-code/workspace-settings-guard.ts
agents/codex/app-server/external-auth.ts  # 动态 import('...') 类型引用，无导入
agents/codex/app-server/protocol.ts  # 静态 import type，无运行时导入
agents/codex/app-server/transport.ts  # 动态 import('...') 类型引用，无导入
agents/codex/retry-escalation.ts  # 动态 import('...') 类型引用，无导入
agents/credential-mode.ts
agents/pi/cache-compatibility.ts  # 动态 import('...') 类型引用，仅 node:crypto
agents/pi/managed-command.ts  # 动态 import('...') 类型引用，无导入
agents/pi/transport.ts  # 动态 import('...') 类型引用，仅 node 内建 + 已 vendor 模块
agents/shared/async-queue.ts
agents/shared/auto-compact-controller.ts
agents/shared/auto-review-decision.ts
agents/shared/auto-review.ts
agents/shared/bot-runtime-policy.ts
agents/shared/context-overflow-error.ts
agents/shared/customization-scanner.ts
agents/shared/device-hosted.ts
agents/shared/fast-mode-policy.ts  # base-agent 动态 import('...') 类型引用；回指 base-agent 类型，无新依赖
agents/shared/image-resizer.ts
agents/shared/library-native-read.ts
agents/shared/live-generation-snapshot.ts
agents/shared/loop-guard.ts
agents/shared/managed-image-reference.ts
agents/shared/managed-skill-policy.ts
agents/shared/mcp-tool-target.ts
agents/shared/orca-report-policy.ts
agents/shared/overload-error.ts
agents/shared/palette-scanner.ts
agents/shared/remote-skill-scanner.ts
agents/shared/review-read-scope.ts
agents/shared/sensitive-credential-paths.ts
agents/shared/shell-input-redirections.ts
agents/shared/skill-activation.ts
agents/shared/skill-scan-limits.ts
agents/shared/terminal-output.ts
agents/shared/token-speed.ts
agents/shared/tool-loop-review.ts
agents/shared/turn-start-phrases.ts
agents/shared/usage-tracker.ts
interfaces/auth-adapter.ts
interfaces/logger.ts
interfaces/mcp-provider.ts
interfaces/runtime-config.ts
memory/flush-controller.ts
memory/fts.ts
memory/manager.ts
memory/scope-resolver.ts
memory/storage.ts
memory/store.ts
memory/system-prompt.ts
memory/system-prompt.md (?raw)
memory/types.ts
types/account-rate-limits.ts
types/capabilities.ts
types/capability-routing.ts
types/common.ts
types/context-usage.ts
types/customizations.ts
types/events.ts
types/memory.ts
types/palette.ts
types/permissions.ts
types/pi-project-trust.ts
types/pi-runtime-capabilities.ts
```

### `model-providers/`（15 个 TS + 1 个 JSON，零外部依赖）

```text
cindyMark.ts
classification.ts
disableOverrides.ts
effortResolution.ts
localModelCatalog.ts
localModelDescriptions.json
modelAccessBean.ts
modelDisplayPricing.ts
modelGeneration.ts
modelList.ts
modelMetadataLayers.ts  # 动态 import("./modelSource.js") 类型引用
modelSource.ts  # 39 行纯叶子，无导入
provider-identity.ts
providerBranding.ts
registry.ts
types.ts
```

### `maker-shared/`（11 个 TS，零外部依赖）

```text
agentTask.ts
autoReviewIntent.ts
commandDisplay.ts
errorRedaction.ts
internalCitation.ts
outputLimitError.ts
runningTokenRateHistory.ts
subagentObservation.ts
toolLoopError.ts
toolProcessMedia.ts
usageFormat.ts
```

## 外部依赖（vendor 之外，由 bridge 包 `agent/cindy-bridge/` 供给）

- `@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk`（npm，仓内 pnpm 供给）
- `better-sqlite3`（仅 `import type Database` + host 注入 `SqliteFactory`，native 模块由 pnpm 供给）
- `gray-matter`（npm，front-matter 解析）
- Node 内建：`node:fs`、`node:os`、`node:path`、`node:crypto`、`node:child_process`、
  `node:url`、`node:util`
