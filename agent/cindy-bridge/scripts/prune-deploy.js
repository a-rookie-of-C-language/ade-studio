/**
 * Prunes the `pnpm deploy` output for release packaging.
 *
 * Drops the SDK's per-platform CLI packages (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`):
 * the bridge always spawns the user's own `claude` binary (see `deps.ts`), so the
 * ~250 MB bundled executable is dead weight. Booting the pruned closure still
 * reaches the auth gate, which the bridge e2e covers.
 *
 * Orphaned links left behind by the prune are deleted: Node tolerates dangling
 * symlinks, but resource packers that walk the tree choke on them. Links that
 * still resolve are kept as-is (pnpm's isolated layout depends on them; the
 * tarball path preserves them and is the proven-good carrier).
 *
 * Usage: `node scripts/prune-deploy.js [deploy-dir]` (defaults to `../deploy`).
 */
import { rmSync, readdirSync, existsSync, statSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const deploy = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : join(root, "..", "deploy");
const pnpmDir = join(deploy, "node_modules", ".pnpm");
const scopedDir = join(deploy, "node_modules", "@anthropic-ai");

const PLATFORM_PREFIX = "@anthropic-ai+claude-agent-sdk-";

let removed = 0;
const remove = (path) => {
  if (!existsSync(path)) return;
  const before = sizeOf(path);
  rmSync(path, { recursive: true, force: true });
  removed += before;
  console.log(`prune-deploy: removed ${path} (${(before / 1024 / 1024).toFixed(1)} MB)`);
};

function sizeOf(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

if (existsSync(pnpmDir)) {
  for (const name of readdirSync(pnpmDir)) {
    if (name.startsWith(PLATFORM_PREFIX)) remove(join(pnpmDir, name));
  }
}
if (existsSync(scopedDir)) {
  for (const name of readdirSync(scopedDir)) {
    if (name.startsWith("claude-agent-sdk-")) remove(join(scopedDir, name));
  }
}
// Delete links whose target is gone (the platform-package prune orphans the
// SDK's nested link to it). Valid links are kept: the isolated layout needs them.
let dangling = 0;
const sweep = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (!existsSync(path)) {
        rmSync(path, { force: true });
        dangling++;
      }
      continue;
    }
    if (st.isDirectory()) sweep(path);
  }
};
const modulesDir = join(deploy, "node_modules");
if (existsSync(modulesDir)) sweep(modulesDir);
console.log(`prune-deploy: removed ${dangling} dangling link(s)`);
console.log(`prune-deploy: saved ${(removed / 1024 / 1024).toFixed(1)} MB`);
