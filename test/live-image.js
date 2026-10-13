#!/usr/bin/env node
// test/live-image.js - OPT-IN live check that image input actually reaches the model.
//
//   node test/live-image.js
//
// Not part of `npm run check`: it needs the network and a real credential.
//
// Why it exists: the offline suite asserts the *request body* carries an inline
// data URL for a DSH image block. That does not prove the upstream accepts it
// or that the model can see the picture. This sends a 96x96 solid-red PNG down
// both image paths and checks the answer:
//
//   1. the DSH adapter path  - ContentBlock `{type:'image'}` + the attachment seam
//   2. the OpenAI surface    - `{type:'image_url'}` with a data URL
//
// The image is generated here, so there is no fixture to keep in sync.
import zlib from 'node:zlib';
import { TraeAdapter } from '../lib/adapter.js';
import { CredentialStore } from '../lib/credentials.js';
import { detectEnv } from '../src/env.js';

/** A minimal 8-bit truecolour PNG encoder - enough for a solid colour. */
function solidPng(size, [r, g, b]) {
  const raw = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(0).map((_, i) => [r, g, b][i % 3])])));
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = solidPng(96, [220, 20, 20]);
const PROMPT = '这张图是什么颜色？只回复颜色名，不要解释。';
const env = detectEnv();

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const isRed = (text) => /红|red/i.test(text);

console.log(`test image: 96x96 red PNG, ${png.length} bytes\n`);

// --- 1. DSH adapter path: a ContentBlock image plus the attachment seam ------
try {
  const attachments = { async readImage(ref) { return { data: png, ref }; } };
  const ctx = { get: (name) => (name === 'attachments' ? attachments : undefined) };
  const store = new CredentialStore({ scope: 'trae-cn', id: 'trae-cn', source: 'oauth', edition: 'cn' });
  const adapter = new TraeAdapter({ ctx, env, credentials: store, requestStyle: 'chat_v3', logger: console });

  let text = '';
  let placeholder = false;
  for await (const chunk of adapter.stream({
    provider: 'trae-cn',
    model: 'Doubao-Seed-Code',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image', attachment: { id: 'img-1', name: 'red.png', mediaType: 'image/png', width: 96, height: 96 } },
      ],
    }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  placeholder = /omitted/.test(text);
  check(!placeholder, 'adapter path inlined the attachment (no placeholder)');
  check(isRed(text), 'adapter path: the model saw the image', JSON.stringify(text.slice(0, 40)));
} catch (err) {
  check(false, 'adapter path completed', err?.message ?? String(err));
}

// --- 2. OpenAI surface path: an image_url data URL ---------------------------
try {
  const { TraeProvider, createRequestHandler } = await import('../src/openai-server.js');
  const { loadCredentials } = await import('../src/env.js');
  const http = await import('node:http');
  const provider = new TraeProvider({ env, credentials: loadCredentials() });
  const server = http.createServer(createRequestHandler(provider));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'Doubao-Seed-Code',
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        }],
      }),
    });
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    check(response.status === 200, 'OpenAI surface returned 200', String(response.status));
    check(isRed(text), 'OpenAI surface: the model saw the image', JSON.stringify(String(text).slice(0, 40)));
  } finally {
    server.close();
  }
} catch (err) {
  check(false, 'OpenAI surface path completed', err?.message ?? String(err));
}

console.log(`\nlive-image: ${failures ? 'FAILED' : 'PASSED'}`);
process.exit(failures ? 1 : 0);
