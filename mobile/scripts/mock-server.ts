#!/usr/bin/env npx tsx
// Standalone mock of `openidea-server --mobile` (protocol v2) for phone UI work
// without a Rust build. Mirrors `crates/ide-host/src/mobile.rs`: plaintext
// `e2ee_hello` / `e2ee_ready`, then every frame NaCl-box encrypted.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import nacl from "tweetnacl";
import { deriveSharedKey, e2eeDecrypt, e2eeEncrypt } from "../src/transport/e2ee.js";
import { pairingUrl } from "../src/transport/pairing.js";

const PORT = Number(process.env.PORT ?? 6768);
const PAIRING_TTL_MS = 5 * 60_000;
const PROTOCOL = 2;

type Device = { name: string; seen: boolean };

const devices = new Map<string, Device>();
const codes = new Map<string, number>();
let pendingToken: string | null = null;

function mintCode(): string {
  const n = 100_000 + Math.floor(Math.random() * 900_000);
  const code = String(n);
  codes.set(code, Date.now() + PAIRING_TTL_MS);
  return code;
}

function consumeCode(code: string): boolean {
  const exp = codes.get(code.trim());
  if (!exp) return false;
  codes.delete(code.trim());
  return Date.now() <= exp;
}

function pending(): string {
  if (pendingToken && devices.get(pendingToken)?.seen === false) return pendingToken;
  for (const [token, d] of devices) {
    if (!d.seen) {
      pendingToken = token;
      return token;
    }
  }
  const token = randomUUID();
  devices.set(token, { name: "phone", seen: false });
  pendingToken = token;
  return token;
}

function loadOrCreateKeyPair(): nacl.BoxKeyPair {
  const file = process.env.MOCK_SERVER_KEY_FILE;
  if (!file) return nacl.box.keyPair();
  try {
    const raw = readFileSync(file, "utf-8").trim();
    const secret = Buffer.from(raw, "base64");
    if (secret.length === 32) return nacl.box.keyPair.fromSecretKey(new Uint8Array(secret));
    console.warn(`[mock] Key file ${file} unreadable — minting a fresh key`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      console.warn(`[mock] Key file unreadable — minting a fresh key`);
  }
  const kp = nacl.box.keyPair();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(kp.secretKey).toString("base64"), { mode: 0o600 });
  return kp;
}

const serverKeys = loadOrCreateKeyPair();
const serverPubB64 = Buffer.from(serverKeys.publicKey).toString("base64");
const code = mintCode();
const token = pending();
const endpoint = `ws://127.0.0.1:${PORT}`;
console.log(`[mock] listening on ${endpoint}`);
console.log(`[mock] pairing url: ${pairingUrl(endpoint, token, serverPubB64)}`);
console.log(`[mock] manual pairing code ${code} (valid 5 min)`);
if (process.env.MOCK_SERVER_KEY_FILE) console.log(`[mock] key file: ${process.env.MOCK_SERVER_KEY_FILE}`);

const wss = new WebSocketServer({ port: PORT });
const sessions = new Map<WebSocket, { shared: Uint8Array; authed: boolean }>();

function ok(id: unknown, result: unknown): string {
  return JSON.stringify({ id, result });
}
function err(id: unknown, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } });
}

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    const sess = sessions.get(ws);
    if (!sess) {
      let hello: { type?: unknown; publicKeyB64?: unknown };
      try {
        hello = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: "e2ee_error", message: "invalid JSON" }));
        ws.close();
        return;
      }
      if (hello.type !== "e2ee_hello" || typeof hello.publicKeyB64 !== "string") {
        ws.send(JSON.stringify({ type: "e2ee_error", message: "expected e2ee_hello" }));
        ws.close();
        return;
      }
      let clientPub: Uint8Array;
      try {
        clientPub = new Uint8Array(Buffer.from(hello.publicKeyB64, "base64"));
        if (clientPub.length !== 32) throw new Error("bad length");
      } catch {
        // Bad key: tell the phone and hang up.
        ws.send(JSON.stringify({ type: "e2ee_error", message: "bad publicKeyB64" }));
        ws.close();
        return;
      }
      sessions.set(ws, { shared: deriveSharedKey(serverKeys.secretKey, clientPub), authed: false });
      ws.send(JSON.stringify({ type: "e2ee_ready" }));
      return;
    }
    const plain = e2eeDecrypt(text, sess.shared);
    if (plain === null) return;
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(plain);
    } catch {
      return;
    }
    const reply = (s: string) => {
      if (ws.readyState === ws.OPEN) ws.send(e2eeEncrypt(s, sess.shared));
    };
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "pair.exchange": {
        const c = String(params["code"] ?? "");
        const name = String(params["name"] ?? "phone").trim() || "phone";
        if (!consumeCode(c)) {
          reply(err(req.id, 403, "invalid or expired pairing code"));
          break;
        }
        const t = randomUUID();
        devices.set(t, { name, seen: false });
        reply(ok(req.id, { deviceToken: t }));
        break;
      }
      case "e2ee_auth": {
        const t = String(params["deviceToken"] ?? "").trim();
        if (!devices.has(t)) {
          reply(err(req.id, 401, "unknown device: pair again from the desktop"));
          break;
        }
        sess.authed = true;
        reply(ok(req.id, { authenticated: true }));
        break;
      }
      case "initialize": {
        if (!sess.authed) {
          reply(err(req.id, 401, "call e2ee_auth first"));
          break;
        }
        const t = String(params["deviceToken"] ?? "").trim();
        if (!devices.has(t)) {
          reply(err(req.id, 401, "unknown device: pair again from the desktop"));
          break;
        }
        if (params["version"] !== PROTOCOL) {
          reply(err(req.id, 426, `incompatible mobile protocol ${params["version"]}: server speaks ${PROTOCOL}`));
          break;
        }
        sess.authed = true;
        devices.get(t)!.seen = true;
        reply(ok(req.id, { protocol: PROTOCOL, serverVersion: "mock-0.1.0", os: "mock", arch: "mock" }));
        break;
      }
      case "ping":
        reply(ok(req.id, { pong: true }));
        break;
      case "mobile.projects":
        reply(
          ok(req.id, [
            { name: "openidea", path: join(process.cwd(), ".."), kind: "demo" },
            { name: "fixtures-rust", path: join(process.cwd(), "..", "fixtures", "rust"), kind: "demo" },
          ]),
        );
        break;
      case "invoke":
        reply(ok(req.id, { echo: { cmd: params["cmd"], args: params["args"] ?? null } }));
        break;
      default:
        if (!sess.authed && req.method !== "pair.code") {
          reply(err(req.id, 401, "pair this phone first (e2ee_auth, then initialize)"));
        } else if (req.method === "pair.code") {
          reply(ok(req.id, { code: mintCode() }));
        } else {
          reply(err(req.id, -32601, `unknown method ${String(req.method)}`));
        }
    }
  });
  ws.on("close", () => sessions.delete(ws));
  ws.on("error", () => {
    sessions.delete(ws);
    try {
      ws.close();
    } catch {
      // Socket already gone; session cleanup above is enough.
    }
  });
});
