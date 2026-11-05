// Saved pairing state. The client keypair is stable per phone so reconnects
// reuse the same identity; the server key is pinned from the QR.
import * as SecureStore from "expo-secure-store";

export type SavedSession = {
  endpoint: string;
  deviceToken: string;
  serverPublicKeyB64: string;
  serverKeyPinned: boolean;
  clientPublicB64: string;
  clientSecretB64: string;
};

const KEY = "openidea-mobile-session-v1";

export async function loadSession(): Promise<SavedSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedSession>;
    if (!v.endpoint || !v.deviceToken || !v.serverPublicKeyB64 || !v.clientSecretB64) return null;
    return v as SavedSession;
  } catch {
    return null;
  }
}

export async function saveSession(s: SavedSession): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(s));
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
