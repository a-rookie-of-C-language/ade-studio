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

describe("pasted text chips", () => {
  const longText = Array.from({ length: 11 }, (_, i) => `log line ${i}`).join("\n");
  const pasteEvent = (text: string) => ({
    clipboardData: { files: [] as File[], getData: (_type: string) => text },
  });
  it("folds a long paste into a chip and expands it for sending", () => {
    updateComposer("test", { text: "" });
    render(<Composer {...props} />);
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), pasteEvent(longText));
    expect(screen.getByText("11 lines")).toBeInTheDocument();
    const draft = composerDraft("test");
    expect(draft.pastes).toHaveLength(1);
    expect(draft.text).toMatch(/\[Pasted 11 lines #[a-z0-9]+\]/);
    // The token line (not the 11 lines) is what sits in the box.
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(draft.text);
  });
  it("removes the chip and its token together", () => {
    updateComposer("test", { text: "" });
    render(<Composer {...props} />);
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), pasteEvent(longText));
    fireEvent.click(screen.getByRole("button", { name: "Remove pasted text" }));
    expect(composerDraft("test").pastes).toEqual([]);
    expect(composerDraft("test").text).toBe("");
    expect(screen.queryByText("11 lines")).not.toBeInTheDocument();
  });
  it("leaves short pastes inline", () => {
    updateComposer("test", { text: "" });
    render(<Composer {...props} />);
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), pasteEvent("just a note"));
    expect(composerDraft("test").pastes).toEqual([]);
    expect(screen.queryByText("Remove pasted text")).not.toBeInTheDocument();
  });
});
