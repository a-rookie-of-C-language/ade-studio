// Full v2 handshake against an in-process mock that mirrors
// `crates/ide-host/src/mobile.rs`: hello/ready in plaintext, then every frame
// NaCl-box encrypted. Proves the TS client interops with the Rust wire format.
import { afterAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import {
  deriveSharedKey,
  e2eeDecrypt,
  e2eeEncrypt,
  generateKeyPair,
  publicKeyToBase64,
} from "../src/transport/e2ee.js";
import { MobileClient, type WebSocketLike } from "../src/transport/client.js";

const PROTOCOL = 2;
const TOKEN = "test-token";

const serverKeys = generateKeyPair();
const wss = new WebSocketServer({ port: 0 });
const sessions = new Map<WebSocket, { shared: Uint8Array; authed: boolean }>();

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString();
    const sess = sessions.get(ws);
    if (!sess) {
      const hello = JSON.parse(text) as { type?: string; publicKeyB64?: string };
      if (hello.type !== "e2ee_hello" || !hello.publicKeyB64) {
        ws.send(JSON.stringify({ type: "e2ee_error", message: "expected e2ee_hello" }));
        ws.close();
        return;
      }
      const clientPub = new Uint8Array(Buffer.from(hello.publicKeyB64, "base64"));
      sessions.set(ws, { shared: deriveSharedKey(serverKeys.secretKey, clientPub), authed: false });
      ws.send(JSON.stringify({ type: "e2ee_ready" }));
      return;
    }
    const plain = e2eeDecrypt(text, sess.shared);
    if (!plain) return;
    const req = JSON.parse(plain) as { id: number; method: string; params: Record<string, unknown> };
    const send = (v: unknown) => ws.send(e2eeEncrypt(JSON.stringify(v), sess.shared));
    if (req.method === "e2ee_auth") {
      if (req.params?.["deviceToken"] !== TOKEN) {
        send({ id: req.id, error: { code: 401, message: "unknown device" } });
        return;
      }
      sess.authed = true;
      send({ id: req.id, result: { authenticated: true } });
      return;
    }
    if (req.method === "initialize") {
      if (req.params?.["deviceToken"] !== TOKEN || !sess.authed) {
        send({ id: req.id, error: { code: 401, message: "unauthorized" } });
        return;
      }
      if (req.params?.["version"] !== PROTOCOL) {
        send({ id: req.id, error: { code: 426, message: "version mismatch" } });
        return;
      }
      send({ id: req.id, result: { protocol: PROTOCOL, serverVersion: "test" } });
      return;
    }
    if (req.method === "ping") {
      send({ id: req.id, result: { pong: true } });
      return;
    }
    send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  });
});

afterAll(async () => {
  wss.close();
});

async function address(): Promise<string> {
  while (!wss.address()) await new Promise((r) => setTimeout(r, 10));
  const a = wss.address();
  const port = typeof a === "object" && a ? a.port : 0;
  return `ws://127.0.0.1:${port}`;
}

function openWs(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

describe("v2 handshake", () => {
  it("auth -> initialize -> ping", async () => {
    const endpoint = await address();
    const keys = generateKeyPair();
    const client = new MobileClient();
    await client.connect(
      { v: 1, endpoint, deviceToken: TOKEN, publicKeyB64: publicKeyToBase64(serverKeys.publicKey) },
      keys,
      openWs,
    );
    await client.auth(TOKEN);
    const hello = await client.initialize(TOKEN);
    expect(hello.protocol).toBe(2);
    expect(await client.ping()).toBe(true);
    client.close();
  });

  it("rejects a bad token", async () => {
    const endpoint = await address();
    const client = new MobileClient();
    await client.connect(
      { v: 1, endpoint, deviceToken: "nope", publicKeyB64: publicKeyToBase64(serverKeys.publicKey) },
      generateKeyPair(),
      openWs,
    );
    await expect(client.auth("nope")).rejects.toThrow();
    client.close();
  });
});
