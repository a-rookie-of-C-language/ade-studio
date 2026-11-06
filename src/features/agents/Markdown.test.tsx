import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Markdown, renderUserText } from "./Markdown";
import styles from "./Session.module.css";

const { openFile, openExternalUrl, notify } = vi.hoisted(() => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn(),
}));
vi.mock("@/workbench/contributions", () => ({
  editorService: () => ({ openFile }),
  notifications: () => ({ notify }),
}));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));

const { fsProbe, openLightEdit, projectState } = vi.hoisted(() => ({
  fsProbe: vi.fn(),
  openLightEdit: vi.fn().mockResolvedValue(undefined),
  projectState: {
    current: { project: { root: "/repo" } as { root: string } | null, lightEdit: false },
  },
}));
vi.mock("@/platform/ipc", async (original) => {
  const mod = await original<typeof import("@/platform/ipc")>();
  return { ...mod, commands: { ...mod.commands, fsProbe } };
});

vi.mock("@/platform/project", async (original) => {
  const mod = await original<typeof import("@/platform/project")>();
  return { ...mod, openLightEdit, useProject: { getState: () => projectState.current } };
});

beforeEach(() => {
  vi.clearAllMocks();
  projectState.current = { project: { root: "/repo" }, lightEdit: false };
});

it.each([
  "<style>body{outline:7px solid red}</style>",
  '<form action="https://example.com/x"><button>go</button></form>',
  '<div style="position:fixed">x</div>',
  '<link rel="stylesheet" href="https://example.com/x.css">',
  '<meta http-equiv="refresh" content="0;url=https://example.com">',
  '<base href="https://example.com/">',
  '<iframe src="https://example.com"></iframe>',
  '<button formaction="https://example.com/x">go</button>',
])("keeps raw markup from reaching the page: %s", (raw) => {
  const { container } = render(<Markdown text={`text\n\n${raw}`} cwd="/repo" />);
  expect(container.querySelector("style, form, link, meta, base, iframe, [style], [formaction]")).toBeNull();
  expect(container.textContent).not.toContain("outline");
});

it("ignores data attributes written in a reply, keeping its own", () => {
  const { container } = render(
    <Markdown
      text={'<button data-copy="evil">x</button>\n\n<code data-path="/etc/passwd">y</code>\n\n```ts\nconst a = 1;\n```'}
      cwd="/repo"
    />,
  );
  expect(container.querySelector("code[data-path]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "x" }));
  fireEvent.click(container.querySelector("code")!);
  expect(openFile).not.toHaveBeenCalled();
  expect(
    [...container.querySelectorAll<HTMLElement>("button[data-copy]")].map((button) => button.dataset.copy),
  ).toEqual(["const a = 1;"]);
});

it.each([
  ["/Users/thomas/vmos-shots/tiktok-home.jpg", "/Users/thomas/vmos-shots/tiktok-home.jpg", undefined],
  ["images/home.jpg", "/repo/images/home.jpg", undefined],
  ["/tmp/截图%20one.jpg", "/tmp/截图 one.jpg", undefined],
  ["/repo/main.rs:12:5", "/repo/main.rs", { line: 11, col: 4 }],
  ["/repo/main.rs#L7", "/repo/main.rs", { line: 6, col: 0 }],
])("opens a Markdown file link: %s", (href, path, selection) => {
  render(<Markdown text={`[查看文件](${href})`} cwd="/repo" />);
  fireEvent.click(screen.getByRole("link", { name: "查看文件" }));
  expect(openFile).toHaveBeenCalledWith(path, { focus: true, selection });
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it("keeps web links external", () => {
  render(<Markdown text="[Website](https://example.com/image.jpg)" cwd="/repo" />);
  fireEvent.click(screen.getByRole("link"));
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/image.jpg");
  expect(openFile).not.toHaveBeenCalled();
});

it.each(["#section", "//example.com/image.jpg", "javascript:alert(1)", "/tmp/%ZZ.jpg"])(
  "does not open unsupported links as files: %s",
  (href) => {
    const { container } = render(<Markdown text={`[Link](${href})`} cwd="/repo" />);
    fireEvent.click(container.querySelector("a")!);
    expect(openFile).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  },
);

it("links a user message code chip to an existing file", async () => {
  fsProbe.mockResolvedValue({ status: "ok", data: null });
  const { container } = render(<div>{renderUserText("see `user-link-a.md`", "/repo")}</div>);
  const code = container.querySelector("code")!;
  await waitFor(() => expect(code.classList.contains(styles.fileLink!)).toBe(true));
  fireEvent.click(code);
  expect(openFile).toHaveBeenCalledWith("/repo/user-link-a.md", { focus: true, selection: undefined });
});

it("leaves a user message chip plain when the file is missing", async () => {
  fsProbe.mockRejectedValue(new Error("missing"));
  const { container } = render(<div>{renderUserText("see `user-miss-b.md`", "/repo")}</div>);
  const code = container.querySelector("code")!;
  await waitFor(() => expect(fsProbe).toHaveBeenCalled());
  expect(code.classList.contains(styles.fileLink!)).toBe(false);
  fireEvent.click(code);
  expect(openFile).not.toHaveBeenCalled();
});

it("does not probe user text that is not a file path", () => {
  render(<div>{renderUserText("run `foo()` now", "/repo")}</div>);
  expect(fsProbe).not.toHaveBeenCalled();
});

it("opens LightEdit first when no project is open (cowork home)", async () => {
  projectState.current = { project: null, lightEdit: false };
  render(<Markdown text={`see [CLAUDE.md](CLAUDE.md)`} cwd="/repo" />);
  fireEvent.click(screen.getByRole("link", { name: "CLAUDE.md" }));
  await waitFor(() => expect(openLightEdit).toHaveBeenCalledWith("/repo/CLAUDE.md"));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith("/repo/CLAUDE.md", { focus: true, selection: undefined }));
});

it("opens directly when a project is open", async () => {
  render(<Markdown text={`see [CLAUDE.md](CLAUDE.md)`} cwd="/repo" />);
  fireEvent.click(screen.getByRole("link", { name: "CLAUDE.md" }));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith("/repo/CLAUDE.md", { focus: true, selection: undefined }));
  expect(openLightEdit).not.toHaveBeenCalled();
});

it("toasts when the file cannot be opened", async () => {
  openFile.mockRejectedValueOnce(new Error("gone"));
  render(<Markdown text={`see [CLAUDE.md](CLAUDE.md)`} cwd="/repo" />);
  fireEvent.click(screen.getByRole("link", { name: "CLAUDE.md" }));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(notify.mock.calls[0]![0]).toMatchObject({ level: "error" });
});
