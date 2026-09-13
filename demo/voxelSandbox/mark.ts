/**
 * The DriftEngine mark, drawn into the frame by the engine that the mark is for.
 *
 * **Why the geometry is here rather than fetched.** The canonical artwork is
 * `packages/package/assets/mark-plain.svg`, which the packager's splash serves as a file. Nothing
 * serves it to a demo, and nothing on the public surface puts an image into a screen rectangle
 * anyway, which `GAPS.md` records. What the mark *is*, though, is five flat quads with no
 * gradient and no curve, because it was drawn to be what this renderer does to a cube: so it
 * costs five quads to say it in geometry instead, and the loading screen carries the real mark
 * rather than a stand-in.
 *
 * The two copies have to move together. If the SVG is ever redrawn, these numbers are its
 * `<polygon points>` in the same order, in its own 64 by 64 viewBox with y running down.
 */
import type { MeshData, Vec3 } from '../../packages/core/src/index';

/** One quad of the mark: four points in the SVG's viewBox, and the flat colour it carries. */
interface Facet {
  readonly points: readonly (readonly [number, number])[];
  readonly color: Vec3;
}

/** sRGB hex to the linear values the renderer shades in. */
function srgb(hex: string): Vec3 {
  const channel = (at: number): number => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

/**
 * The mark, facet for facet from the SVG.
 *
 * Two streaks, then the cube's three faces: left in shadow, right lit, top brightest. The order
 * is the file's, and it is also back to front, which is what lets this draw with no depth sort.
 */
const FACETS: readonly Facet[] = [
  {
    points: [
      [19.82, 27.06],
      [5, 34.47],
      [5, 39],
      [19.82, 31.59],
    ],
    color: srgb('#2ac79c'),
  },
  {
    points: [
      [19.82, 39.41],
      [5, 46.82],
      [5, 51.35],
      [19.82, 43.94],
    ],
    color: srgb('#116352'),
  },
  {
    points: [
      [24.77, 22.12],
      [41.88, 32],
      [41.88, 51.77],
      [24.77, 41.88],
    ],
    color: srgb('#0f5b49'),
  },
  {
    points: [
      [41.88, 32],
      [59, 22.12],
      [59, 41.88],
      [41.88, 51.77],
    ],
    color: srgb('#1c9b7c'),
  },
  {
    points: [
      [41.88, 12.23],
      [59, 22.12],
      [41.88, 32],
      [24.77, 22.12],
    ],
    color: srgb('#35e0b0'),
  },
];

/**
 * Twice the signed area of a polygon, in the mesh's own frame.
 *
 * Positive is counter-clockwise once the SVG's downward Y has been flipped, which is the
 * handedness every facet is normalised to before the quad is wound.
 */
function signedArea(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i] as readonly [number, number];
    const [bx, by] = points[(i + 1) % points.length] as readonly [number, number];
    /* Y negated on the way in, matching what `buildMarkMesh` writes into the positions. */
    sum += ax * -by - bx * -ay;
  }
  return sum;
}

/** The viewBox the points are given in, so a caller can scale without knowing the artwork. */
export const MARK_VIEWBOX = 64;

/**
 * The mark as one mesh in the XY plane, sized to `MARK_VIEWBOX` and centred on its own origin.
 *
 * **Both axes are flipped, for two different reasons.** Y because the SVG's runs down and the
 * renderer's runs up, and a mark drawn without that is the cube upside down. X because the basis
 * a camera-parented draw is handed has a determinant of -1, so anything drawn through it arrives
 * mirrored: the streaks came out to the right of the cube, where the artwork has them to the
 * left. Pre-mirroring here cancels it.
 *
 * Mirroring flips handedness, so the quad is wound in its natural order rather than reversed.
 * `hotbarIcons.ts` reverses its own for the same reason from the other side: it is not
 * pre-mirrored, so it has to pay for the basis instead of cancelling it.
 */
export function buildMarkMesh(): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const half = MARK_VIEWBOX / 2;

  for (const facet of FACETS) {
    const base = positions.length / 3;
    /*
     * **The artwork does not wind consistently, so the handedness is measured rather than
     * assumed.** In the SVG the two streaks run one way round and the cube's three faces run the
     * other, which is invisible there because an SVG has no back face. Emitted as given, the
     * streaks drew and the cube did not: three quarters of the mark missing, and it read as a
     * broken logo rather than as a culling problem. The shoelace area says which way each one
     * goes and the points are reversed where they disagree, so a facet added to the table later
     * cannot reintroduce this.
     */
    const points = signedArea(facet.points) < 0 ? [...facet.points].reverse() : facet.points;
    for (const [x, y] of points) {
      positions.push(half - x, half - y, 0);
      normals.push(0, 0, -1);
      colors.push(facet.color[0], facet.color[1], facet.color[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    emissive: new Float32Array(positions.length / 3),
    indices: new Uint32Array(indices),
  };
}
