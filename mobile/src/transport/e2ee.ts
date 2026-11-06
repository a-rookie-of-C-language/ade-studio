// NaCl `box.before` / `box.after` framing for the mobile companion protocol.
// Wire layout mirrors the Rust server (`crates/ide-host/src/mobile.rs`) and
// Orca's `mock-server-encryption.ts`: one frame is
// `base64(nonce24 || box_after(plaintext))`.
import nacl from "tweetnacl";

// Normalize typed-array prototypes for Hermes-era tweetnacl `instanceof` checks
// (same helper as Orca's mobile `e2ee.ts`); harmless on Node/Hermes alike.
function u8(x: Uint8Array): Uint8Array {
  return new Uint8Array(x);
}

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: u8(kp.publicKey), secretKey: u8(kp.secretKey) };
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return u8(nacl.box.before(u8(peerPublicKey), u8(ourSecretKey)));
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  const raw = Buffer.from(b64.trim(), "base64");
  if (raw.length !== 32) {
    throw new Error(`Invalid public key: expected 32 bytes, got ${raw.length}`);
  }
  return u8(raw);
}

export function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(u8(key)).toString("base64");
}

export function e2eeEncrypt(plaintext: string, sharedKey: Uint8Array): string {
  const msg = u8(new TextEncoder().encode(plaintext));
  const nonce = u8(nacl.randomBytes(nacl.box.nonceLength));
  const box = nacl.box.after(msg, nonce, u8(sharedKey));
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return Buffer.from(out).toString("base64");
}

export function e2eeDecrypt(frame: string, sharedKey: Uint8Array): string | null {
  let bundle: Uint8Array;
  try {
    bundle = u8(Buffer.from(frame.trim(), "base64"));
  } catch {
    return null;
  }
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) return null;
  const nonce = u8(bundle.subarray(0, nacl.box.nonceLength));
  const cipher = u8(bundle.subarray(nacl.box.nonceLength));
  const plain = nacl.box.open.after(cipher, nonce, u8(sharedKey));
  if (!plain) return null;
  try {
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Install an Expo-crypto backed RNG for Hermes (Orca does the same). No-op on Node. */
export function setExpoPRNG(getRandomBytes: (n: number) => Uint8Array): void {
  nacl.setPRNG((out: Uint8Array, n: number) => {
    out.set(u8(getRandomBytes(n)));
  });
}
