/**
 * Bridge-owned shim for `@cindy/maker-shared/session-controls` (spec B2).
 *
 * Vendor `types/context-usage.ts` 有一处类型-only 引用
 * `import('@cindy/maker-shared/session-controls').ContextTextEstimate`。
 * 上游真文件（`maker-shared/src/sessionControls.ts` @ 快照 commit）的运行时 import
 * 拖 `messageNormalize / deviceLinkContract / presentationLocalization` 整条展示链，
 * vendoring 会违背 maker-shared“自包含叶子”边界；Claude 链路只消费其中这一个可选
 * 字段的类型，故此处按快照 commit 实测形状声明最小接口（type-only，运行时擦除）。
 *
 * 为什么不用 vendor 整文件：见上。形状漂移时 tsc 不会报错（结构类型），
 * 下次快照同步时人工比对上游 `ContextTextEstimate` 即可（字段极少）。
 */
export interface ContextTextEstimate {
  method: "text-heuristic";
  items: Array<{ source: string; tokens: number }>;
}
