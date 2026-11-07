/**
 * Model favorites and recents for the composer's model picker.
 *
 * A favorite is a copy of the effective configuration (model + effort), not a
 * star on the model: the same model with different efforts are independent
 * entries, each with its own `uid`. Applying a favorite sets both the model
 * and (when the agent still offers that level) the effort. Recents are keyed
 * by the same (model, effort) identity and move to the front on use.
 */
export interface ModelFavorite {
  uid: string;
  /** Agent provider the model value belongs to (`cindy`, `codex`, …). */
  provider: string;
  /** The model option value (a wire id like `auto/opus`). */
  value: string;
  /** The effort option value at star time, if the agent has effort levels. */
  effort: string | null;
  at: number;
}

export interface ModelRecent {
  provider: string;
  value: string;
  effort: string | null;
  at: number;
}

export const RECENT_LIMIT = 8;

let uidCounter = 0;
const uid = () =>
  `${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const sameConfig = (a: { value: string; effort: string | null }, b: { value: string; effort: string | null }) =>
  a.value === b.value && (a.effort ?? null) === (b.effort ?? null);

/** Starred configs of `provider`, oldest first. */
export const providerFavorites = (list: readonly ModelFavorite[], provider: string) =>
  list.filter((f) => f.provider === provider);

/** Recent configs of `provider`, newest first. */
export const providerRecents = (list: readonly ModelRecent[], provider: string) =>
  list.filter((r) => r.provider === provider);

/** Star the current config; an identical entry is returned as-is (no duplicates). */
export function addFavorite(
  list: readonly ModelFavorite[],
  provider: string,
  value: string,
  effort: string | null,
): ModelFavorite[] {
  const next = { provider, value, effort: effort ?? null };
  if (list.some((f) => f.provider === provider && sameConfig(f, next))) return [...list];
  return [...list, { ...next, uid: uid(), at: Date.now() }];
}

/** Unstar by `uid`. */
export function removeFavorite(list: readonly ModelFavorite[], uidToRemove: string): ModelFavorite[] {
  return list.filter((f) => f.uid !== uidToRemove);
}

/** Whether the current config is starred. */
export const isFavorite = (list: readonly ModelFavorite[], provider: string, value: string, effort: string | null) =>
  list.some((f) => f.provider === provider && sameConfig(f, { value, effort: effort ?? null }));

/**
 * Record a used config: move to the front, drop duplicates and entries past
 * the limit. Favorites and recents are independent; using a favorite also
 * records a recent.
 */
export function recordRecent(
  list: readonly ModelRecent[],
  provider: string,
  value: string,
  effort: string | null,
): ModelRecent[] {
  const next = { provider, value, effort: effort ?? null };
  return [{ ...next, at: Date.now() }, ...list.filter((r) => !(r.provider === provider && sameConfig(r, next)))].slice(
    0,
    RECENT_LIMIT,
  );
}
