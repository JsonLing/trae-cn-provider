// llm.js - resilient access to the `@deepseek-ai/*` runtime packages.
//
// Under the DSH loader every one of these specifiers resolves normally because
// the plugin is mounted from a profile whose node_modules carries the host's
// peer dependencies. A bare checkout of this repository has no such
// node_modules, so the loader-fallback below walks a few well-known DSH
// installation roots and imported the absolute entry point instead. That keeps
// `node -e "import('./lib/index.js')"` loadable from the source tree and keeps
// a published bundle resolving exactly as before.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/** Roots searched, in order, for a fallback copy of a `@deepseek-ai/*` package. */
function fallbackRoots() {
  const roots = [
    path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules'),
    path.join(DSH_HOME, 'profiles', 'web', 'node_modules'),
    path.join(DSH_HOME, 'profiles', 'headless', 'node_modules'),
    path.join(DSH_HOME, 'profiles', 'node_modules'),
    path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ];
  // Walk up from this file so a checkout nested inside an installed tree works.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i += 1) {
    roots.push(path.join(dir, 'node_modules'));
    dir = path.dirname(dir);
  }
  return roots;
}

/**
 * Resolve one package name to an importable file URL.
 * @param {string} name - package specifier, e.g. `@deepseek-ai/dsh-llm`.
 * @returns {Promise<string | null>} file URL, or null when nothing resolves.
 */
async function resolveEntry(name) {
  try {
    return pathToFileURL(require.resolve(name)).href;
  } catch {
    /* fall through to the explicit roots */
  }
  for (const root of fallbackRoots()) {
    try {
      const manifest = path.join(root, name, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const rel =
        (typeof pkg.exports === 'object' && pkg.exports?.['.']?.default) ||
        pkg.exports?.['.'] ||
        pkg.module ||
        pkg.main ||
        'lib/index.js';
      const entry = path.join(root, name, typeof rel === 'string' ? rel : 'lib/index.js');
      if (fs.existsSync(entry)) return pathToFileURL(entry).href;
    } catch {
      /* try the next root */
    }
  }
  return null;
}

/**
 * Import one runtime package, preferring normal resolution.
 * @param {string} name - package specifier.
 * @returns {Promise<any>} the module namespace.
 * @throws {Error} when neither normal nor fallback resolution succeeds.
 */
export async function loadModule(name) {
  try {
    return await import(name);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    const href = await resolveEntry(name);
    if (href) return import(href);
    throw err;
  }
}

export const llm = await loadModule('@deepseek-ai/dsh-llm');
export const credentialsApi = await loadModule('@deepseek-ai/dsh-credentials');

// A namespace object fetched at runtime cannot re-export its names implicitly,
// so the symbols this plugin actually uses are re-exported explicitly. Under a
// DSH profile these resolve to the host's own single instance of the package,
// which is what keeps `instanceof LlmError` and the `instanceof LlmAdapter`
// subclass relationship working across the boundary.
export const {
  LlmAdapter,
  LlmError,
  ToolCallId,
  ReasoningEffortId,
  attributionHeaders,
  userAgent,
  APP_IDENTITY,
} = llm;
