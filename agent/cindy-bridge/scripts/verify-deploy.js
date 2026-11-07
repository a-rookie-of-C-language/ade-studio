/**
 * Verifies a packaged cindy-bridge closure (deploy dir, extracted tarball, or
 * bundle resources dir): entry discoverable, runtime deps present, prompt
 * resources present, and the entry boots far enough to answer a v0 frame.
 *
 * Usage: node verify-deploy.js <root> [--boot-timeout-ms N] [--node bin]
 * Exit 0 on success; non-zero with the reason on failure (CI fails loudly).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root || root.startsWith("-")) {
  console.error("usage: node verify-deploy.js <root> [--boot-timeout-ms N] [--node bin]");
  process.exit(2);
}
const args = process.argv.slice(3);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const bootTimeoutMs = Number(opt("--boot-timeout-ms", "60000"));
const nodeBin = opt("--node", "node");

const fail = (msg) => {
  console.error(`verify-deploy: FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`verify-deploy: ok: ${msg}`);

// The same suffixes the Rust side searches (see native::cindy BUNDLE_RELS):
// whatever depth the packager preserved, the entry is found.
const SUFFIXES = [
  ["deploy", "dist", "agent", "cindy-bridge", "src", "index.js"],
  ["dist", "agent", "cindy-bridge", "src", "index.js"],
];

let entry = null;
let closureRoot = null;
outer: for (const suffix of SUFFIXES) {
  // Walk the root itself plus a few levels (tarball top dir, Resources nesting).
  const bases = [root, join(root, "deploy"), join(root, "resources")];
  for (const base of bases) {
    const cand = join(base, ...suffix);
    if (existsSync(cand) && statSync(cand).isFile()) {
      entry = cand;
      // The closure root is the dir holding `dist/` (or `deploy/dist/`).
      closureRoot = suffix[0] === "deploy" ? join(base, "deploy") : base;
      break outer;
    }
  }
}
if (!entry) fail(`no bridge entry under ${root} (tried ${SUFFIXES.map((s) => s.join("/")).join(", ")})`);
ok(`entry ${entry}`);

const mustExist = (rel, what) => {
  const p = join(closureRoot, ...rel);
  if (!existsSync(p)) fail(`missing ${what}: ${p}`);
  ok(`${what} present`);
};
mustExist(["node_modules"], "prod dependencies");
mustExist(["node_modules", "@anthropic-ai"], "SDK packages");
for (const md of [
  ["dist", "third-party", "cindy-agent", "maker-core", "memory", "system-prompt.md"],
  ["dist", "third-party", "cindy-agent", "maker-core", "agents", "claude-code", "system-prompt-append.md"],
]) {
  mustExist(md, "prompt resource");
}

// Boot it: a v0 answer (started or terminal auth error) proves the whole load
// path (raw-loader, vendor imports, deps) without needing a login.
const child = spawn(nodeBin, [entry], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
const timer = setTimeout(() => {
  console.error(`verify-deploy: FAIL: no v0 answer within ${bootTimeoutMs}ms`);
  child.kill();
  process.exit(1);
}, bootTimeoutMs);
child.stdin.write(JSON.stringify({ type: "start", session: "verify", cwd: ".", model: "probe" }) + "\n");
let settled = false;
for await (const line of rl) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    continue;
  }
  if (frame && typeof frame.type === "string" && (frame.type === "started" || frame.type === "error")) {
    clearTimeout(timer);
    settled = true;
    ok(`bridge answered: ${line.slice(0, 160)}`);
    break;
  }
}
child.kill();
if (!settled) console.error("verify-deploy: FAIL: bridge exited without answering");
process.exit(settled ? 0 : 1);
