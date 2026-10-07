/**
 * Vertex animation from bone textures: a clip that turns and places each bone frame by frame,
 * which every vertex of an instanced batch's mesh follows — one bone a vertex, named by the mesh's
 * second coordinates — at a moment each instance keeps its own clock for.
 *
 * **What a crowd is built from.** A rigged character skinned per draw costs a palette upload and a
 * draw each; a crowd of them, played back from a clip a mesh, costs nothing on the processor once
 * the clip is on the device, and every instance moves at the frame's rate on its own clock rather
 * than in step with the others. What it gives up against skinning is the blend: a vertex follows
 * exactly one bone, so a joint bends hard, which at a crowd's distance is what such clips are made
 * for.
 *
 * **The vertex's bone is its second coordinates' u times `boneScale`**, rounded: a mesh's second
 * coordinates (`MeshData.lightmapUvs`) are free on a crowd, which bakes no lightmap, and the format
 * that writes one bone a sixty-fourth of u is the format this reads with `boneScale: 64`.
 *
 * **A frame's turn and place move the vertex as the bone does**: the turn about the mesh's origin,
 * then the place added — `turn(q, p) + t` — and its normal and tangent turned with it. Between two
 * frames both are blended: the places linearly, the turns normalised along the shorter arc. The
 * moment is `(sceneTime × rate + phase) × framesPerSecond`, looping, where the scene's time is the
 * clock `setAnimationTime` sets, once a frame before the shadows, and each instance's phase and
 * rate are `MeshInstances.clocks`.
 *
 * Backend-neutral: both backends upload what `packBoneAnimation` packs and run
 * `shaders/boneAnimation.ts`, which is `animateBoneVertex` below, line for line.
 */
import type { MeshInstances } from './instances.ts';

/** A clip on the device, from `createBoneAnimation`. Opaque but for its size. */
export interface BoneAnimationHandle {
  readonly bones: number;
  readonly frames: number;
}

/** A clip, as a caller hands it to `createBoneAnimation`. */
export interface BoneAnimationClip {
  /** Bones each frame holds. */
  readonly bones: number;
  /** Frames, played in order and looped. */
  readonly frames: number;
  readonly framesPerSecond: number;
  /** Where each bone puts what it carries: three floats a bone, bone by bone, frame by frame. */
  readonly places: Float32Array;
  /** Each bone's turn: a unit quaternion, x y z w, laid out as `places` is. */
  readonly turns: Float32Array;
  /** How many bones one unit of the second coordinates' u counts: `bones` unless given. */
  readonly boneScale?: number;
}

/** A clip as textures hold it: a texel a bone a frame, bones across and frames down. */
export interface BoneAnimationTexels {
  readonly bones: number;
  readonly frames: number;
  readonly framesPerSecond: number;
  readonly boneScale: number;
  /** RGBA floats: the place, and 1. */
  readonly places: Float32Array;
  /** RGBA floats: the turn, normalised. */
  readonly turns: Float32Array;
}

/**
 * The most bones or frames a clip may have: WebGL2's guaranteed texture size. A clip past it is
 * refused rather than cut, since a cut clip is a crowd frozen at its last row.
 */
export const MAX_BONE_TEXTURE_SIZE = 2048;

/** A clip checked and packed into its two textures' texels. Runs once, when the clip is made. */
export function packBoneAnimation(clip: BoneAnimationClip): BoneAnimationTexels {
  const { bones, frames, framesPerSecond } = clip;
  for (const [name, value] of [
    ['bones', bones],
    ['frames', frames],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_BONE_TEXTURE_SIZE) {
      throw new Error(
        `createBoneAnimation: ${name} is ${value}; a whole number from 1 to ${MAX_BONE_TEXTURE_SIZE}`,
      );
    }
  }
  if (!(framesPerSecond > 0)) {
    throw new Error(`createBoneAnimation: framesPerSecond is ${framesPerSecond}; above zero`);
  }
  const count = bones * frames;
  if (clip.places.length !== count * 3 || clip.turns.length !== count * 4) {
    throw new Error(
      `createBoneAnimation: ${bones} bones over ${frames} frames is ${count * 3} places and ` +
        `${count * 4} turn numbers, and was given ${clip.places.length} and ${clip.turns.length}`,
    );
  }
  const boneScale = clip.boneScale ?? bones;
  if (!(boneScale > 0)) {
    throw new Error(`createBoneAnimation: boneScale is ${boneScale}; above zero`);
  }
  const places = new Float32Array(count * 4);
  const turns = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    places[i * 4] = clip.places[i * 3] as number;
    places[i * 4 + 1] = clip.places[i * 3 + 1] as number;
    places[i * 4 + 2] = clip.places[i * 3 + 2] as number;
    places[i * 4 + 3] = 1;
    const x = clip.turns[i * 4] as number;
    const y = clip.turns[i * 4 + 1] as number;
    const z = clip.turns[i * 4 + 2] as number;
    const w = clip.turns[i * 4 + 3] as number;
    const length = Math.hypot(x, y, z, w);
    /* A zero turn is no turn, rather than a NaN through every vertex that reads it. */
    const scale = length > 0 ? 1 / length : 0;
    turns[i * 4] = x * scale;
    turns[i * 4 + 1] = y * scale;
    turns[i * 4 + 2] = z * scale;
    turns[i * 4 + 3] = length > 0 ? w * scale : 1;
  }
  return { bones, frames, framesPerSecond, boneScale, places, turns };
}

/** How wide a batch's clock texture is: one row up to this many instances, then more rows. */
export const CLOCK_TEXTURE_WIDTH = 1024;

/**
 * Each instance's clock into `out`, two floats an instance — its phase in seconds and its rate —
 * from `data.clocks`, and `(0, 1)` where it gives none: every instance at the clip's own speed,
 * in step. `out` is the batch's, sized once.
 */
export function packInstanceClocks(data: MeshInstances, out: Float32Array): void {
  const clocks = data.clocks;
  const count = Math.min(data.count, out.length / 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = clocks === undefined ? 0 : ((clocks[i * 2] as number | undefined) ?? 0);
    out[i * 2 + 1] = clocks === undefined ? 1 : ((clocks[i * 2 + 1] as number | undefined) ?? 1);
  }
}

/**
 * Which two frames a moment falls between, and how far: what the shader reads. Looped, with a
 * moment before the clip's start counted back from its end. **The first frame is clamped to the
 * last**, with the blend left at whatever reaches the next: a moment a hair short of the loop that
 * float error rounds up to `frames` lands on the last frame blended fully into the first, which is
 * the first frame — the right answer — where an index of `frames` would read past the texture.
 */
export function boneFrame(
  moment: number,
  frames: number,
  out: { first: number; second: number; blend: number },
): void {
  const wrapped = moment - frames * Math.floor(moment / frames);
  const first = Math.min(Math.floor(wrapped), frames - 1);
  out.first = first;
  out.second = first + 1 === frames ? 0 : first + 1;
  out.blend = Math.min(Math.max(wrapped - first, 0), 1);
}

const scratchFrame = { first: 0, second: 0, blend: 0 };
const mixed = new Float32Array(4);

/** `v` turned by the unit quaternion `q`, into `out`. */
function turn(q: ArrayLike<number>, at: number, v: ArrayLike<number>, out: Float32Array): void {
  const qx = q[at] as number;
  const qy = q[at + 1] as number;
  const qz = q[at + 2] as number;
  const qw = q[at + 3] as number;
  const vx = v[0] as number;
  const vy = v[1] as number;
  const vz = v[2] as number;
  /* v + 2 q.xyz × (q.xyz × v + q.w v), as the shader writes it. */
  const cx = qy * vz - qz * vy + qw * vx;
  const cy = qz * vx - qx * vz + qw * vy;
  const cz = qx * vy - qy * vx + qw * vz;
  out[0] = vx + 2 * (qy * cz - qz * cy);
  out[1] = vy + 2 * (qz * cx - qx * cz);
  out[2] = vz + 2 * (qx * cy - qy * cx);
}

/**
 * Where the clip puts a vertex at rest at `position`, following `bone`, at the scene's `time` on an
 * instance clock of `phase` and `rate`, into `out`. The processor's statement of what the shader
 * does, which the tests hold the arithmetic to and a device check holds the shader to.
 */
export function animateBoneVertex(
  clip: BoneAnimationTexels,
  bone: number,
  position: ArrayLike<number>,
  time: number,
  phase: number,
  rate: number,
  out: Float32Array,
): void {
  boneFrame((time * rate + phase) * clip.framesPerSecond, clip.frames, scratchFrame);
  const { first, second, blend } = scratchFrame;
  const b = Math.min(Math.max(bone, 0), clip.bones - 1);
  const a = (first * clip.bones + b) * 4;
  const c = (second * clip.bones + b) * 4;
  const q = clip.turns;
  /* The shorter arc: a quaternion and its negation are one turn. */
  const sign =
    (q[a] as number) * (q[c] as number) +
      (q[a + 1] as number) * (q[c + 1] as number) +
      (q[a + 2] as number) * (q[c + 2] as number) +
      (q[a + 3] as number) * (q[c + 3] as number) <
    0
      ? -1
      : 1;
  for (let k = 0; k < 4; k++) {
    mixed[k] = (q[a + k] as number) * (1 - blend) + sign * (q[c + k] as number) * blend;
  }
  const length = Math.hypot(
    mixed[0] as number,
    mixed[1] as number,
    mixed[2] as number,
    mixed[3] as number,
  );
  for (let k = 0; k < 4; k++) mixed[k] = (mixed[k] as number) / length;
  turn(mixed, 0, position, out);
  const p = clip.places;
  for (let k = 0; k < 3; k++) {
    out[k] = (out[k] as number) + (p[a + k] as number) * (1 - blend) + (p[c + k] as number) * blend;
  }
}

/** The bone a vertex follows, from its second coordinates' u: what the shader rounds. */
export function boneOf(u: number, boneScale: number): number {
  return Math.floor(u * boneScale + 0.5);
}
