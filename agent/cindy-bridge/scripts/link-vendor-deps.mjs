/**
 * Recreate the `third-party/cindy-agent/node_modules` junction.
 *
 * Vendor files live outside this package (`agent/cindy-bridge/`), so TypeScript
 * cannot resolve their bare npm imports (`@anthropic-ai/*`, `gray-matter`,
 * `better-sqlite3` types) from this package's `node_modules` without help.
 * This junction (a Windows junction / POSIX symlink, git-ignored) points the
 * vendor dir at this package's installed dependencies.
 *
 * Run after a fresh clone + `pnpm install` in this directory:
 *   node scripts/link-vendor-deps.mjs
 */
import { symlinkSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.resolve(bridgeDir, "../../third-party/cindy-agent");
const link = path.join(vendorDir, "node_modules");
const target = path.join(bridgeDir, "node_modules");

if (!existsSync(target)) {
  console.error(`missing ${target} — run pnpm install in agent/cindy-bridge first`);
  process.exit(1);
}
if (existsSync(link)) rmSync(link, { recursive: true, force: true });
symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
console.log(`linked ${link} -> ${target}`);
