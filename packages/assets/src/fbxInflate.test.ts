import { describe, expect, it } from 'vitest';
import { browserInflate, browserInflateRaw } from './fbxInflate.ts';

/**
 * What a browser's decompressor does at the end of a stream, which is where two hosts disagree.
 *
 * Node's `zlib.inflateSync` — what the baker uses — returns every byte of a stream that has
 * bytes after its end. `DecompressionStream` errors on the same input, *after* delivering every
 * byte. So a file the baker reads is a file a browser refuses, over padding rather than over
 * anything in the arrays. These hold the reconciliation.
 */

async function deflate(bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const payload = (): Uint8Array => {
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
  return bytes;
};

describe('the browser decompressors', () => {
  it('expands a stream that is exactly what it says it is', async () => {
    const raw = payload();
    expect(await browserInflate(await deflate(raw, 'deflate'), raw.length)).toEqual(raw);
  });

  it('keeps the array when a file wrote bytes after the end of the stream', async () => {
    const raw = payload();
    const compressed = await deflate(raw, 'deflate');
    const padded = new Uint8Array(compressed.length + 16);
    padded.set(compressed);
    expect(await browserInflate(padded, raw.length)).toEqual(raw);
  });

  it('refuses a stream that came up short, rather than handing back half an array', async () => {
    const raw = payload();
    const compressed = await deflate(raw, 'deflate');
    await expect(
      browserInflate(compressed.slice(0, compressed.length - 20), raw.length),
    ).rejects.toThrow();
  });

  /*
   * The message is the whole point of reading the stream by hand. `new Response(stream)` reports
   * `Failed to fetch` for every one of these, which is what a consumer saw for a model that would
   * not load, and it sends the reader to the network for a fault in a file.
   */
  it('says what the platform said rather than naming the network', async () => {
    await expect(browserInflate(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 64)).rejects.not.toThrow(
      /failed to fetch/i,
    );
  });

  it('does the same for the raw deflate a zip stores', async () => {
    const raw = payload();
    const compressed = await deflate(raw, 'deflate-raw');
    const padded = new Uint8Array(compressed.length + 8);
    padded.set(compressed);
    expect(await browserInflateRaw(padded, raw.length)).toEqual(raw);
  });
});
