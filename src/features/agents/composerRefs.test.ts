import { describe, expect, it } from "vitest";
import {
  effectiveFiles,
  effectivePastes,
  expandPastes,
  foldPasted,
  pastedIds,
  removeMention,
  removePasteToken,
  shouldFoldPasted,
  toPrompt,
  type FileRef,
} from "./composerModel";

const ref = (rel: string, path = `/root/${rel.replace(/\/$/, "")}`): FileRef => ({ path, rel });

describe("effectiveFiles", () => {
  it("keeps files still mentioned in the text, each once", () => {
    const draft = {
      text: "fix @a.ts and @a.ts plus @b/",
      files: [ref("a.ts"), ref("a.ts"), ref("b/")],
      images: [],
      pastes: [],
    };
    expect(effectiveFiles(draft).map((f) => f.rel)).toEqual(["a.ts", "b/"]);
  });
  it("drops files whose mention was deleted", () => {
    const draft = { text: "fix this", files: [ref("a.ts")], images: [], pastes: [] };
    expect(effectiveFiles(draft)).toEqual([]);
  });
  it("does not match a longer name sharing the prefix", () => {
    const draft = { text: "look at @a.ts", files: [ref("a.tsx")], images: [], pastes: [] };
    expect(effectiveFiles(draft)).toEqual([]);
  });
  it("keeps files mentioned with a line range", () => {
    const draft = { text: "see @a.ts:10-20", files: [ref("a.ts")], images: [], pastes: [] };
    expect(effectiveFiles(draft).map((f) => f.rel)).toEqual(["a.ts"]);
  });
});

describe("removeMention", () => {
  it("drops every mention and tidies the gap", () => {
    expect(removeMention("fix @a.ts and @a.ts:1-3 now", "a.ts")).toBe("fix and now");
  });
  it("leaves longer names sharing the prefix alone", () => {
    expect(removeMention("see @a.tsx", "a.ts")).toBe("see @a.tsx");
  });
  it("trims the result", () => {
    expect(removeMention("@a.ts", "a.ts")).toBe("");
  });
});

describe("toPrompt", () => {
  it("sends only the still-mentioned files", () => {
    const draft = { text: "fix @a.ts", files: [ref("a.ts"), ref("gone.ts")], images: [], pastes: [] };
    expect(toPrompt(draft).files).toEqual(["/root/a.ts"]);
  });
  it("expands folded pastes", () => {
    const { paste, token } = foldPasted("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9");
    const draft = { text: `look:\n${token}\nthanks`, files: [], images: [], pastes: [paste] };
    expect(toPrompt(draft).text).toBe("look:\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nthanks");
  });
});

describe("shouldFoldPasted", () => {
  it("keeps snippets inline and folds logs", () => {
    expect(shouldFoldPasted("const x = 1;")).toBe(false);
    expect(shouldFoldPasted("   \n  ")).toBe(false);
    expect(shouldFoldPasted(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
    expect(shouldFoldPasted("x".repeat(1201))).toBe(true);
  });
});

describe("folded pastes", () => {
  it("round-trips the token back to the entry", () => {
    const { paste, token } = foldPasted("a\nb");
    expect(pastedIds(`${token}`)).toEqual([paste.id]);
  });
  it("lists pastes in token order without duplicates", () => {
    const a = foldPasted("a1\na2\na3\na4\na5\na6\na7\na8\na9");
    const b = foldPasted("b1\nb2\nb3\nb4\nb5\nb6\nb7\nb8\nb9");
    const draft = {
      text: `${b.token}\nmid\n${a.token}\n${a.token}`,
      files: [],
      images: [],
      pastes: [a.paste, b.paste],
    };
    expect(effectivePastes(draft).map((p) => p.id)).toEqual([b.paste.id, a.paste.id]);
  });
  it("drops tokens whose entry is gone", () => {
    expect(effectivePastes({ text: "[Pasted 3 lines #nope]", files: [], images: [], pastes: [] })).toEqual([]);
  });
  it("expands known tokens and leaves unknown ones visible", () => {
    const { paste, token } = foldPasted("x\ny");
    const draft = { text: `a\n${token}\n[Pasted 3 lines #nope]\nb`, files: [], images: [], pastes: [paste] };
    expect(expandPastes(draft)).toBe("a\nx\ny\n[Pasted 3 lines #nope]\nb");
  });
  it("removes the token line and tidies the gap", () => {
    const { paste, token } = foldPasted("x\ny");
    expect(removePasteToken(`first\n${token}\nlast`, paste.id)).toBe("first\nlast");
    expect(removePasteToken(token, paste.id)).toBe("");
  });
});
