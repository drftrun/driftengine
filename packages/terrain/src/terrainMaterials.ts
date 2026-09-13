import type { ReadonlyVec3 } from 'gl-matrix';

/**
 * Several materials blended across one field, as vertex colour.
 *
 * **A weight map baked into vertex colour, and that is the idiomatic answer here rather than a
 * compromise.** This engine's colour *is* vertex data — it is what makes the world one flat-shaded
 * draw call, and the root README says so where it introduces `drawMesh`'s tint. A splat map read by
 * a shader would mean a texture bound on every terrain draw and a branch in `flatFrag`, which Track
 * D measured at 19.8 KB gzipped for a capability generated into sixteen fragment permutations. This
 * costs nothing at all at runtime: the blend happens once, where the patch is built.
 *
 * **What that gives up, and it is the honest limit**: the blend is only as sharp as the mesh. A
 * material boundary inside a cell is drawn as a gradient across that cell, and a patch drawn at a
 * quarter detail blends four times as coarsely as one at full detail. A consumer who wants a sharp
 * line — a road edge, a cliff base — draws that patch at full detail, which is the same dial the
 * geometry already uses.
 *
 * **The weights are read bilinearly, which is the opposite of how a height is read**, and the
 * contrast is the whole reason both decisions are written down. A height is read as the *triangle*
 * because the surface is drawn as triangles and the query has to agree with the picture
 * (`heightfield.ts` argues that at length). A weight is not drawn: it decides a vertex colour, and
 * the vertex is wherever the mesh put it. There is no triangulation to agree with, so the smooth
 * interpolation is simply the better one — reading a weight map as triangles would put a visible
 * crease along every cell diagonal for nothing.
 */

export interface TerrainMaterial {
  readonly color: ReadonlyVec3;
  /** Self-illumination, revealed at night. Zero unless a material glows. */
  readonly emissive?: number;
  /** How sharply this material takes a sun highlight, 0 to 1. */
  readonly specular?: number;
}

export interface TerrainMaterialsOptions {
  /** The materials being blended. At least one. */
  readonly materials: readonly TerrainMaterial[];
  /** Samples of the weight map across x. It need not match the heightfield's own resolution. */
  readonly width: number;
  /** Samples across z. */
  readonly depth: number;
  /**
   * `width * depth * materials.length` weights, row-major with the material running fastest.
   *
   * They need not sum to anything: `terrainMaterialWeights` normalises what it reads, because a
   * map is painted or generated and nothing balances its channels.
   */
  readonly weights: ArrayLike<number>;
}

/** Scratch for one blend, so shading a patch allocates nothing per vertex. */
const SCRATCH = new Float32Array(16);

/**
 * The normalised weights at a point in the field's own `0..1` extent.
 *
 * **Normalised, and a sample that weighs nothing falls back to the first material.** An unpainted
 * corner of a map sums to zero, and dividing by that gives a NaN or a black patch depending on
 * where it lands — both of which read as a rendering fault rather than as an unpainted map. Black
 * is not a colour terrain should ever be by accident.
 *
 * `out` must hold one number per material; it is returned for convenience and is the caller's.
 */
export function terrainMaterialWeights(
  map: TerrainMaterials,
  u: number,
  v: number,
  out: Float32Array,
): Float32Array {
  const count = map.materials.length;
  /* Clamped rather than wrapped: a field has an edge, and a query past it should answer the edge
     rather than the far side of the map. */
  const x = Math.min(map.width - 1, Math.max(0, u * (map.width - 1)));
  const z = Math.min(map.depth - 1, Math.max(0, v * (map.depth - 1)));
  const ix = Math.min(map.width - 2, Math.floor(x));
  const iz = Math.min(map.depth - 2, Math.floor(z));
  const fu = map.width < 2 ? 0 : x - ix;
  const fv = map.depth < 2 ? 0 : z - iz;

  const a = (iz * map.width + ix) * count;
  const b = (iz * map.width + Math.min(map.width - 1, ix + 1)) * count;
  const c = (Math.min(map.depth - 1, iz + 1) * map.width + ix) * count;
  const d = (Math.min(map.depth - 1, iz + 1) * map.width + Math.min(map.width - 1, ix + 1)) * count;

  let total = 0;
  for (let m = 0; m < count; m++) {
    const top = (map.weights[a + m] ?? 0) * (1 - fu) + (map.weights[b + m] ?? 0) * fu;
    const bottom = (map.weights[c + m] ?? 0) * (1 - fu) + (map.weights[d + m] ?? 0) * fu;
    const weight = top * (1 - fv) + bottom * fv;
    out[m] = weight;
    total += weight;
  }

  if (total <= 0) {
    out[0] = 1;
    for (let m = 1; m < count; m++) out[m] = 0;
    return out;
  }
  for (let m = 0; m < count; m++) out[m] = (out[m] ?? 0) / total;
  return out;
}

export class TerrainMaterials {
  readonly materials: readonly TerrainMaterial[];
  readonly width: number;
  readonly depth: number;
  readonly weights: Float32Array;
  /**
   * Whether any material shines, so a patch built from this uploads a specular buffer only if one
   * is wanted — the promise `MeshData.specular` makes and the reason it is optional.
   */
  readonly shines: boolean;
  /** The same question for emissive, and for the same reason. */
  readonly glows: boolean;

  private readonly scratch: Float32Array;

  constructor(options: TerrainMaterialsOptions) {
    const count = options.materials.length;
    if (count < 1) throw new Error('TerrainMaterials: needs at least one material to blend');
    const needed = options.width * options.depth * count;
    if (options.weights.length !== needed) {
      throw new Error(
        `TerrainMaterials: ${options.width} by ${options.depth} over ${count} materials needs ` +
          `${needed} weights, got ${options.weights.length}`,
      );
    }
    this.materials = [...options.materials];
    this.width = Math.round(options.width);
    this.depth = Math.round(options.depth);
    this.weights = Float32Array.from(options.weights);
    this.shines = this.materials.some((material) => (material.specular ?? 0) !== 0);
    this.glows = this.materials.some((material) => (material.emissive ?? 0) !== 0);
    this.scratch = count <= SCRATCH.length ? SCRATCH : new Float32Array(count);
  }

  /** The blended colour at a point in the field's `0..1` extent. */
  colorAt(u: number, v: number, out: Float32Array): Float32Array {
    const weights = terrainMaterialWeights(this, u, v, this.scratch);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let m = 0; m < this.materials.length; m++) {
      const weight = weights[m] ?? 0;
      const colour = this.materials[m]?.color;
      r += (colour?.[0] ?? 0) * weight;
      g += (colour?.[1] ?? 0) * weight;
      b += (colour?.[2] ?? 0) * weight;
    }
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }

  /** The blended self-illumination, on the same weights the colour used. */
  emissiveAt(u: number, v: number): number {
    const weights = terrainMaterialWeights(this, u, v, this.scratch);
    let sum = 0;
    for (let m = 0; m < this.materials.length; m++) {
      sum += (this.materials[m]?.emissive ?? 0) * (weights[m] ?? 0);
    }
    return sum;
  }

  /** The blended highlight, likewise. */
  specularAt(u: number, v: number): number {
    const weights = terrainMaterialWeights(this, u, v, this.scratch);
    let sum = 0;
    for (let m = 0; m < this.materials.length; m++) {
      sum += (this.materials[m]?.specular ?? 0) * (weights[m] ?? 0);
    }
    return sum;
  }
}
