// messages.js - DSH provider-neutral messages -> Trae wire messages.
//
// The harness message model differs from OpenAI's in three ways that matter
// here, and all three are handled below:
//   * every message carries `content: ContentBlock[]`, never a bare string;
//   * an assistant tool call is a `tool-call` *block*, not a `tool_calls` field;
//   * a tool result is a **user-role** message whose content is a single
//     `tool-result` block, not a `role: 'tool'` message.
// The OpenAI-shaped branch is kept because the bundled OpenAI-compatible
// endpoint (`lib/index.js` -> `src/openai-server.js`) feeds this same helper
// legacy chat-completion payloads.
import { sanitizeToolTags, fallbackCallId, pick } from './support.js';
import { textOnlyImageText } from './attachments.js';

/** Data URL payload split into its media type and base64 body. */
function decodeDataUrl(url) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ''));
  if (!match) return null;
  const [, mediaType = 'image/png', base64, body] = match;
  return base64 ? { mediaType, data: body } : null;
}

/**
 * Read one image block into an inline part.
 * @param {any} block - DSH `image` content block.
 * @param {any} imageResolver - synchronous factory returning an async reader.
 * @returns {Promise<object[]>} parts for this block.
 */
async function imagePart(block, imageResolver) {
  const ref = block?.attachment ?? block;
  const url = block?.url ?? block?.image_url?.url ?? ref?.url;
  if (typeof url === 'string' && /^data:/i.test(url)) {
    const decoded = decodeDataUrl(url);
    if (decoded) return [{ type: 'image_url', image_url: { url } }];
  }
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    return [{ type: 'image_url', image_url: { url } }];
  }
  if (imageResolver && ref) {
    try {
      const read = imageResolver(ref);
      const inline = read ? await read() : null;
      if (inline?.data) {
        return [{ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } }];
      }
    } catch {
      /* fall through to the placeholder */
    }
  }
  return [{ type: 'text', text: textOnlyImageText(ref) }];
}

/**
 * Convert one content value (string, plain array, or DSH block array) into
 * Trae `content` parts.
 * @param {any} content - string, or array of parts/blocks.
 * @param {any} [imageResolver] - attachment-backed image reader factory.
 * @returns {Promise<object[]>} Trae content parts.
 */
export async function toContentParts(content, imageResolver) {
  const parts = [];
  const pushText = (text) => {
    const clean = sanitizeToolTags(text);
    if (clean) parts.push({ type: 'text', text: clean });
  };

  if (typeof content === 'string') {
    pushText(content);
    return parts;
  }
  if (!Array.isArray(content)) return parts;

  for (const part of content) {
    if (typeof part === 'string') {
      pushText(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text':
      case 'input_text':
        pushText(part.text ?? '');
        break;
      case 'reasoning':
        // Reasoning is provider-private replay state; it is never resent.
        break;
      case 'image':
        parts.push(...(await imagePart(part, imageResolver)));
        break;
      case 'image_url': {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) parts.push({ type: 'image_url', image_url: { url } });
        break;
      }
      case 'tool-call':
        break; // collected by the caller
      case 'tool-result':
      case 'tool_result':
        break; // re-expressed as a top-level message by the caller
      default: {
        // Tolerate provider-shaped parts that predate the DSH block union.
        const url = part.image_url ?? part.image;
        const resolved = typeof url === 'string' ? url : url?.url ?? part.url;
        if (resolved) parts.push({ type: 'image_url', image_url: { url: resolved } });
        else if (typeof part.text === 'string') pushText(part.text);
      }
    }
  }
  return parts;
}

/** Coerce one legacy tool call into Trae's `function_call` shape. */
function legacyToolCall(call) {
  const fn = call?.function ?? call?.function_call ?? {};
  if (!fn?.name) return null;
  const args = fn.arguments ?? fn.partial_arguments ?? '{}';
  return {
    id: call?.id || fallbackCallId(),
    type: 'function',
    function_call: { name: fn.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

/**
 * Convert harness messages into the Trae `messages` array.
 * @param {readonly any[]} [messages] - DSH `Message[]` (or legacy OpenAI messages).
 * @param {object} [options]
 * @param {any} [options.imageResolver] - attachment-backed image reader factory.
 * @returns {Promise<object[]>} Trae wire messages, never empty.
 */
export async function toTraeMessages(messages = [], { imageResolver } = {}) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    // DSH hands us block arrays, but a legacy OpenAI caller sends a plain string.
    // Treating that as "no blocks" silently dropped the whole message.
    const blocks = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string' && message.content
        ? [{ type: 'text', text: message.content }]
        : [];
    const hasToolResult = blocks.some(
      (block) => block?.type === 'tool-result' || block?.type === 'tool_result',
    );

    if (hasToolResult) {
      for (const block of blocks) {
        if (block?.type !== 'tool-result' && block?.type !== 'tool_result') continue;
        const content = await toContentParts(block.content, imageResolver);
        if (!content.length) content.push({ type: 'text', text: block.isError ? '(tool failed)' : '' });
        out.push({
          role: 'tool',
          tool_call_id: block.toolCallId || message.tool_call_id || 'unknown',
          ...(block.name || message.name ? { name: block.name ?? message.name } : {}),
          content,
        });
      }
      // Any plain text riding beside the tool result stays visible to the model.
      const beside = blocks.filter((block) => block?.type !== 'tool-result' && block?.type !== 'tool_result');
      const parts = await toContentParts(beside, imageResolver);
      if (parts.length) out.push({ role: 'user', content: parts });
      continue;
    }

    if (message.role === 'tool') {
      const content = await toContentParts(message.content, imageResolver);
      if (!content.length) content.push({ type: 'text', text: '' });
      out.push({
        role: 'tool',
        tool_call_id: message.tool_call_id || message.toolCallId || 'unknown',
        ...(message.name ? { name: message.name } : {}),
        content,
      });
      continue;
    }

    // Role decides everything after the two special cases above: a legacy
    // `tool_calls` array is only meaningful on an assistant message, and
    // reading it before this point would let a stray field turn a system or
    // user message into a tool-call-bearing assistant turn.
    const role = message.role === 'developer' || message.role === 'system' ? 'system' : message.role;

    if (role === 'assistant') {
      const blockCalls = blocks
        .filter((block) => block?.type === 'tool-call')
        .map((block) => ({
          id: block.id || fallbackCallId(),
          type: 'function',
          function_call: {
            name: block.name,
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          },
        }))
        .filter((call) => Boolean(call.function_call.name));
      const legacyCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map(legacyToolCall).filter(Boolean)
        : [];
      const toolCalls = [...blockCalls, ...legacyCalls];
      const content = await toContentParts(blocks, imageResolver);
      if (toolCalls.length) {
        out.push({ role: 'assistant', content, tool_calls: toolCalls });
        continue;
      }
      if (!content.length) continue;
      out.push({ role: 'assistant', content });
      continue;
    }

    const content = await toContentParts(blocks, imageResolver);
    if (!content.length) continue;
    out.push({ role: role === 'system' ? 'system' : 'user', content });
  }
  if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: '' }] });
  return out;
}

/**
 * Prepend the harness `system` slot as Trae's own system message.
 * @param {object[]} messages - output of {@link toTraeMessages}.
 * @param {string} [system] - `GenerateOptions.system`.
 * @param {any} [imageResolver] - unused; kept for symmetry at call sites.
 * @returns {Promise<object[]>} messages with the system slot first.
 */
export async function withSystemMessage(messages, system) {
  const text = sanitizeToolTags(system);
  if (!text) return messages;
  return [{ role: 'system', content: [{ type: 'text', text }] }, ...messages];
}

/** Read the display name off a legacy or harness tool schema. */
export function toolFunctionOf(tool) {
  return tool?.function ?? (tool?.name ? tool : null);
}

export { pick };
