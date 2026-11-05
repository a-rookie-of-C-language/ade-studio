import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useTerminals } from "./store";
import { TerminalStatusBar, statusTone } from "./StatusBar";
import type { SessionSnapshot } from "./session";

const snap = (patch: Partial<SessionSnapshot>): SessionSnapshot => ({
  status: "running",
  exitCode: null,
  title: "pwsh",
  appTitle: null,
  commandRunning: false,
  cwd: "D:\\code\\demo",
  follow: true,
  ...patch,
});

afterEach(() => useTerminals.setState({ sessions: {} }));

describe("statusTone", () => {
  it("marks starting sessions and running commands busy", () => {
    expect(statusTone(snap({ status: "starting" }))).toBe("busy");
    expect(statusTone(snap({ commandRunning: true, appTitle: "vim" }))).toBe("busy");
  });

  it("marks idle shells idle", () => {
    expect(statusTone(snap({}))).toBe("idle");
    expect(statusTone(snap({ status: "idle" }))).toBe("idle");
  });

  it("marks exits done or bad by their code", () => {
    expect(statusTone(snap({ status: "exited", exitCode: 0 }))).toBe("done");
    expect(statusTone(snap({ status: "exited", exitCode: 2 }))).toBe("bad");
    expect(statusTone(snap({ status: "error", exitCode: null }))).toBe("bad");
  });
});

describe("TerminalStatusBar", () => {
  it("shows the shell and directory while idle", () => {
    useTerminals.setState({ sessions: { s1: snap({}) } });
    render(<TerminalStatusBar sessionKey="s1" />);
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("pwsh");
    expect(bar.textContent).toContain("D:\\code\\demo");
  });

  it("shows the running program while a command runs", () => {
    useTerminals.setState({ sessions: { s1: snap({ commandRunning: true, appTitle: "vim" }) } });
    render(<TerminalStatusBar sessionKey="s1" />);
    expect(screen.getByRole("status").textContent).toContain("vim");
  });

  it("shows the exit code with a restart action when the session ends", () => {
    useTerminals.setState({ sessions: { s1: snap({ status: "exited", exitCode: 2 }) } });
    render(<TerminalStatusBar sessionKey="s1" />);
    expect(screen.getByRole("status").textContent).toContain("exit 2");
    expect(screen.getByRole("button", { name: "Restart Session" })).toBeDefined();
  });

  it("renders nothing without a session", () => {
    const { container } = render(<TerminalStatusBar sessionKey="missing" />);
    expect(container.firstChild).toBeNull();
  });
});
