// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps application regexes parseable in pre-16.4 WebKit", () => {
  const root = resolve(import.meta.dirname, "../..");
  const offenders: string[] = [];
  for (const dir of ["src", "public"]) {
    for (const file of readdirSync(resolve(root, dir), { recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.[jt]sx?$/.test(file)) continue;
      // The Cindy embed is a prebuilt third-party bundle (scripts/cindy-embed);
      // its regexes are Cindy's, guarded by the embed's own browser floor.
      const rel = file.replace(/\\/g, "/");
      if (dir === "public" && (rel === "cindy" || rel.startsWith("cindy/"))) continue;
      const source = readFileSync(resolve(root, dir, file), "utf8");
      if (source.includes("(?<" + "=") || source.includes("(?<" + "!")) offenders.push(`${dir}/${file}`);
    }
  }
  expect(offenders).toEqual([]);
});
