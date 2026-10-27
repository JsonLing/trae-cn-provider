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

## The local OpenAI-compatible surface

`mountOpenAIEndpoint` (and `node src/cli.js serve`) expose an OpenAI-shaped
endpoint on loopback. It is **unauthenticated by default** — the assumption is
that only processes on this machine can reach it — but that assumption is wrong
for browsers: *any* page you have open can POST to `127.0.0.1`, and a permissive
CORS header would let it read the answer back and spend your Trae quota.

So the surface is locked down in two ways:

- **No `Access-Control-Allow-Origin: *`.** A request that carries an `Origin`
  header is answered `403` unless its origin is listed in
  `allowBrowserOrigins` (default: empty). Agent/SDK clients — Hermes,
  `openai-python`, `curl` — send no `Origin` and are unaffected.
- **`apiKey`** can be set for the standalone server (`serve --api-key`), which
  then requires `Authorization: Bearer …` or `X-API-Key` on `/v1/*`.

Both are opt-in hardening on top of the loopback binding; neither claims to
sandbox the endpoint from other local processes, which can always connect.

## Gateway mode: API keys at rest and the admin page

`serve --db` turns on a local SQLite gateway (`~/.trae-proxy/gateway.db`). It adds
two new surfaces, and both are opt-in — nothing here runs unless `--db` is passed.

**API keys are stored in plaintext alongside their SHA-256.** Authentication only
ever reads the hash, so a key can be revoked by deleting its row. The plaintext
column exists because an operator distributing keys has to be able to read one
back later; losing it means re-issuing and re-distributing, which is how people
end up pasting keys into chat logs. The trade is explicit and bounded by file
permissions: `gateway.db` is created `0600` inside a `0700` directory, next to
the credential file it already sits beside. **Anyone who can read that file can
read every issued key** — the same exposure as the operator's own credentials.

The database never stores prompt or completion text. A `usage` row carries the
timestamp, key label, model name, token counts, status, duration and the upstream
session id, which is what makes per-person accounting possible. Conversation
content is not among them.

**The `/admin` page has its own password, separate from every `/v1` key.** An API
key holder must not be able to reach it: they could raise their own daily cap,
read everybody else's usage, or mint themselves a new key. `serve` refuses to
start on a non-loopback bind without `--admin-password`, and also refuses a
non-loopback bind with neither `--db` nor `--api-key` — an unauthenticated
gateway on a LAN would spend the operator's own quota.

**The gateway speaks plain HTTP and has no TLS.** It is built for a trusted
network. Exposing it to the internet requires a TLS-terminating proxy in front;
the project does not ship one. `--host 0.0.0.0` is a deliberate act, which is why
the startup banner prints every address it just became reachable on.

Browser `Origin` requests are still refused (`403`) unless listed in
`allowBrowserOrigins`, on the gateway surface as well.

## Nothing secret is written to the debug log

`~/.trae-proxy/login-debug.log` exists to diagnose unrecognised OAuth callbacks.
Trae's callback query carries `userJwt` (which itself contains `Token` and
`RefreshToken`), so the raw query is **not** what gets written: sensitive keys
(anything matching token/jwt/code/ticket/session/auth/key/sig/credential/userinfo)
are replaced with `<redacted N>`, and other long values are truncated. The log
keeps the parameter *shape* and nothing else. `test/smoke-login.js` asserts that
neither the access token nor the refresh token appears in the file.

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
