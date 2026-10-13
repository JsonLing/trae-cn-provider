// attribution.js - the harness attribution headers, without a hard dependency.
//
// `@deepseek-ai/dsh-llm` requires that "every provider HTTP request must include
// attributionHeaders()". The adapter merges the real value through
// `lib/llm.js`; this module exists for the shared transport in `src/`, which is
// also runnable as a plain CLI outside the harness and therefore cannot assume
// the harness package resolves. When it does not resolve, the fallback keeps the
// public product-token shape (`product/version (+url)`) so an out-of-harness run
// still self-identifies rather than sending nothing.
let impl = null;
try {
  const mod = await import('@deepseek-ai/dsh-llm');
  if (typeof mod.attributionHeaders === 'function') impl = mod.attributionHeaders;
} catch {
  impl = null;
}

/** Fallback identity mirrors `APP_IDENTITY` in the harness. */
const FALLBACK = { product: 'deepseek-harness', version: '0.0.0', url: 'https://github.com/deepseek-ai/deepseek-harness' };

/**
 * Build the attribution headers for one provider request.
 * @param {object} [identity] - optional identity override.
 * @returns {Record<string, string>} headers to merge into the request.
 */
export function attribution() {
  if (impl) return impl();
  return { 'user-agent': `${FALLBACK.product}/${FALLBACK.version} (+${FALLBACK.url})` };
}

export const hasRealAttribution = impl !== null;
