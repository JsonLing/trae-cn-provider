// support.js - small shared helpers: numbers, sanitizing, deferred reads.
import crypto from 'node:crypto';

/** First finite number among `keys`, else `fallback`. */
export function num(source, keys, fallback = 0) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

/** First non-empty string among `keys`, else `fallback`. */
export function pick(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

/** First boolean among `keys`, else `fallback`. */
export function bool(source, keys, fallback = false) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

// The upstream model treats OpenCode's native tool tags as its own protocol and
// stalls mid-output, so history text is rewritten to neutral tags before send.
const TOOL_TAG_REWRITES = [
  ['</opencode_tool_call>', '</tool_invoke>'],
  ['<opencode_tool_call>', '<tool_invoke>'],
  ['</opencode_tool_result>', '</tool_result>'],
  ['<opencode_tool_result', '<tool_result'],
];

/** Rewrite provider-hostile tool tags in one history string. */
export function sanitizeToolTags(text) {
  let out = String(text ?? '');
  for (const [from, to] of TOOL_TAG_REWRITES) {
    while (out.includes(from)) out = out.replace(from, to);
  }
  return out;
}

/** Deterministic replacement id for a tool call the provider left anonymous. */
export function fallbackCallId() {
  return `call_${crypto.randomUUID()}`;
}

/** Resolve a dotted-free config default without assuming the value exists. */
export function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

/**
 * Build a successful `/trae-login` command result.
 *
 * `CommandResult` is a **closed union**. `@deepseek-ai/dsh-commands` validates it
 * at the registry boundary (`normalizeResult` in its `lib/index.js`) and throws
 *
 *   command "<name>" returned unknown result kind "<kind>"
 *
 * for anything else. The only accepted shapes are:
 *
 *   { kind: 'success', text?: string, sourceEventSeq?: number }
 *   { kind: 'error',   text: string }   // non-empty, and the field is `text`
 *
 * This deliberately lives here rather than inline in the entry so a test can
 * assert the shape: the entry once returned `{ kind: 'text', text }`, which made
 * every `/trae-login` finish the login and then throw on return.
 */
export function commandSuccess(text) {
  return { kind: 'success', text };
}

/** Build a failed command result. `text` must be a non-empty string. */
export function commandFailure(text) {
  return { kind: 'error', text };
}
