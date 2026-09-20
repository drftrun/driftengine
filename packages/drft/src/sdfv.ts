/**
 * `SDFV` — an object's signed distance field, so indirect light can be traced through it.
 *
 * **What it carries and why it is in the container at all.** A distance field is expensive to
 * build — exact point-to-triangle distance from every grid point in a band around every triangle —
 * and it depends on nothing but the geometry. `bakeObjectSdf` in `@driftengine/assets` produces
 * one; `globalField.ts` in `@driftengine/core` composes them around the camera each frame. Neither
 * end can do the other's job, and the container is what joins them.
 *
 * **One chunk for the file with the mesh ordinal carried per entry, which is `SUBS`'s lesson.**
 * The chunk table's `index` is the ordinal *within a FourCC*, so a file where only the fourth mesh
 * has a field would carry a chunk at index 0 — and a reader pairing by it would trace light through
 * the wrong geometry. `MORP` found that first and paid for it.
 *
 * **No per-chunk version field**, matching `COLL`, `MSHL`, `DTEX` and every other chunk here: the
 * file's own version covers the format and a second one would be a second thing to keep in step.
 * The implementation plan asked this chunk to refuse a bad version of its own; the convention it
 * would have broken is older than the plan and is argued in `drftMeshlets.ts`, so what refuses a
 * version here is the container, as it does for every other chunk.
 *
 * **Additive, and that is what keeps the freeze in `FORMAT.md` intact.** A reader that does not
 * know this code skips it by its length and loses only indirect light, which is the one thing it
 * could not have traced anyway.
 *
 * ### Layout
 *
 * ```text
 * u32  count
 * count x SDFV_ENTRY_BYTES:
 *   u32  mesh        the mesh ordinal this field belongs to
 *   u32  nx, ny, nz  samples on each axis
 *   f32  bounds[6]   minX, minY, minZ, maxX, maxY, maxZ
 * f32  fields        every entry's samples, back to back, in entry order
 * ```
 *
 * **The table is a fixed stride and the samples follow it**, rather than each entry carrying its
 * own samples inline. Two reasons, and the second is the load-bearing one: a reader can walk the
 * table to find one mesh's field without parsing every field before it, and every sample block
 * starts at a four-byte boundary — `4 + count * 40` is divisible by four for any count — so a
 * `Float32Array` view can be taken straight onto the buffer instead of copying. `drftMeshlets.ts`
 * takes its views the same way and for the same reason.
 */

import { DrftError, align } from './drftFormat.ts';

/** `u32` mesh, three `u32` dimensions and six `f32` bounds. A field's samples are elsewhere. */
export const SDFV_ENTRY_BYTES = 40;

/**
 * The most samples one field may declare.
 *
 * **A bound on the count, not a bound on ambition.** The product of three `u32`s read out of a
 * file overflows a double at 2^53 and is a plausible number long before that, so a corrupt entry
 * asks for an allocation that either throws somewhere unhelpful or succeeds and eats the tab. A
 * 512-cubed field is 537 MB at four bytes a sample, which is far past anything a per-object bake
 * produces and is comfortably under where the arithmetic stops being trustworthy.
 */
export const SDFV_MAX_SAMPLES = 512 * 512 * 512;

export interface DrftSdfvEntry {
  /** The mesh ordinal this field belongs to, as `MESH` numbers them. */
  readonly mesh: number;
  /** Samples on each axis. The spacing is the same on all three; see `bakeObjectSdf`. */
  readonly dims: readonly [number, number, number];
  /** The field's own extent, `[minX, minY, minZ, maxX, maxY, maxZ]`. Six floats. */
  readonly bounds: Float32Array;
  /** Distance in metres, negative inside. `x` fastest, then `y`, then `z`. */
  readonly field: Float32Array;
}

export interface DrftSdfv {
  readonly entries: readonly DrftSdfvEntry[];
}

/** Write the chunk. Refuses anything a reader would have to guess about. */
export function buildSdfv(sdfv: DrftSdfv): Uint8Array {
  let samples = 0;
  for (const [at, entry] of sdfv.entries.entries()) {
    const [nx, ny, nz] = entry.dims;
    if (!(nx >= 1 && ny >= 1 && nz >= 1)) {
      throw new DrftError(
        `SDFV entry ${at} declares dimensions ${nx}x${ny}x${nz}; every dimension is at least one.`,
      );
    }
    if (entry.bounds.length !== 6) {
      throw new DrftError(
        `SDFV entry ${at} carries ${entry.bounds.length} bounds and the layout is six.`,
      );
    }
    const expected = nx * ny * nz;
    if (entry.field.length !== expected) {
      throw new DrftError(
        `SDFV entry ${at} is ${nx}x${ny}x${nz}, which is ${expected} samples, and carries ` +
          `${entry.field.length}.`,
      );
    }
    samples += expected;
  }

  const table = 4 + sdfv.entries.length * SDFV_ENTRY_BYTES;
  const bytes = new Uint8Array(align(table + samples * 4));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, sdfv.entries.length, true);

  let at = 4;
  let sample = table;
  for (const entry of sdfv.entries) {
    view.setUint32(at, entry.mesh, true);
    view.setUint32(at + 4, entry.dims[0], true);
    view.setUint32(at + 8, entry.dims[1], true);
    view.setUint32(at + 12, entry.dims[2], true);
    for (let axis = 0; axis < 6; axis++) {
      view.setFloat32(at + 16 + axis * 4, entry.bounds[axis] as number, true);
    }
    at += SDFV_ENTRY_BYTES;
    new Float32Array(bytes.buffer, sample, entry.field.length).set(entry.field);
    sample += entry.field.length * 4;
  }
  return bytes;
}

/** Read the chunk, refusing every shape a reader would otherwise have to trust. */
export function readSdfv(buffer: ArrayBuffer, offset: number, byteLength: number): DrftSdfv {
  if (byteLength < 4) throw new DrftError('SDFV is too short to hold its count');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);

  const table = 4 + count * SDFV_ENTRY_BYTES;
  /*
   * **The count is checked against the chunk before a single entry is read.** It is the first
   * thing in the payload and everything after derives from it, so a corrupt one is what turns a
   * short read into an allocation the size of the file's declared ambition.
   */
  if (table > byteLength) {
    throw new DrftError(
      `SDFV declares ${count} fields, which needs ${table} bytes of table, and the chunk has ` +
        `${byteLength}`,
    );
  }

  const entries: DrftSdfvEntry[] = [];
  let sample = table;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * SDFV_ENTRY_BYTES;
    const mesh = view.getUint32(at, true);
    const nx = view.getUint32(at + 4, true);
    const ny = view.getUint32(at + 8, true);
    const nz = view.getUint32(at + 12, true);
    if (nx < 1 || ny < 1 || nz < 1) {
      throw new DrftError(
        `SDFV field ${i} declares dimensions ${nx}x${ny}x${nz}; a field with no samples has no ` +
          'surface.',
      );
    }
    const samples = nx * ny * nz;
    if (samples > SDFV_MAX_SAMPLES) {
      throw new DrftError(
        `SDFV field ${i} declares ${samples} samples and the cap is ${SDFV_MAX_SAMPLES}`,
      );
    }
    if (sample + samples * 4 > byteLength) {
      throw new DrftError(
        `SDFV field ${i} is ${nx}x${ny}x${nz}, which is ${samples * 4} bytes, and the chunk has ` +
          `${byteLength - sample} left`,
      );
    }
    const bounds = new Float32Array(6);
    for (let axis = 0; axis < 6; axis++) bounds[axis] = view.getFloat32(at + 16 + axis * 4, true);
    entries.push({
      mesh,
      dims: [nx, ny, nz],
      bounds,
      field: new Float32Array(buffer, offset + sample, samples),
    });
    sample += samples * 4;
  }
  return { entries };
}
