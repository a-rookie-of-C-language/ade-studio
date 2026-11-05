// React Native entry points: real randomness for Hermes and the platform socket.
import * as ExpoCrypto from "expo-crypto";
import { setExpoPRNG } from "./e2ee.js";
import type { WebSocketLike } from "./client.js";

let installed = false;

/** tweetnacl has no `crypto.getRandomValues` on Hermes; Orca does the same. */
export function installMobileCrypto(): void {
  if (installed) return;
  installed = true;
  setExpoPRNG((n) => new Uint8Array(ExpoCrypto.getRandomBytes(n)));
}

export function openSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
