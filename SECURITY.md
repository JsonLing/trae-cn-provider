# Security notes

Written for the people who review this plugin before installing it — including
automated scanners, which look for hard-coded secrets, data-exfiltration
endpoints, destructive operations and mining signatures. This file says what
each of those could *look* like here, and what it actually is.

## Credentials

This plugin talks to Trae with **your own** account. It never forwards a
credential anywhere except Trae's own endpoints.

| Source | What happens | Where it lives |
|---|---|---|
| `oauth` (default) | You authorize in a browser; Trae answers a loopback callback with the token material | `~/.trae-proxy/credentials.json` (mode `0600`), or the harness `credentials` service when present |
| `local` (opt-in) | Reads the credential the Trae client already stored on this machine | read-only; a rotated token is held in memory and **never** written back to the client's store |

`credentialSource: local` **decrypts** `storage.json`. That is the one part of
this repository that a scanner may reasonably flag as credential access, so:

- it is **not** the default (`oauth` is), and the README says what enabling it
  means;
- the decryption is self-contained and auditable in
  [`src/trae-local-credentials.js`](./src/trae-local-credentials.js) — its key
  material is derived from the ciphertext itself and verified against an
  embedded SHA-512 digest;
- no credential value is ever logged, put in an error message, or included in an
  emitted chunk. There are tests asserting exactly that.

## Outbound network surface

Every request target in the shipped code (`lib/` + `src/`):

| Host | Purpose |
|---|---|
| `trae-api-cn.mchost.guru` | CN model catalog and chat |
| `a0ai-api-sg.byteintlapi.com` | international model catalog and chat |
| `api.trae.cn` | token refresh (default host) |
| `console.enterprise.trae.cn` and other tenant hosts | token refresh for enterprise accounts — the host comes **from the credential**, it is not hard-coded |
| `www.trae.cn` | the browser authorization page (opened in your browser, never fetched by this code) |
| `127.0.0.1` / `localhost` | the loopback OAuth callback, and the optional local OpenAI-compatible surface |

There is **no third-party host, no telemetry, no analytics**.

One non-Trae URL does appear: `https://github.com/deepseek-ai/deepseek-harness`
in [`lib/attribution.js`](./lib/attribution.js). It is the DeepSeek Harness
project's own homepage, used inside a `user-agent` string — the attribution
shape DSH itself mandates for every provider request. It is not contacted and no
data is sent to it.

## Process execution

`child_process.spawn` appears in exactly one role: opening the authorization URL
in your browser (`open` / `cmd` / `xdg-open`). It is passed a URL only. Nothing
is downloaded, piped to a shell, or executed.

## Destructive operations

The shipped code performs none. The tests create and delete their own
directories under the OS temp dir; the one recursive delete asserts its target
resolves inside `os.tmpdir()` before running. The suites redirect the credential
file with `TRAE_PROXY_CRED_DIR`, so a test run cannot touch your real login.

## Test fixtures

`test/` contains strings that look like tokens (`fake-access-token-not-a-real-secret`,
`fake-refresh-token`, …). They are literals invented for the suites; the suites
are offline and every upstream call is a stub. This is a known false-positive
shape for scanners — see
[deepseek-harness#2818](https://github.com/deepseek-ai/deepseek-harness/discussions/2818).

## Reporting

Open an issue at <https://github.com/JsonLing/trae-cn-provider/issues>. Please
do not include real credentials, tokens or account identifiers.
