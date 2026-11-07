import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { composerDraft, updateComposer, useAgents } from "./store";

const props = {
  id: "test",
  placeholder: "Ask",
  root: "/root",
  projectRoot: "/root",
  commands: [],
  history: [],
  config: [],
  onSubmit: vi.fn(),
};

beforeEach(() => {
  useAgents.setState({ composers: new Map() });
});

describe("reference chips", () => {
  it("shows referenced files as chips and unreferences on remove", () => {
    updateComposer("test", { text: "fix @a.ts now", files: [{ path: "/root/a.ts", rel: "a.ts" }] });
    render(<Composer {...props} />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove reference" }));
    expect(composerDraft("test").text).toBe("fix now");
    expect(composerDraft("test").files).toEqual([]);
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });
  it("hides files whose mention was deleted from the text", () => {
    updateComposer("test", { text: "fix this", files: [{ path: "/root/a.ts", rel: "a.ts" }] });
    render(<Composer {...props} />);
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });
});
