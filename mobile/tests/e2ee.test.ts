import { describe, expect, it } from "vitest";
import {
  deriveSharedKey,
  e2eeDecrypt,
  e2eeEncrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64,
} from "../src/transport/e2ee.js";

describe("e2ee frames", () => {
  it("round-trips between two parties", () => {
    const server = generateKeyPair();
    const client = generateKeyPair();
    const s2c = deriveSharedKey(server.secretKey, client.publicKey);
    const c2s = deriveSharedKey(client.secretKey, server.publicKey);
    const frame = e2eeEncrypt('{"id":1,"result":{"pong":true}}', s2c);
    expect(e2eeDecrypt(frame, c2s)).toBe('{"id":1,"result":{"pong":true}}');
    expect(e2eeDecrypt(e2eeEncrypt("ping", c2s), s2c)).toBe("ping");
  });

  it("rejects garbage and stranger keys", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const shared = deriveSharedKey(a.secretKey, b.publicKey);
    const frame = e2eeEncrypt("hello", shared);
    expect(e2eeDecrypt("not-base64!!", shared)).toBeNull();
    expect(e2eeDecrypt(frame.slice(0, 8), shared)).toBeNull();
    const stranger = generateKeyPair();
    expect(e2eeDecrypt(frame, deriveSharedKey(stranger.secretKey, b.publicKey))).toBeNull();
  });

  it("base64 public-key helpers validate length", () => {
    const kp = generateKeyPair();
    const b64 = publicKeyToBase64(kp.publicKey);
    expect(Array.from(publicKeyFromBase64(b64))).toEqual(Array.from(kp.publicKey));
    expect(() => publicKeyFromBase64(Buffer.from([1, 2, 3]).toString("base64"))).toThrow();
  });
});
