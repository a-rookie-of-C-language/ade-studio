import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, sep } from "node:path";

/**
 * node 运行时 `*.md?raw` 装载器（vendor 零修改，spec B2）。
 *
 * 背景：vendor `translator.ts` / `memory/*` 用 `import "./x.md?raw"` 内联 prompt 资源；
 * tsc 靠自带 `raw-imports.d.ts` 做类型检查，但 emit 出来的 JS 在 node 下无法解析。
 * 本 loader 把 `dist/` 镜像路径映射回源码树读文本（`export default "<全文>"`）。
 * vitest 下不需要它（vite 原生支持 `?raw`）。
 */

interface ResolveContext {
  parentURL?: string;
}

type ResolveNext = (specifier: string, context: ResolveContext) => Promise<{ url: string }>;

function stripRawQuery(url: string): string {
  return url.endsWith("?raw") ? url.slice(0, -"?raw".length) : url;
}

/**
 * `@cindy/*` 裸包名运行时映射（与 tsconfig.json `paths` 同一张表，vendor 零修改）。
 *
 * tsc 靠 `paths` 把裸包名静态映射到 vendor 快照 / bridge shim；node 运行时不认
 * `paths`，故在这里补上。规则与 tsconfig 保持一致：
 * - `@cindy/maker-shared`（裸 barrel）→ bridge 自有 barrel shim；
 * - `@cindy/maker-shared/session-controls` → bridge 自有 session-controls shim
 *   （真文件拖展示链，见该 shim 头注释）；
 * - 其余 `@cindy/<pkg>/<kebab-sub>` → `dist/third-party/cindy-agent/<pkg>/<camel>.js`
 *   （`agent-task → agentTask.js`，以此类推；tsconfig 里逐条列的映射都符合这条规则）。
 * 新增 vendor 叶子若被链路以裸包名引用，无需改 loader（规则自动覆盖），
 * 只需同步 tsconfig `paths`（类型检查用）。
 */
function toCamelFileName(kebab: string): string {
  return kebab
    .split("-")
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function resolveCindyPackage(specifier: string, importerFilePath: string): string | null {
  const match = /^@cindy\/([a-z-]+)(\/([a-z-]+))?$/.exec(specifier);
  if (!match) return null;
  const pkg = match[1];
  const sub = match[3];
  if (pkg !== "maker-shared" && pkg !== "model-providers") return null;

  const marker = `${sep}dist${sep}`;
  const idx = importerFilePath.lastIndexOf(marker);
  if (idx === -1) return null;
  const distRoot = importerFilePath.slice(0, idx + marker.length);

  if (pkg === "maker-shared" && sub === undefined) {
    return join(distRoot, "agent", "cindy-bridge", "src", "vendor-shims", "maker-shared-barrel.js");
  }
  if (pkg === "maker-shared" && sub === "session-controls") {
    return join(distRoot, "agent", "cindy-bridge", "src", "vendor-shims", "session-controls.js");
  }
  if (sub === undefined) return null;
  return join(distRoot, "third-party", "cindy-agent", pkg, `${toCamelFileName(sub)}.js`);
}

function distToSource(filePath: string): string {
  // 编译产物 `dist/` 镜像的是仓库根布局（`dist/agent/...` / `dist/third-party/...`），
  // 而包目录是 `<root>/agent/cindy-bridge`：去掉 `dist/` 后拼回仓库根。
  // 中文注释：映射锚点必须是包目录上两级（仓库根），不能简单删掉 `dist/` 字段，
  // 否则 vendor 的 `.md` 会被定位到包目录下的 `third-party/`（不存在）。
  const marker = `${sep}dist${sep}`;
  const idx = filePath.lastIndexOf(marker);
  if (idx === -1) return filePath;
  const pkgDir = filePath.slice(0, idx);
  const rel = filePath.slice(idx + marker.length);
  return join(pkgDir, "..", "..", rel);
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  next: ResolveNext,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier.endsWith(".md?raw")) {
    const parent = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
    const abs = fileURLToPath(new URL(specifier, parent));
    const direct = stripRawQuery(abs);
    // Release bundles carry the resources inside `dist/` (see
    // `copy-md-resources.js`); the source tree only exists in dev.
    const source = existsSync(direct) ? direct : distToSource(direct);
    return { url: `${pathToFileURL(source).href}?raw`, shortCircuit: true };
  }
  if (specifier.startsWith("@cindy/") && context.parentURL) {
    const mapped = resolveCindyPackage(specifier, fileURLToPath(context.parentURL));
    if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true };
  }
  return next(specifier, context);
}

interface LoadResult {
  format: string;
  source: string;
  shortCircuit?: boolean;
}

type LoadNext = (url: string, context: unknown) => Promise<LoadResult>;

export async function load(url: string, _context: unknown, next: LoadNext): Promise<LoadResult> {
  if (url.includes(".md?raw")) {
    const filePath = fileURLToPath(new URL(stripRawQuery(url)));
    const text = await readFile(filePath, "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, _context);
}
