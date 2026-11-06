/**
 * Bridge-owned ambient declaration for Vite-style `?raw` imports.
 * Upstream loads two markdown assets (`system-prompt-append.md`,
 * `system-prompt.md`) this way; the bridge bundling step (B2) handles the
 * actual loading. This file only lets `tsc --noEmit` (B1) see them as strings.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
