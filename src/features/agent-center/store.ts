import { create } from "zustand";

interface AgentCenterState {
  open: boolean;
}

export const useAgentCenter = create<AgentCenterState>(() => ({ open: false }));

export function openAgentCenter(): void {
  useAgentCenter.setState({ open: true });
}

export function closeAgentCenter(): void {
  useAgentCenter.setState({ open: false });
}
