# OpenIDEA mobile companion (MVP)

Minimal Expo + mock-server shell against the v2 companion protocol in
`crates/ide-host/src/mobile.rs`. Wire-compatible with Orca's NaCl-box framing
(`base64(nonce24 || box_after(plaintext))`, `tweetnacl` on both ends).

## Protocol (v2)

- Plaintext: `{"type":"e2ee_hello","publicKeyB64":"…"}` → `{"type":"e2ee_ready"}`
- Then every frame is encrypted: `{id, method, params}` → `{id, result}` or `{id, error}`
- First encrypted call is `e2ee_auth {deviceToken}`; then
- `initialize {version: 2, deviceToken}` → `{protocol: 2, …}`; then `ping`,
- `mobile.projects`, `invoke {window, cmd, args}`, `pair.*`
- Pairing QR: `openidea://pair?code=<base64url(JSON {v:1, endpoint, deviceToken, publicKeyB64}>)`

The phone pins `publicKeyB64` from the QR before deriving the shared secret,
so a LAN attacker cannot MITM the hello.

## Run the mock server

```sh
pnpm --dir mobile install
pnpm --dir mobile mock-server        # prints pairing url + manual code
PORT=6769 pnpm --dir mobile mock-server
MOCK_SERVER_KEY_FILE=~/.openidea-mobile-mock.key pnpm --dir mobile mock-server
```

## Run the tests

```sh
pnpm --dir mobile test       # e2ee, pairing, full handshake vs in-process mock
pnpm --dir mobile typecheck
```

## Point the app at the real server

```sh
cargo run -p ide-host --bin openidea-server -- --mobile --mobile-bind 0.0.0.0:6768
# scan the printed `openidea://pair?code=…` QR, or type the manual code
```

## Expo UI

`app/` holds the Expo Router screens (pair → confirm → projects). They import
only from `src/transport/*`, so the same code runs against the mock and the
Rust server. `npx expo start` once the Expo deps are installed (not part of the
default `pnpm --dir mobile install` yet — coming next).
