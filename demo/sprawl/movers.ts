/**
 * Movers drawn: every mesh of every kind one instanced batch, refilled each frame with what the
 * simulations put near the eye and drawn in one call — tinted per instance by its paint, its glow
 * or its palette, and a person's limbs turned about their pivots by the stride, as the reference's
 * rigid limbs are.
 *
 * **The caller builds the body's matrix and fills `tints`**, then `add`s; this multiplies in each
 * limb's turn and writes the batches, allocating nothing. `upload` runs before the shadow pass,
 * because the same batches are its casters (`casters`): a mover near the walker shades the street
 * as a building does.
 *
 * What gives: a limb's `lift` is not drawn — the stride swings a leg and does not raise its foot —
 * and a batch holds at most its capacity, so past it the furthest-added go undrawn.
 */
import { createMeshInstances } from '../../packages/core/src/index';
import type {
  InstancedHandle,
  MeshData,
  MeshInstances,
  RendererApi,
  ShadowCasters,
} from '../../packages/core/src/index';
import type { MoverKindData, Tint } from './data/life';

/** The colours an instance wears, by the slot a mesh names: filled by the caller per instance. */
export interface Tints {
  readonly paint: Float32Array;
  readonly glow: Float32Array;
  readonly skin: Float32Array;
  readonly cloth: Float32Array;
  readonly cloth2: Float32Array;
  readonly hair: Float32Array;
  readonly accent: Float32Array;
  /** White while the instance's blinking lights are lit, black between: see `blinkOn`. */
  readonly blink: Float32Array;
}

/**
 * Whether a light beating at `rate` hertz, lit for `duty` of each beat, is lit at `t` seconds on a
 * beat shifted by `phase` beats — each instance its own, so a fleet does not flash together.
 */
export function blinkOn(t: number, rate: number, duty: number, phase: number): boolean {
  const beat = t * rate + phase;
  return beat - Math.floor(beat) < duty;
}

export function createTints(): Tints {
  const white = (): Float32Array => new Float32Array([1, 1, 1]);
  return {
    paint: white(),
    glow: white(),
    skin: white(),
    cloth: white(),
    cloth2: white(),
    hair: white(),
    accent: white(),
    blink: white(),
  };
}

interface Batch {
  readonly batch: InstancedHandle;
  readonly data: MeshInstances;
  readonly tint: Tint;
  readonly limb: number;
}

const WHITE = new Float32Array([1, 1, 1]);

export class MoverBatches {
  /** Each kind's batches, by the kind's index among the scene's; empty until its meshes are in. */
  private readonly batches: Batch[][];
  private readonly kinds: readonly MoverKindData[];

  constructor(
    renderer: RendererApi,
    kinds: readonly MoverKindData[],
    meshes: ReadonlyMap<number, MeshData>,
    capacity: (kind: MoverKindData) => number,
  ) {
    this.kinds = kinds;
    this.batches = kinds.map((kind) => {
      const cap = capacity(kind);
      if (cap <= 0 || kind.meshes.some((m) => !meshes.has(m.mesh))) return [];
      return kind.meshes.map((m) => {
        const handle = renderer.createMesh(meshes.get(m.mesh) as MeshData);
        return {
          batch: renderer.createInstanced(handle, cap, { cull: true }),
          data: createMeshInstances(cap),
          tint: m.tint,
          limb: m.limb,
        };
      });
    });
  }

  /** Kind `k`'s blinking lights' beat, hertz and duty, or null where it has none. */
  blinkOf(k: number): readonly [number, number] | null {
    return this.kinds[k]?.blink ?? null;
  }

  /** The kind named `name`, or −1. */
  indexOf(name: string): number {
    return this.kinds.findIndex((k) => k.name === name);
  }

  /** Empty every batch for a new frame. */
  begin(): void {
    for (const list of this.batches) for (const b of list) b.data.count = 0;
  }

  /**
   * One instance of kind `k` whose body stands at `model`, wearing `tints`, its limbs `stride`
   * radians into their swing.
   */
  add(k: number, model: Float32Array, tints: Tints, stride: number): void {
    const list = this.batches[k];
    const kind = this.kinds[k];
    if (list === undefined || kind === undefined) return;
    for (const b of list) {
      const data = b.data;
      if (data.count >= data.capacity) continue;
      const at = data.count * 16;
      const limb = b.limb >= 0 ? kind.limbs[b.limb] : undefined;
      if (limb === undefined) data.models.set(model, at);
      else {
        const angle = limb.swing * Math.sin(stride + limb.phase);
        limbMatrix(model, limb.pivot, Math.cos(angle), Math.sin(angle), data.models, at);
      }
      const colour = b.tint === null ? WHITE : tints[b.tint];
      data.tints[data.count * 3] = colour[0] as number;
      data.tints[data.count * 3 + 1] = colour[1] as number;
      data.tints[data.count * 3 + 2] = colour[2] as number;
      data.count++;
    }
  }

  /** Send the frame's instances to the device: before the shadow pass, which casts them too. */
  upload(renderer: RendererApi): void {
    for (const list of this.batches) {
      for (const b of list) if (b.data.count > 0) renderer.uploadInstanced(b.batch, b.data);
    }
  }

  /** Draw every batch that holds anything, in whatever material is set; the draws it issued. */
  draw(renderer: RendererApi): number {
    let draws = 0;
    for (const list of this.batches) {
      for (const b of list) {
        if (b.data.count === 0) continue;
        renderer.drawInstanced(b.batch, b.data);
        draws++;
      }
    }
    return draws;
  }

  /** The filled batches as shadow casters; valid once `upload` has run this frame. */
  readonly casters: ShadowCasters = (sink) => {
    for (const list of this.batches) {
      for (const b of list) if (b.data.count > 0) sink.instanced?.(b.batch, b.data);
    }
  };
}

/**
 * `body` × the limb's turn: a rotation about x by the angle whose cosine and sine are given, about
 * `pivot`, written sixteen floats into `out` at `at`. Column-major, as the models are.
 */
function limbMatrix(
  body: Float32Array,
  pivot: readonly [number, number, number],
  c: number,
  s: number,
  out: Float32Array,
  at: number,
): void {
  for (let r = 0; r < 4; r++) {
    const b0 = body[r] as number;
    const b1 = body[4 + r] as number;
    const b2 = body[8 + r] as number;
    const b3 = body[12 + r] as number;
    out[at + r] = b0;
    out[at + 4 + r] = c * b1 + s * b2;
    out[at + 8 + r] = -s * b1 + c * b2;
    out[at + 12 + r] = pivot[0] * b0 + pivot[1] * b1 + pivot[2] * b2 + b3;
  }
}

/**
 * A body's matrix into `out`: turned `yaw` about +y, its nose pitched down `pitch` about its own x,
 * rolled `roll` about its own z, scaled by `scale`, standing at (x, y, z). Column-major.
 */
export function pose(
  out: Float32Array,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll: number,
  scale: number,
): void {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  /* Heading, then pitch: its x (cy, 0, −sy), y (sy·sp, cp, cy·sp), z (sy·cp, −sp, cy·cp); then roll. */
  const a1x = sy * sp;
  const a1z = cy * sp;
  out[0] = (cr * cy + sr * a1x) * scale;
  out[1] = sr * cp * scale;
  out[2] = (-cr * sy + sr * a1z) * scale;
  out[3] = 0;
  out[4] = (-sr * cy + cr * a1x) * scale;
  out[5] = cr * cp * scale;
  out[6] = (sr * sy + cr * a1z) * scale;
  out[7] = 0;
  out[8] = sy * cp * scale;
  out[9] = -sp * scale;
  out[10] = cy * cp * scale;
  out[11] = 0;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
}
