import { describe, expect, it } from "vitest";
import { effectiveFiles, removeMention, toPrompt, type FileRef } from "./composerModel";

const ref = (rel: string, path = `/root/${rel.replace(/\/$/, "")}`): FileRef => ({ path, rel });

describe("effectiveFiles", () => {
  it("keeps files still mentioned in the text, each once", () => {
    const draft = {
      text: "fix @a.ts and @a.ts plus @b/",
      files: [ref("a.ts"), ref("a.ts"), ref("b/")],
      images: [],
    };
    expect(effectiveFiles(draft).map((f) => f.rel)).toEqual(["a.ts", "b/"]);
  });
  it("drops files whose mention was deleted", () => {
    const draft = { text: "fix this", files: [ref("a.ts")], images: [] };
    expect(effectiveFiles(draft)).toEqual([]);
  });
  it("does not match a longer name sharing the prefix", () => {
    const draft = { text: "look at @a.ts", files: [ref("a.tsx")], images: [] };
    expect(effectiveFiles(draft)).toEqual([]);
  });
  it("keeps files mentioned with a line range", () => {
    const draft = { text: "see @a.ts:10-20", files: [ref("a.ts")], images: [] };
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
    const draft = { text: "fix @a.ts", files: [ref("a.ts"), ref("gone.ts")], images: [] };
    expect(toPrompt(draft).files).toEqual(["/root/a.ts"]);
  });
});
