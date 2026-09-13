/**
 * What a rig and its clips are, as data.
 *
 * **Here for the reason `MeshData` is here**, and stated in that file's header: these are the
 * boundary objects between the container and everything that uses one. `SKIN` and `ANIM` are
 * chunks, so what they carry belongs to the format package — which also means the two packages
 * that meet over a rig, `@driftengine/assets` producing one and `@driftengine/animation` consuming
 * one, do so without either depending on the other. Both already depend on this.
 *
 * Nothing here has behaviour. `Skeleton`, `Pose` and `sampleClip` live in the animation package,
 * which re-exports these types so a consumer imports from one place.
 */

/** One joint: where it hangs and what it is called. */
export interface Joint {
  /**
   * Index of this joint's parent, or -1 for a root. **Always less than this joint's own index.**
   *
   * Parents-first is a requirement rather than a convention: a palette is resolved in index order
   * and reads each joint's parent as it goes, so a nearly-sorted rig is wrong in one limb — which
   * reads as a bad animation rather than as a data error. The importer sorts, because it is also
   * the layer that can remap every index naming a joint; `Skeleton` refuses an unsorted one.
   */
  readonly parent: number;
  /** The name the source rig gave it, which is what retargeting matches on. */
  readonly name: string;
}

/** Which of a joint's three transforms a track drives. */
export type TrackPath = 'translation' | 'rotation' | 'scale';

/** One joint's keys for one of its three transforms. */
export interface JointTrack {
  readonly joint: number;
  readonly path: TrackPath;
  /** Ascending, in seconds. One entry per key. */
  readonly times: Float32Array;
  /** Three floats a key for translation and scale, four for rotation. */
  readonly values: Float32Array;
}

export interface AnimationClip {
  readonly name: string;
  readonly durationSec: number;
  readonly tracks: readonly JointTrack[];
}

/**
 * A skin: the joints, their inverse bind matrices, and nothing about how it is played.
 *
 * `inverseBind` is sixteen floats a joint, column-major, in the same order as `joints`. An entry
 * takes a vertex from model space into that joint's bind-pose space, which is what makes a palette
 * identity at the bind pose whatever the bind pose is.
 */
export interface DrftSkin {
  readonly joints: readonly Joint[];
  readonly inverseBind: Float32Array;
}
