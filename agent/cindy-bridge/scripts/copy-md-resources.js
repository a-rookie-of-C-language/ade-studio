/**
 * Mirrors vendor `*.md` resources into `dist/` (tsc only emits `.ts`).
 *
 * The `?raw` prompt files (`third-party/cindy-agent/.../*.md`) are read at
 * runtime by `raw-loader.js`, which maps `dist/` back to the source tree in
 * dev. Release bundles have no source tree, so the build copies them into
 * `dist/` too, and the loader prefers the copy when it exists.
 *
 * Usage: `node scripts/copy-md-resources.js` (from `agent/cindy-bridge/`).
 */
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const vendor = join(root, "..", "..", "..", "third-party", "cindy-agent");
const dist = join(root, "..", "dist", "third-party", "cindy-agent");

if (!existsSync(vendor)) {
  console.error(`copy-md-resources: vendor tree missing: ${vendor}`);
  process.exit(1);
}
mkdirSync(dist, { recursive: true });
// Only the prompt resources the bridge loads (`?raw`); docs stay behind.
for (const rel of ["maker-core/memory/system-prompt.md", "maker-core/agents/claude-code/system-prompt-append.md"]) {
  cpSync(join(vendor, rel), join(dist, rel), { force: true });
  console.log(`copy-md-resources: ${rel}`);
}
