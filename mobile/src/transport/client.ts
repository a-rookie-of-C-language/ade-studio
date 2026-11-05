// Minimal v2 companion client: plaintext `e2ee_hello` / `e2ee_ready`, then
// every frame NaCl-box encrypted. Server pins the long-term public key through
// the QR offer, so a mismatch here closes the socket (TOFU).
import {
  deriveSharedKey,
  e2eeDecrypt,
  e2eeEncrypt,
  publicKeyFromBase64,
  publicKeyToBase64,
  type KeyPair,
} from "./e2ee.js";
import type { PairingOffer } from "./pairing.js";

export const MOBILE_PROTOCOL = 2;

export type WsFactory = (url: string) => WebSocketLike;
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
};

export type RpcError = { code: number | string; message: string };
export type RpcEvent = { method: string; params: unknown };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000;

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  // Node `ws` may hand us a Buffer; ArrayBuffer views are covered above.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf-8");
  return String(data ?? "");
}

export class MobileClient {
  private ws: WebSocketLike | null = null;
  private sharedKey: Uint8Array | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onEvent: ((e: RpcEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  /** Open the socket, run the E2EE hello, and leave auth to the caller. */
  async connect(offer: PairingOffer, keys: KeyPair, open: WsFactory): Promise<void> {
    const serverPub = publicKeyFromBase64(offer.publicKeyB64);
    const shared = deriveSharedKey(keys.secretKey, serverPub);
    const ws = open(offer.endpoint);
    this.ws = ws;
    this.sharedKey = shared;

    await new Promise<void>((resolve, reject) => {
      const fail = (e: unknown) => reject(e instanceof Error ? e : new Error("websocket open failed"));
      ws.onerror = fail;
      ws.onopen = () => {
        ws.onmessage = (e) => {
          const text = toText(e.data);
          try {
            const hello = JSON.parse(text) as { type?: string };
            if (hello.type === "e2ee_ready") resolve();
            else reject(new Error(`expected e2ee_ready, got: ${text.slice(0, 80)}`));
          } catch (err) {
            reject(err instanceof Error ? err : new Error("bad e2ee_ready frame"));
          }
        };
        ws.send(JSON.stringify({ type: "e2ee_hello", publicKeyB64: publicKeyToBase64(keys.publicKey) }));
      };
    });

    // Steady-state dispatch: encrypted replies resolve `request()`, bare
    // `{method, params}` frames go to `onEvent` (channel/logcat streams).
    const ws2 = this.ws;
    ws2.onmessage = (e) => this.dispatch(toText(e.data));
    ws2.onerror = null;
    ws2.onclose = () => {
      this.failAll(new Error("connection closed"));
      this.onClose?.();
    };
  }

  get connected(): boolean {
    return this.ws !== null;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    const shared = this.sharedKey;
    if (!ws || !shared) throw new Error("not connected");
    const id = this.nextId++;
    const frame = e2eeEncrypt(JSON.stringify({ id, method, params }), shared);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      ws.send(frame);
    });
  }

  async pairExchange(code: string, name: string): Promise<string> {
    const res = await this.request<{ deviceToken: string }>("pair.exchange", { code, name });
    return res.deviceToken;
  }

  async auth(deviceToken: string): Promise<void> {
    await this.request("e2ee_auth", { deviceToken });
  }

  async initialize(deviceToken: string): Promise<{ protocol: number; serverVersion: string }> {
    return this.request("initialize", { version: MOBILE_PROTOCOL, deviceToken });
  }

  async ping(): Promise<boolean> {
    const res = await this.request<{ pong: boolean }>("ping");
    return res.pong === true;
  }

  async projects(): Promise<unknown[]> {
    const res = await this.request<unknown[]>("mobile.projects");
    return Array.isArray(res) ? res : [];
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.failAll(new Error("client closed"));
    this.ws = null;
  }

  private dispatch(frame: string): void {
    const shared = this.sharedKey;
    if (!shared) return;
    const plain = e2eeDecrypt(frame, shared);
    if (plain === null) return;
    let msg: { id?: unknown; result?: unknown; error?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(plain);
    } catch {
      return;
    }
    if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as RpcError;
        p.reject(new Error(typeof e === "string" ? e : (e.message ?? "request failed")));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg && typeof msg.method === "string") {
      this.onEvent?.({ method: msg.method, params: msg.params });
    }
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}

/** Convenience for Node/`ws`: derive the public half with tweetnacl directly. */
export function publicKeyB64Of(pair: { publicKey: Uint8Array }): string {
  return publicKeyToBase64(pair.publicKey);
}
