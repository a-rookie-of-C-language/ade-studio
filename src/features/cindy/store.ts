/** Reachability of the embedded Cindy files (same origin, no sidecar port). */
import { create } from "zustand";
import { EMBED_PATH } from "./model";

export type CindyStatus = "unknown" | "checking" | "online" | "offline";

interface CindyState {
  status: CindyStatus;
  lastCheckedMs: number | null;
  check: () => Promise<boolean>;
  markOnline: () => void;
  markOffline: () => void;
}

export const useCindy = create<CindyState>((set) => ({
  status: "unknown",
  lastCheckedMs: null,
  check: async () => {
    set({ status: "checking" });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(EMBED_PATH, { method: "GET", signal: ctrl.signal });
      const online = res.ok;
      set({ status: online ? "online" : "offline", lastCheckedMs: Date.now() });
      return online;
    } catch {
      set({ status: "offline", lastCheckedMs: Date.now() });
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
  markOnline: () => set({ status: "online", lastCheckedMs: Date.now() }),
  markOffline: () => set({ status: "offline", lastCheckedMs: Date.now() }),
}));
