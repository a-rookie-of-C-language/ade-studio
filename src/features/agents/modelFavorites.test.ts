import { describe, expect, it } from "vitest";
import {
  RECENT_LIMIT,
  addFavorite,
  isFavorite,
  providerFavorites,
  providerRecents,
  recordRecent,
  removeFavorite,
  type ModelFavorite,
  type ModelRecent,
} from "./modelFavorites";

const fav = (over: Partial<ModelFavorite> = {}): ModelFavorite => ({
  uid: "u",
  provider: "cindy",
  value: "auto/opus",
  effort: "high",
  at: 0,
  ...over,
});

describe("addFavorite", () => {
  it("stars the current model and effort as one entry", () => {
    const list = addFavorite([], "cindy", "auto/opus", "high");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "cindy", value: "auto/opus", effort: "high" });
    expect(list[0]!.uid).toBeTruthy();
  });
  it("keeps the same model with different efforts as independent entries", () => {
    const list = addFavorite(addFavorite([], "cindy", "auto/opus", "high"), "cindy", "auto/opus", "low");
    expect(list).toHaveLength(2);
  });
  it("does not duplicate an identical entry", () => {
    const once = addFavorite([], "cindy", "auto/opus", "high");
    expect(addFavorite(once, "cindy", "auto/opus", "high")).toEqual(once);
  });
  it("treats null and undefined effort as the same", () => {
    const once = addFavorite([], "cindy", "auto/opus", null);
    expect(addFavorite(once, "cindy", "auto/opus", null)).toEqual(once);
  });
});

describe("removeFavorite/isFavorite", () => {
  it("unstars by uid without touching siblings", () => {
    const list = [fav({ uid: "a" }), fav({ uid: "b", effort: "low" })];
    expect(removeFavorite(list, "a").map((f) => f.uid)).toEqual(["b"]);
  });
  it("reports the starred state by config identity", () => {
    const list = [fav({ value: "auto/opus", effort: "high" })];
    expect(isFavorite(list, "cindy", "auto/opus", "high")).toBe(true);
    expect(isFavorite(list, "cindy", "auto/opus", "low")).toBe(false);
    expect(isFavorite(list, "codex", "auto/opus", "high")).toBe(false);
  });
});

describe("providerFavorites/providerRecents", () => {
  it("scopes entries to the asking provider", () => {
    const favs = [fav({ provider: "cindy" }), fav({ provider: "codex" })];
    expect(providerFavorites(favs, "cindy")).toHaveLength(1);
    const recs: ModelRecent[] = [
      { provider: "cindy", value: "a", effort: null, at: 2 },
      { provider: "codex", value: "b", effort: null, at: 3 },
    ];
    expect(providerRecents(recs, "codex").map((r) => r.value)).toEqual(["b"]);
  });
});

describe("recordRecent", () => {
  it("moves a reused config to the front without duplicates", () => {
    const list = recordRecent(recordRecent([], "cindy", "a", null), "cindy", "b", "high");
    const again = recordRecent(list, "cindy", "a", null);
    expect(again.map((r) => r.value)).toEqual(["a", "b"]);
  });
  it("caps the list", () => {
    let list: ModelRecent[] = [];
    for (let i = 0; i < RECENT_LIMIT + 3; i++) list = recordRecent(list, "cindy", `m${i}`, null);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]!.value).toBe(`m${RECENT_LIMIT + 2}`);
  });
});
