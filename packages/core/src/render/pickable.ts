/**
 * What is under a ray, from a set of registered meshes.
 *
 * Backend-agnostic on purpose: nothing here touches a context, so one implementation
 * answers for WebGL2 and WebGPU alike and the tests need neither. Same argument
 * `textLayout.ts` makes for keeping glyph arithmetic out of the two text renderers.
 *
 * **Broad phase then narrow phase.** A world-space box per entry rejects nearly
 * everything for the cost of six compares, and only survivors pay for their triangles.
 * Without it a scene of forty pickables would walk every triangle of all of them on every
 * pointer move.
 *
 * **The box is recomputed when a model matrix is set, not when a ray is cast.** A scene
 * moves a handful of things per frame and casts one ray per pointer move, so the work
 * belongs on the write.
 */
import { rayAabb, rayTriangle } from '../math/intersect.ts';

export interface PickableSource {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface PickHit {
  handle: number;
  distance: number;
  /** Where the ray met it, in world space. Reused between queries; copy to keep it. */
  readonly point: Float32Array;
}

interface Entry {
  handle: number;
  source: PickableSource;
  model: Float32Array;
  inverse: Float32Array;
  min: Float32Array;
  max: Float32Array;
}

export class PickableSet {
  private readonly entries: Entry[] = [];
  private nextHandle = 1;

  /* Reused per query: a pick runs on pointermove and must not allocate. */
  private readonly localOrigin = new Float32Array(3);
  private readonly localDirection = new Float32Array(3);
  private readonly hit: PickHit = { handle: 0, distance: 0, point: new Float32Array(3) };

  add(source: PickableSource, model: Float32Array): number {
    const handle = this.nextHandle++;
    const entry: Entry = {
      handle,
      source,
      model: new Float32Array(model),
      inverse: new Float32Array(16),
      min: new Float32Array(3),
      max: new Float32Array(3),
    };
    this.entries.push(entry);
    this.refresh(entry, model);
    return handle;
  }

  update(handle: number, model: Float32Array): void {
    const entry = this.entries.find((candidate) => candidate.handle === handle);
    if (entry === undefined) return;
    this.refresh(entry, model);
  }

  remove(handle: number): void {
    const at = this.entries.findIndex((candidate) => candidate.handle === handle);
    if (at >= 0) this.entries.splice(at, 1);
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** The nearest registered mesh along the ray, or null. */
  pick(origin: ArrayLike<number>, direction: ArrayLike<number>): PickHit | null {
    let best = Infinity;
    let bestEntry: Entry | null = null;

    for (const entry of this.entries) {
      const broad = rayAabb(origin, direction, entry.min, entry.max);
      if (broad < 0 || broad > best) continue;

      transformPoint(this.localOrigin, entry.inverse, origin);
      transformDirection(this.localDirection, entry.inverse, direction);

      const { positions, indices } = entry.source;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const distance = rayTriangle(
          this.localOrigin,
          this.localDirection,
          positions,
          indices[i] as number,
          indices[i + 1] as number,
          indices[i + 2] as number,
        );
        if (distance >= 0 && distance < best) {
          best = distance;
          bestEntry = entry;
        }
      }
    }

    if (bestEntry === null) return null;
    this.hit.handle = bestEntry.handle;
    this.hit.distance = best;
    this.hit.point[0] = (origin[0] as number) + (direction[0] as number) * best;
    this.hit.point[1] = (origin[1] as number) + (direction[1] as number) * best;
    this.hit.point[2] = (origin[2] as number) + (direction[2] as number) * best;
    return this.hit;
  }

  /**
   * Re-take the model matrix, its inverse and the world-space box.
   *
   * The box is the transformed corners' extent rather than the transformed local box,
   * which for a rotated mesh is looser than tight and tighter than wrong. A loose broad
   * phase costs triangles; a wrong one loses picks.
   */
  private refresh(entry: Entry, model: Float32Array): void {
    entry.model.set(model);
    invertAffine(entry.inverse, model);

    const { positions } = entry.source;
    entry.min.fill(Infinity);
    entry.max.fill(-Infinity);
    for (let i = 0; i + 2 < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value =
          (model[axis] as number) * (positions[i] as number) +
          (model[axis + 4] as number) * (positions[i + 1] as number) +
          (model[axis + 8] as number) * (positions[i + 2] as number) +
          (model[axis + 12] as number);
        if (value < (entry.min[axis] as number)) entry.min[axis] = value;
        if (value > (entry.max[axis] as number)) entry.max[axis] = value;
      }
    }
  }
}

/** A point through a 4x4, with the translation. */
function transformPoint(out: Float32Array, m: Float32Array, p: ArrayLike<number>): void {
  for (let axis = 0; axis < 3; axis++) {
    out[axis] =
      (m[axis] as number) * (p[0] as number) +
      (m[axis + 4] as number) * (p[1] as number) +
      (m[axis + 8] as number) * (p[2] as number) +
      (m[axis + 12] as number);
  }
}

/**
 * A direction through a 4x4, without the translation, left unnormalised on purpose.
 *
 * `localOrigin` and this are both built from the same inverse matrix, so the local ray
 * `localOrigin + t * localDirection` is `inverse(model)` applied to the world ray
 * `origin + t * direction` at every `t` — the model's linear part and its inverse cancel.
 * That makes `t` itself invariant under the transform, scale included, uniform or not, so
 * the `t` `rayTriangle` finds in local space is already the caller's world-space distance.
 * Normalising this would break that: it would rescale `t` by this vector's length and
 * `rayTriangle` would start returning a value that needs converting back, for nothing
 * gained.
 */
function transformDirection(out: Float32Array, m: Float32Array, d: ArrayLike<number>): void {
  for (let axis = 0; axis < 3; axis++) {
    out[axis] =
      (m[axis] as number) * (d[0] as number) +
      (m[axis + 4] as number) * (d[1] as number) +
      (m[axis + 8] as number) * (d[2] as number);
  }
}

/**
 * The inverse of a model matrix, assuming it is affine.
 *
 * Every model matrix this engine produces is translation, rotation and scale, so the
 * general 4x4 inverse would be arithmetic spent on a bottom row that is always
 * `0 0 0 1`. Written out rather than reached for from gl-matrix because this is called
 * whenever anything moves.
 */
function invertAffine(out: Float32Array, m: Float32Array): void {
  const a = m[0] as number,
    b = m[1] as number,
    c = m[2] as number;
  const d = m[4] as number,
    e = m[5] as number,
    f = m[6] as number;
  const g = m[8] as number,
    h = m[9] as number,
    i = m[10] as number;

  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  const s = determinant === 0 ? 0 : 1 / determinant;

  out[0] = A * s;
  out[1] = (c * h - b * i) * s;
  out[2] = (b * f - c * e) * s;
  out[3] = 0;
  out[4] = B * s;
  out[5] = (a * i - c * g) * s;
  out[6] = (c * d - a * f) * s;
  out[7] = 0;
  out[8] = C * s;
  out[9] = (b * g - a * h) * s;
  out[10] = (a * e - b * d) * s;
  out[11] = 0;

  const tx = m[12] as number,
    ty = m[13] as number,
    tz = m[14] as number;
  out[12] = -((out[0] as number) * tx + (out[4] as number) * ty + (out[8] as number) * tz);
  out[13] = -((out[1] as number) * tx + (out[5] as number) * ty + (out[9] as number) * tz);
  out[14] = -((out[2] as number) * tx + (out[6] as number) * ty + (out[10] as number) * tz);
  out[15] = 1;
}
