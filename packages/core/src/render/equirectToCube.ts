/** An equirectangular image resampled onto the six faces of a cube. */

/**
 * The direction a texel stands for, per face.
 *
 * `forward` is the face centre, `basisX` steps across a row and `basisY` down a column, matching
 * `webgpu/probePass.ts`'s `PROBE_FACE_BASIS` exactly — the same table, and it is the same table
 * because getting one sign wrong mirrors a single face, which projects to a plausible-looking
 * wrong answer rather than to an error.
 *
 * **It lived in `irradianceSh.ts` until the spherical-harmonic path was retired**, and it moved
 * here rather than being deleted with it: the capture is still a cube, so a loaded environment
 * still has to know which direction each of its texels stands for. The prefilter's own copy went
 * with the six-face loop, since an octahedral target has no faces at all.
 */
export const FACE_BASIS: readonly {
  readonly forward: readonly [number, number, number];
  readonly basisX: readonly [number, number, number];
  readonly basisY: readonly [number, number, number];
}[] = [
  { forward: [1, 0, 0], basisX: [0, 0, -1], basisY: [0, -1, 0] },
  { forward: [-1, 0, 0], basisX: [0, 0, 1], basisY: [0, -1, 0] },
  { forward: [0, 1, 0], basisX: [1, 0, 0], basisY: [0, 0, 1] },
  { forward: [0, -1, 0], basisX: [1, 0, 0], basisY: [0, 0, -1] },
  { forward: [0, 0, 1], basisX: [1, 0, 0], basisY: [0, -1, 0] },
  { forward: [0, 0, -1], basisX: [-1, 0, 0], basisY: [0, -1, 0] },
];

/** What a decoded `.hdr` looks like, restated structurally so this imports no package. */
export interface EquirectSource {
  readonly width: number;
  readonly height: number;
  /** `width * height * 3` linear values, row-major from the top. */
  readonly data: Float32Array;
}

/**
 * Resample an equirectangular environment onto six cube faces.
 *
 * **Backend-neutral, and it produces exactly what the projection already takes.** The output is the
 * shape a bake produces — six `size * size * 4` arrays of linear RGBA in
 * cubemap order — so a loaded environment joins the captured path at the same place a bake does,
 * and everything downstream of the cube is one implementation rather than two.
 *
 * **The face basis is imported rather than restated.** This is the fourth place that table would
 * have appeared, and its failure mode is the one the 2026-08-17 rule is about: a mirrored face
 * projects perfectly well onto a wrong answer, and the last time two copies disagreed it took
 * projecting both backends' cubes onto one shared basis to find a sign in the linear Z band.
 *
 * ## The convention, stated because there is no universal one
 *
 * - **Row 0 is the zenith.** `v = acos(y) / pi`, so the top of the image is `+Y`. Inverting this
 *   puts the sky underfoot, and every surface is then lit from below with nothing in the picture
 *   to say why.
 * - **The centre column is `-Z`.** `u = 0.5 + atan2(x, -z) / 2pi`, which is the engine's own camera
 *   convention — yaw 0 looks toward `-Z` and positive yaw turns toward `+X` — so `+X` lands three
 *   quarters of the way across. Choosing the mirror of this passes every brightness check and
 *   every sky-is-up check, and shows only as a reflection that turns the wrong way.
 *
 * **What it costs** is bilinear sampling per texel of the destination, once, at load. **What would
 * make it wrong** is a source small enough that the cube is upsampling it — at that point the faces
 * carry interpolation rather than image, and the honest answer is a smaller cube.
 */
export function equirectToCubeFaces(source: EquirectSource, size: number): Float32Array[] {
  if (size <= 0) throw new Error(`equirectToCubeFaces: a ${size}-texel face is not buildable`);
  if (source.width <= 0 || source.height <= 0) {
    throw new Error(
      `equirectToCubeFaces: a ${source.width} by ${source.height} source has nothing to sample`,
    );
  }

  const faces: Float32Array[] = [];
  for (let face = 0; face < FACE_BASIS.length; face++) {
    const basis = FACE_BASIS[face];
    const pixels = new Float32Array(size * size * 4);
    if (basis === undefined) {
      faces.push(pixels);
      continue;
    }
    for (let y = 0; y < size; y++) {
      /* Texel centres in [-1, 1], the same mapping the projection uses, so the two agree exactly. */
      const v = ((y + 0.5) / size) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1;
        const dx = basis.forward[0] + basis.basisX[0] * u + basis.basisY[0] * v;
        const dy = basis.forward[1] + basis.basisX[1] * u + basis.basisY[1] * v;
        const dz = basis.forward[2] + basis.basisX[2] * u + basis.basisY[2] * v;
        const inverse = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        sampleEquirect(
          source,
          dx * inverse,
          dy * inverse,
          dz * inverse,
          pixels,
          (y * size + x) * 4,
        );
      }
    }
    faces.push(pixels);
  }
  return faces;
}

/**
 * One direction, bilinearly sampled out of the source, written as RGBA at `out`.
 *
 * **Wrapped in longitude and clamped in latitude**, which is what the sphere actually does: the
 * seam at `u = 1` meets `u = 0` and is a real join, while the pole is a point and has no neighbour
 * above it. Clamping both would put a visible seam down the back of every environment; wrapping
 * both would sample the far side of the sky at the zenith.
 */
function sampleEquirect(
  source: EquirectSource,
  dx: number,
  dy: number,
  dz: number,
  out: Float32Array,
  at: number,
): void {
  const { width, height, data } = source;

  const u = 0.5 + Math.atan2(dx, -dz) / (2 * Math.PI);
  const v = Math.acos(Math.min(1, Math.max(-1, dy))) / Math.PI;

  /* Texel centres again, so a sample at the exact centre of a texel reads that texel and no other. */
  const fx = u * width - 0.5;
  const fy = v * height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const xa = wrap(x0, width);
  const xb = wrap(x0 + 1, width);
  const ya = clamp(y0, height);
  const yb = clamp(y0 + 1, height);

  for (let channel = 0; channel < 3; channel++) {
    const aa = data[(ya * width + xa) * 3 + channel] ?? 0;
    const ba = data[(ya * width + xb) * 3 + channel] ?? 0;
    const ab = data[(yb * width + xa) * 3 + channel] ?? 0;
    const bb = data[(yb * width + xb) * 3 + channel] ?? 0;
    const top = aa + (ba - aa) * tx;
    const bottom = ab + (bb - ab) * tx;
    out[at + channel] = top + (bottom - top) * ty;
  }
  /* One, because a cube sampler reads four channels whatever an environment meant by the fourth. */
  out[at + 3] = 1;
}

/** Longitude wraps: the image's left edge is its right edge. */
function wrap(value: number, extent: number): number {
  const wrapped = value % extent;
  return wrapped < 0 ? wrapped + extent : wrapped;
}

/** Latitude clamps: there is nothing above the zenith to blend with. */
function clamp(value: number, extent: number): number {
  return value < 0 ? 0 : value >= extent ? extent - 1 : value;
}
