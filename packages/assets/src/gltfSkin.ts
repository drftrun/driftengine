import type { AnimationClip, Joint, JointTrack, TrackPath } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';

import type { GltfDocument } from './gltf.ts';
import { accessorFloats } from './gltfAccessor.ts';

/**
 * Skins and animations out of a glTF document, sorted into the order a palette can be resolved in.
 *
 * **Its own module rather than more of `gltf.ts`**, because the two answer different questions: that
 * file turns primitives into geometry in world space and says in its header that the node graph
 * does not survive it. A skin is the one thing that needs the graph, and keeping the reader for it
 * separate is what lets the flattening stay exactly as it was for every document without one.
 *
 * **Nothing here depends on `@driftengine/animation`.** The shapes it produces live in the format
 * package, beside the chunks that carry them, so the package that writes a rig and the package
 * that plays one meet over data rather than over each other.
 */

export interface GltfSkin {
  readonly joints: readonly Joint[];
  /** Sixteen floats a joint, column-major, in the same order as `joints`. */
  readonly inverseBind: Float32Array;
  /**
   * glTF joint index to sorted joint index.
   *
   * The importer sorts parents-first because a palette is resolved in index order, and it is also
   * the only layer that can: every index naming a joint has to move with it — a mesh's `JOINTS_0`
   * and every animation channel's target. A caller re-indexing a mesh needs this.
   */
  readonly remap: Uint16Array;
}

export interface GltfAnimated {
  readonly skins: readonly GltfSkin[];
  readonly clips: readonly AnimationClip[];
}

export function readGltfSkins(doc: GltfDocument, buffers: readonly Uint8Array[]): GltfAnimated {
  const definitions = doc.skins ?? [];
  if (definitions.length === 0) return { skins: [], clips: [] };

  /* Which node is whose child, which glTF states only in the other direction. */
  const parentOf = new Map<number, number>();
  (doc.nodes ?? []).forEach((node, at) => {
    for (const child of node.children ?? []) parentOf.set(child, at);
  });

  const skins: GltfSkin[] = [];
  /** Node index to sorted joint index, for every skin, so a channel can find its track. */
  const jointOfNode = new Map<number, number>();

  for (const definition of definitions) {
    const order = sortParentsFirst(definition.joints, parentOf, doc);
    const joints: Joint[] = order.map((node) => {
      const parent = parentOf.get(node);
      /*
       * A parent outside this skin makes the joint a root *of this skin*. glTF allows it — a rig
       * hung under a scene node — and reading it as missing would refuse valid files.
       */
      const within = parent === undefined ? -1 : order.indexOf(parent);
      return { parent: within, name: doc.nodes?.[node]?.name ?? `joint ${node}` };
    });

    const remap = new Uint16Array(definition.joints.length);
    definition.joints.forEach((node, old) => {
      remap[old] = order.indexOf(node);
    });

    skins.push({ joints, inverseBind: readInverseBind(doc, buffers, definition, order), remap });
    order.forEach((node, at) => jointOfNode.set(node, at));
  }

  return { skins, clips: readClips(doc, buffers, jointOfNode) };
}

/**
 * The skin's joints, parents before children.
 *
 * A depth-first walk from each root rather than a sort with a comparator, because "before its
 * parent" is not a total order over nodes and a comparator would have to invent one. Visiting a
 * node only after its parent is what the walk gives for free.
 */
function sortParentsFirst(
  joints: readonly number[],
  parentOf: ReadonlyMap<number, number>,
  doc: GltfDocument,
): number[] {
  const within = new Set(joints);
  for (const node of joints) {
    if (doc.nodes?.[node] === undefined) {
      throw new DrftError(`gltf: a skin names node ${node}, which is absent`);
    }
  }

  const out: number[] = [];
  const placed = new Set<number>();
  const place = (node: number, depth: number): void => {
    if (placed.has(node)) return;
    /*
     * A cycle would recurse forever. glTF forbids one, and `gltf.ts` refuses a graph with one on
     * the mesh path — but this reader walks the graph the other way round, from children up, so it
     * checks for itself rather than relying on a check that may not have run.
     */
    if (depth > joints.length) {
      throw new DrftError(`gltf: the joint hierarchy around node ${node} has a cycle`);
    }
    const parent = parentOf.get(node);
    if (parent !== undefined && within.has(parent)) place(parent, depth + 1);
    if (placed.has(node)) return;
    placed.add(node);
    out.push(node);
  };
  for (const node of joints) place(node, 0);
  return out;
}

/**
 * The inverse bind matrices, reordered to match the sorted joints.
 *
 * Absent means identity, which glTF defines: a rig whose bind pose is the node graph's own rest
 * transforms needs no matrices, and reading absence as zeroes would collapse every vertex.
 */
function readInverseBind(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  definition: { joints: number[]; inverseBindMatrices?: number },
  order: readonly number[],
): Float32Array {
  const out = new Float32Array(order.length * 16);
  if (definition.inverseBindMatrices === undefined) {
    for (let j = 0; j < order.length; j++) {
      out[j * 16] = 1;
      out[j * 16 + 5] = 1;
      out[j * 16 + 10] = 1;
      out[j * 16 + 15] = 1;
    }
    return out;
  }

  const source = accessorFloats(
    doc,
    buffers,
    definition.inverseBindMatrices,
    'skin inverseBindMatrices',
  );
  if (source.length < definition.joints.length * 16) {
    throw new DrftError(
      `gltf: a skin has ${definition.joints.length} joints but ${source.length / 16} inverse ` +
        `bind matrices. Every joint needs one, or the ones past the end read as zero and ` +
        `collapse the vertices they weight.`,
    );
  }
  order.forEach((node, at) => {
    const old = definition.joints.indexOf(node);
    out.set(source.subarray(old * 16, old * 16 + 16), at * 16);
  });
  return out;
}

/** glTF's path names are this engine's, but only three of them drive a joint. */
function trackPath(path: string | undefined): TrackPath | null {
  if (path === 'translation' || path === 'rotation' || path === 'scale') return path;
  /*
   * `weights` drives morph targets rather than a joint, and is dropped here rather than refused:
   * a file carrying both should still animate its skeleton. Track A's morph phase is what reads it.
   */
  return null;
}

function readClips(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  jointOfNode: ReadonlyMap<number, number>,
): AnimationClip[] {
  const clips: AnimationClip[] = [];

  (doc.animations ?? []).forEach((animation, index) => {
    const tracks: JointTrack[] = [];
    let duration = 0;

    for (const channel of animation.channels) {
      const path = trackPath(channel.target.path);
      const node = channel.target.node;
      /*
       * A channel targeting a node no skin contains is skipped rather than refused. A scene's
       * camera or a prop is animated in the same block as its characters, and a file that
       * animates one is not a broken file.
       */
      if (path === null || node === undefined) continue;
      const joint = jointOfNode.get(node);
      if (joint === undefined) continue;

      const sampler = animation.samplers[channel.sampler];
      if (sampler === undefined) {
        throw new DrftError(
          `gltf: animation ${index} has a channel naming sampler ${channel.sampler}, which is absent`,
        );
      }
      const times = accessorFloats(doc, buffers, sampler.input, `animation ${index} input`);
      const values = accessorFloats(doc, buffers, sampler.output, `animation ${index} output`);
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      tracks.push({ joint, path, times, values });
    }

    clips.push({ name: animation.name ?? `animation ${index}`, durationSec: duration, tracks });
  });

  return clips;
}
