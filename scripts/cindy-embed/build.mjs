// Builds Cindy's desktop renderer as static files for first-party embedding.
// Reads Cindy's repo (default: D:/code/cindy, override with --cindy-dir or
// CINDY_DIR), writes nothing there. Output goes to public/cindy/ (gitignored,
// served by `pnpm dev` and bundled into dist by `pnpm build`).
//
// Usage: node scripts/cindy-embed/build.mjs [--cindy-dir <path>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const dirFlag = args.indexOf("--cindy-dir");
const CINDY_DIR = process.env.CINDY_DIR ?? (dirFlag !== -1 ? args[dirFlag + 1] : undefined) ?? "D:/code/cindy";
const CINDY_DESKTOP = path.join(CINDY_DIR, "apps/desktop");
const OUT_DIR = path.join(ROOT, "public/cindy");

function pin() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: CINDY_DIR }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: CINDY_DIR }).toString().trim();
    return { commit, dirty: dirty.length > 0 };
  } catch {
    return { commit: "unknown", dirty: null };
  }
}

if (!fs.existsSync(path.join(CINDY_DESKTOP, "package.json"))) {
  console.error(`cindy desktop not found under ${CINDY_DESKTOP} (use --cindy-dir)`);
  process.exit(1);
}

// The embed vite config carries base '/cindy/' + the electronAPI shim and
// resolves its toolchain (vite/react) from Cindy's own node_modules.
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.VITE_CINDY_EMBED_OUT = OUT_DIR;
execFileSync(
  process.execPath,
  [
    path.join(CINDY_DIR, "node_modules/vite/bin/vite.js"),
    "build",
    "--config",
    path.join(here, "vite.embed.config.mjs"),
  ],
  { cwd: CINDY_DESKTOP, stdio: "inherit" },
);

fs.writeFileSync(
  path.join(OUT_DIR, "cindy-pin.json"),
  JSON.stringify({ ...pin(), builtAt: new Date().toISOString() }, null, 2) + "\n",
);
console.log(`cindy embed built -> ${OUT_DIR}`);
