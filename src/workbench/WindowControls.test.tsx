import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { useAgents } from "@/features/agents/store";
import { AgentButton } from "./WindowControls";

describe("AgentButton", () => {
  it("stays hidden without a project and jumps back to Cowork in the same window", async () => {
    const run = vi.fn();
    const dispose = registerActions([{ id: "file.closeProject", title: "Close Project", category: "File", run }]);
    try {
      useProject.setState({ project: null });
      const hidden = render(<AgentButton />);
      expect(screen.queryByRole("button", { name: "Back to Cowork" })).toBeNull();
      hidden.unmount();

      // No session: plain close.
      useAgents.setState({ tasks: new Map(), docked: null, lastTask: null, homeOpen: true });
      useProject.setState({ project: { root: "/p" } as never });
      const { unmount } = render(<AgentButton />);
      let button = screen.getByRole("button", { name: "Back to Cowork" });
      expect(button).toHaveTextContent("Agent");
      fireEvent.click(button);
      expect(run).toHaveBeenCalledTimes(1);
      unmount();

      // Centered session: carried back via the same close action.
      useAgents.setState({
        tasks: new Map([["A", { id: "A", updatedMs: 1 } as never]]),
        docked: null,
        lastTask: "A",
        homeOpen: false,
      });
      render(<AgentButton />);
      button = screen.getByRole("button", { name: "Back to Cowork" });
      fireEvent.click(button);
      expect(run).toHaveBeenCalledTimes(2);
      useProject.setState({ project: null });
    } finally {
      dispose();
    }
  });
});
