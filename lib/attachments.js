// attachments.js - turn durable DSH image blocks into Trae inline image parts.
//
// The provider-neutral ContentBlock for an image carries only an
// `ImageAttachmentRef` (an opaque store id plus dimensions); the bytes live in
// the attachment service. Trae's wire format wants an
// `{type:'image_url', image_url:{url}}` part, so the store is read here and the
// normalised bytes are inlined as a data URL. The read is best effort: a
// missing service, an unknown ref, or a storage error degrades to a stable
// text placeholder rather than failing the whole request.

/** Stable model-facing text for an image this adapter could not inline. */
export function textOnlyImageText(ref) {
  const name = ref?.name ? ` "${ref.name}"` : '';
  return `[image${name} (${ref?.mediaType ?? 'unknown'}, ${ref?.width ?? '?'}x${ref?.height ?? '?'}) omitted: this Trae route cannot receive its bytes]`;
}

/**
 * Build one image reader backed by the attachment seam.
 * @param {any} ctx - the plugin context (`ctx.get('attachments', false)`).
 * @returns {(ref: any, signal?: AbortSignal) => Promise<{data: string, mediaType: string} | null> | null}
 *   a synchronous factory returning an async reader, or null when no store exists.
 */
export function imageReaderFor(ctx) {
  const store = typeof ctx?.get === 'function' ? ctx.get('attachments', false) : undefined;
  if (!store || typeof store.readImage !== 'function') return null;
  return (ref, signal) => async () => {
    try {
      const stored = await store.readImage(ref, signal);
      if (!stored?.data) return null;
      return {
        data: Buffer.from(stored.data).toString('base64'),
        mediaType: stored.ref?.mediaType || ref?.mediaType || 'image/png',
      };
    } catch {
      return null;
    }
  };
}
