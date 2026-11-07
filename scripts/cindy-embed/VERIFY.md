# Verifying the embedded model picker

Cloud CI does **not** cover the embed (no Cindy checkout, no `public/cindy`
bundle on runners). Verify locally:

## Rebuild the bundle

```sh
node scripts/cindy-embed/build.mjs
```

This regenerates gitignored `public/cindy/` from `D:/code/cindy`
(`CINDY_DIR` overrides) plus `cindy-pin.json` (Cindy commit + timestamp).
Any `shim.js` change needs a rebuild to take effect in the running app.

## 1. Gateway up?

```sh
curl http://127.0.0.1:3425/v1/models | head -c 500
```

(`MAGPIE_BASE_URL` overrides the loopback default.) Empty / connection
refused = the picker can only show retry — start the gateway first.

## 2. Trigger label

Open a new chat (`#/cc-agent/new`). The model trigger must show a model
name. "Model Details Unavailable" means the selected `(providerId, modelId)`
is absent from the magpie catalog (wrong gateway data, or a stale selection
from desktop storage).

## 3. Open the dropdown

It must list providers/models without the "Something went wrong" boundary.
If it crashes: expand **Error Details** and paste the component stack —
that line number is the fix location.

## 4. Refresh

Reopening the selector and Settings → model providers refresh must both
complete without the loading state hanging (watch `__ipcCalls` on the
iframe window for the `cindy-embed:magpie-catalog:request` round-trip).
