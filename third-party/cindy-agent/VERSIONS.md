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
