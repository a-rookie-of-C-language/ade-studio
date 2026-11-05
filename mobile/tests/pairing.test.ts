import { describe, expect, it } from "vitest";
import { decodePairingUrl, pairingUrl } from "../src/transport/pairing.js";

describe("pairing urls", () => {
  it("round-trips the offer", () => {
    const url = pairingUrl("ws://192.168.1.20:6768", "tok-123", "QUJD");
    expect(url.startsWith("openidea://pair?code=")).toBe(true);
    const offer = decodePairingUrl(url);
    expect(offer).toMatchObject({ endpoint: "ws://192.168.1.20:6768", deviceToken: "tok-123", publicKeyB64: "QUJD" });
  });

  it("accepts a bare code and rejects other schemes", () => {
    const url = pairingUrl("ws://127.0.0.1:6768", "tok", "QUJD");
    const code = new URL(url).searchParams.get("code")!;
    expect(decodePairingUrl(code)?.deviceToken).toBe("tok");
    expect(decodePairingUrl("orca://pair?code=abc")).toBeNull();
    expect(decodePairingUrl("openidea://pair?code=!!!")).toBeNull();
    expect(decodePairingUrl("not a url at all")).toBeNull();
  });
});
