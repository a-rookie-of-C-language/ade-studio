# Cindy embed bridges (`/cindy/`)

The welcome home embeds Cindy's desktop renderer as static files
(`public/cindy/`, gitignored, built by `build.mjs`, pinned in
`cindy-pin.json`). The renderer runs in an iframe with `shim.js` standing in
for `window.electronAPI`. Namespaces move from absorb-stub to real bridges
one by one (P2 order: catalog → auth → chat → task).

## Live bridges

### Model catalog (`maker.listProviders`, `maker.getCapabilities`)

- Renderer pulls via `window.electronAPI.maker.listProviders()` into
  `providersSnapshotStore`; commit requires `dataOwnerId`/`ownerGeneration`
  to match the embed boot identity (`local` / `1`, see the auth-stall fix).
- The iframe cannot fetch the loopback magpie gateway (no CORS headers), so
  the shim posts `{ source: "cindy-embed", type: "cindy-embed:magpie-catalog:request", id }`
  to the parent; `CindyView` answers with
  `{ source: "openidea-host", type: "cindy-embed:magpie-catalog:response", id, ok, models|error }`
  served from the Rust `cindy_magpie_catalog` command (loopback `GET /v1/models`).
- Fail-closed: timeout (10s) or gateway-down rejects; the picker shows retry,
  never infinite loading.
- Mapping (`magpieProviderView` in `shim.js`): group rows under their real
  magpie `provider` ids (the picker's trigger/panel resolve by
  `(providerId, modelId)` with non-null assertions — one lumped provider
  leaves every selection at "Model Details Unavailable" and throws on open);
  effort strings filtered to the `@cindy/model-providers` union; vendor id
  passed through as the model's `group` (real vendors group properly, unknown
  gateway names ride the userProvider pass-through in `isAgentSelectableModel`
  instead of being killed by the id-regex classifier — never set a known
  non-chat category); `MobileChoiceOption`s (`effortLevels`,
  `permissionModes`) use `{ id, label }`, `availableModels` use `displayName`;
  empty catalogs reject (the panel assumes at least one model); opening the
  selector busts the 15s cache via `requestProviderModelsAutoRefresh`;
  `connected: true`, `auth: { method: "none" }`, routing loopback 3425,
  every model attached to all three agents (`claude-code`, `codex`, `pi`).

## Still stubbed

Auth/session (local-mode boot identity only), chat send, task run, device
link, provider management writes. The trigger shows "unresolved" and panels
may throw whenever the catalog lacks the stored selection — never feed the
renderer a provider id the selection cannot match.
