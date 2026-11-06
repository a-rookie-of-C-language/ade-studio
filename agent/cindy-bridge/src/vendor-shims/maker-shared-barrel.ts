/**
 * Bridge-owned shim for the bare `@cindy/maker-shared` barrel specifier.
 *
 * The vendor snapshot (`third-party/cindy-agent/`) intentionally does not
 * contain the upstream barrel (`maker-shared/src/index.ts`), which re-exports
 * ~90 unrelated business modules. The only bare-barrel import in the Claude
 * chain is type-only (`import type { OutputLimitDetails }` in
 * `types/events.ts`), so this shim re-exports that type from the vendored leaf
 * and preserves type identity without widening the snapshot.
 *
 * 为什么: vendor 只读、不可修改；shim 是 bridge 侧自有文件。
 * If a future sync adds a *runtime* bare-barrel import to the Claude chain,
 * tsc will fail here — that is intentional: widen the snapshot instead.
 */
export type { OutputLimitDetails } from "../../../../third-party/cindy-agent/maker-shared/outputLimitError.js";
