# Cindy Agent 接入 OpenIDEA：私有最小桥（v0，不用 ACP）

> 状态：草案（待评审）。已定方向：agent 区暂时禁用 ACP，先用 Cindy；协议用私有最小桥，
> 后续可在 bridge 内或 openidea 侧再扩展 ACP。本 spec 是行为改动的前置说明，实现前需评审通过。

## 0. 目标与非目标

- 目标：把 Cindy `maker-core` 的 Claude Code orchestration（env 组装、system-prompt 拼装、
  permission 回调、transcript 修复、usage/limit 事件）接到 OpenIDEA，Cowork Home 照常用，
  第一期只接 **Claude Code** 一个 provider。
- 非目标：ACP（双方都不走）；Cindy 账号体系/网关/OAuth（只复用本机 `claude` 登录态）；
  Codex/Pi（后加）；把 Electron renderer 搬过来（不可能，也不做）。

## 1. 现状盘点（已确认）

- OpenIDEA：`AgentManager` 是多 provider 任务所有者（`create/prompt/respond/cancel/fork/entries/
  changes`，`crates/ide-agent/src/lib.rs`）；`native/claude/cli.rs` 已是一会话一子进程 +
  stdio 管道模型；自定义 agent 支持 `<config>/agents/<id>.toml`（默认 ACP driver）。
- Cindy：`packages/maker-core`（约 380 个 TS 文件）是 Electron main 的库，对外是
  `startSession/send/oneShot` + `AgentEvent` 流；`ClaudeCodeAgent` 走
  `@anthropic-ai/claude-agent-sdk`（in-process），依赖宿主注入
  `AuthAdapter/McpProvider/runtime-config/safeStorage`；`model-providers` 连着官方服务与网关，
  **不进仓**。
- 结论：Rust 直链 TS 不可能；任何“用 Cindy”都必然经过一个 Node 进程。v0 用私有最小协议，
  不用 ACP 做线格式。

## 2. 总体方案：`cindy-bridge` sidecar + `Driver::Cindy`

```text
Cowork UI / mobile ── AgentManager(Rust,任务/存储唯一所有者)
        │  Driver::Cindy: spawn `node cindy-bridge.mjs`, stdio NDJSON
        ▼
cindy-bridge (Node, 无状态转译)
        │  vendor maker-core 只读快照：ClaudeCodeAgent + env/prompt/transcript 模块
        ▼  @anthropic-ai/claude-agent-sdk (in-process, 本机 claude 登录态)
     Claude Code CLI / 模型
```

- 状态所有者：任务、entries、worktree 仍归 `AgentManager`；bridge 只持有活着的 SDK
  session handle（`sessionId → Query`），重启后按 SDK resume 语义重建，不另存任务。
- 事件顺序：`prompt → text/tool_delta* → permission_request ⏸ → respond → … → done`；
  permission 在 bridge 侧排队等 Rust 回包，超时只做失败传播，不自动放行、不重试掩盖。
- 线格式（v0 私有 NDJSON，每行一帧）：
  - Rust→bridge：`start {provider:"claude", cwd, model?}` / `prompt {session, text}` /
    `respond {session, permissionId, decision}` / `cancel {session}` / `close {session}`。
  - bridge→Rust：`started {session, sdkSessionId}` / `text {delta}` / `tool {name, status}` /
    `permission {id, summary}` / `done {stopReason}` / `error {message}`。
- 字段只满足 timeline 折叠与 permission 审批的最小需要；以后切 ACP 时逐帧可映射
  （`session/update` 的子集语义），不在 v0 里预埋 ACP。

## 3. 模块划分

### B1 — vendor 快照（只读，不跟上游历史）

落仓 `third-party/cindy-agent/`（上游 commit `5c1ddeeab20476e9fc8fd40a99ad19ac958b7006`，
2026-11-07；目录镜像上游包结构，文件原样拷贝）：

- `maker-core/`：以 `agents/claude-code/index.ts` 为根的 import 闭包（含动态
  `import('...')` 类型引用），共 **87 个 TS 文件** —
  `agents/base-agent.ts`、`agents/credential-mode.ts`、`agents/claude-code/*`（23 个）、
  `agents/shared/*`（29 个）、`interfaces/*`（4 个）、`memory/*`（7 个）、`types/*`（10 个）、
  `agents/codex/*`（4 个，见下）、`agents/pi/*`（3 个，见下），
  另加 `agents/claude-code/system-prompt-append.md`、`memory/system-prompt.md` 两个 `?raw` 资源。
- `model-providers/`：原 spec 写“不进仓”，闭包实测 `credential-mode.ts` 与
  `claude-code/index.ts` 分别运行时依赖 `classification`（`isCodexGatewayWireModel`）与
  `effort-resolution`（`clampEffortToSupported`）两个叶子模块，其传递闭包共 **15 个文件、零外部依赖、
  零网络调用**（包自述即“Pure logic”）。改为纳入这 16 个文件（`classification/effortResolution/types/
  modelList/registry/provider-identity/disableOverrides/providerBranding/cindyMark/
  localModelCatalog(+json)/modelAccessBean/modelDisplayPricing/modelGeneration/
  modelMetadataLayers/modelSource`），网关/账号/OAuth 相关仍不进仓，重写这两个函数视为禁区（行为漂移风险）。
- `maker-shared/`：Claude 链路实际命中的 9 个子路径模块 + 传递闭包，共 **11 个自包含文件**
  （`agentTask/autoReviewIntent/commandDisplay/errorRedaction/internalCitation/
  outputLimitError/runningTokenRateHistory/subagentObservation/toolLoopError/
  toolProcessMedia/usageFormat`，零外部依赖）。
- codex/pi 目录例外（共 7 个，链路内全部只出现在类型位置，零运行时导入）：
  `agents/codex/app-server/protocol.ts`（静态 `import type`）、
  `agents/codex/app-server/transport.ts`、`agents/codex/retry-escalation.ts`、
  `agents/codex/app-server/external-auth.ts`（动态 `import('...')` 类型引用，三个文件自身无导入）、
  `agents/pi/managed-command.ts`（无导入）、`agents/pi/transport.ts`
  （仅 node 内建 + 已 vendor 模块）、`agents/pi/cache-compatibility.ts`（仅 `node:crypto`）；
  codex/pi 其余运行时文件仍不进仓。
- 上述之外的 codex/pi 文件、desktop host（Electron 注入层）、`model-providers`
  网关/账号部分**不进仓**。
- `types/events.ts` 有一处 `import type { OutputLimitDetails } from '@cindy/maker-shared'`
  （裸包名 barrel）；vendor 不含 barrel，bridge 侧用自有 shim（B2，`agent/cindy-bridge/` 内文件，
  非 vendor 修改）做 `export type` 重导出，类型身份不变。
- `?raw` 的 `.md` 文件 tsc 不可解析：vendor 内附带自有 `raw-imports.d.ts`
  （`declare module '*.md?raw'`，bridge 侧文件），B2 打包时处理实际加载。

附 `VERSIONS.md`（上游 commit + 日期 + 纳入文件清单 + 下次同步方法：重跑闭包脚本比对，
新增文件评审后纳入）；
`THIRD_PARTY_LICENSES.md` 新增 Apache-2.0 条目并保留 LICENSE/NOTICE 原文。

### B2 — `cindy-bridge.mjs`（Node，仓内 `agent/cindy-bridge/`）

- 依赖注入全部本地化：`AuthAdapter` 读本机 `claude` 登录态（沿用用户终端登录，不存新凭据）；
  `McpProvider` v0 为空实现（后加）；storage 只用内存 + SDK 自有 jsonl。
- 翻译层：`AgentEvent → v0 帧`（纯函数，可单测）；permission 回调转 `permission` 帧并挂起等待。
- 验收：对假 SDK 句柄的 NDJSON 回放测试（start/prompt/permission/done 全序列）。

### B3 — Rust `Driver::Cindy`（`ide-agent` 最小增量）

- 新增 driver 变体 + spawn/成帧/事件折入 timeline，复用 `native/claude/cli.rs` 的进程管理形状；
  `AgentManager` 公共 API（`create/prompt/respond/...`）签名不变，mobile S4 零改动。
- 失败语义：bridge 崩溃 → 任务标错并保留 entries，不删 worktree，不静默重建。
- 验收：`provider.rs`/`cli` 同风格单测 + 一次真 bridge 的 `create→prompt→respond→cancel` 端到端。

### B4 — 注册与发布

- `<config>/agents/cindy.toml`（`driver = "cindy"`, `command = "node"`,
  `args = ["<app>/cindy-bridge.mjs"]`）；Node 用仓库既有版本要求，找不到时明确报错。
- 文案进 text catalog（中英）；Cowork 新任务页出现 “Cindy (Claude)” provider。

## 4. 安全边界

- 凭据：只读本机已有登录态；bridge/日志不记录 token、secret；`relay-state.json` 式文件不新增。
- 执行面：agent 的写操作仍走 OpenIDEA 现有 permission/信任门（`require_trust`、project trust），
  bridge 不自建放行规则；v0 不引入 auto-review 自动放行（Cindy 的 auto-review 默认关闭，
  打开与否是后续决策，不在 v0 做）。
- 供应链：vendor 快照只读；`@anthropic-ai/*` 等 npm 依赖走仓内锁文件审计，
  与现有 pnpm 供给一致。

## 5. 合规

- Apache-2.0，`THIRD_PARTY_LICENSES.md` 按条目约定新增；`VERSIONS.md` 钉版本；
  上游安全修复手动同步受影响文件并重跑 B2/B3 验收。

## 6. 验证

- B1：vendor 拷贝上重跑闭包，文件集与 `VERSIONS.md` 清单一致（无多余、无缺失、无上游 barrel 外
  的新增外部依赖）；`tsc --noEmit` 在 bridge 包上下文（`agent/cindy-bridge/` tsconfig `paths` 指向
  vendor + 真实 `node_modules`）下通过。
- B2：NDJSON 回放测试全过；permission 挂起/超时/取消三态单测。
- B3：Rust 单测 + 真 bridge E2E；bridge crash 演练（任务标错、entries 保留）。
- 全链：Cowork 新建 Cindy 任务 → 发消息 → permission 审批 → 取消，全程 UI 可见。

## 7. 里程碑与后续

- M1：本 spec 评审通过（先不动代码）。
- M2：B1 快照入库；B2 回放测试通过。
- M3：B3 + B4，Cowork 可用 Cindy 跑一次完整任务。
- 后续（不在 v0）：Codex/Pi provider；MCP 注入；auto-review 策略决策；
  ACP 扩展（可在 bridge 内用 ACP 对接子 provider，也可把整条线切到 ACP，v0 帧语义已对齐）。
- 风险：SDK 与本地 `claude` CLI 版本耦合；SDK jsonl 与 openidea task 存储的双写口径；
  maker-core 上游迭代快，快照同步成本。
