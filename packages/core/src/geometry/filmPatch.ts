/**
 * A rounded, feathered patch lying on a swept surface.
 *
 * The shape a spill has. Not a rectangle, not a decal, not a box: an irregular
 * lens that follows the surface's curvature and bank and dissolves at its rim.
 *
 * The rim is the whole reason this exists. A patch drawn with a hard edge reads as
 * a sticker on the world no matter what material it is made of, because a real
 * puddle is thinnest where it ends — so this emits a *coverage* value per vertex,
 * 1 through the middle and 0 around the outside, and the film shader turns that
 * into alpha. Geometry supplies the silhouette; the shader supplies the wetness.
 *
 * Textureless and engine-generic: it takes a curve, a window along it, a width and
 * a seed, and knows nothing about oil, water or what a slick is for.
 */
import type { MeshData } from '../render/mesh.ts';
import type { Spline } from './spline.ts';
import { createSplineSample } from './spline.ts';
import type { Vec3 } from '../math/color.ts';

export interface FilmPatchOptions {
  /** Arc-length window on the curve. */
  fromM: number;
  toM: number;
  /** Lateral centre and half-width, metres from the centreline. */
  centreM: number;
  halfWidthM: number;
  /** Height above the surface. Small: this is a film, not a kerb. */
  liftM: number;
  color: Vec3;
  /**
   * Shape seed. Two patches with the same window and the same seed are the same
   * patch, which is what keeps a day's world identical on every device.
   */
  seed: number;
}

/**
 * Stations along the patch, and vertices across it.
 *
 * Nine across is what a soft rim costs: the outer pair carry zero coverage, so
 * they contribute silhouette rather than colour, and the falloff needs a couple of
 * rings inside them or the shoulder becomes a visible band.
 */
const MIN_STATIONS = 7;
const STATION_SPACING_M = 0.7;
const ACROSS = 9;
/**
 * How much the outline wanders, as a fraction of the half-width.
 *
 * Enough that no two slicks are the same lens and none of them looks drawn with a
 * compass; not so much that the patch stops reading as one connected spill.
 */
const WOBBLE = 0.28;

export function buildFilmPatch(spline: Spline, options: FilmPatchOptions): MeshData {
  const spanM = Math.max(options.toM - options.fromM, 0.1);
  const stations = Math.max(MIN_STATIONS, Math.ceil(spanM / STATION_SPACING_M) | 1);
  const vertexCount = stations * ACROSS;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const coverage = new Float32Array(vertexCount);
  const indices = new Uint32Array((stations - 1) * (ACROSS - 1) * 6);

  const sample = createSplineSample();
  // Two incommensurable frequencies per axis, so the outline does not repeat
  // across a long patch, and phases from the seed so each one is its own shape.
  const phaseA = (options.seed % 1000) * 0.0063;
  const phaseB = (options.seed % 997) * 0.0157;

  let v = 0;
  let i = 0;
  for (let s = 0; s < stations; s++) {
    // -1 at the near end, +1 at the far end.
    const along = (s / (stations - 1)) * 2 - 1;
    const d = options.fromM + ((along + 1) / 2) * spanM;
    spline.sampleAt(d, sample);

    /*
     * An ellipse, roughened.
     *
     * The circular profile is what rounds the ends — a patch whose width is
     * constant to its last station has square ends however soft its sides are.
     */
    const profile = Math.sqrt(Math.max(1 - along * along, 0));
    /*
     * The wobble only ever eats *inward*.
     *
     * Written first as `1 ± wobble`, which is the obvious form and is wrong: the
     * half-width then reaches 1.28× what the caller asked for, and a caller like an
     * oil slick has a physics window that is exactly this band. Ground that looks
     * wet and grips normally is a lie, and ground that grips nowhere near what is
     * drawn is worse. Subtracting keeps the silhouette inside the contract by
     * construction rather than by a tolerance.
     */
    const dent =
      0.6 * (0.5 + 0.5 * Math.sin(along * 3.7 + phaseA)) +
      0.4 * (0.5 + 0.5 * Math.sin(along * 8.3 + phaseB));
    const half = options.halfWidthM * profile * (1 - WOBBLE * dent);

    for (let a = 0; a < ACROSS; a++) {
      // -1 at one edge, +1 at the other.
      const across = (a / (ACROSS - 1)) * 2 - 1;
      const lateral = options.centreM + across * half;

      const o = v * 3;
      positions[o] = sample.x + sample.rightX * lateral + sample.normalX * options.liftM;
      positions[o + 1] = sample.y + sample.rightY * lateral + sample.normalY * options.liftM;
      positions[o + 2] = sample.z + sample.rightZ * lateral + sample.normalZ * options.liftM;
      normals[o] = sample.normalX;
      normals[o + 1] = sample.normalY;
      normals[o + 2] = sample.normalZ;
      colors[o] = options.color[0];
      colors[o + 1] = options.color[1];
      colors[o + 2] = options.color[2];

      /*
       * Coverage falls off in both directions at once, and multiplying the two is
       * what keeps the corners honest — a patch feathered only across its width
       * still ends in two hard lines at the ends.
       */
      const acrossFade = 1 - across * across;
      const alongFade = 1 - along * along;
      coverage[v] = Math.max(acrossFade, 0) * Math.max(alongFade, 0);
      v++;
    }

    if (s === 0) continue;
    for (let a = 0; a < ACROSS - 1; a++) {
      const here = s * ACROSS + a;
      const back = here - ACROSS;
      /*
       * Wound so the patch faces *up*.
       *
       * The first version had every triangle facing down — measured, 224 of 224 — which under
       * back-face culling means the slick was never drawn at all. That cost a whole session
       * hunting the shader while looking straight at the patch: the shader was fine and the
       * geometry was inside out.
       *
       * The lesson is the same one the ribbon taught, and it is why the test below measures the
       * cross product of the triangle rather than reading `normals`: the stored normals are the
       * *surface's*, written by hand and pointing up whatever the winding does, so asking them
       * whether the winding is right is asking the wrong array.
       */
      indices[i] = back;
      indices[i + 1] = back + 1;
      indices[i + 2] = here;
      indices[i + 3] = back + 1;
      indices[i + 4] = here + 1;
      indices[i + 5] = here;
      i += 6;
    }
  }

  return { positions, normals, colors, emissive: coverage, indices };
}
