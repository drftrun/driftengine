/**
 * A material's maps placed by where a point is in the world: `SurfaceMaterial.projection`, and the
 * one vector `shaders/flat/worldUv.ts` reads it from.
 */

/**
 * Texture coordinates from the world rather than from the mesh.
 *
 * **`'planar'`** lays the maps across the two horizontal axes, `x` and `z`: ground whose mesh
 * carries flat coordinates, or none worth reading, shows its texture at `scale` repeats a metre.
 * **`'triplanar'`** reads each map on the three planes across `x`, `y` and `z` and blends them by
 * how squarely the surface faces each, the normal's components raised to `sharpness`, so walls and
 * rock wear a texture without stretching. See `worldUv.ts` for the normal map's blend.
 *
 * **What it gives up**: the world's coordinates do not move with a mesh, so a moving mesh slides
 * under its texture; triplanar reads every map three times; and the material's `uScale`, `vScale`
 * and offsets, which are the mesh's coordinates', do not apply.
 */
export interface SurfaceProjection {
  readonly kind: 'planar' | 'triplanar';
  /** Repeats a metre: 2 lays a texture every half metre. */
  readonly scale: number;
  /** How sharply triplanar's planes meet: the exponent on the normal. 4 unless given. */
  readonly sharpness?: number;
}

/** Floats `packSurfaceProjection` writes: one vector. */
export const PROJECTION_FLOATS = 4;

/**
 * `projection` into `out`: its kind (0 none, 1 planar, 2 triplanar), its repeats a metre and its
 * sharpness; zeros for none. A scale that is not finite and above zero projects nothing, so a
 * material is never drawn at a scale that collapses its texture to a point.
 */
export function packSurfaceProjection(
  projection: SurfaceProjection | null | undefined,
  out: Float32Array,
): void {
  out.fill(0);
  if (projection === null || projection === undefined) return;
  const scale = projection.scale;
  if (!Number.isFinite(scale) || scale <= 0) return;
  out[0] = projection.kind === 'triplanar' ? 2 : 1;
  out[1] = scale;
  const sharpness = projection.sharpness ?? 4;
  out[2] = Number.isFinite(sharpness) ? Math.min(Math.max(sharpness, 1), 64) : 4;
}

/** Whether a material projects its maps at all. */
export function projects(projection: SurfaceProjection | null | undefined): boolean {
  return (
    projection !== null &&
    projection !== undefined &&
    Number.isFinite(projection.scale) &&
    projection.scale > 0
  );
}
