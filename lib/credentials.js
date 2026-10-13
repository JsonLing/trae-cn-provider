// credentials.js - the one credential timeline this plugin reads from.
//
// Three sources, selected by configuration:
//
//   oauth  (default) - the browser-login result only.
//   local            - the local Trae install's own credentials, read through
//                      `src/trae-local-credentials.js`. Requires no browser at
//                      all. It is OFF by default on purpose: shipping a bundle
//                      whose default path decrypts local IDE storage is a
//                      different product decision from shipping one that does
//                      not, and the user explicitly chose the former.
//   auto             - saved OAuth login first, then the local install.
//
// OAuth logins persist through the harness credentials seam when it is mounted
// (a `grant` record whose payload is this plugin's own JSON) and always through
// the standalone file at `~/.trae-proxy/credentials.json`, so the plain CLI and
// the plugin share one login. No token, refresh token, or decrypted payload
// fragment ever reaches a log line, an error message, or an `LlmError`.
import { credentialsApi as credsApi } from './llm.js';
import { loadCredentials, saveCredentials, CRED_FILE } from '../src/env.js';
import { refreshToken } from '../src/trae-auth.js';
import {
  TcDecryptError,
  discoverEditions,
  readAnyLocalCredentials,
  readLocalCredentials,
} from '../src/trae-local-credentials.js';

/** Local installs are only consulted when configuration asks for them. */
export const CREDENTIAL_SOURCES = ['oauth', 'local', 'auto'];

/**
 * Raised when no source could produce a usable login. Distinct from an
 * `LlmError` so the adapter can attach the harness-facing code; the message is
 * always safe to print (it names the source and the reason, never a secret).
 */
export class CredentialUnavailableError extends Error {
  /**
   * @param {string} message - safe, human-readable reason.
   * @param {object} [options]
   * @param {string} [options.source] - configured credential source.
   * @param {Error} [options.cause] - underlying failure, if any.
   */
  constructor(message, { source = 'oauth', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CredentialUnavailableError';
    this.source = source;
  }
}

/** Normalize one local-install credential into the stored login shape. */
function fromLocal(local) {
  return {
    source: 'local',
    edition: local.edition,
    format: local.format,
    token: local.token,
    refreshToken: local.refreshToken,
    userId: local.userId,
    username: local.username,
    expiresAt: local.expiresAt,
    refreshExpiresAt: local.refreshExpiresAt,
    machineId: local.machineId,
    isEnterprise: local.isEnterprise,
    // The local credential carries no device key pair, so `refreshToken()`
    // takes its unsigned simple-exchange branch - which is the correct flow
    // for an account that logged in through the IDE itself.
    //
    // `host` is the account's *own* refresh host, already resolved by
    // `src/trae-local-credentials.js` in the documented order:
    // account.saasBootConfig.apiHost -> consoleHost -> auth.host -> platform
    // default. A hardcoded `api.trae.cn` fails with
    // `{"code":20101,"message":"Token 无效：refresh token is invalid."}` on an
    // enterprise tenant, so this value must never be overridden here.
    host: local.refreshHost,
    apiHost: local.apiHost,
    clientId: undefined,
  };
}

/** Attach the discriminator to a persisted OAuth login. */
function fromOauth(creds) {
  return { ...creds, source: creds.source ?? 'oauth' };
}

/**
 * Store the login, dispatching every read by the configured source.
 */
export class CredentialStore {
  /**
   * @param {object} options
   * @param {any} options.ctx - plugin context.
   * @param {string} [options.scope] - owning plugin name (`trae-cn-provider`).
   * @param {string} [options.id] - provider route key (`trae-cn`).
   * @param {string} [options.source] - `oauth` (default), `local`, or `auto`.
   * @param {string} [options.edition] - edition id for `local` / `auto`.
   * @param {() => string} [options.fallbackFile] - diagnostic file path.
   */
  constructor({
    ctx,
    scope = 'trae-cn-provider',
    id = 'trae-cn',
    source = 'oauth',
    edition = 'cn',
    fallbackFile = CRED_FILE,
  } = {}) {
    this.ctx = ctx;
    this.scope = scope;
    this.id = id;
    this.source = CREDENTIAL_SOURCES.includes(source) ? source : 'oauth';
    this.edition = edition;
    this.fallbackFile = fallbackFile;
    this.lastSource = 'none';
    this.lastReason = '';
    this.lastLocalError = undefined;
    try {
      this.key = credsApi.credentialKey(scope, id);
    } catch {
      this.key = undefined;
    }
  }

  /** The credentials service, or undefined in compositions without it. */
  get service() {
    if (typeof this.ctx?.get !== 'function') return undefined;
    const service = this.ctx.get('credentials', false);
    return service && typeof service.readRecord === 'function' ? service : undefined;
  }

  /** Whether the local install may be consulted at all. */
  get localEnabled() {
    return this.source === 'local' || this.source === 'auto';
  }

  /**
   * Read the saved OAuth login (seam record first, then the standalone file).
   * @returns {Promise<object | null>} the stored login, or null.
   */
  async readOauth() {
    const service = this.service;
    if (service && this.key !== undefined) {
      try {
        const record = await service.readRecord(this.key);
        if (record?.kind === 'grant' && record.payload && typeof record.payload === 'object') {
          this.lastSource = 'credentials-record';
          return fromOauth(record.payload);
        }
      } catch (err) {
        this.lastReason = `credentials-record-error:${err?.code ?? 'unknown'}`;
      }
    }
    try {
      const file = loadCredentials();
      if (file) {
        this.lastSource = 'file';
        return fromOauth(file);
      }
    } catch (err) {
      this.lastReason = `file-error:${err?.message ?? 'unknown'}`;
    }
    return null;
  }

  /**
   * Read the local Trae install's credential.
   * @returns {object} the normalized login.
   * @throws {TcDecryptError} when nothing usable exists.
   */
  readLocal() {
    const local = this.edition === 'auto' ? readAnyLocalCredentials() : readLocalCredentials(this.edition);
    this.lastSource = `local:${local.edition}`;
    return fromLocal(local);
  }

  /**
   * Read the current login according to the configured source.
   * @returns {Promise<object | null>} the credential JSON, or null when absent.
   * @throws {CredentialUnavailableError} when `local` was requested and failed.
   */
  async read() {
    if (this.source === 'oauth') return this.readOauth();

    if (this.source === 'local') {
      try {
        return this.readLocal();
      } catch (err) {
        // TcDecryptError messages name a format or length, never a secret.
        //
        // The Trae client owns `storage.json` and rewrites it — signing out,
        // resetting the login state or an in-place migration all drop
        // `iCubeAuthInfo://icube.cloudide` (observed on this machine). So this
        // is a normal, recoverable state, and the message has to say what to do
        // rather than only what was missing.
        throw new CredentialUnavailableError(
          `本机 Trae 凭据不可用（edition=${this.edition}）：${err?.message ?? err}。` +
            `请在 Trae 客户端（${this.edition}）确认已登录后重试；` +
            '或改用 credentialSource: oauth（浏览器登录）／auto（两者都允许）。',
          { source: this.source, cause: err },
        );
      }
    }

    // auto: a saved browser login wins, the local install is the fallback.
    const saved = await this.readOauth();
    if (saved) return saved;
    try {
      return this.readLocal();
    } catch (err) {
      this.lastLocalError = err;
      return null;
    }
  }

  /**
   * Persist one browser login. Best effort on every layer: a seam failure still
   * writes the file so the CLI and the next boot agree. Local-install
   * credentials are never persisted - they are re-read from their own store.
   * @param {object} value - the credential JSON.
   * @returns {Promise<{record: boolean, file: boolean, filePath: string}>} write outcomes.
   */
  async write(value) {
    const outcome = { record: false, file: false, filePath: this.fallbackFile };
    if (value?.source === 'local') return outcome;
    const service = this.service;
    if (service && this.key !== undefined) {
      try {
        await service.modifyRecord(this.key, async () => ({ kind: 'grant', payload: value }));
        outcome.record = true;
        this.lastSource = 'credentials-record';
      } catch {
        outcome.record = false;
      }
    }
    try {
      outcome.filePath = saveCredentials(value);
      outcome.file = true;
      if (!outcome.record) this.lastSource = 'file';
    } catch {
      outcome.file = false;
    }
    return outcome;
  }

  /**
   * Refresh one login, carrying its source forward.
   *
   * `src/trae-auth.js` already dispatches: a credential carrying
   * `privateKeyPem` + `deviceInfo` uses the ECDSA device proof, anything else
   * uses the unsigned simple exchange. A local-install credential has no key
   * pair, so it correctly takes the simple branch.
   * @param {object} creds - the credential to refresh.
   * @param {string} ideVersion - `IDEVersion` for the exchange request.
   * @returns {Promise<object>} the refreshed credential.
   */
  async refresh(creds, ideVersion) {
    const next = await refreshToken(creds, ideVersion);
    return { ...next, source: creds.source ?? 'oauth', edition: creds.edition ?? next.edition };
  }

  /**
   * Remove the stored browser login from both back ends.
   * @returns {Promise<void>}
   */
  async clear() {
    const service = this.service;
    if (service && this.key !== undefined && typeof service.deleteRecord === 'function') {
      try {
        await service.deleteRecord(this.key);
      } catch {
        /* nothing stored, or the seam refused; the file clear below still runs */
      }
    }
  }

  /** Editions that exist on this machine, for a diagnostic line. */
  editions() {
    try {
      return discoverEditions().map((edition) => edition.id);
    } catch {
      return [];
    }
  }
}

export { CRED_FILE, TcDecryptError };
