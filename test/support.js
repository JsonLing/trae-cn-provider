// test/support.js - shared test harness.
//
// This checkout has no node_modules of its own, so the tests point module
// resolution at the DSH artifacts that are actually installed on this machine
// before importing any `lib/` module. Nothing here is part of the published
// bundle; the published bundle resolves its peer dependencies normally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** All generated artifacts live under the OS cache dir, never in the repo. */
export const WORK = path.join(os.tmpdir(), 'trae-cn-provider-test');
const SHIM = path.join(WORK, 'node_modules');
const FAKE = path.join(WORK, 'fakehome');
const DSH_NODE_MODULES = path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules');

/** Packages the test imports by bare specifier. */
const NEEDED = ['@deepseek-ai/schemastery'];
/** Packages whose absolute entry is resolved and linked for `lib/llm.js`. */
const LINKED = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-credentials'];

function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(target, linkPath, 'dir');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/** Make bare `@deepseek-ai/*` specifiers resolvable from the temp work dir. */
export function installShims() {
  for (const name of [...NEEDED, ...LINKED]) {
    const source = path.join(DSH_NODE_MODULES, name);
    if (!fs.existsSync(source)) throw new Error(`missing DSH dependency: ${source}`);
    link(source, path.join(SHIM, name));
  }
}

/** Destination paths used by fake credential files. */
export const paths = {
  repo: REPO,
  work: WORK,
  fake: FAKE,
  shim: SHIM,
  out: path.join(WORK, 'out'),
  oauthFile: path.join(FAKE, 'fakehome-note.txt'),
};

/** Import one repository module by its path relative to the repo root. */
export function load(relative) {
  return import(pathToFileURL(path.join(REPO, relative)).href);
}

/** One tiny PNG's bytes, base64. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Build one DSH user message carrying a single text block. */
export function userMessage(text) {
  return { id: 'msg-user-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** Build one DSH assistant message that requested a tool call. */
export function assistantToolCall({ id = 'call_upstream_1', name = 'read_file', args = '{}' } = {}) {
  return {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: [{ type: 'tool-call', id, name, arguments: args }],
    source: { kind: 'model', provider: 'trae-cn', model: 'glm-5.2' },
  };
}

/** Build one DSH tool-result message (a *user-role* message in this model). */
export function toolResultMessage({ callId = 'call_upstream_1', text = 'file body' } = {}) {
  return {
    id: 'msg-tool-1',
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId },
  };
}

/** Minimal structured logger that records everything it is given. */
export function recordingLogger() {
  const lines = [];
  const record = (level) => (message) => lines.push({ level, message: String(message) });
  return {
    lines,
    text: () => lines.map((line) => `${line.level} ${line.message}`).join('\n'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * Install a scripted global fetch.
 * @param {(url: string, init: object, index: number) => any} responder
 * @returns {{calls: Array<{url: string, init: any}>, restore: () => void}}
 */
export function mockFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const index = calls.length - 1;
    const reply = await responder(String(url), init, index);
    if (reply instanceof Response) return reply;
    if (typeof reply === 'object' && reply !== null && typeof reply.body === 'string' && reply.status !== undefined) {
      return new Response(reply.body, { status: reply.status });
    }
    return new Response(JSON.stringify(reply ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A `Response` whose body is the given SSE text. */
export function sseResponse(text) {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Frames one SSE event exactly as the upstream emits it. */
export function sse(event, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** Assert helper that prints the actual value on failure. */
export function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected: ${b}\n  actual:   ${a}`);
}

/** Assert one condition. */
export function assert(condition, label) {
  if (!condition) throw new Error(`assertion failed: ${label}`);
}

/** Run one named test, printing a line either way. */
export async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err?.stack ?? err).split('\n').join('\n       ')}`);
    process.exitCode = 1;
    return false;
  }
}
