import type { AnimationClip, DrftSkin, Joint, JointTrack, TrackPath } from './animationData.ts';
import { align, DrftError } from './drftFormat.ts';

/**
 * `NODE`, `SKIN` and `ANIM`: reading and writing the three chunks a rig needs.
 *
 * **All three are optional, which is what makes this additive.** Rule 2 of docs/FORMAT.md §4.4
 * says an optional chunk a reader does not understand is skipped in silence, so a 1.6 file opens
 * in a 1.5 reader as the static geometry it also holds — the right degradation, since a reader
 * that has never heard of a skin cannot deform anything.
 *
 * **`NODE` was specified in §4.3 and implemented nowhere.** `CHUNK_NODE` has been declared and in
 * `KNOWN_CHUNKS` since v1 with no writer and no reader; rigid TRS animation is the first thing to
 * need a hierarchy, so this is a chunk the format has claimed for its whole life finally being
 * built. Its payload is what §4.3 already promised — parent index, TRS, mesh index, name — rather
 * than whatever would be convenient now.
 */

/** A node in the asset's own hierarchy. `mesh` is -1 for a node that draws nothing. */
export interface DrftNode {
  readonly parent: number;
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  readonly mesh: number;
  readonly name: string;
}

/** i32 parent, 3 floats, 4 floats, 3 floats, i32 mesh. */
const NODE_ENTRY_BYTES = 4 + 12 + 16 + 12 + 4;
/** u32 joint, u32 path, u32 keyCount. */
const TRACK_ENTRY_BYTES = 12;

const PATHS: readonly TrackPath[] = ['translation', 'rotation', 'scale'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Length-prefixed and padded to four, so the block that follows a name stays aligned. */
function encodeString(value: string): Uint8Array {
  const text = encoder.encode(value);
  const bytes = new Uint8Array(align(4 + text.length));
  new DataView(bytes.buffer).setUint32(0, text.length, true);
  bytes.set(text, 4);
  return bytes;
}

/** Reads one, and answers where the next begins. */
function decodeString(view: DataView, at: number): { value: string; next: number } {
  const length = view.getUint32(at, true);
  const start = view.byteOffset + at + 4;
  if (start + length > view.byteOffset + view.byteLength) {
    throw new DrftError('a name runs past the end of its chunk');
  }
  return {
    value: decoder.decode(new Uint8Array(view.buffer, start, length)),
    next: at + align(4 + length),
  };
}

/* --- NODE --- */

export function buildNodes(nodes: readonly DrftNode[]): Uint8Array {
  const names = nodes.map((node) => encodeString(node.name));
  let nameBytes = 0;
  for (const name of names) nameBytes += name.length;

  const bytes = new Uint8Array(align(8 + nodes.length * NODE_ENTRY_BYTES + nameBytes));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, nodes.length, true);
  view.setUint32(4, NODE_ENTRY_BYTES, true);

  let at = 8;
  for (const node of nodes) {
    view.setInt32(at, node.parent, true);
    for (let c = 0; c < 3; c++)
      view.setFloat32(at + 4 + c * 4, node.translation[c] as number, true);
    for (let c = 0; c < 4; c++) view.setFloat32(at + 16 + c * 4, node.rotation[c] as number, true);
    for (let c = 0; c < 3; c++) view.setFloat32(at + 32 + c * 4, node.scale[c] as number, true);
    view.setInt32(at + 44, node.mesh, true);
    at += NODE_ENTRY_BYTES;
  }
  for (const name of names) {
    bytes.set(name, at);
    at += name.length;
  }
  return bytes;
}

export function readNodes(buffer: ArrayBuffer, offset: number, byteLength: number): DrftNode[] {
  if (byteLength < 8) throw new DrftError('NODE is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);
  /*
   * The stride is read rather than assumed, exactly as `MATL` reads its own: a later minor version
   * may widen an entry, and a reader that assumed the old width would walk into the middle of the
   * next one and produce a hierarchy of noise rather than a refusal.
   */
  const stride = view.getUint32(4, true);
  if (stride < NODE_ENTRY_BYTES) {
    throw new DrftError(
      `NODE entry stride ${stride} is shorter than this reader's ${NODE_ENTRY_BYTES}`,
    );
  }
  if (8 + count * stride > byteLength) throw new DrftError('NODE names more nodes than it holds');

  const nodes: DrftNode[] = [];
  let namesAt = 8 + count * stride;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * stride;
    const name = decodeString(view, namesAt);
    namesAt = name.next;
    nodes.push({
      parent: view.getInt32(at, true),
      translation: [
        view.getFloat32(at + 4, true),
        view.getFloat32(at + 8, true),
        view.getFloat32(at + 12, true),
      ],
      rotation: [
        view.getFloat32(at + 16, true),
        view.getFloat32(at + 20, true),
        view.getFloat32(at + 24, true),
        view.getFloat32(at + 28, true),
      ],
      scale: [
        view.getFloat32(at + 32, true),
        view.getFloat32(at + 36, true),
        view.getFloat32(at + 40, true),
      ],
      mesh: view.getInt32(at + 44, true),
      name: name.value,
    });
  }
  return nodes;
}

/* --- SKIN --- */

export function buildSkin(skin: DrftSkin): Uint8Array {
  const count = skin.joints.length;
  if (skin.inverseBind.length !== count * 16) {
    throw new DrftError(
      `SKIN: ${count} joints but ${skin.inverseBind.length} inverse-bind floats; expected ${count * 16}`,
    );
  }
  const names = skin.joints.map((joint) => encodeString(joint.name));
  let nameBytes = 0;
  for (const name of names) nameBytes += name.length;

  const parentsAt = 8;
  const matricesAt = parentsAt + count * 4;
  const namesStart = matricesAt + count * 64;
  const bytes = new Uint8Array(align(namesStart + nameBytes));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, count, true);
  /* Reserved, and it must be ignored on read — rule 6 of §4.4, so it can become a field later. */
  view.setUint32(4, 0, true);

  skin.joints.forEach((joint, i) => view.setInt32(parentsAt + i * 4, joint.parent, true));
  for (let f = 0; f < count * 16; f++) {
    view.setFloat32(matricesAt + f * 4, skin.inverseBind[f] as number, true);
  }
  let at = namesStart;
  for (const name of names) {
    bytes.set(name, at);
    at += name.length;
  }
  return bytes;
}

export function readSkin(buffer: ArrayBuffer, offset: number, byteLength: number): DrftSkin {
  if (byteLength < 8) throw new DrftError('SKIN is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);
  const parentsAt = 8;
  const matricesAt = parentsAt + count * 4;
  const namesStart = matricesAt + count * 64;
  if (namesStart > byteLength) throw new DrftError('SKIN names more joints than it holds');

  const inverseBind = new Float32Array(count * 16);
  for (let f = 0; f < count * 16; f++) inverseBind[f] = view.getFloat32(matricesAt + f * 4, true);

  const joints: Joint[] = [];
  let namesAt = namesStart;
  for (let i = 0; i < count; i++) {
    const name = decodeString(view, namesAt);
    namesAt = name.next;
    const parent = view.getInt32(parentsAt + i * 4, true);
    /*
     * Checked on the way in rather than trusted. A palette is resolved in index order, so a joint
     * whose parent is not already resolved produces a rig wrong in one limb — which reads as a bad
     * animation rather than as a bad file, and is exactly the failure a reader can turn loud.
     */
    if (parent >= i) {
      throw new DrftError(
        `SKIN: joint ${i} ("${name.value}") names parent ${parent}, which is not before it. ` +
          `Joints are written parents-first.`,
      );
    }
    joints.push({ parent, name: name.value });
  }
  return { joints, inverseBind };
}

/* --- ANIM --- */

export function buildClip(clip: AnimationClip): Uint8Array {
  const name = encodeString(clip.name);
  const tracks = clip.tracks;
  let floats = 0;
  for (const track of tracks) floats += track.times.length + track.values.length;

  const headerAt = 16 + name.length;
  const dataAt = headerAt + tracks.length * TRACK_ENTRY_BYTES;
  const bytes = new Uint8Array(align(dataAt + floats * 4));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, tracks.length, true);
  view.setFloat32(4, clip.durationSec, true);
  view.setUint32(8, name.length, true);
  view.setUint32(12, 0, true);
  bytes.set(name, 16);

  let at = headerAt;
  let data = dataAt;
  for (const track of tracks) {
    const path = PATHS.indexOf(track.path);
    if (path < 0) throw new DrftError(`ANIM: unknown track path "${track.path}"`);
    view.setUint32(at, track.joint, true);
    view.setUint32(at + 4, path, true);
    view.setUint32(at + 8, track.times.length, true);
    at += TRACK_ENTRY_BYTES;

    for (const value of track.times) {
      view.setFloat32(data, value, true);
      data += 4;
    }
    for (const value of track.values) {
      view.setFloat32(data, value, true);
      data += 4;
    }
  }
  return bytes;
}

export function readClip(buffer: ArrayBuffer, offset: number, byteLength: number): AnimationClip {
  if (byteLength < 16) throw new DrftError('ANIM is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const count = view.getUint32(0, true);
  const durationSec = view.getFloat32(4, true);
  const nameBytes = view.getUint32(8, true);
  const name = decodeString(view, 16).value;

  const headerAt = 16 + nameBytes;
  let at = headerAt;
  let data = headerAt + count * TRACK_ENTRY_BYTES;
  const tracks: JointTrack[] = [];
  for (let i = 0; i < count; i++) {
    const joint = view.getUint32(at, true);
    const pathIndex = view.getUint32(at + 4, true);
    const keys = view.getUint32(at + 8, true);
    at += TRACK_ENTRY_BYTES;

    const path = PATHS[pathIndex];
    if (path === undefined) throw new DrftError(`ANIM: track ${i} names path ${pathIndex}`);
    const components = path === 'rotation' ? 4 : 3;
    if (data + keys * 4 + keys * components * 4 > byteLength) {
      throw new DrftError(`ANIM: track ${i} reads past the end of its chunk`);
    }

    const times = new Float32Array(keys);
    for (let k = 0; k < keys; k++) {
      times[k] = view.getFloat32(data, true);
      data += 4;
    }
    const values = new Float32Array(keys * components);
    for (let v = 0; v < keys * components; v++) {
      values[v] = view.getFloat32(data, true);
      data += 4;
    }
    tracks.push({ joint, path, times, values });
  }
  return { name, durationSec, tracks };
}

/* --- MORP --- */

/** One mesh's morph deltas, and which mesh they belong to. */
export interface DrftMorph {
  /** The ordinal of the mesh these deform. */
  readonly mesh: number;
  readonly targetCount: number;
  /** Three floats a vertex per target, interleaved by vertex. See `MeshData.morphTargets`. */
  readonly deltas: Float32Array;
}

export function buildMorph(morph: DrftMorph): Uint8Array {
  const bytes = new Uint8Array(align(8 + morph.deltas.length * 4));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, morph.targetCount, true);
  /*
   * The mesh this deforms, **in the payload rather than in the chunk table's `index`**.
   *
   * That field is the ordinal *within a FourCC* — the writer derives it and a caller cannot set
   * it — so for a file where only the second and fifth meshes have targets, the two `MORP` chunks
   * would carry 0 and 1 and a reader pairing by it would deform the wrong geometry. The table's
   * own convention is right and this is the field that has to move.
   */
  view.setUint32(4, morph.mesh, true);
  for (let f = 0; f < morph.deltas.length; f++) {
    view.setFloat32(8 + f * 4, morph.deltas[f] as number, true);
  }
  return bytes;
}

export function readMorph(buffer: ArrayBuffer, offset: number, byteLength: number): DrftMorph {
  if (byteLength < 8) throw new DrftError('MORP is too short to hold its header');
  const view = new DataView(buffer, offset, byteLength);
  const targetCount = view.getUint32(0, true);
  const mesh = view.getUint32(4, true);
  if (targetCount < 1) throw new DrftError(`MORP for mesh ${mesh} declares ${targetCount} targets`);
  const floats = Math.floor((byteLength - 8) / 4);
  const deltas = new Float32Array(floats);
  for (let f = 0; f < floats; f++) deltas[f] = view.getFloat32(8 + f * 4, true);
  return { mesh, targetCount, deltas };
}
