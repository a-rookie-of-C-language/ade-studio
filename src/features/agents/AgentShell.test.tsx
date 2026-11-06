import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getContext } from "@/platform/context";
import { useAgents } from "./store";
import { isAgentMode, resetAgentMode, setAgentMode } from "./agentMode";
import { AgentShell } from "./AgentShell";
import type { AgentTask } from "@/bindings";

vi.mock("./HomeEditor", () => ({ HomeEditor: () => <div>home-stub</div> }));
vi.mock("./SessionEditor", () => ({
  SessionEditor: () => <div>session-stub</div>,
}));

const task = (id: string, title: string): AgentTask => ({
  id,
  title,
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "/project",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetAgentMode();
  useAgents.setState({
    tasks: new Map(),
    docked: null,
    lastTask: null,
    homeOpen: true,
    sessionLocation: "toolWindow",
  });
});

afterEach(() => {
  cleanup();
});

describe("AgentShell", () => {
  it("shows the agent nav, centered home, and an IDE way back", async () => {
    const one = task("one", "Analyze project");
    useAgents.setState({ tasks: new Map([[one.id, one]]), homeOpen: true });
    setAgentMode(true);
    render(<AgentShell />);
    expect(screen.getByText("New Task")).toBeInTheDocument();
    expect(screen.getByText("Plugin Market")).toBeInTheDocument();
    expect(screen.getByText("Analyze project")).toBeInTheDocument();
    expect(screen.getByText("home-stub")).toBeInTheDocument();
    const ide = screen.getByRole("button", { name: "IDE ↗" });
    expect(ide).toHaveTextContent("IDE");
    fireEvent.click(ide);
    expect(isAgentMode()).toBe(false);
    expect(getContext().agentMode).toBe(false);
  });

  it("shows the docked session in the center column", async () => {
    const one = task("one", "Analyze project");
    useAgents.setState({
      tasks: new Map([[one.id, one]]),
      homeOpen: false,
      docked: "one",
      lastTask: "one",
    });
    render(<AgentShell />);
    expect(screen.getByText("session-stub")).toBeInTheDocument();
  });
});
