/**
 * Decompressing an FBX's arrays in a browser. One responsibility: make an async
 * decompressor usable by a synchronous parser.
 *
 * **The problem.** FBX stores its vertex arrays deflate-compressed, and `fbxToMeshes` is
 * synchronous: it walks a recursive record tree and decodes each array where it meets it.
 * The only decompressor a browser has built in is `DecompressionStream`, which is
 * asynchronous. So the reader ran everywhere except the one place it was designed to be able
 * to run, and only for files that happen to store their arrays uncompressed.
 *
 * **Why not make the reader async.** Every array decode sits inside a recursive descent over
 * the tree, so awaiting there turns the whole parser inside out for a cost paid once per
 * file. It would also make the baker's path async for no reason, since Node has had a
 * synchronous inflate all along.
 *
 * **Why not ship a decompressor.** Writing a DEFLATE decoder is a couple of hundred lines of
 * Huffman tables and back-references. It is well specified and it is also exactly the sort of
 * thing the platform already does, faster, in code somebody else maintains. Adding one would
 * be choosing to own a correctness risk for nothing.
 *
 * **So: decompress everything first, then parse.** The tree is walked once with an inflate
 * that *records* each compressed span instead of expanding it, every span is decompressed
 * concurrently, and the real parse then runs synchronously against the results. Two structural
 * walks rather than one, and the expensive half happens exactly once.
 */

import { parseFbxTree } from './fbx.ts';
import { readZip } from './zip.ts';
import type { Inflate } from './fbx.ts';
import { DrftError } from '@driftengine/drft';

/** Turn a deflate stream into bytes, eventually. What a browser can actually offer. */
export type AsyncInflate = (compressed: Uint8Array, expectedBytes: number) => Promise<Uint8Array>;

/**
 * Read a decompression stream to the end, and decide what a failure at the end means.
 *
 * **Written because `new Response(stream).arrayBuffer()` throws away the reason.** Measured in
 * Chrome 141 over the four ways a deflate stream can fail — bytes after the end, a truncated
 * payload, a flipped byte, and something that is not deflate at all — and the Response reports
 * exactly `Failed to fetch` for every one of them. That is the message a consumer saw for a
 * model that would not load, and it names the network for a fault that has nothing to do with
 * it. A reader keeps what the platform actually said: *Junk found after end of compressed
 * data*, *Compressed input was truncated*, *incorrect header check*.
 *
 * **And bytes after the end of the stream are not a failure**, which is the other half and the
 * one that changes what loads. Measured on both sides: Node's `zlib.inflateSync` returns all
 * 4,096 bytes of a stream with sixteen zeros appended, and `DecompressionStream` errors on the
 * same input *after* delivering all 4,096. So an exporter that writes a padded length produces a
 * file the baker reads and a browser refuses, which is a difference between two hosts reading one
 * format rather than anything about the file. The bytes are complete either way, so they are
 * kept, and the error is only raised when the array actually came up short.
 *
 * What would make this wrong: a stream that errors early *and* whose header happens to promise
 * fewer bytes than arrived. `expectedBytes` comes from the record around the payload rather than
 * from the payload itself, so that would need the file to be wrong about its own array, which is
 * a different failure and one the reader above this catches by shape.
 */
async function readToEnd(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
  } catch (error) {
    /* Short, so the array is genuinely missing bytes and the reason belongs to the caller. */
    if (got === 0 || got < expectedBytes) {
      const said = error instanceof Error ? error.message : String(error);
      throw new Error(said === '' ? 'the compressed data could not be read' : said);
    }
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * `DecompressionStream`, which every target browser has and which needs no dependency.
 *
 * FBX writes zlib-wrapped deflate, so `'deflate'` rather than `'deflate-raw'`. Getting that
 * wrong fails on the first two bytes rather than producing something subtly wrong, which is
 * the good kind of mistake to make.
 */
export const browserInflate: AsyncInflate = async (compressed, expectedBytes) => {
  const stream = new Blob([compressed.slice()])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return readToEnd(stream, expectedBytes);
};

/**
 * Decompress every array in a file, then hand back a synchronous `Inflate` over the results.
 *
 * The returned function is what `fbxToMeshes` wants, so the reader itself needs no change and
 * the baker keeps using Node's synchronous inflate directly.
 *
 * Spans are keyed by `byteOffset`, which identifies them exactly: each compressed payload is
 * a subarray of the one buffer being read, so its offset within that buffer is unique and is
 * the same value the parser will present on the second pass.
 */
interface Span {
  readonly at: number;
  readonly compressed: Uint8Array;
  readonly expected: number;
}

/**
 * Expand every recorded span, and give a failure a second chance on its own.
 *
 * **The retry is for a fan-out and not for the data.** Both callers hand `Promise.all` every
 * span a file has at once, which for one bought model measured 1,586 concurrent Blobs, streams
 * and stream readers, on top of the 32 the archive around it had already run. A file this shape
 * was reported as failing at one span while the same span, decompressed on its own in the same
 * browser, was measured as completely sound: the compressed length is 1,064 bytes, the array is
 * 1,680, and it expands to exactly that. So the one thing left standing is the company it was
 * decompressed in, which is a resource failure rather than a file.
 *
 * The cost is one extra attempt, on the failure path only, after the fan-out has drained. What
 * would make it wrong is a file that fails deterministically: then the second attempt fails
 * identically, the throw carries the platform's own reason, and the only thing lost is the time
 * of a single span. That is the trade, and it is why the retry is not a loop.
 */
async function expandSpans(
  spans: readonly Span[],
  inflate: AsyncInflate,
  format: 'fbx' | 'zip',
): Promise<Map<number, Uint8Array>> {
  const decoded = new Map<number, Uint8Array>();
  const failed: Span[] = [];

  await Promise.all(
    spans.map(async (span) => {
      try {
        decoded.set(span.at, await inflate(span.compressed, span.expected));
      } catch {
        failed.push(span);
      }
    }),
  );

  for (const span of failed) {
    try {
      decoded.set(span.at, await inflate(span.compressed, span.expected));
    } catch (error) {
      throw new DrftError(
        `${format}: an array at byte ${span.at} would not decompress: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return decoded;
}

export async function prepareFbxInflate(
  buffer: ArrayBuffer,
  inflate: AsyncInflate,
): Promise<Inflate> {
  const spans: Span[] = [];

  /*
   * Pass one records rather than expands. The stand-in has to be the *expected* length,
   * because the caller immediately builds a typed array over it and a short one would throw
   * here rather than at the point the shape is actually wrong.
   */
  parseFbxTree(buffer, (compressed, expected) => {
    spans.push({ at: compressed.byteOffset, compressed, expected });
    return new Uint8Array(expected);
  });

  const decoded = await expandSpans(spans, inflate, 'fbx');

  return (compressed: Uint8Array, expectedBytes: number): Uint8Array => {
    const found = decoded.get(compressed.byteOffset);
    if (found === undefined) {
      /*
       * Only reachable if the two passes disagreed about the file, which would mean the
       * parse is not deterministic. Loud, because silently returning empty bytes would draw
       * a model with a hole in it and send somebody looking at the geometry reader.
       */
      throw new DrftError(
        `fbx: no decompressed array was prepared for byte ${compressed.byteOffset}`,
      );
    }
    if (found.length < expectedBytes) {
      throw new DrftError(
        `fbx: an array at byte ${compressed.byteOffset} decompressed to ${found.length} bytes, ` +
          `and its own header says ${expectedBytes}`,
      );
    }
    return found;
  };
}

/**
 * The same trick for a zip, which is how a `.3mf` and a bought archive both arrive.
 *
 * **Promoted from a consumer's private copy.** Every piece needed to open an archive was already
 * exported — `readZip`, `readerFor`, `MODEL_FORMATS`, `assetCandidates`, `ModelSource.beside` — and
 * a second consumer still spent about sixty lines assembling them, most of it rediscovering this
 * function. The engine's own model worker had implemented it privately for `.3mf` at the same time,
 * which is two copies of one idea and the point at which it belongs here.
 *
 * **A zip stores raw deflate and FBX stores zlib-wrapped**, so this takes its own decompressor and
 * is deliberately a separate name from `prepareFbxInflate`. Passing either where the other belongs
 * fails on the first bytes, which is the good kind of mistake.
 *
 * Two passes for the same reason: `readZip` expands each entry as it walks and the only
 * decompressor a browser has is asynchronous, so entries are recorded first and answered second.
 * Spans are keyed by `byteOffset`, which identifies them exactly, since each payload is a subarray
 * of the one buffer being read.
 */
export async function prepareZipInflate(
  buffer: ArrayBuffer,
  inflate: AsyncInflate,
): Promise<Inflate> {
  const spans: Span[] = [];
  readZip(buffer, (compressed, expected) => {
    spans.push({ at: compressed.byteOffset, compressed, expected });
    return new Uint8Array(expected);
  });

  /* The same expansion the FBX path takes, which this one used to do without the retry and
     without saying which entry failed: a bare rejection out of `Promise.all` named neither. */
  const decoded = await expandSpans(spans, inflate, 'zip');

  return (compressed: Uint8Array): Uint8Array => {
    const found = decoded.get(compressed.byteOffset);
    if (found === undefined) {
      throw new DrftError(
        `zip: no decompressed entry was prepared for byte ${compressed.byteOffset}`,
      );
    }
    return found;
  };
}

/**
 * Raw deflate through the browser, which is what a zip needs and what FBX must not be given.
 */
export const browserInflateRaw: AsyncInflate = async (compressed, expectedBytes) => {
  const stream = new Blob([compressed.slice()])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return readToEnd(stream, expectedBytes);
};
