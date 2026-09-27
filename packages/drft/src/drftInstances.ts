/**
 * `INST`: meshes drawn many times, each copy placed by a column-major 4×4 matrix.
 *
 * **Required, because a reader that skipped it would draw one copy where there are thousands.** The
 * mesh an instance group names holds one prototype, so an old reader that did not know the chunk
 * would open a scene of ten thousand candles as a single candle at the origin and say nothing. A
 * refusal naming `INST` is the honest answer. What that gives up is opening such a file at all in a
 * reader before 1.18.
 *
 * Layout, little-endian:
 * - u32 group count;
 * - per group: u32 mesh ordinal, u32 instance count, then that many 16-float matrices.
 *
 * A mesh appears in at most one group.
 */
import { DrftError, align } from './drftFormat.ts';

export interface DrftInstanceGroup {
  /** The ordinal of the `MESH` this group draws, which holds one copy. */
  readonly mesh: number;
  /** Sixteen floats a copy, column-major, taking the mesh to where that copy stands. */
  readonly transforms: Float32Array;
}

export function buildInstances(groups: readonly DrftInstanceGroup[]): Uint8Array {
  const seen = new Set<number>();
  let floats = 0;
  for (const group of groups) {
    if (group.transforms.length === 0 || group.transforms.length % 16 !== 0) {
      throw new DrftError(
        `instance group for mesh ${group.mesh} has ${group.transforms.length} floats, which is not whole matrices`,
      );
    }
    if (seen.has(group.mesh)) throw new DrftError(`mesh ${group.mesh} is instanced twice`);
    seen.add(group.mesh);
    floats += group.transforms.length;
  }
  const bytes = new Uint8Array(align(4 + groups.length * 8 + floats * 4));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, groups.length, true);
  let at = 4;
  for (const group of groups) {
    view.setUint32(at, group.mesh, true);
    view.setUint32(at + 4, group.transforms.length / 16, true);
    at += 8;
    for (let i = 0; i < group.transforms.length; i++) {
      view.setFloat32(at, group.transforms[i] as number, true);
      at += 4;
    }
  }
  return bytes;
}

/** The groups in an `INST` payload, each checked against the file's mesh count. */
export function readInstances(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
  meshCount: number,
): DrftInstanceGroup[] {
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);
  const out: DrftInstanceGroup[] = [];
  let at = 4;
  for (let g = 0; g < count; g++) {
    if (at + 8 > byteLength) throw new DrftError('INST ends inside a group header');
    const mesh = view.getUint32(at, true);
    const copies = view.getUint32(at + 4, true);
    at += 8;
    if (mesh >= meshCount) {
      throw new DrftError(`INST places mesh ${mesh}, and the file carries ${meshCount} meshes`);
    }
    if (at + copies * 64 > byteLength)
      throw new DrftError(`INST ends inside mesh ${mesh}'s placements`);
    const transforms = new Float32Array(copies * 16);
    for (let i = 0; i < transforms.length; i++) transforms[i] = view.getFloat32(at + i * 4, true);
    at += copies * 64;
    out.push({ mesh, transforms });
  }
  return out;
}
