/** Reading a `.drft` while it is still arriving, chunk by chunk. */

import type { MeshData } from './meshData.ts';
import {
  CHUNK_ENTRY_BYTES,
  CHUNK_HEAD,
  CHUNK_LODM,
  CHUNK_SPLT,
  CHUNK_MATL,
  CHUNK_MESH,
  CHUNK_REQUIRED,
  CHUNK_TEXS,
  DRFT_MAGIC,
  DRFT_VERSION_MAJOR,
  DrftError,
  HEADER_BYTES,
  KNOWN_CHUNKS,
  fourCCName,
  CHUNK_ANIM,
  CHUNK_NODE,
  CHUNK_SKIN,
  CHUNK_MORP,
} from './drftFormat.ts';
import type { DrftChunk, DrftHead, DrftMaterial, DrftSplatBlock } from './drftFormat.ts';
import { readHead, readMaterials, readMesh, readSplatBlock, readTexture } from './drftRead.ts';
import type { DrftTexture } from './drftRead.ts';
import type { AnimationClip, DrftSkin } from './animationData.ts';
import type { DrftNode } from './drftSkin.ts';
import type { DrftMorph } from './drftSkin.ts';
import { readClip, readMorph, readNodes, readSkin } from './drftSkin.ts';

/**
 * What the file says is coming, known from the first few kilobytes.
 *
 * **The chunk table is a manifest and always was**: a fixed 32-byte header, then
 * `chunkCount x 16` bytes naming every chunk's kind, offset and length. For a 187-mesh car
 * that is about 3 KB, so a reader holding the first three kilobytes of a 74 MB file knows
 * exactly what the rest of it contains and how big each piece is. That is what lets a loading
 * bar say "142 of 187 parts" rather than counting bytes and hoping.
 */
export interface DrftManifest {
  readonly totalBytes: number;
  readonly meshCount: number;
  readonly textureCount: number;
  /** Bytes of geometry, of images, and of everything else, from the table alone. */
  readonly meshBytes: number;
  readonly textureBytes: number;
  /**
   * How many coarse levels of detail this file carries, which is normally one or none.
   *
   * Worth reporting rather than leaving to be discovered, because it is the difference between
   * a load that opens on an outline and one that opens on an empty room, and a caller composing
   * words for a progress readout wants to know that before the first stage rather than after it.
   */
  readonly lodCount: number;
  /**
   * How many `SPLT` blocks this file carries, and how many bytes they are between them.
   *
   * **Blocks, not splats**, because the number a progress readout wants is how many refinements
   * are still coming — the splat count is in every block's own header and a caller has it from
   * the first one. Zero for a file with no capture, which is most of them.
   */
  readonly splatBlockCount: number;
  readonly splatBytes: number;
}

/**
 * Called as each kind of thing finishes arriving. Every one is optional.
 *
 * A consumer that wants the whole asset at once should use `readDrft`; these exist so a scene
 * can put a coarse thing on screen and improve it, which is the point of streaming at all.
 */
export interface DrftStreamHandlers {
  /** The table has arrived, so what is coming is now known. Fires once, before anything else. */
  readonly onManifest?: (manifest: DrftManifest) => void;
  readonly onHead?: (head: DrftHead) => void;
  /**
   * A coarse whole-model level, with its level ordinal: 0 is the coarsest.
   *
   * Fires before any part on a file the baker laid out, which is the whole point of it — a
   * complete object on screen while the parts are still arriving. A caller that draws it must
   * stop drawing it in the same frame it starts drawing the model, or the two are both there.
   */
  readonly onLod?: (mesh: MeshData, level: number) => void;
  /** One mesh, in the order the file lays them out, with its ordinal in that order. */
  readonly onMesh?: (mesh: MeshData, ordinal: number) => void;
  /**
   * One block of a Gaussian splat capture, with its ordinal.
   *
   * **Every block is a sparse version of the whole capture, so the first one is already worth
   * drawing** — that is what the writer's coarse-first ordering buys and it is the reason splats
   * are in this container rather than in a file of their own. A consumer allocates from
   * `block.totalCount` on the first call and appends after that; the drawn count rises and
   * nothing is re-allocated or re-sorted.
   */
  readonly onSplats?: (block: DrftSplatBlock, ordinal: number) => void;
  /**
   * The asset's hierarchy, once, when its `NODE` chunk lands.
   *
   * Handed over whole rather than a node at a time: a hierarchy is one chunk and a partial one is
   * not useful — a child whose parent has not arrived cannot be placed.
   */
  readonly onNodes?: (nodes: readonly DrftNode[]) => void;
  /** One mesh's morph deltas, naming the mesh ordinal they belong to. */
  readonly onMorph?: (morph: DrftMorph) => void;
  /** One skin, as its `SKIN` chunk lands. Several arrive for an asset with several. */
  readonly onSkin?: (skin: DrftSkin, ordinal: number) => void;
  /**
   * One clip, as its `ANIM` chunk lands.
   *
   * Per chunk rather than collected, for the reason `onSplats` is: a consumer that can start a
   * character on the first clip should not wait for the last. The writer puts all three ahead of
   * the geometry so this is usually possible.
   */
  readonly onClip?: (clip: AnimationClip, ordinal: number) => void;
  readonly onMaterials?: (materials: readonly DrftMaterial[]) => void;
  readonly onTexture?: (texture: DrftTexture, ordinal: number) => void;
}

/**
 * An incremental `.drft` reader: feed it bytes, it reports each chunk as that chunk completes.
 *
 * **Its own entry point rather than a flag on `readDrft`**, which is what docs/FORMAT.md §4.6
 * asks for and the reason is the strictness. `readDrft` requires a `HEAD` and at least one
 * `MESH` and refuses anything partial, which is right for a file on disk and wrong for a
 * stream. The rules do not relax here, they *move*: a chunk is validated when its last byte
 * lands, the table's own rules apply the moment the table is readable, and the whole-asset
 * rules apply at `end`. A malformed file still throws, naming the chunk.
 *
 * **Zero-copy survives, and that is not obvious.** The header carries `totalBytes`, so this
 * allocates one buffer of the final size the moment it knows that number and writes arriving
 * bytes into it. Every completed chunk is then viewed in place, exactly as a whole-file read
 * views it. Accumulating chunks into their own buffers instead would cost a copy per chunk and
 * give up the one property this format exists for.
 *
 * Sequential, because that is the property worth designing for: with the payloads laid out in
 * priority order by the baker, a *plain* fetch refines the model as bytes arrive, with no range
 * requests and no server support beyond serving a file. Range requests would be an
 * optimisation on top, and would need an offset per push rather than a different reader.
 */
export class DrftStream {
  private readonly handlers: DrftStreamHandlers;
  /** The final buffer, once `totalBytes` is known. Written into at the arrival offset. */
  private buffer: ArrayBuffer | null = null;
  private bytes: Uint8Array | null = null;
  /** The header and table, before the real buffer exists. At most a few arrivals. */
  private prelude: Uint8Array[] = [];
  private preludeBytes = 0;
  private received = 0;
  private chunks: DrftChunk[] = [];
  /** How many table entries have been reported complete, in table order. */
  private settled = 0;
  private meshOrdinal = 0;
  private textureOrdinal = 0;
  private head: DrftHead | null = null;
  private meshCount = 0;
  private materialCount = 0;
  private textureCount = 0;
  private splatBlockCount = 0;
  private manifestSent = false;
  private versionMajor = 0;
  private versionMinor = 0;
  private ended = false;

  constructor(handlers: DrftStreamHandlers = {}) {
    this.handlers = handlers;
  }

  /** Bytes arrived so far, and how many the file says there are. Zero until the header lands. */
  get progress(): { readonly received: number; readonly total: number } {
    return { received: this.received, total: this.buffer?.byteLength ?? 0 };
  }

  /**
   * Hand over the next bytes of the file, in order.
   *
   * Reports whatever those bytes completed before returning, so a caller that draws between
   * pushes sees every intermediate state.
   */
  push(part: Uint8Array): void {
    if (this.ended) throw new DrftError('bytes pushed after the stream ended');

    if (this.bytes === null) {
      /*
       * Before the buffer exists there is nowhere to write, so the first arrivals are held as
       * they came and joined once.
       *
       * **Held as slices rather than as bytes**, which is not a micro-optimisation: the first
       * thing a fetch hands over is tens of kilobytes, and pushing that a byte at a time into a
       * plain array is a five-figure loop before a single pixel of the model exists. It was
       * measurable as a hitch at the very start of a load, which is the worst place to have one
       * because nothing is on screen yet to explain it.
       */
      this.prelude.push(part);
      this.preludeBytes += part.length;
      if (this.preludeBytes < HEADER_BYTES) return;
      this.openBuffer();
      if (this.bytes === null) return;
    } else {
      const target = this.bytes;
      if (this.received + part.length > target.length) {
        throw new DrftError(
          `the file said it was ${target.length} bytes and more than that has arrived`,
        );
      }
      target.set(part, this.received);
      this.received += part.length;
    }

    this.readTable();
    this.settleChunks();
  }

  /**
   * No more bytes. Applies the rules that are about the asset as a whole rather than about one
   * chunk, which is where `readDrft`'s refusals live.
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.buffer === null) {
      throw new DrftError(`a file is at least ${HEADER_BYTES} bytes, got ${this.preludeBytes}`);
    }
    if (this.received < this.buffer.byteLength) {
      throw new DrftError(
        `the file said it was ${this.buffer.byteLength} bytes and ${this.received} arrived`,
      );
    }
    if (this.head === null) throw new DrftError('no HEAD chunk — every asset must describe itself');
    /* Geometry *or* a capture, since 1.5 — the same rule `readDrft` and `writeDrft` apply, kept
       in step here because a stream that refused what a whole-file read accepts would fail only
       for the consumer that had chosen to show a load. */
    if (this.meshCount === 0 && this.splatBlockCount === 0) {
      throw new DrftError(
        'no MESH and no SPLT chunk — an asset with neither geometry nor a capture',
      );
    }
    /*
     * The pairing check `readDrft` makes, and for the same reason: materials pair with meshes
     * by ordinal, so a count mismatch means every surface describes a different mesh. That is
     * silent, and it draws as a scene whose materials have been shuffled.
     */
    if (this.materialCount > 0 && this.materialCount !== this.meshCount) {
      throw new DrftError(
        `MATL carries ${this.materialCount} materials for ${this.meshCount} meshes; ` +
          `they pair by ordinal`,
      );
    }
  }

  /** Everything the header and the table say, once they have arrived. */
  private openBuffer(): void {
    const prelude = new Uint8Array(this.preludeBytes);
    let at = 0;
    for (const part of this.prelude) {
      prelude.set(part, at);
      at += part.length;
    }
    const view = new DataView(prelude.buffer, prelude.byteOffset, prelude.byteLength);
    if (view.getUint32(0, true) !== DRFT_MAGIC) {
      throw new DrftError('not a drft file — the magic does not match');
    }
    this.versionMajor = view.getUint16(4, true);
    this.versionMinor = view.getUint16(6, true);
    const minReaderMajor = view.getUint16(8, true);
    if (minReaderMajor > DRFT_VERSION_MAJOR) {
      throw new DrftError(
        `this file needs a reader of version ${minReaderMajor} or newer and this one is ` +
          `${DRFT_VERSION_MAJOR}. Its own version is ${this.versionMajor}.${this.versionMinor}.`,
      );
    }
    const chunkCount = view.getUint32(12, true);
    const totalBytes = view.getUint32(16, true);
    const tableEnd = HEADER_BYTES + chunkCount * CHUNK_ENTRY_BYTES;
    if (tableEnd > totalBytes) {
      throw new DrftError(`a table of ${chunkCount} chunks runs past the end of the file`);
    }

    this.buffer = new ArrayBuffer(totalBytes);
    this.bytes = new Uint8Array(this.buffer);
    this.bytes.set(prelude.subarray(0, Math.min(prelude.length, totalBytes)));
    this.received = Math.min(prelude.length, totalBytes);
    this.prelude = [];
    this.preludeBytes = 0;
  }

  /** Parse the table once all of it has arrived, and announce what is coming. */
  private readTable(): void {
    if (this.manifestSent || this.buffer === null) return;
    const view = new DataView(this.buffer);
    const chunkCount = view.getUint32(12, true);
    const tableEnd = HEADER_BYTES + chunkCount * CHUNK_ENTRY_BYTES;
    if (this.received < tableEnd) return;

    let meshBytes = 0;
    let textureBytes = 0;
    let splatBytes = 0;
    for (let i = 0; i < chunkCount; i++) {
      const entry = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
      const chunk: DrftChunk = {
        code: view.getUint32(entry, true),
        offset: view.getUint32(entry + 4, true),
        byteLength: view.getUint32(entry + 8, true),
        flags: view.getUint16(entry + 12, true),
        index: view.getUint16(entry + 14, true),
      };
      if (chunk.offset + chunk.byteLength > this.buffer.byteLength) {
        throw new DrftError(
          `chunk ${i} (${fourCCName(chunk.code)}) spans ${chunk.offset}..` +
            `${chunk.offset + chunk.byteLength} past the end of a ${this.buffer.byteLength} ` +
            `byte file`,
        );
      }
      if (chunk.offset % 4 !== 0) {
        throw new DrftError(`chunk ${i} (${fourCCName(chunk.code)}) is not 4-byte aligned`);
      }
      if (!KNOWN_CHUNKS.has(chunk.code) && (chunk.flags & CHUNK_REQUIRED) !== 0) {
        throw new DrftError(
          `this file requires chunk "${fourCCName(chunk.code)}", which this reader does not ` +
            `understand. It was written by version ${this.versionMajor}.${this.versionMinor}.`,
        );
      }
      /*
       * A level of detail counts as geometry for the weighting, because that is what it is:
       * the bar is weighted by what the file is made of, and a few hundred kilobytes of
       * outline is part of the geometry a viewer is waiting for. It is deliberately *not*
       * counted in `meshCount`, which is the number of parts — an outline is not a part, and
       * a readout saying "1 of 188 parts" would be counting the model twice.
       */
      if (chunk.code === CHUNK_MESH || chunk.code === CHUNK_LODM) meshBytes += chunk.byteLength;
      if (chunk.code === CHUNK_TEXS) textureBytes += chunk.byteLength;
      /* Its own weight rather than geometry's: a capture is not made of parts, so folding it into
         `meshBytes` would make a "parts" readout weigh something that is not one. */
      if (chunk.code === CHUNK_SPLT) splatBytes += chunk.byteLength;
      this.chunks.push(chunk);
    }

    /*
     * Sorted by where the payload sits rather than by table order, because completion is
     * decided by arriving bytes and the two orders are allowed to differ: the table is a
     * manifest and the payload order is a bake-time priority decision. Sorting here means the
     * settle loop can stop at the first chunk that is not yet complete.
     */
    this.chunks.sort((a, b) => a.offset - b.offset);

    this.manifestSent = true;
    this.handlers.onManifest?.({
      totalBytes: this.buffer.byteLength,
      meshCount: this.chunks.filter((c) => c.code === CHUNK_MESH).length,
      textureCount: this.chunks.filter((c) => c.code === CHUNK_TEXS).length,
      lodCount: this.chunks.filter((c) => c.code === CHUNK_LODM).length,
      splatBlockCount: this.chunks.filter((c) => c.code === CHUNK_SPLT).length,
      meshBytes,
      textureBytes,
      splatBytes,
    });
  }

  /** Report every chunk whose last byte has now landed, in file order. */
  private settleChunks(): void {
    if (!this.manifestSent || this.buffer === null) return;
    while (this.settled < this.chunks.length) {
      const chunk = this.chunks[this.settled];
      if (chunk === undefined) break;
      if (chunk.offset + chunk.byteLength > this.received) break;
      this.settled++;

      if (!KNOWN_CHUNKS.has(chunk.code)) continue;
      if (chunk.code === CHUNK_HEAD) {
        this.head = readHead(this.buffer, chunk);
        this.handlers.onHead?.(this.head);
      } else if (chunk.code === CHUNK_MESH) {
        const mesh = readMesh(this.buffer, chunk);
        this.meshCount++;
        this.handlers.onMesh?.(mesh, this.meshOrdinal++);
      } else if (chunk.code === CHUNK_SPLT) {
        /* The ordinal the file gave it, so blocks append in the writer's order however they
           arrived — which for a sequential fetch is the same order, and for a range-fetching
           caller need not be. */
        this.splatBlockCount++;
        this.handlers.onSplats?.(readSplatBlock(this.buffer, chunk), chunk.index);
      } else if (chunk.code === CHUNK_MORP) {
        /*
         * Reported as its own event rather than folded into the mesh, because a `MORP` chunk can
         * land before or after the `MESH` it names — the writer puts it after, a range-fetching
         * caller need not — and a stream cannot rewrite a mesh it has already handed over.
         */
        this.handlers.onMorph?.(readMorph(this.buffer, chunk.offset, chunk.byteLength));
      } else if (chunk.code === CHUNK_NODE) {
        this.handlers.onNodes?.(readNodes(this.buffer, chunk.offset, chunk.byteLength));
      } else if (chunk.code === CHUNK_SKIN) {
        this.handlers.onSkin?.(readSkin(this.buffer, chunk.offset, chunk.byteLength), chunk.index);
      } else if (chunk.code === CHUNK_ANIM) {
        this.handlers.onClip?.(readClip(this.buffer, chunk.offset, chunk.byteLength), chunk.index);
      } else if (chunk.code === CHUNK_LODM) {
        /* The level the file gave it, not the order it happened to arrive in. */
        this.handlers.onLod?.(readMesh(this.buffer, chunk), chunk.index);
      } else if (chunk.code === CHUNK_MATL) {
        const materials = readMaterials(this.buffer, chunk);
        this.materialCount = materials.length;
        this.handlers.onMaterials?.(materials);
      } else if (chunk.code === CHUNK_TEXS) {
        const texture = readTexture(this.buffer, chunk);
        this.textureCount++;
        this.handlers.onTexture?.(texture, this.textureOrdinal++);
      }
    }
  }
}

/**
 * Read a `.drft` from a fetch response as it arrives.
 *
 * The whole point of the sequential design in one function: a plain `fetch` of a plain file,
 * and the model improves as the bytes land. A response with no body — an error page, a
 * cache miss served as a redirect — throws rather than resolving to an empty asset.
 */
export async function streamDrft(
  response: Response,
  handlers: DrftStreamHandlers = {},
): Promise<void> {
  if (!response.ok) {
    throw new DrftError(`fetching the asset returned ${response.status} ${response.statusText}`);
  }
  const body = response.body;
  if (body === null) throw new DrftError('the response carried no body to stream');

  const stream = new DrftStream(handlers);
  const reader = body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value !== undefined) stream.push(next.value);
  }
  stream.end();
}
