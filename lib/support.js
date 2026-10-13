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
