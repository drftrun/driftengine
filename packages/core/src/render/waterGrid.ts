/**
 * The ocean's tessellation: a near sheet that carries waves, and a ringed skirt
 * that carries distance.
 *
 * These are two different problems and one mesh cannot serve both.
 *
 * The near sheet must be *uniform* and snapped to whole cells. That combination
 * is what makes the wave lattice invariant in world space: shifting by exactly
 * one cell lands every vertex where its neighbour was, so the reconstructed
 * surface does not change as the camera moves. Break the uniformity — grade the
 * cells to buy reach, say — and that invariance goes with it. Cells wider than
 * the snap quantum are re-sampled at a new phase on every snap, and the surface
 * visibly swims underfoot.
 *
 * The skirt carries no displacement, so its tessellation cannot distort
 * anything, and it can stretch to tens of kilometres. That reach is not
 * decoration: a sheet that stops short ends in a straight line with a corner in
 * it, and no alpha ramp hides that. At eye height the horizon of a flat plane is
 * at infinity, so a fade measured in world metres compresses into a pixel or two
 * of skyline and the corner survives. The rim has to be too small to resolve.
 *
 * But the skirt cannot be a single leap to the far edge either, even though its
 * *shape* would be identical. Fog is evaluated per fragment from world position,
 * so one triangle spanning 150 m to 30 km squeezes the entire fog gradient into
 * the handful of pixels that triangle covers — which puts a hard line right back
 * at the near sheet's rim, in exactly the place the skirt was meant to hide. So
 * the skirt is a set of concentric rings whose radii grow geometrically, giving
 * the gradient somewhere to happen. They are cheap: being flat, they need only
 * enough vertices per side to stay a square.
 */

/** Concentric rings between the near sheet and the far edge. */
const SKIRT_RINGS = 12;
/** Vertices per side of each ring. A flat square needs very few. */
const SKIRT_SEGMENTS_PER_SIDE = 8;

export interface WaterGrid {
  /** Grid-local xz pairs, metres from the camera-snapped origin. */
  readonly offsets: Float32Array;
  readonly indices: Uint32Array;
  /**
   * Cell size of the near sheet. The grid origin snaps to whole multiples of
   * this — see above for why that must equal the cell size exactly.
   */
  readonly cellSize: number;
  /** Half-width of the wave-bearing near sheet. */
  readonly nearHalfExtent: number;
  /** Half-width of the outermost ring, i.e. how far the ocean reaches. */
  readonly farHalfExtent: number;
}

/**
 * Point at parameter `t` (in [0, 4)) around a square of the given half-width,
 * walked anticlockwise from the -x/-z corner. Consistent ordering across rings
 * is what lets consecutive rings be stitched by index arithmetic alone.
 */
function squarePerimeter(t: number, radius: number): [number, number] {
  const side = Math.floor(t) % 4;
  const u = t - Math.floor(t);
  const span = radius * 2;
  if (side === 0) return [-radius + span * u, -radius];
  if (side === 1) return [radius, -radius + span * u];
  if (side === 2) return [radius - span * u, radius];
  return [-radius, radius - span * u];
}

export function buildWaterGrid(
  resolution: number,
  nearExtent: number,
  farHalfExtent: number,
): WaterGrid {
  const side = resolution + 1;
  const cellSize = nearExtent / resolution;
  const nearHalfExtent = nearExtent * 0.5;

  const perimeter = SKIRT_SEGMENTS_PER_SIDE * 4;
  const nearVertices = side * side;
  const skirtVertices = (SKIRT_RINGS + 1) * perimeter;
  const offsets = new Float32Array((nearVertices + skirtVertices) * 2);

  for (let z = 0; z < side; z++) {
    const gz = z * cellSize - nearHalfExtent;
    for (let x = 0; x < side; x++) {
      const v = (z * side + x) * 2;
      offsets[v] = x * cellSize - nearHalfExtent;
      offsets[v + 1] = gz;
    }
  }

  // Geometric radii: each ring is the same factor wider than the last, so the
  // fog gradient gets roughly equal screen space in every band.
  const growth = (farHalfExtent / nearHalfExtent) ** (1 / SKIRT_RINGS);
  for (let ring = 0; ring <= SKIRT_RINGS; ring++) {
    const radius = ring === SKIRT_RINGS ? farHalfExtent : nearHalfExtent * growth ** ring;
    for (let i = 0; i < perimeter; i++) {
      const [px, pz] = squarePerimeter(i / SKIRT_SEGMENTS_PER_SIDE, radius);
      const v = (nearVertices + ring * perimeter + i) * 2;
      offsets[v] = px;
      offsets[v + 1] = pz;
    }
  }

  const indices = new Uint32Array(resolution * resolution * 6 + SKIRT_RINGS * perimeter * 6);
  let i = 0;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const a = z * side + x;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = c;
      indices[i++] = d;
    }
  }
  for (let ring = 0; ring < SKIRT_RINGS; ring++) {
    const inner = nearVertices + ring * perimeter;
    const outer = inner + perimeter;
    for (let k = 0; k < perimeter; k++) {
      const next = (k + 1) % perimeter;
      indices[i++] = inner + k;
      indices[i++] = outer + k;
      indices[i++] = inner + next;
      indices[i++] = inner + next;
      indices[i++] = outer + k;
      indices[i++] = outer + next;
    }
  }

  return { offsets, indices, cellSize, nearHalfExtent, farHalfExtent };
}

/**
 * Cells per side of the bounded-body patch.
 *
 * Exported so neither backend keeps its own copy: a patch built at two resolutions is two
 * different meshes for the same pool, and nothing would raise.
 */
export const PATCH_RESOLUTION = 24;

/**
 * A flat square sheet in [-1, 1], for any body of water with edges.
 *
 * Here rather than in `waterRenderer.ts` because both backends build the same patch, and a
 * second copy of a mesh generator is a bounded body whose triangles differ per backend.
 */
export function buildUnitSheet(resolution: number): {
  offsets: Float32Array;
  indices: Uint32Array;
} {
  const side = resolution + 1;
  const offsets = new Float32Array(side * side * 2);
  let v = 0;
  for (let z = 0; z < side; z++) {
    for (let x = 0; x < side; x++) {
      offsets[v++] = (x / resolution) * 2 - 1;
      offsets[v++] = (z / resolution) * 2 - 1;
    }
  }
  const indices = new Uint32Array(resolution * resolution * 6);
  let i = 0;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const a = z * side + x;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = c;
      indices[i++] = d;
    }
  }
  return { offsets, indices };
}
