// QR pairing offer for `openidea://pair?code=<base64url(JSON)>`.
// Matches the Rust server's `PairingOffer` (`crates/ide-host/src/mobile.rs`).
export type PairingOffer = {
  v: 1;
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
};

function base64UrlEncode(json: string): string {
  return Buffer.from(json, "utf-8").toString("base64url");
}

function base64UrlDecode(code: string): string {
  return Buffer.from(code.trim(), "base64url").toString("utf-8");
}

export function pairingUrl(endpoint: string, deviceToken: string, publicKeyB64: string): string {
  const offer: PairingOffer = { v: 1, endpoint, deviceToken, publicKeyB64 };
  return `openidea://pair?code=${base64UrlEncode(JSON.stringify(offer))}`;
}

function parseOffer(value: unknown): PairingOffer | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.endpoint !== "string" || typeof o.deviceToken !== "string") return null;
  if (typeof o.publicKeyB64 !== "string") return null;
  if (!o.endpoint.startsWith("ws://") && !o.endpoint.startsWith("wss://")) return null;
  return o as PairingOffer;
}

export function decodePairingCode(code: string): PairingOffer | null {
  try {
    return parseOffer(JSON.parse(base64UrlDecode(code)));
  } catch {
    return null;
  }
}

const MAX_INPUT = 4096;

/** Accept the full `openidea://pair?code=…` URL, a `#…` fragment form, or a bare code. */
export function decodePairingUrl(input: string): PairingOffer | null {
  if (input.length > MAX_INPUT) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /^openidea:\/\/([^/?#]*)([^?#]*)?/i.exec(trimmed);
  if (!m) {
    // Bare base64url code pasted by hand.
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? decodePairingCode(trimmed) : null;
  }
  if (m[1]?.toLowerCase() !== "pair") return null;
  const rest = trimmed.slice(m[0].length);
  const q = rest.indexOf("?");
  if (q !== -1) {
    const query = rest.slice(q + 1).split("#")[0] ?? "";
    const code = new URLSearchParams(query).get("code");
    if (code) return decodePairingCode(code);
  }
  const hash = rest.indexOf("#");
  if (hash !== -1) return decodePairingCode(rest.slice(hash + 1));
  return null;
}
