// adapter.js - the LlmAdapter every harness model call arrives through.
//
// This is the protocol bridge: it owns the model catalog, resolves one exact
// model route, assembles a Trae request body, and translates the normalized
// event stream produced by `src/trae-client.js` into the harness `StreamChunk`
// vocabulary. Credential refresh and the 401 retry live here because the
// harness never sees the access token.
//
// Text and reasoning deltas are forwarded as they arrive. Tool calls are
// *buffered*: the upstream only publishes a complete call at `done`, so each
// call's block is opened on its first delta and closed with its fully
// accumulated argument string. That keeps every emitted `block-end` a total
// block, as the assembler contract requires.
import crypto from 'node:crypto';
import { LlmAdapter, LlmError, ToolCallId, attributionHeaders, ReasoningEffortId } from './llm.js';
import { chat, ideHeaders, listModels as fetchModelCatalog } from '../src/trae-client.js';
import {
  buildChatBody,
  reasoningEffortFor,
  toTokenUsage,
  toTraeTools,
} from './chat-body.js';
import { toTraeMessages, withSystemMessage } from './messages.js';
import { imageReaderFor } from './attachments.js';
import { CredentialUnavailableError } from './credentials.js';
import { needsRefresh } from '../src/trae-auth.js';

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_RETRY_MS = 5 * 60 * 1000;

/** Human-readable label for one Trae-native effort id. */
const EFFORT_LABELS = {
  low: 'Low',
  high: 'High',
  extra_high: 'Extra high',
};

/**
 * Build the reasoning metadata for one catalog entry.
 *
 * The ids are the **Trae-native** `low` / `high` / `extra_high` values, because
 * whatever the user picks is forwarded verbatim as the request body's
 * `reasoning_effort`. `undefined` is returned - never an empty `efforts` array -
 * when the model has no `reasoning_effort_config`, since the runtime rejects
 * empty reasoning metadata outright.
 * @param {{effortOptions?: string[], effortDefault?: string, supportThinking?: boolean}} entry - catalog entry.
 * @returns {{efforts: Array<{id: string, name: string}>, defaultEffort?: string} | undefined}
 */
export function reasoningInfoFor(entry) {
  const options = Array.isArray(entry?.effortOptions) ? entry.effortOptions.filter(Boolean) : [];
  if (!options.length) return undefined;
  const efforts = options.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id }));
  const declaredDefault = typeof entry.effortDefault === 'string' ? entry.effortDefault.trim() : '';
  const defaultEffort = options.includes(declaredDefault) ? declaredDefault : options[0];
  return { efforts, defaultEffort };
}

/** Stable machine-facing reason for a local abort. */
function abortFailure() {
  return { message: 'The Trae request was aborted.', code: 'ABORTED' };
}

/** Map Trae's `finish_reason` onto the harness union. */
function finishReasonFor(raw) {
  const reason = String(raw || 'stop').toLowerCase();
  if (reason === 'tool_calls' || reason === 'tool_call') return { kind: 'tool-calls' };
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') return { kind: 'max-tokens' };
  return { kind: 'stop' };
}

/**
 * Classify one upstream failure into a stable harness code.
 * The message is passed through verbatim and never re-worded, so a provider
 * error can never be mistaken for a credential diagnostic here.
 */
function upstreamFailure(err) {
  const status = err?.httpStatus;
  const code = err?.code;
  if (status === 401 || status === 403 || code === 1001) {
    return { message: err.message, code: 'AUTH', ...(status ? { status } : {}) };
  }
  if (status === 429) return { message: err.message, code: 'RATE_LIMIT', status };
  if (status === 402) return { message: err.message, code: 'QUOTA', status };
  // The gateway reports an exhausted balance as an SSE error with a business
  // code instead of an HTTP status, so it would otherwise land in UNKNOWN and
  // render as a generic provider failure.
  if (code === 4008 || code === 4009 || /exceeded the quota|quota exceeded/i.test(String(err?.message ?? ''))) {
    return { message: err.message, code: 'QUOTA' };
  }
  if (status === 400 || status === 422) return { message: err.message, code: 'INVALID_REQUEST', status };
  if (typeof status === 'number' && status >= 500) return { message: err.message, code: 'PROVIDER_ERROR', status };
  return { message: err.message, code: 'UNKNOWN' };
}

/** One provider route's adapter instance. */
export class TraeAdapter extends LlmAdapter {
  /**
   * @param {object} options
   * @param {any} options.ctx - plugin context, for the attachment seam.
   * @param {object} options.env - `detectEnv()` result, possibly with overrides.
   * @param {any} options.credentials - `CredentialStore`.
   * @param {any} [options.logger] - cordis logger.
   * @param {string} [options.requestStyle] - `chat_v3` (default, verified) or `inline_chat`.
   * @param {string} [options.displayName] - provider name for selectors.
   * @param {number} [options.catalogTtlMs] - catalog lifetime.
   */
  constructor({
    ctx,
    env,
    credentials: credentialStore,
    logger = console,
    requestStyle = 'chat_v3',
    displayName = 'Trae CN',
    catalogTtlMs = CATALOG_TTL_MS,
  } = {}) {
    super();
    this.ctx = ctx;
    this.env = env;
    this.store = credentialStore;
    this.logger = logger;
    this.requestStyle = requestStyle;
    this.displayName = displayName;
    this.catalogTtlMs = catalogTtlMs;
    this.imageResolver = imageReaderFor(ctx);
    /** @type {Map<string, {models: any[], at: number, error: Error | null}>} */
    this.catalogs = new Map();
    /** @type {Promise<any[]> | null} */
    this.loading = null;
    /** @type {Promise<any> | null} */
    this.refreshing = null;
    /** A refreshed local-install credential, held in memory instead of persisted. */
    this.forcedCreds = null;
    this.missingLogged = false;
  }

  /** Provider display metadata; `id` must equal the route the caller passed. */
  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  /** Completion request never surfaces retryable transport codes of its own. */
  providerRetryPolicy(_provider) {
    return undefined;
  }

  /** Model catalog, cached per route. */
  async listModels(provider) {
    const models = await this.catalog(provider);
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.effortOptions?.length
        ? { description: `reasoning: ${model.effortOptions.join(' / ')}` }
        : {}),
      inputModalities: model.vision ? ['text', 'image'] : ['text'],
    }));
  }

  /** Exact-route metadata for one model id. */
  async resolveModel(provider, model, signal) {
    const entry = await this.entryFor(provider, model, signal);
    const reasoning = reasoningInfoFor(entry);
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      // `contextWindow` comes from the catalog's `context_window_tokens` /
      // `context_window_size`; a `__max` profile widens it.
      ...(entry.contextWindow > 0 ? { context: { contextWindow: entry.contextWindow } } : {}),
      // Absent when the model declares no `reasoning_effort_config`, which is
      // the contract the runtime enforces (it rejects an empty efforts list).
      ...(reasoning ? { reasoning } : {}),
    };
  }

  /**
   * The raw catalog entry enriched with the reasoning metadata `buildChatBody`
   * needs. `stream()` and `prepareCall()` must both use this: passing the bare
   * entry made `reasoningEffortFor()` miss `info.reasoning.efforts` and silently
   * drop a declared-and-requested effort.
   */
  async infoFor(provider, model, signal) {
    const entry = await this.entryFor(provider, model, signal);
    const reasoning = reasoningInfoFor(entry);
    return reasoning ? { ...entry, reasoning } : entry;
  }

  /** Bind one generation's model metadata to its dispatch entry point. */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    const info = await this.infoFor(provider, model, signal);
    return {
      model: resolved,
      // The harness dereferences `Symbol.asyncIterator` on the value returned
      // here *synchronously* (an adapter must hand back an AsyncIterable, not a
      // promise of one), so this entry point has to be a generator.
      stream: (options) => this.streamPrepared(options, info, provider),
    };
  }

  /**
   * Dispatch entry point for `prepareCall()`. Returns an AsyncIterable
   * synchronously while the eager upstream start stays inside
   * {@link streamWithInfo}.
   * @param options - the full request.
   * @param info - catalog entry enriched with reasoning metadata.
   * @param provider - registered provider route.
   * @returns the harness chunk stream.
   */
  async *streamPrepared(options, info, provider) {
    yield* await this.streamWithInfo(options, info, provider);
  }

  /** Required entry point: resolve the route, then stream. */
  async *stream(options) {
    const info = await this.infoFor(options.provider, options.model, options.signal);
    const chunks = await this.streamWithInfo(options, info, options.provider);
    yield* chunks;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Build the catalog-backed entry for one model id.
   * @param {string} provider - provider route.
   * @param {string} requested - model id, or empty/`auto` for the first entry.
   * @param {AbortSignal} [signal] - cancellation.
   */
  async entryFor(provider, requested, signal) {
    const models = await this.catalog(provider, signal);
    const want = String(requested || '').trim().toLowerCase();
    const exact =
      !want || want === 'auto' || want === 'default'
        ? models[0]
        : models.find((model) => model.id.toLowerCase() === want) ||
          models.find((model) => model.modelName?.toLowerCase() === want) ||
          models.find((model) => model.name?.toLowerCase() === want) ||
          models.find((model) => model.id.toLowerCase().includes(want));
    if (!exact) {
      throw new LlmError(
        `trae-cn: model "${requested}" is not in the current Trae catalog; call listModels() for the accepted ids`,
        'MODEL_NOT_FOUND',
      );
    }
    return exact;
  }

  /**
   * Read one route's catalog, refreshing on the configured TTL.
   * @param {string} provider - provider route.
   * @param {AbortSignal} [signal] - cancellation (checked between attempts).
   */
  async catalog(provider, signal) {
    const cached = this.catalogs.get(provider);
    const now = Date.now();
    if (cached?.models?.length && now - cached.at < this.catalogTtlMs) return cached.models;
    if (cached?.error && now - cached.at < CATALOG_RETRY_MS) throw cached.error;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        const models = await this.withAuthRetry((creds) =>
          fetchModelCatalog(creds, this.env, this.wireHeaders(creds)),
        );
        this.catalogs.set(provider, { models, at: Date.now(), error: null });
        this.missingLogged = false;
        return models;
      } catch (err) {
        this.catalogs.set(provider, { models: [], at: Date.now(), error: err });
        throw err;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Current login, or a MISSING_CREDENTIAL error naming the fix. */
  async requireCredentials() {
    let creds;
    try {
      creds = await this.store.read();
    } catch (err) {
      // A local-install read failure carries a format/length reason only, so
      // the message is safe to pass through as-is.
      if (err instanceof CredentialUnavailableError) {
        if (!this.missingLogged) {
          this.missingLogged = true;
          this.logger.warn?.(`[trae-cn] ${err.message}`);
        }
        throw new LlmError(`trae-cn: ${err.message}`, 'MISSING_CREDENTIAL', { cause: err });
      }
      throw err;
    }
    if (!creds?.refreshToken) {
      if (!this.missingLogged) {
        this.missingLogged = true;
        this.logger.warn?.(
          this.store.source === 'oauth'
            ? `[trae-cn] 未登录：请运行 /trae-login 完成浏览器授权（或 node src/cli.js login）。凭据位置: ${this.store.fallbackFile}`
            : `[trae-cn] 未取到凭据（credentialSource=${this.store.source}）：请运行 /trae-login 登录，或把 credentialSource 设为 local/auto 以读取本机 Trae 凭据`,
        );
      }
      throw new LlmError(
        this.store.source === 'oauth'
          ? `trae-cn: no Trae CN credentials. Run the /trae-login command to authorize in a browser (the standalone equivalent is "node src/cli.js login"). The login is stored as the "${this.store.scope}/${this.store.id}" credential record and at ${this.store.fallbackFile}`
          : `trae-cn: no usable Trae CN credential for credentialSource="${this.store.source}". Either run /trae-login, or select the local Trae install's own credential with credentialSource: local (edition "${this.store.edition}").`,
        'MISSING_CREDENTIAL',
      );
    }
    return creds;
  }

  /**
   * Refresh when the access token is near expiry; concurrent callers share one
   * refresh.
   *
   * @param {boolean} [force] - refresh even when `needsRefresh()` says no. Used
   *   by {@link withAuthRetry} after the gateway rejected the token.
   */
  async ensureFresh(force = false) {
    // A local-install credential is refreshed into memory only, so it wins once
    // it exists; an OAuth credential is re-read (and persisted on rotation).
    const creds = this.forcedCreds ?? (await this.requireCredentials());
    if (!force && !needsRefresh(creds)) return creds;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        let next;
        try {
          next = await this.store.refresh(creds, this.env.ideVersion);
        } catch (err) {
          // `needsRefresh()` fires 30 minutes early, so a transient refresh
          // failure must not break a request the still-valid token could have
          // served — degrade instead of failing.
          const now = Math.floor(Date.now() / 1000);
          if (creds.expiresAt && now < creds.expiresAt) {
            this.logger.warn?.(
              `[trae-cn] 刷新登录凭据失败，但 access token 尚未过期（${new Date(creds.expiresAt * 1000).toISOString()}），` +
                `本次先用现有凭据继续：${err?.message ?? err}`,
            );
            return creds;
          }
          // Genuinely stuck. The gateway reports a dead refresh token as
          // `30022 网络异常`, which reads like a transient network fault. Measured:
          // it is not — once the access token expires there is no way forward
          // without a new login, and a stale refresh token is the normal way to
          // get here (the Trae client rotates its own copy, and a refresh whose
          // result was discarded kills the old value).
          throw new LlmError(
            `trae-cn: 刷新登录凭据失败（source=${this.store.source}；上游返回 ${err?.message ?? err}）。` +
              '这通常意味着 refresh token 已失效。' +
              'access token 过期后必须重新登录：在 DSH 中运行登录命令，或执行 "node src/cli.js login"。',
            'REFRESH_FAILED',
            { cause: err },
          );
        }
        next.userId ||= creds.userId;
        next.username ||= creds.username;
        next.deviceInfo ||= creds.deviceInfo;
        next.privateKeyPem ||= creds.privateKeyPem;
        next.clientId ||= creds.clientId;
        next.host ||= creds.host;
        next.machineId ||= creds.machineId;
        if (next.source === 'local') {
          // The local install owns its own copy; never write a rotated token
          // into the OAuth store, or the two sources would silently diverge.
          this.forcedCreds = next;
        } else {
          await this.store.write(next);
        }
        this.logger.info?.('[trae-cn] access token 已刷新');
        return next;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Run `fn` with a fresh token, refreshing once more on a rejected credential. */
  async withAuthRetry(fn) {
    const creds = await this.ensureFresh();
    try {
      return await fn(creds);
    } catch (err) {
      const unauthorized = err?.httpStatus === 401 || err?.code === 1001;
      if (!unauthorized) throw err;
      this.logger.warn?.('[trae-cn] 认证失败，刷新令牌后重试一次');
      this.refreshing = null;
      // `force` rather than persisting `expiresAt: 0`: `needsRefresh()` treats a
      // falsy expiry as "unknown, do not refresh", so that trick silently made
      // this retry reuse the very token the gateway had just rejected.
      const next = await this.ensureFresh(true);
      return fn(next);
    }
  }

  /**
   * Every provider HTTP request carries the harness attribution headers.
   * The IDE header group owns the lowercase names it already sets, so
   * attribution is merged in without clobbering them.
   */
  wireHeaders(creds, { sse = false } = {}) {
    return {
      ...ideHeaders(creds, this.env, { sse }),
      ...attributionHeaders(),
    };
  }

  /**
   * Translate one Trae chat call into the harness chunk stream.
   *
   * `streamWithInfo` itself is deliberately **not** an async generator: it is
   * an async function that performs the whole request set-up and only then
   * returns the chunk iterable. That ordering is what lets {@link streamAsync}
   * start the upstream call eagerly, before the consumer's first `next()`.
   */
  streamWithInfo(options, info, provider) {
    return this.streamAsync(options, info, provider);
  }

  /** Build the request, start the call, and return its chunk generator. */
  async streamAsync(options, info, provider) {
    const providerName = provider || options.provider;
    const requestId = crypto.randomUUID();
    const messages = await withSystemMessage(
      await toTraeMessages(options.messages ?? [], { imageResolver: this.imageResolver }),
      options.system,
    );
    const body = buildChatBody({
      messages,
      tools: options.tools,
      info,
      // The upstream pairs a chat with a session; DSH's session id is the
      // stable pairing key, and a per-call UUID is the fallback when the caller
      // has none. `chat-body.js` only emits the fields when this is present.
      options: { ...options, sessionId: options.sessionId ?? requestId },
      requestStyle: this.requestStyle,
    });
    if (this.requestStyle === 'inline_chat') {
      // The experimental inline_chat shape pairs the request with a session id; the
      // harness session (when the caller has one) is the better pairing key.
      body.request_id = requestId;
      body.session_id = options.sessionId ?? requestId;
    }
    const attachmentCount = countImages(options.messages);
    if (attachmentCount > 0 && !this.imageResolver) {
      this.logger.warn?.(
        `[trae-cn] 请求含 ${attachmentCount} 张图片，但当前组合没有 attachments 服务，已退化为文本占位符`,
      );
    }
    this.logger.debug?.(
      `[trae-cn] ${providerName}/${info.id} → ${this.requestStyle}，` +
        `${messages.length} 条消息，${toTraeTools(options.tools).length} 个工具，` +
        `effort=${reasoningEffortFor(options, info) ?? '(未透传)'}`,
    );

    // Chunks are handed over one at a time through this queue: deltas as they
    // arrive, then the usage chunk and the terminal finish once the call
    // settles. Nothing is buffered to the end, so a long answer still streams.
    const queue = createChunkQueue();
    const state = createTranslationState(queue, info);

    // The call is kicked off *eagerly*, in this synchronous frame, and its
    // completion closes the queue one macrotask later. Both details are
    // load-bearing:
    //
    //  * eager: the consumer's first `next()` is itself scheduled on a
    //    microtask, which fires before this generator body would have run if
    //    the call were started inside it. Starting here means events are
    //    already queued by then, so the consumer never has to wait for a push
    //    that already happened.
    //  * one macrotask later: if the queue closed from a microtask, it could
    //    close in the window after the consumer drained its last chunk but
    //    before it re-entered `shift()`, and the close signal would be lost.
    //    Deferring past the microtask queue closes that window.
    const call = this.withAuthRetry((creds) =>
      chat({
        creds,
        env: this.env,
        body,
        signal: options.signal,
        headers: this.wireHeaders(creds, { sse: true }),
        onEvent: (event) => state.accept(event),
      }),
    );
    // Side-band rejection handler: `pumpCall` below still observes the failure,
    // but this keeps a fast rejection from also tripping the unhandled
    // rejection warning.
    call.catch(() => {});

    const pumpCall = (async () => {
      let result;
      let failed;
      try {
        result = await call;
      } catch (err) {
        failed = err;
      }
      // Close every open block first, so the assembler sees its block-ends
      // before it stops reading.
      state.finish();
      await new Promise((resolve) => setImmediate(resolve));
      queue.close();
      return { result, failed };
    })();

    // Bound explicitly: a function declaration would lose `this` for the
    // diagnostic warn below.
    const adapter = this;
    async function* chunks() {
      while (true) {
        const next = await queue.shift();
        if (next.done) break;
        yield next.value;
      }
      const { result, failed } = await pumpCall;
      // Anything `state.finish()` produced while the queue was still open.
      while (true) {
        const next = queue.shiftNow();
        if (next.done) break;
        yield next.value;
      }

      if (failed) {
        const aborted = options.signal?.aborted || failed?.name === 'AbortError';
        if (aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: abortFailure() } };
          return;
        }
        const failure = upstreamFailure(failed);
        adapter.logger.warn?.(`[trae-cn] 上游失败 (${failure.code}): ${failure.message}`);
        yield { type: 'finish', reason: { kind: 'error', failure } };
        return;
      }
      // The real upstream answers `finish_reason: "stop"` even on turns where it
      // emitted tool calls (measured), so a tool-bearing turn is reported as
      // `tool-calls` instead of trusting the raw string alone.
      const mapped = finishReasonFor(result?.finishReason);
      const reason = mapped.kind === 'stop' && state.sawToolCalls() ? { kind: 'tool-calls' } : mapped;
      yield { type: 'finish', reason };
    }

    return chunks();
  }
}

/**
 * A promise-ordered hand-off queue: `push()` from a synchronous callback,
 * awaited by the consumer. The waiter is registered *inside* the check loop, so
 * a push that lands between the emptiness check and the registration is never
 * lost (a single `wake` slot plus a bare `this.closed` produced exactly that
 * lost-wakeup hang before this shape).
 */
function createChunkQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  const settle = () => {
    if (!wake) return;
    const resolve = wake;
    wake = null;
    resolve();
  };
  return {
    push(chunk) {
      items.push(chunk);
      settle();
    },
    /** Await the next chunk, or `{done:true}` once {@link close} has run and the queue drained. */
    async shift() {
      while (items.length === 0) {
        if (closed) return { done: true };
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      return { done: false, value: items.shift() };
    },
    /** Drain whatever is already queued without waiting. */
    shiftNow() {
      if (items.length === 0) return { done: true };
      return { done: false, value: items.shift() };
    },
    close() {
      closed = true;
      settle();
    },
  };
}

/**
 * Stateful Trae-event -> StreamChunk translation.
 *
 * Text and reasoning deltas open their block on the first piece and stream
 * straight through. Tool calls follow the upstream's own shape: the call is
 * announced first (id/name), its argument string accumulates across frames,
 * and the block closes with the complete argument JSON. The harness
 * assembler accepts delta-only block ends, and closing here guarantees the
 * emitted block is the full call rather than a partial one.
 */
function createTranslationState(queue, info) {
  const open = new Map();
  const tools = new Map();
  let nextIndex = 0;
  let pendingUsage = null;
  let toolCallsSeen = false;

  const openBlock = (key, blockType) => {
    // Switching content type (reasoning -> text -> tool call) closes whatever is
    // still open, so every block is contiguous and closed in the stream.
    for (const other of [...open.keys()]) if (other !== key) closeBlock(other);
    const index = nextIndex;
    nextIndex += 1;
    open.set(key, { index, blockType, text: '', args: '', id: undefined, name: undefined });
    queue.push({ type: 'block-start', index, blockType });
    return open.get(key);
  };

  const slotFor = (key, blockType) => open.get(key) ?? openBlock(key, blockType);

  const closeBlock = (key) => {
    const slot = open.get(key);
    if (!slot) return;
    open.delete(key);
    if (slot.blockType === 'text') {
      queue.push({ type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } });
      return;
    }
    if (slot.blockType === 'reasoning') {
      queue.push({ type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.text } });
      return;
    }
    queue.push({
      type: 'block-end',
      index: slot.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(slot.id || `call-${slot.index}`),
        name: slot.name ?? '',
        arguments: slot.args || '{}',
      },
    });
  };

  return {
    /** True once any tool call has been translated. */
    sawToolCalls: () => toolCallsSeen,
    /** Feed one normalized event from `src/trae-client.js`. */
    accept(event) {
      if (!event || typeof event !== 'object') return;
      switch (event.type) {
        case 'text': {
          if (!event.text) return;
          const slot = slotFor('text', 'text');
          slot.text += event.text;
          queue.push({ type: 'text-delta', index: slot.index, text: event.text });
          return;
        }
        case 'reason': {
          if (!event.text) return;
          const slot = slotFor('reasoning', 'reasoning');
          slot.text += event.text;
          queue.push({ type: 'reasoning-delta', index: slot.index, text: event.text });
          return;
        }
        case 'tool': {
          toolCallsSeen = true;
          const key = `tool:${event.index ?? tools.size}`;
          const slot = slotFor(key, 'tool-call');
          tools.set(key, slot);
          if (event.id) slot.id = event.id;
          if (event.name) slot.name = event.name;
          const delta = typeof event.arguments === 'string' ? event.arguments : '';
          slot.args += delta;
          queue.push({
            type: 'tool-call-delta',
            index: slot.index,
            id: ToolCallId(slot.id || `call-${slot.index}`),
            ...(slot.name ? { name: slot.name } : {}),
            argumentsDelta: delta,
          });
          return;
        }
        case 'usage':
          // Upstream may publish usage more than once (token_usage then
          // notify_usage). Buffer the last one: pushing here would place the
          // chunk before the block-ends, so finish() releases it after every
          // block is closed and immediately before the terminal finish chunk.
          pendingUsage = event.usage;
          return;
        default:
          return; // queue / done / error are handled by the caller path
      }
    },
    /** Close every open block, then release the buffered usage. */
    finish() {
      for (const key of [...open.keys()]) closeBlock(key);
      if (pendingUsage) {
        queue.push({ type: 'usage', usage: toTokenUsage(pendingUsage) });
        pendingUsage = null;
      }
    },
  };
}

/** Count image occurrences anywhere in a request history. */
function countImages(messages) {
  let count = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'image') count += 1;
      if (block?.type === 'tool-result' && Array.isArray(block.content)) {
        for (const nested of block.content) if (nested?.type === 'image') count += 1;
      }
    }
  }
  return count;
}

export { finishReasonFor, upstreamFailure, toTokenUsage };
