import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { executeAction, getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { bindingsFor, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { provideEditorService, provideToolWindowService, registerToolWindow } from "@/workbench/contributions";
import { isDistractionFree, resetDistractionFree, setDistractionFree } from "@/workbench/distractionFree";
import { notificationActions } from "@/workbench/Notifications";
import { clearNotifications, useNotifications } from "@/workbench/notificationStore";
import {
  hideAllToolWindows,
  isToolWindowVisible,
  loadToolWindowLayout,
  resetToolWindowLayout,
  showToolWindow,
  useToolWindowLayout,
} from "@/workbench/toolwindows/store";
import {
  AGENT_MODE_ACTION,
  AGENT_MODE_HINT_KEY,
  AGENT_MODE_RIGHT_WIDTH,
  agentModeHint,
  installAgentMode,
  isAgentMode,
  resetAgentMode,
  setAgentMode,
  useAgentMode,
} from "./agentMode";
import { TOOL_WINDOW } from "./model";
import { setSessionLocation, useAgents } from "./store";
import type { AgentTask } from "@/bindings";

const Empty = () => null;
let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetToolWindowLayout();
  resetDistractionFree();
  resetAgentMode();
  provideEditorService({
    activeInput: () => null,
    openTabs: () => [],
    closeInput: async () => true,
    openInput: async () => {},
  } as never);
  provideToolWindowService({ show: () => {}, hide: () => {}, toggle: () => {}, isVisible: () => false });
  useAgents.setState({ sessionLocation: "editor", docked: null, homeOpen: false, tasks: new Map(), lastTask: null });
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
    registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: Empty }),
    registerToolWindow({
      id: TOOL_WINDOW,
      title: "Agents",
      icon: "toolwindow-agents",
      anchor: "right",
      component: Empty,
    }),
    registerToolWindow({ id: "structure", title: "Structure", icon: "structure", anchor: "right", component: Empty }),
  ];
  loadToolWindowLayout("/work/agent");
  showToolWindow("terminal");
});

afterEach(() => {
  disposers.reverse().forEach((d) => d());
  resetAgentMode();
  resetDistractionFree();
  useKeymap.setState({ overrides: {} });
});

const savedLayout = () => JSON.parse(localStorage.getItem("openidea.layout.v1:/work/agent")!);

const task = (id: string): AgentTask => ({
  id,
  title: id,
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

describe("agent mode", () => {
  it("toggles with one action whose title flips Enter / Exit, publishing a context key", async () => {
    disposers.push(installAgentMode());
    expect(getAction(AGENT_MODE_ACTION)?.title).toBe("Enter Agent Mode");
    expect(getContext().agentMode).toBe(false);
    await executeAction(AGENT_MODE_ACTION);
    expect(isAgentMode()).toBe(true);
    expect(getContext().agentMode).toBe(true);
    expect(getAction(AGENT_MODE_ACTION)?.title).toBe("Exit Agent Mode");
    await executeAction(AGENT_MODE_ACTION);
    expect(isAgentMode()).toBe(false);
    expect(getAction(AGENT_MODE_ACTION)?.title).toBe("Enter Agent Mode");
  });

  it("is unbound by default", () => {
    expect(bindingsFor(AGENT_MODE_ACTION)).toEqual([]);
  });

  it("keeps the left side, hides the bottom and pins Agents right at a usable width", () => {
    expect(useToolWindowLayout.getState().sizes.right).toBeLessThan(AGENT_MODE_RIGHT_WIDTH);
    setAgentMode(true);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(true);
    expect(useToolWindowLayout.getState().sizes.right).toBeGreaterThanOrEqual(AGENT_MODE_RIGHT_WIDTH);
    expect(useToolWindowLayout.getState().focusRequest?.id).toBe(TOOL_WINDOW);
    // A window opened meanwhile (by shortcut) is gone again after exit.
    showToolWindow("structure");
    expect(isToolWindowVisible("structure")).toBe(true);
    setAgentMode(false);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(false);
    expect(isToolWindowVisible("structure")).toBe(false);
    expect(useToolWindowLayout.getState().sizes.right).toBeLessThan(AGENT_MODE_RIGHT_WIDTH);
  });

  it("persists the layout to restore, not the agent one", () => {
    setAgentMode(true);
    showToolWindow("structure");
    expect(savedLayout().visible).toMatchObject({ left: "project", bottom: "terminal", right: null });
    expect(savedLayout().sizes.right).toBeLessThan(AGENT_MODE_RIGHT_WIDTH);
    // Leaving the mode (now or after a restart) loads the normal layout.
    resetAgentMode();
    resetToolWindowLayout();
    loadToolWindowLayout("/work/agent");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(false);
  });

  it("does not disturb Hide All Tool Windows", () => {
    setAgentMode(true);
    hideAllToolWindows();
    setAgentMode(false);
    expect(useToolWindowLayout.getState().stashed).toBeNull();
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("entering exits Distraction Free Mode first", () => {
    setDistractionFree(true);
    expect(isToolWindowVisible("project")).toBe(false);
    setAgentMode(true);
    expect(isDistractionFree()).toBe(false);
    expect(isAgentMode()).toBe(true);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(true);
    setAgentMode(false);
  });

  it("nests Distraction Free Mode entered on top, returning to the agent layout", () => {
    setAgentMode(true);
    setDistractionFree(true);
    expect(isAgentMode()).toBe(true);
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(false);
    setDistractionFree(false);
    expect(isAgentMode()).toBe(true);
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(true);
    setAgentMode(false);
    expect(isToolWindowVisible("terminal")).toBe(true);
  });

  it("survives an app restart and re-applies to a newly loaded project", () => {
    setAgentMode(true);
    expect(localStorage.getItem("openidea.agentMode")).toBe("1");
    // Restart: fresh module, layout and session state; only localStorage remains.
    sessionStorage.clear();
    useAgentMode.setState({ active: false });
    resetToolWindowLayout();
    disposers.push(installAgentMode());
    expect(isAgentMode()).toBe(true);
    loadToolWindowLayout("/work/agent");
    expect(isToolWindowVisible(TOOL_WINDOW)).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(false);
    setAgentMode(false);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(localStorage.getItem("openidea.agentMode")).toBeNull();
  });

  describe("exit hint", () => {
    const hint = () => useNotifications.getState().items.find((n) => n.key === AGENT_MODE_HINT_KEY);
    beforeEach(() => clearNotifications());

    it("tells how to leave the mode on entering, with an Exit action, and expires on exit", () => {
      setAgentMode(true);
      expect(hint()?.balloon).toBe(true);
      expect(hint()?.body).toBe(agentModeHint());
      expect(agentModeHint()).toContain("View | Exit Agent Mode");
      // Unbound toggle: Find Action with its shortcut is the keyboard way out.
      expect(agentModeHint()).toMatch(/Find Action \(.+\)/);
      act(() => {
        hint()!
          .actions!.find((a) => a.label === "Exit Agent Mode")!
          .run();
      });
      expect(isAgentMode()).toBe(false);
      expect(hint()?.balloon ?? false).toBe(false);
    });

    it("names the toggle's own shortcut when it has one", () => {
      useKeymap.setState({ overrides: { [AGENT_MODE_ACTION]: ["Ctrl+Alt+A"] } });
      expect(agentModeHint()).not.toContain("Find Action");
    });

    it("shows again after a restart in the mode, once the project frame loads", () => {
      setAgentMode(true);
      clearNotifications();
      useAgentMode.setState({ active: false });
      resetToolWindowLayout();
      disposers.push(installAgentMode());
      expect(isAgentMode()).toBe(true);
      expect(hint()).toBeUndefined();
      loadToolWindowLayout("/work/agent");
      expect(hint()?.balloon).toBe(true);
    });

    it("offers Don't Show Again once, scoped to its own notification group", () => {
      setAgentMode(true);
      const labels = notificationActions(hint()!).map((a) => a.label);
      expect(labels.filter((l) => l === "Don't Show Again")).toHaveLength(1);
      expect(hint()!.group).toBe("agentMode");
    });

    it("stays off once its group shows no popup", () => {
      const settings = useProject.getState().settings;
      useProject.setState({
        settings: { ...settings, notifications: { groups: { agentMode: { display: "none" } } } } as never,
      });
      try {
        setAgentMode(true);
        expect(hint()?.balloon ?? false).toBe(false);
      } finally {
        useProject.setState({ settings });
      }
    });
  });

  describe("right-side conversation", () => {
    beforeEach(() => {
      // Docking targets the project frame's right tool window: pretend a
      // project is open (Cowork has no tool window and stays centered).
      useProject.setState({
        project: { root: "/work/agent", name: "agent", trusted: true, isGit: false, settings: {} as never },
        lightEdit: false,
      });
    });
    afterEach(() => {
      useProject.setState({ project: null, lightEdit: false });
    });
    it("docks the conversation on the right when entering, keeping it there on exit (TRAE IDE)", () => {
      expect(useAgents.getState().sessionLocation).toBe("editor");
      setAgentMode(true);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      expect(useAgents.getState().homeOpen).toBe(true);
      setAgentMode(false);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      expect(localStorage.getItem("openidea.agentMode.sessionLocation")).toBeNull();
    });

    it("docks the open task instead of its editor tab", () => {
      const one = task("one");
      useAgents.setState({ tasks: new Map([[one.id, one]]) });
      setAgentMode(true);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      expect(useAgents.getState().docked).toBe("one");
      setAgentMode(false);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      expect(useAgents.getState().docked).toBe("one");
    });

    it("docks the centered fallback session when already on the right", () => {
      const one = { ...task("one"), updatedMs: 10 };
      const two = { ...task("two"), updatedMs: 20 };
      useAgents.setState({
        tasks: new Map([
          [one.id, one],
          [two.id, two],
        ]),
        sessionLocation: "toolWindow",
        docked: null,
        lastTask: null,
        homeOpen: false,
      });
      setAgentMode(true);
      // The shell centers the newest task; carry it so the IDE keeps it on exit.
      expect(useAgents.getState().docked).toBe("two");
      expect(useAgents.getState().lastTask).toBe("two");
      setAgentMode(false);
      expect(useAgents.getState().docked).toBe("two");
    });

    it("exiting carries a session centered mid-mode into the docked slot", () => {
      setAgentMode(true);
      const one = task("one");
      // A task arriving mid-mode centers as an undocked fallback in the shell.
      useAgents.setState({
        tasks: new Map([[one.id, one]]),
        docked: null,
        lastTask: "one",
        homeOpen: false,
      });
      setAgentMode(false);
      expect(useAgents.getState().docked).toBe("one");
      expect(useAgents.getState().homeOpen).toBe(false);
    });

    it("keeps an editor placement that was already docked", () => {
      setSessionLocation("toolWindow");
      setAgentMode(true);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      setAgentMode(false);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
    });

    it("re-docks on the right on exit even after a mid-mode undock (TRAE IDE)", () => {
      setAgentMode(true);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      setSessionLocation("editor");
      expect(useAgents.getState().sessionLocation).toBe("editor");
      setAgentMode(false);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
    });

    it("stays docked across a restart and keeps the right side on exit", () => {
      setAgentMode(true);
      expect(localStorage.getItem("openidea.agentMode.sessionLocation")).toBe("editor");
      // Restart: fresh module and session state; only localStorage remains.
      sessionStorage.clear();
      useAgentMode.setState({ active: false });
      resetToolWindowLayout();
      useAgents.setState({ sessionLocation: "editor", docked: null, homeOpen: false });
      disposers.push(installAgentMode());
      expect(isAgentMode()).toBe(true);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      setAgentMode(false);
      expect(useAgents.getState().sessionLocation).toBe("toolWindow");
      expect(localStorage.getItem("openidea.agentMode.sessionLocation")).toBeNull();
    });
  });
});
