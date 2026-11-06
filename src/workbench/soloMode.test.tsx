import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { executeAction, getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { bindingsFor, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { registerToolWindow } from "./contributions";
import { isDistractionFree, resetDistractionFree, setDistractionFree } from "./distractionFree";
import { notificationActions } from "./Notifications";
import { clearNotifications, useNotifications } from "./notificationStore";
import {
  SOLO_MODE_ACTION,
  SOLO_MODE_HINT_KEY,
  SOLO_MODE_RIGHT_WIDTH,
  installSoloMode,
  isSoloMode,
  resetSoloMode,
  setSoloMode,
  soloModeHint,
  useSoloMode,
} from "./soloMode";
import {
  hideAllToolWindows,
  isToolWindowVisible,
  loadToolWindowLayout,
  resetToolWindowLayout,
  showToolWindow,
  useToolWindowLayout,
} from "./toolwindows/store";

const Empty = () => null;
let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetToolWindowLayout();
  resetDistractionFree();
  resetSoloMode();
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
    registerToolWindow({ id: "terminal", title: "Terminal", icon: "terminal", anchor: "bottom", component: Empty }),
    registerToolWindow({ id: "assistant", title: "Assistant", icon: "assistant", anchor: "right", component: Empty }),
  ];
  loadToolWindowLayout("/work/solo");
  showToolWindow("assistant");
  showToolWindow("terminal");
});

afterEach(() => {
  disposers.reverse().forEach((d) => d());
  resetSoloMode();
  resetDistractionFree();
  useKeymap.setState({ overrides: {} });
});

const savedVisible = () => JSON.parse(localStorage.getItem("openidea.layout.v1:/work/solo")!).visible;

describe("solo mode", () => {
  it("toggles with one action whose title flips Enter / Exit, publishing a context key", async () => {
    disposers.push(installSoloMode());
    expect(getAction(SOLO_MODE_ACTION)?.title).toBe("Enter Solo Mode");
    expect(getContext().soloMode).toBe(false);
    await executeAction(SOLO_MODE_ACTION);
    expect(isSoloMode()).toBe(true);
    expect(getContext().soloMode).toBe(true);
    expect(getAction(SOLO_MODE_ACTION)?.title).toBe("Exit Solo Mode");
    await executeAction(SOLO_MODE_ACTION);
    expect(isSoloMode()).toBe(false);
    expect(getAction(SOLO_MODE_ACTION)?.title).toBe("Enter Solo Mode");
  });

  it("is unbound by default", () => {
    expect(bindingsFor(SOLO_MODE_ACTION)).toEqual([]);
  });

  it("hides left and bottom, keeps the chat on the right at a usable width", () => {
    expect(useToolWindowLayout.getState().sizes.right).toBeLessThan(SOLO_MODE_RIGHT_WIDTH);
    setSoloMode(true);
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("terminal")).toBe(false);
    expect(isToolWindowVisible("assistant")).toBe(true);
    expect(useToolWindowLayout.getState().sizes.right).toBeGreaterThanOrEqual(SOLO_MODE_RIGHT_WIDTH);
    // A window opened meanwhile (by shortcut) is gone again after exit.
    showToolWindow("terminal");
    expect(isToolWindowVisible("terminal")).toBe(true);
    setSoloMode(false);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
    expect(useToolWindowLayout.getState().sizes.right).toBeLessThan(SOLO_MODE_RIGHT_WIDTH);
  });

  it("persists the layout to restore, not the solo one", () => {
    setSoloMode(true);
    showToolWindow("terminal");
    expect(savedVisible()).toMatchObject({ left: "project", bottom: "terminal", right: "assistant" });
    // Leaving the mode (now or after a restart) loads the normal layout.
    resetSoloMode();
    resetToolWindowLayout();
    loadToolWindowLayout("/work/solo");
    expect(isToolWindowVisible("project")).toBe(true);
    expect(isToolWindowVisible("terminal")).toBe(true);
  });

  it("does not disturb Hide All Tool Windows", () => {
    setSoloMode(true);
    hideAllToolWindows();
    setSoloMode(false);
    expect(useToolWindowLayout.getState().stashed).toBeNull();
    expect(isToolWindowVisible("project")).toBe(true);
  });

  it("entering exits Distraction Free Mode first", () => {
    setDistractionFree(true);
    expect(isToolWindowVisible("project")).toBe(false);
    setSoloMode(true);
    expect(isDistractionFree()).toBe(false);
    expect(isSoloMode()).toBe(true);
    expect(isToolWindowVisible("assistant")).toBe(true);
    setSoloMode(false);
  });

  it("survives an app restart and re-applies to a newly loaded project", () => {
    setSoloMode(true);
    expect(localStorage.getItem("openidea.soloMode")).toBe("1");
    // Restart: fresh module, layout and session state; only localStorage remains.
    sessionStorage.clear();
    useSoloMode.setState({ active: false });
    resetToolWindowLayout();
    disposers.push(installSoloMode());
    expect(isSoloMode()).toBe(true);
    loadToolWindowLayout("/work/solo");
    expect(isToolWindowVisible("project")).toBe(false);
    expect(isToolWindowVisible("assistant")).toBe(true);
    setSoloMode(false);
    expect(isToolWindowVisible("project")).toBe(true);
    expect(localStorage.getItem("openidea.soloMode")).toBeNull();
  });

  describe("exit hint", () => {
    const hint = () => useNotifications.getState().items.find((n) => n.key === SOLO_MODE_HINT_KEY);
    beforeEach(() => clearNotifications());

    it("tells how to leave the mode on entering, with an Exit action, and expires on exit", () => {
      setSoloMode(true);
      expect(hint()?.balloon).toBe(true);
      expect(hint()?.body).toBe(soloModeHint());
      expect(soloModeHint()).toContain("View | Exit Solo Mode");
      // Unbound toggle: Find Action with its shortcut is the keyboard way out.
      expect(soloModeHint()).toMatch(/Find Action \(.+\)/);
      act(() => {
        hint()!
          .actions!.find((a) => a.label === "Exit Solo Mode")!
          .run();
      });
      expect(isSoloMode()).toBe(false);
      expect(hint()?.balloon ?? false).toBe(false);
    });

    it("names the toggle's own shortcut when it has one", () => {
      useKeymap.setState({ overrides: { [SOLO_MODE_ACTION]: ["Ctrl+Alt+O"] } });
      expect(soloModeHint()).not.toContain("Find Action");
    });

    it("shows again after a restart in the mode, once the project frame loads", () => {
      setSoloMode(true);
      clearNotifications();
      useSoloMode.setState({ active: false });
      resetToolWindowLayout();
      disposers.push(installSoloMode());
      expect(isSoloMode()).toBe(true);
      expect(hint()).toBeUndefined();
      loadToolWindowLayout("/work/solo");
      expect(hint()?.balloon).toBe(true);
    });

    it("offers Don't Show Again once, scoped to its own notification group", () => {
      setSoloMode(true);
      const labels = notificationActions(hint()!).map((a) => a.label);
      expect(labels.filter((l) => l === "Don't Show Again")).toHaveLength(1);
      expect(hint()!.group).toBe("soloMode");
    });

    it("stays off once its group shows no popup", () => {
      const settings = useProject.getState().settings;
      useProject.setState({
        settings: { ...settings, notifications: { groups: { soloMode: { display: "none" } } } } as never,
      });
      try {
        setSoloMode(true);
        expect(hint()?.balloon ?? false).toBe(false);
      } finally {
        useProject.setState({ settings });
      }
    });
  });

  describe("solo shell", () => {
    it("hides tabs, banners, status bar and stripes, keeping a bare title bar", async () => {
      const { render, screen } = await import("@testing-library/react");
      const { act } = await import("react");
      const { Workbench } = await import("./Workbench");
      const { registerStatusItem } = await import("./contributions");
      const { useProject: useProjectStore } = await import("@/platform/project");
      disposers.push(
        registerStatusItem({ id: "t.status", align: "left", priority: 0, component: () => <span>status-x</span> }),
      );
      act(() =>
        useProjectStore.setState({
          project: { root: "/work/solo", name: "solo-demo", trusted: true, isGit: false, settings: {} },
        }),
      );
      const { unmount } = render(<Workbench />);
      expect(await screen.findByText("solo-demo")).toBeInTheDocument();
      expect(screen.getByText("status-x")).toBeInTheDocument();

      act(() => setSoloMode(true));
      // Project name (tabs/status chrome) and status items are gone, as are
      // the tool window stripes; the bare bar keeps the drag region only.
      expect(screen.queryByText("solo-demo")).toBeNull();
      expect(screen.queryByText("status-x")).toBeNull();
      expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
      const bar = document.querySelector("header[data-titlebar='bare']");
      expect(bar?.hasAttribute("data-tauri-drag-region") || bar?.hasAttribute("data-window-drag-region")).toBe(true);

      act(() => setSoloMode(false));
      expect(screen.getByText("solo-demo")).toBeInTheDocument();
      expect(screen.getByText("status-x")).toBeInTheDocument();
      unmount();
      useProjectStore.setState({ project: null });
    });
  });
});
