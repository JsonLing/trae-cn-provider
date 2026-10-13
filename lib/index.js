// index.js - the DSH plugin entry for the Trae CN provider route.
//
// Registers two things with the `llm` service, both of which are required for
// the route to be usable:
//   * `registerConfigurableProviders` so the Models settings page can list the
//     route and open its section;
//   * `registerAdapter(['trae-cn'], adapter)` so the models appear in the model
//     selector and stream through the adapter.
//
// It also mounts the existing OpenAI-compatible surface from
// `src/openai-server.js` on the host web server (no `listen` of its own) so
// plain OpenAI clients can point at the same login.
//
// No token ever reaches a log line, an error message, or a thrown `LlmError`.
import { spawn } from 'node:child_process';
import {
  LlmError,
  credentialsApi,
  loadModule,
} from './llm.js';
import { TraeAdapter } from './adapter.js';
import { CredentialStore, CRED_FILE } from './credentials.js';
import { commandFailure, commandSuccess } from './support.js';
import { detectEnv } from '../src/env.js';
import { webLogin, needsRefresh } from '../src/trae-auth.js';
import { TraeProvider, createRequestHandler } from '../src/openai-server.js';

// schemastery is loaded through the same resilient path as the harness
// packages so a bare checkout still imports this module; under a real DSH
// profile the normal specifier resolves first and nothing changes.
//
// The fallback MUST be a Standard Schema, not a plain defaults object: cordis
// validates every plugin's config through `Config['~standard'].validate(...)`
// (see `resolveConfig` in cordis/lib/index.js). A bare object made that call
// throw "Cannot read properties of undefined (reading 'validate')", which is
// not a no-op — it aborts the whole profile boot. Returning `{value}` with the
// defaults merged in keeps a missing schemastery harmless.
const fallbackSchema = (defaults) => ({
  '~standard': {
    version: 1,
    vendor: 'trae-cn-provider',
    validate(value) {
      const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { value: { ...defaults, ...input } };
    },
  },
  default: () => defaults,
  toJSON: () => ({ type: 'object', properties: {}, default: defaults }),
});
let z = null;
try {
  z = (await loadModule('@deepseek-ai/schemastery')).default;
} catch {
  z = null;
}

const DEFAULT_APP_VERSION_CODE = 20260401;

const Config = z
  ? z.object({
      /** Numeric build code sent as `x-app-version-code` / `x-ide-version-code`. */
      appVersionCode: z.number().default(DEFAULT_APP_VERSION_CODE),
      /** `x-ide-version`; empty means discover it from the local Trae install. */
      ideVersion: z.string().default(''),
      /** Wire style: the verified `chat_v3`, or the experimental `inline_chat`. */
      requestStyle: z.string().default('chat_v3'),
      /** Provider name shown in the model selector. */
      displayName: z.string().default('Trae CN'),
      /** Human command that starts the browser login, without the leading slash. */
      loginCommand: z.string().default('trae-login'),
      /** Namespace whose settings section configures this route. */
      settingsNs: z.string().default('trae-cn-provider'),
      /** Mount the OpenAI-compatible surface on the host web server. */
      mountOpenAIEndpoint: z.boolean().default(true),
      /** Path prefix of that surface. */
      openAIPath: z.string().default('/trae-cn'),
      /**
       * Where the login comes from: `oauth` (browser login only, the default),
       * `local` (read this machine's Trae install), or `auto` (saved OAuth
       * login first, then the local install).
       */
      credentialSource: z.string().default('oauth'),
      /** Edition whose local credential is read: `cn` | `solo` | `sg` | `solo-sg`. */
      edition: z.string().default('cn'),
    })
  : fallbackSchema({
      appVersionCode: DEFAULT_APP_VERSION_CODE,
      ideVersion: '',
      requestStyle: 'chat_v3',
      displayName: 'Trae CN',
      loginCommand: 'trae-login',
      settingsNs: 'trae-cn-provider',
      mountOpenAIEndpoint: true,
      openAIPath: '/trae-cn',
      credentialSource: 'oauth',
      edition: 'cn',
    });

const name = 'trae-cn-provider';
const inject = ['llm'];
const PROVIDER = 'trae-cn';
const CREDENTIAL_REF = 'TRAE_CN_CREDENTIALS';

/** Read one config value whether the object is a live proxy or a plain level. */
function configValue(config, key, fallback) {
  const holder = config?.[key];
  if (holder && typeof holder.get === 'function') {
    try {
      const value = holder.get();
      return value === undefined || value === null || value === '' ? fallback : value;
    } catch {
      return fallback;
    }
  }
  if (holder === undefined || holder === null || holder === '') return fallback;
  return holder;
}

/** Merge configuration overrides into the detected local Trae environment. */
function resolveEnv(config) {
  const detected = detectEnv();
  const override = Number(configValue(config, 'appVersionCode', 0)) || 0;
  const ideVersion = String(configValue(config, 'ideVersion', '') || detected.ideVersion);
  const appVersionCode = override || detected.appVersionCode || detected.ideVersionCode || DEFAULT_APP_VERSION_CODE;
  return {
    ...detected,
    ideVersion,
    appVersionCode,
    ideVersionCode: String(appVersionCode),
    source: override ? 'config' : detected.source,
  };
}

/** Best-effort browser launch for the authorization URL. */
function openBrowser(ctx, url, logger) {
  try {
    const opener = typeof ctx?.get === 'function' ? ctx.get('openInApp', false) : undefined;
    if (opener) {
      if (typeof opener.openUrl === 'function') {
        opener.openUrl(url);
        return;
      }
      if (typeof opener.open === 'function') {
        opener.open(url);
        return;
      }
      if (typeof opener === 'function') {
        opener(url);
        return;
      }
    }
  } catch (err) {
    logger?.debug?.(`[trae-cn] openInApp 不可用: ${err?.message ?? err}`);
  }
  try {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    logger?.debug?.(`[trae-cn] 无法自动打开浏览器: ${err?.message ?? err}`);
  }
}

/**
 * Register the Trae CN provider route.
 * @param {any} ctx - the owning plugin context.
 * @param {any} config - validated plugin configuration.
 */
function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const env = resolveEnv(config);
  const credentialSource = String(configValue(config, 'credentialSource', 'oauth'));
  const edition = String(configValue(config, 'edition', 'cn'));
  const store = new CredentialStore({ ctx, scope: name, id: PROVIDER, source: credentialSource, edition });
  const requestStyle = String(configValue(config, 'requestStyle', 'chat_v3'));
  const displayName = String(configValue(config, 'displayName', 'Trae CN'));
  const settingsNs =
    String(configValue(config, 'settingsNs', '')) ||
    ctx.fiber?.entry?.options?.id ||
    name;
  // This is the *mount* prefix, not the OpenAI base URL: the mounted handler
  // owns the `/v1/...` routes itself, so `/trae-cn` yields the documented
  // `/trae-cn/v1/models` surface.
  const openAIPath = String(configValue(config, 'openAIPath', '/trae-cn')).replace(/\/+$/, '');

  const adapter = new TraeAdapter({
    ctx,
    env,
    credentials: store,
    logger,
    requestStyle,
    displayName,
  });

  // Human command that owns the browser login. Registered through the
  // registry so it disposes with this plugin's fiber.
  const loginCommand = String(configValue(config, 'loginCommand', 'trae-login'));
  const commands = typeof ctx.get === 'function' ? ctx.get('commands', false) : undefined;
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: loginCommand,
        description: '登录 Trae CN 账号（网页 OAuth，浏览器授权后自动写回凭据）',
        recordInput: false,
        async handler() {
          logger.info?.('[trae-cn] 正在启动网页登录，请在浏览器中完成授权…');
          try {
            const creds = await webLogin({
              ideVersion: env.ideVersion,
              onAuthorizeUrl: (url) => {
                logger.info?.(`[trae-cn] 授权链接（如未自动打开请手动访问）:\n${url}`);
                openBrowser(ctx, url, logger);
              },
              onProgress: (message) => logger.info?.(`[trae-cn] ${message}`),
            });
            const outcome = await store.write(creds);
            const targets = [];
            if (outcome.record) targets.push(`credentials 记录 ${store.scope}/${store.id}`);
            if (outcome.file) targets.push(outcome.filePath);
            return commandSuccess(
              `Trae CN 登录成功${creds.username ? `（${creds.username}）` : ''}，凭据已写入 ${targets.join(' + ') || '内存'}`,
            );
          } catch (err) {
            // The login error never carries a token; it is a transport or
            // user-action failure only.
            return commandFailure(`Trae CN 登录失败：${err?.message ?? err}`);
          }
        },
      }),
    );
  } else {
    logger.warn?.(
      `[trae-cn] 未找到 commands 服务，/trae-login 不可用；请改用 "node src/cli.js login" 完成登录`,
    );
  }

  // Directory entry: lets configuration surfaces list the route even when it is
  // dormant (no login yet).
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName, settingsNs, settingsPath: [] },
  ]);

  // The adapter itself; a rejected registration must not be swallowed because
  // the route would then be silently missing from the model selector.
  ctx.llm.registerAdapter([PROVIDER], adapter);

  // Diagnostic only: the configuration facts, never a credential value.
  logger.debug?.(
    `[trae-cn] 已注册 provider=${PROVIDER} style=${requestStyle} credentialSource=${store.source} ` +
      `ideVersion=${env.ideVersion} appVersionCode=${env.appVersionCode} 凭据文件=${store.fallbackFile}`,
  );

  // Model discovery for the settings surface: reuse the adapter catalog so the
  // settings page sees exactly the ids the selector offers.
  if (typeof ctx.llm.registerModelDiscovery === 'function') {
    try {
      ctx.llm.registerModelDiscovery(settingsNs, async () => {
        const models = await adapter.listModels(PROVIDER);
        return models.map((model) => ({ id: model.id, name: model.name }));
      });
    } catch (err) {
      logger.debug?.(`[trae-cn] registerModelDiscovery 跳过: ${err?.message ?? err}`);
    }
  }

  // Preload the catalog so a missing login is reported once, early, instead of
  // only when the user opens the model selector.
  adapter
    .listModels(PROVIDER)
    .then((models) => logger.info?.(`[trae-cn] 模型目录已加载：${models.length} 个`))
    .catch((err) => {
      if (err instanceof LlmError && err.code === 'MISSING_CREDENTIAL') return;
      logger.warn?.(`[trae-cn] 模型目录预拉取失败：${err?.message ?? err}`);
    });

  // OpenAI-compatible surface on the host web server. `createRequestHandler`
  // returns a bare `(req, res)` handler — `createServer` returns an
  // `http.Server`, which is not callable and made every mounted request fail
  // as an opaque 400.
  if (configValue(config, 'mountOpenAIEndpoint', true)) {
    const provider = new TraeProvider({ env, credentials: null, logger });
    // Point the standalone provider's refresh loop at the same credential
    // timeline as the adapter, so `credentialSource: local` works through this
    // surface too and a rotated token is never written twice.
    provider.ensureFresh = async () => {
      const creds = await store.read();
      if (!creds?.refreshToken) throw new Error(`trae-cn: 没有可用凭据（credentialSource=${store.source}），请先运行 /trae-login`);
      if (needsRefresh(creds)) {
        const next = await store.refresh(creds, env.ideVersion);
        if (next.source !== 'local') await store.write(next);
        provider.creds = next;
        return next;
      }
      provider.creds = creds;
      return creds;
    };
    try {
      provider.creds = store.source === 'local' ? store.readLocal() : null;
    } catch (err) {
      logger.warn?.(`[trae-cn] ${err?.message ?? err}`);
    }
    const inner = createRequestHandler(provider);
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const webServer = typeof ctx.get === 'function' ? ctx.get('webServer', false) : undefined;
        if (!webServer || typeof webServer.register !== 'function') {
          logger.warn?.(
            `[trae-cn] 未找到 webServer 服务，OpenAI 兼容接口 ${openAIPath} 未挂载（可用 "node src/cli.js serve" 独立启动）`,
          );
          return () => {};
        }
        const handler = (req, res) => {
          const original = req.url ?? '/';
          const queryIndex = original.indexOf('?');
          const pathname = queryIndex < 0 ? original : original.slice(0, queryIndex);
          const search = queryIndex < 0 ? '' : original.slice(queryIndex);
          const rest = pathname.startsWith(openAIPath) ? pathname.slice(openAIPath.length) : pathname;
          req.url = `${rest || '/'}${search}`;
          try {
            return inner(req, res);
          } finally {
            req.url = original;
          }
        };
        const disposer = webServer.register({ kind: 'prefix', path: openAIPath, handler });
        logger.info?.(`[trae-cn] OpenAI 兼容接口已挂载：${openAIPath}/v1/chat/completions`);
        return disposer;
      });
    }
  }

  return { adapter, store, env, provider: PROVIDER, credentialRef: CREDENTIAL_REF };
}

export { Config, apply, inject, name, PROVIDER, CREDENTIAL_REF, CRED_FILE, credentialsApi };
export default { name, inject, Config, apply };
