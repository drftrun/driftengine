/**
 * DriftTR's resolve: a jittered frame at the render size into a picture at the output size.
 *
 * **This is the reference the compute shader is held to**, operation for operation, and it is built
 * from the pieces before it: the jitter taken out of where the current frame was observed
 * (`motionVectors.ts`), the history read bicubically where the surface was (`reproject.ts`), clipped
 * to the render neighbourhood's variance box in YCoCg (`clamp.ts`), weighted by whether it is the
 * same surface (`disocclusion.ts`), accumulated, and then sharpened into the picture that is shown.
 *
 * **Per output pixel, in this order:**
 *
 * 1. The render texels around where this frame observed the output pixel each land, unjittered, some
 *    distance from its centre. **Each contributes by that distance** — a Gaussian over output pixels —
 *    and the sum of their weights is how much this frame knows about the pixel. This is what makes the
 *    accumulation converge on the output-size picture rather than on the render's own, blurred to its
 *    texel size: an interpolated read of the render, averaged over every jitter, is exactly that blur.
 * 2. The same texels bound the history, and give the **nearest depth**, whose texel's motion is the one
 *    taken — the dilation every temporal upscaler uses, because an edge's own motion belongs to the
 *    nearer of the two surfaces meeting there. The centre texel wins a tie.
 * 3. That texel's motion is a drawn object's where the motion target flags one, carrying the object's
 *    previous view depth in its third channel; otherwise it is the camera's, through the surface's
 *    world position.
 * 4. Where the surface was is read from the history — its colour and the weight it had gathered — and
 *    last frame's depth says whether it is the same surface: the nearest of the nine texels around
 *    where the dilated texel was, forgiven its own slope across a texel. The two frames' normals, from
 *    their depths, catch thin geometry, each with the say its planarity gives it. The disocclusion
 *    scales the history's weight.
 * 5. The history is clipped to the box, its weight capped so a tenth of each frame is always new, and
 *    the two are mixed by their weights. Where the pixel has gathered less than one sample's worth,
 *    the render read bicubically fills the gap. The history keeps colour and weight; the picture shown
 *    is it sharpened.
 *
 * **And the temporal resolve's anti-flicker, where the caller carries its records** (`temporalAa.ts`
 * says why it works and what it gives up). A thread finer than a render texel is caught in some
 * phases of the jitter and missed in others, and in a phase that misses it the nine texels can all
 * miss it: the box collapses onto what is behind, the history is clipped out, and a still picture
 * flashes at every fine edge each period. A still camera over a still scene gathers every pixel the
 * same way each period, so each pixel keeps a record of this frame's gathered luma over the period,
 * and once two periods running have repeated its box widens by its own spread and it keeps more of
 * its history. **The record stays at the pixel rather than following the reprojection**, because the
 * proof is only ever for a pixel that has not moved; it starts over wherever the history did not
 * survive, and is forgotten in proportion to motion.
 *
 * **And a still pixel whose depth has been seen to swing is not a disocclusion.** A rail finer than
 * a texel in front of a wall is caught in some phases and missed in others, so last frame can hold
 * the wall where this frame holds the rail with nothing moved — and the depth test threw the history
 * away, leaving the record nothing to keep. So each pixel also keeps the largest relative miss of
 * last frame's depth it has seen lately, kept whatever the test says, and while still its tolerance
 * widens to `DEPTH_SWING_WIDTH` of it — the temporal resolve's answer to a crack of light round a
 * door, as a held peak rather than its running mean: a rail caught in one phase of eighteen misses
 * once a period, and a mean has worn that miss down to a thirtieth by the next. **What it gives up**
 * is the depth test's word at such a pixel while still: a surface arriving there inside the swing
 * keeps the history, and the neighbourhood clip, which the unproven sample of an arrival leaves
 * unwidened, is what takes it out.
 *
 * **Conventions.** Images are rows from `v = 0` upward. Depths are clip depths in the matrices'
 * convention, OpenGL's here — the nearest is the smallest — and the renderer converts its reversed
 * buffer before a sample reaches this arithmetic, as the temporal resolve already does.
 */
import { clipToBox, rgbToYCoCg, varianceBox, yCoCgToRgb } from './clamp.ts';
import {
  disocclusionWeight,
  normalFromPositions,
  planarity,
  surfaceSlope,
  worldPositionFromDepth,
} from './disocclusion.ts';
import type { DisocclusionParams } from './disocclusion.ts';
import { sampleBilinear, sampleHistoryBicubic5 } from './reproject.ts';
import {
  TEMPORAL_FLICKER,
  flickerBlend,
  flickerRule,
  flickerWidening,
  freshFlicker,
  nextFlicker,
  stillness,
} from '../temporalAa.ts';
import type { Flicker, FlickerRule } from '../temporalAa.ts';

/** What a reconstruction is asked for. */
export interface ReconQuality {
  /** Output size over render size, each axis. 1.3 to 2; 0 is off. */
  readonly ratio: number;
  /** The current frame's share of a fully trusted accumulation. */
  readonly alpha: number;
  /** How far the shown picture is sharpened, 0 to 1. */
  readonly sharpen: number;
  /** Standard deviations the neighbourhood box extends either side of its mean. */
  readonly clampGamma: number;
}

/**
 * A tenth of each frame kept, as the temporal resolve keeps; a box of a standard deviation and a
 * quarter; a light sharpen. At two thirds of the output a side.
 */
export const DEFAULT_RECON_QUALITY: ReconQuality = {
  ratio: 1.5,
  alpha: 0.1,
  sharpen: 0.25,
  clampGamma: 1.25,
};

/**
 * The current colour and the clipped history mixed: the history's share is `weight × (1 − alpha)`.
 *
 * A weight of zero is the current colour exactly — no history — and a weight of one with an alpha of
 * zero is the history exactly. A convex mixture, so repeated accumulation of one colour converges to
 * it and never overshoots.
 */
export function accumulate(
  out: Float32Array | Float64Array,
  current: ArrayLike<number>,
  history: ArrayLike<number>,
  weight: number,
  alpha: number,
): void {
  const kept = Math.min(1, Math.max(0, weight)) * (1 - Math.min(1, Math.max(0, alpha)));
  for (let c = 0; c < 3; c += 1) {
    out[c] = (current[c] as number) * (1 - kept) + (history[c] as number) * kept;
  }
}

/**
 * The centre pushed away from its four neighbours' mean by `amount`, and **held inside the range of
 * the five** — the halo a plain unsharp mask draws beside every edge is a value outside that range.
 * A flat region has no difference to push, so it is unchanged.
 */
export function sharpen(
  out: Float32Array | Float64Array,
  centre: ArrayLike<number>,
  neighbours: ArrayLike<number>,
  amount: number,
): void {
  for (let c = 0; c < 3; c += 1) {
    const middle = centre[c] as number;
    let low = middle;
    let high = middle;
    let sum = 0;
    for (let n = 0; n < 4; n += 1) {
      const value = neighbours[n * 3 + c] as number;
      sum += value;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    const pushed = middle + amount * (middle - sum / 4);
    out[c] = Math.min(high, Math.max(low, pushed));
  }
}

/** Everything one resolve reads. Images are rows from `v = 0` upward. */
export interface ResolveFrame {
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  /** Render size, three floats a texel, linear. */
  readonly scene: ArrayLike<number>;
  /** Render size, one clip depth a texel. */
  readonly depth: ArrayLike<number>;
  /**
   * Render size, four floats a texel: a drawn object's motion in uv, its previous view depth, and a
   * flag above one half where a draw wrote them.
   */
  readonly motion: ArrayLike<number>;
  /** Last frame's `depth`. */
  readonly previousDepth: ArrayLike<number>;
  /** Output size, four floats a texel: last frame's unsharpened colour, and the weight it gathered. */
  readonly history: ArrayLike<number>;
  /** False on the first frame, after a resize and after a cut. */
  readonly hasHistory: boolean;
  /** This frame's inverse view-projection, unjittered. */
  readonly inverseViewProj: ArrayLike<number>;
  /** Last frame's view-projection and its inverse, unjittered. */
  readonly previousViewProj: ArrayLike<number>;
  /**
   * Last frame's view-projection times this frame's inverse: where a texel's clip position was
   * last frame. Derived from the two when absent; a caller holding its matrices at a lower precision
   * than it multiplies at passes its own product, as the renderer does.
   */
  readonly reprojection?: ArrayLike<number>;
  readonly previousInverseViewProj: ArrayLike<number>;
  readonly eye: ArrayLike<number>;
  readonly previousEye: ArrayLike<number>;
  /** This frame's and last frame's jitter, in render pixels. */
  readonly jitter: ArrayLike<number>;
  readonly previousJitter: ArrayLike<number>;
  readonly quality: ReconQuality;
  readonly disocclusion: DisocclusionParams;
  /**
   * Last frame's flicker records, output size, four floats a pixel — the spread, this period's
   * running sum, the last period's mean, and how many periods running repeated, as `Flicker` holds
   * them — or absent for the resolve without its anti-flicker.
   */
  readonly flicker?: ArrayLike<number> | null;
  /**
   * Last frame's depth swings, output size, one float a pixel: the largest miss, relative to the
   * depth, of last frame's depth against the one this pixel's surface should have had, seen lately
   * — held, and halving over a period. Carried with `flicker` and read only with it.
   */
  readonly depthSwing?: ArrayLike<number> | null;
  /** Whether this frame samples the first phase of the jitter's period. */
  readonly periodStart?: boolean;
  /** The jitter's period: the reconstruction's own phase count, not the temporal resolve's. */
  readonly flickerPhases?: number;
}

/**
 * How far a render sample's contribution reaches, in output pixels: a Gaussian's standard deviation.
 *
 * Just under half a pixel, so a sample on a pixel's centre counts fully and one a pixel away counts a
 * tenth — the width a reconstruction filter needs to avoid both aliasing and a soft picture.
 */
export const SAMPLE_SPREAD = 0.47;

/** A render sample's weight at `(dx, dy)` output pixels from an output pixel's centre. */
export function reconstructionWeight(dx: number, dy: number): number {
  return Math.exp(-(dx * dx + dy * dy) / (2 * SAMPLE_SPREAD * SAMPLE_SPREAD));
}

/**
 * How much gathered weight counts as knowing a pixel. Below it, the render's bicubic read fills in —
 * which is every pixel on the first frame at a large ratio, where the nearest sample can be most of a
 * pixel away.
 */
export const CONFIDENT_WEIGHT = 1;

/**
 * How many of its held depth swings a still pixel's depth test tolerates. The peak halves over a
 * period, so the frame before the next once-a-period miss holds just over half of it: tolerating
 * twice the peak passes that miss outright, and three leaves the same room again.
 */
export const DEPTH_SWING_WIDTH = 3;

const SAMPLE = new Float32Array(3);
const GATHERED = new Float64Array(3);
const HISTORY = new Float32Array(4);
const NEIGHBOURS = new Float64Array(27);
const LOW = new Float64Array(3);
const HIGH = new Float64Array(3);
const YCOCG = new Float64Array(3);
const CLIPPED = new Float64Array(3);
const MIXED = new Float64Array(3);
const WORLD = new Float64Array(3);
const RIGHT = new Float64Array(3);
const UP = new Float64Array(3);
const NORMAL = new Float64Array(3);
const PREVIOUS_NORMAL = new Float64Array(3);
const CLIP = new Float64Array(4);
/** The last frame's reprojection, derived once a frame rather than once a pixel. */
const REPROJECTION = new Float64Array(16);
let reprojected: ResolveFrame | null = null;

/** `frame.reprojection`, or the product of its two matrices, multiplied once per frame. */
function reprojectionOf(frame: ResolveFrame): ArrayLike<number> {
  if (frame.reprojection !== undefined) return frame.reprojection;
  if (reprojected !== frame) {
    reprojected = frame;
    const a = frame.previousViewProj;
    const b = frame.inverseViewProj;
    for (let c = 0; c < 4; c += 1) {
      for (let r = 0; r < 4; r += 1) {
        let sum = 0;
        for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
        REPROJECTION[c * 4 + r] = sum;
      }
    }
  }
  return REPROJECTION;
}
const HELD: Flicker = { spread: 0, sum: 0, mean: 0, repeated: 0 };
const CARRIED: Flicker = { spread: 0, sum: 0, mean: 0, repeated: 0 };
/** How far, in output pixels, the last `historyWeight` found its surface had moved. */
let moved = 0;
/** How far, relative, last frame's depth missed the one expected there; -1 where nothing was held. */
let missed = -1;
/** The rule for the last period asked for, kept: one is made per period, not per pixel. */
let rulePhases = 0;
let rule: FlickerRule = TEMPORAL_FLICKER;

function clampTexel(value: number, size: number): number {
  return value < 0 ? 0 : value >= size ? size - 1 : value;
}

/** A texel's world position from a depth image, at its unjittered uv. Returns the view depth, or 0. */
function worldAt(
  depths: ArrayLike<number>,
  inverse: ArrayLike<number>,
  jitter: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Float64Array,
): number {
  const tx = clampTexel(x, width);
  const ty = clampTexel(y, height);
  const u = (tx + 0.5 - (jitter[0] as number)) / width;
  const v = (ty + 0.5 - (jitter[1] as number)) / height;
  const z = depths[ty * width + tx] as number;
  if (!worldPositionFromDepth(inverse, u, v, z, out)) return 0;
  /* The view depth is the clip w, which the inverse's w is the reciprocal of. */
  const m = inverse;
  const w =
    (m[3] as number) * (u * 2 - 1) +
    (m[7] as number) * (v * 2 - 1) +
    (m[11] as number) * z +
    (m[15] as number);
  return 1 / w;
}

/**
 * A texel's view depth at its unjittered uv, or 0 — `worldAt` without the position, which is all a
 * search over depths needs: one row of the inverse rather than four. Zero off the picture, where
 * `worldAt` would clamp, because a neighbour that is not there is not a step.
 */
function viewDepthAt(
  depths: ArrayLike<number>,
  inverse: ArrayLike<number>,
  jitter: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  const u = (x + 0.5 - (jitter[0] as number)) / width;
  const v = (y + 0.5 - (jitter[1] as number)) / height;
  const m = inverse;
  const w =
    (m[3] as number) * (u * 2 - 1) +
    (m[7] as number) * (v * 2 - 1) +
    (m[11] as number) * (depths[y * width + x] as number) +
    (m[15] as number);
  return Math.abs(w) > 1e-12 ? 1 / w : 0;
}

/** What a texel's four neighbours say about its surface: see `planarity` and `surfaceSlope`. */
const SURFACE = { planar: 1, slope: 0 };

function surfaceAt(
  depths: ArrayLike<number>,
  inverse: ArrayLike<number>,
  jitter: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  centre: number,
): void {
  let planar = 1;
  let slope = 0;
  for (let axis = 0; axis < 2; axis += 1) {
    const ax = 1 - axis;
    const ay = axis;
    const after = viewDepthAt(depths, inverse, jitter, width, height, x + ax, y + ay);
    const before = viewDepthAt(depths, inverse, jitter, width, height, x - ax, y - ay);
    planar *= planarity(before, centre, after);
    slope = Math.max(slope, surfaceSlope(before, centre, after));
  }
  SURFACE.planar = planar;
  SURFACE.slope = slope;
}

/** The world normal at a texel, from its depth and its right and upper neighbours'. */
function normalAt(
  depths: ArrayLike<number>,
  inverse: ArrayLike<number>,
  jitter: ArrayLike<number>,
  eye: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Float64Array,
): boolean {
  if (worldAt(depths, inverse, jitter, width, height, x, y, WORLD) <= 0) return false;
  /* The neighbour on the inside of the border, so the edge texels have a normal too. */
  const dx = x + 1 < width ? 1 : -1;
  const dy = y + 1 < height ? 1 : -1;
  if (worldAt(depths, inverse, jitter, width, height, x + dx, y, RIGHT) <= 0) return false;
  if (worldAt(depths, inverse, jitter, width, height, x, y + dy, UP) <= 0) return false;
  return normalFromPositions(WORLD, RIGHT, UP, eye, out);
}

/**
 * The weight a pixel's history still deserves this frame: none on the first frame, where the surface
 * was behind last frame's eye or off its picture, and otherwise what it gathered, scaled by whether it
 * is the same surface. Reads `HISTORY`; writes the history's colour there.
 */
function historyWeight(
  frame: ResolveFrame,
  u: number,
  v: number,
  dx: number,
  dy: number,
  swing: number,
): number {
  missed = -1;
  if (!frame.hasHistory) return 0;
  const rw = frame.renderWidth;
  const rh = frame.renderHeight;
  const flagAt = (dy * rw + dx) * 4;
  let mu: number;
  let mv: number;
  let expected: number;
  if ((frame.motion[flagAt + 3] as number) > 0.5) {
    mu = frame.motion[flagAt] as number;
    mv = frame.motion[flagAt + 1] as number;
    expected = frame.motion[flagAt + 2] as number;
  } else {
    /*
     * **Through one matrix, last frame's view-projection times this frame's inverse**, rather than
     * out to a world position and back. The two are the same arithmetic in exact numbers; in single
     * precision the round trip is not the identity — a near plane a quarter of a metre from a far one
     * five kilometres off — and a still camera measured a few hundredths of a pixel of motion growing
     * out from the middle of the frame, which crept every still history and kept every pixel from
     * the anti-flicker's stillness. The product is taken where the precision is (`reprojection`),
     * and for a still camera it is the identity.
     */
    const du = (dx + 0.5 - (frame.jitter[0] as number)) / rw;
    const dv = (dy + 0.5 - (frame.jitter[1] as number)) / rh;
    const x = du * 2 - 1;
    const y = dv * 2 - 1;
    const z = frame.depth[dy * rw + dx] as number;
    const inverse = frame.inverseViewProj;
    /* The homogeneous w of the world position: none, or behind the eye, is no surface. */
    const hw =
      (inverse[3] as number) * x +
      (inverse[7] as number) * y +
      (inverse[11] as number) * z +
      (inverse[15] as number);
    if (!(hw > 1e-12)) return 0;
    const m = reprojectionOf(frame);
    for (let r = 0; r < 4; r += 1) {
      CLIP[r] =
        (m[r] as number) * x +
        (m[4 + r] as number) * y +
        (m[8 + r] as number) * z +
        (m[12 + r] as number);
    }
    /*
     * A surface behind last frame's eye has a w that is not positive: the disocclusion trusts no
     * such depth, so it needs no refusal of its own here.
     */
    expected = (CLIP[3] as number) / hw;
    mu = ((CLIP[0] as number) / (CLIP[3] as number)) * 0.5 + 0.5 - du;
    mv = ((CLIP[1] as number) / (CLIP[3] as number)) * 0.5 + 0.5 - dv;
  }

  moved = Math.hypot(mu * frame.outputWidth, mv * frame.outputHeight);
  const pu = u + mu;
  const pv = v + mv;
  if (!(pu >= 0 && pu <= 1 && pv >= 0 && pv <= 1)) return 0;
  sampleHistoryBicubic5(
    frame.history,
    pu * frame.outputWidth - 0.5,
    pv * frame.outputHeight - 0.5,
    frame.outputWidth,
    frame.outputHeight,
    4,
    HISTORY,
  );
  /*
   * **Last frame's depth is searched for this surface, around where the dilated texel was.** The
   * surface being judged is the dilated texel's, which beside an edge is a neighbour's, so judging
   * it by the texel under the pixel compares two surfaces: the side of every silhouette away from the
   * eye dropped its history on every frame of a still picture. And a new jitter samples a surface
   * somewhere else, so the nearest of last frame's nine is taken rather than the one the rounding
   * picks. What it gives up is a disocclusion narrower than a texel, which keeps a history that the
   * neighbourhood clip then bounds.
   */
  const su = (dx + 0.5 - (frame.jitter[0] as number)) / rw + mu;
  const sv = (dy + 0.5 - (frame.jitter[1] as number)) / rh + mv;
  const cx = clampTexel(Math.round(su * rw + (frame.previousJitter[0] as number) - 0.5), rw);
  const cy = clampTexel(Math.round(sv * rh + (frame.previousJitter[1] as number) - 0.5), rh);
  /*
   * The first texel looked at answers alone when it agrees within the tolerance, which it does
   * everywhere but at an edge: the depth test trusts it fully whichever texel would have won, so
   * only an edge pays for the other eight.
   */
  let held = viewDepthAt(
    frame.previousDepth,
    frame.previousInverseViewProj,
    frame.previousJitter,
    rw,
    rh,
    cx,
    cy,
  );
  let px = cx;
  let py = cy;
  if (!(held > 0 && Math.abs(held - expected) <= frame.disocclusion.depthTolerance * expected)) {
    held = 0;
    let nearest = Number.POSITIVE_INFINITY;
    for (let j = -1; j <= 1; j += 1) {
      for (let i = -1; i <= 1; i += 1) {
        const tx = clampTexel(cx + i, rw);
        const ty = clampTexel(cy + j, rh);
        const depth = viewDepthAt(
          frame.previousDepth,
          frame.previousInverseViewProj,
          frame.previousJitter,
          rw,
          rh,
          tx,
          ty,
        );
        if (!(depth > 0)) continue;
        const off = Math.abs(depth - expected);
        if (off < nearest) {
          nearest = off;
          held = depth;
          px = tx;
          py = ty;
        }
      }
    }
  }

  const here = viewDepthAt(frame.depth, frame.inverseViewProj, frame.jitter, rw, rh, dx, dy);
  surfaceAt(frame.depth, frame.inverseViewProj, frame.jitter, rw, rh, dx, dy, here);
  const slope = SURFACE.slope;
  let planar = SURFACE.planar;
  if (planar > 0) {
    surfaceAt(
      frame.previousDepth,
      frame.previousInverseViewProj,
      frame.previousJitter,
      rw,
      rh,
      px,
      py,
      held,
    );
    planar *= SURFACE.planar;
  }
  /* A normal has the say its planarity gives it; at an edge or a sliver, none, and none is computed. */
  let normalDot = 1;
  if (
    planar > 0 &&
    normalAt(frame.depth, frame.inverseViewProj, frame.jitter, frame.eye, rw, rh, dx, dy, NORMAL) &&
    normalAt(
      frame.previousDepth,
      frame.previousInverseViewProj,
      frame.previousJitter,
      frame.previousEye,
      rw,
      rh,
      px,
      py,
      PREVIOUS_NORMAL,
    )
  ) {
    const cosine =
      (NORMAL[0] as number) * (PREVIOUS_NORMAL[0] as number) +
      (NORMAL[1] as number) * (PREVIOUS_NORMAL[1] as number) +
      (NORMAL[2] as number) * (PREVIOUS_NORMAL[2] as number);
    normalDot = 1 - planar * (1 - cosine);
  }
  if (held > 0 && expected > 0) missed = Math.abs(held - expected) / expected;
  /* A still pixel's own depth swing, as wide as the anti-flicker's box: see the header. */
  const swung = swing > 0 ? DEPTH_SWING_WIDTH * swing * stillness(moved) : 0;
  const trust = disocclusionWeight(
    expected,
    held,
    Math.hypot(mu, mv),
    normalDot,
    frame.disocclusion,
    slope + swung,
  );
  return (HISTORY[3] as number) * trust;
}

/**
 * One output pixel: the history's next colour, before sharpening, and the weight it has gathered —
 * four values into `out` — and, where the frame carries records, the pixel's next one into `record`.
 */
export function resolvePixel(
  frame: ResolveFrame,
  ox: number,
  oy: number,
  out: Float32Array,
  record?: Float32Array,
  swingOut?: Float32Array,
): void {
  const rw = frame.renderWidth;
  const rh = frame.renderHeight;
  const ow = frame.outputWidth;
  const oh = frame.outputHeight;
  const u = (ox + 0.5) / ow;
  const v = (oy + 0.5) / oh;
  const jx = frame.jitter[0] as number;
  const jy = frame.jitter[1] as number;

  /* Where this frame observed the pixel, and the render read there for the gaps. */
  const rx = u * rw + jx - 0.5;
  const ry = v * rh + jy - 0.5;
  sampleHistoryBicubic5(frame.scene, rx, ry, rw, rh, 3, SAMPLE);
  const nx = clampTexel(Math.round(rx), rw);
  const ny = clampTexel(Math.round(ry), rh);

  /* 1 and 2. Each texel around: its weight, its colour in the box, and its depth. */
  let nearest = frame.depth[ny * rw + nx] as number;
  let dx = nx;
  let dy = ny;
  let gathered = 0;
  GATHERED.fill(0);
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const tx = clampTexel(nx + i, rw);
      const ty = clampTexel(ny + j, rh);
      const at = (ty * rw + tx) * 3;
      const r = frame.scene[at] as number;
      const g = frame.scene[at + 1] as number;
      const b = frame.scene[at + 2] as number;
      const weight = reconstructionWeight(
        ((tx + 0.5 - jx) / rw) * ow - (ox + 0.5),
        ((ty + 0.5 - jy) / rh) * oh - (oy + 0.5),
      );
      gathered += weight;
      GATHERED[0] = (GATHERED[0] as number) + r * weight;
      GATHERED[1] = (GATHERED[1] as number) + g * weight;
      GATHERED[2] = (GATHERED[2] as number) + b * weight;
      rgbToYCoCg(YCOCG, r, g, b);
      NEIGHBOURS.set(YCOCG, ((j + 1) * 3 + (i + 1)) * 3);
      const z = frame.depth[ty * rw + tx] as number;
      if (z < nearest) {
        nearest = z;
        dx = tx;
        dy = ty;
      }
    }
  }
  varianceBox(NEIGHBOURS, 9, frame.quality.clampGamma, LOW, HIGH);
  for (let c = 0; c < 3; c += 1) GATHERED[c] = (GATHERED[c] as number) / gathered;

  /* 3 and 4. The history, and the weight it still deserves. */
  const alpha = frame.quality.alpha;
  const records = frame.flicker;
  const anti = records !== undefined && records !== null;
  if (anti) {
    const phases = frame.flickerPhases ?? 0;
    if (phases !== rulePhases) {
      rulePhases = phases;
      rule = phases > 0 ? flickerRule(phases) : TEMPORAL_FLICKER;
    }
  }
  const swings = frame.depthSwing;
  const swing =
    anti && swings !== undefined && swings !== null ? (swings[oy * ow + ox] as number) : 0;
  const weight = historyWeight(frame, u, v, dx, dy, swing);
  let cap = (1 - alpha) / alpha;
  /* The anti-flicker: a proven pixel's box widened by its spread, and more of its history kept. */
  if (anti) {
    const sample =
      (GATHERED[0] as number) * 0.2126 +
      (GATHERED[1] as number) * 0.7152 +
      (GATHERED[2] as number) * 0.0722;
    const at = (oy * ow + ox) * 4;
    if (weight > 0) {
      HELD.spread = records[at] as number;
      HELD.sum = records[at + 1] as number;
      HELD.mean = records[at + 2] as number;
      HELD.repeated = records[at + 3] as number;
    } else {
      freshFlicker(HELD, sample, rule);
    }
    const still = weight > 0 ? stillness(moved) : 0;
    const widen = flickerWidening(HELD, sample, still, rule);
    for (let c = 0; c < 3; c += 1) {
      LOW[c] = (LOW[c] as number) - widen;
      HIGH[c] = (HIGH[c] as number) + widen;
    }
    const keep = flickerBlend(1 - alpha, HELD, sample, still, rule);
    cap = keep / (1 - keep);
    nextFlicker(CARRIED, HELD, sample, still, frame.periodStart === true, rule);
    if (record !== undefined) {
      record[0] = CARRIED.spread;
      record[1] = CARRIED.sum;
      record[2] = CARRIED.mean;
      record[3] = CARRIED.repeated;
    }
    /* The peak carried on, halving over a period, whatever the test said; none where nothing was
       held to miss. */
    if (swingOut !== undefined) {
      swingOut[0] = missed >= 0 ? Math.max(missed, swing * 0.5 ** rule.memory) : 0;
    }
  }
  const kept = Math.min(cap, weight);

  /* 5. Clipped, mixed by weight, and the gaps filled from the render. */
  const total = kept + gathered;
  if (kept > 0) {
    rgbToYCoCg(YCOCG, HISTORY[0] as number, HISTORY[1] as number, HISTORY[2] as number);
    clipToBox(CLIPPED, YCOCG, LOW, HIGH);
    yCoCgToRgb(YCOCG, CLIPPED[0] as number, CLIPPED[1] as number, CLIPPED[2] as number);
    accumulate(MIXED, GATHERED, YCOCG, 1, gathered / total);
  } else {
    MIXED.set(GATHERED);
  }
  const known = Math.min(1, total / CONFIDENT_WEIGHT);
  for (let c = 0; c < 3; c += 1) {
    out[c] = (SAMPLE[c] as number) * (1 - known) + (MIXED[c] as number) * known;
  }
  out[3] = total;
}

const TAP = new Float32Array(4);
const RECORD = new Float32Array(4);
const SWING = new Float32Array(1);
const CENTRE = new Float32Array(4);
const AROUND = new Float32Array(12);
const SHOWN = new Float32Array(3);
const OFFSETS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * The whole frame: the next history into `history`, four floats a pixel, and the picture shown into
 * `shown`, three — the history sharpened against the four direct neighbours it has just been given —
 * and, where the frame carries records, the next ones into `records`, four floats a pixel, and the
 * next depth swings into `swings`, one.
 */
export function resolveFrame(
  frame: ResolveFrame,
  history: Float32Array,
  shown: Float32Array,
  records?: Float32Array,
  swings?: Float32Array,
): void {
  const ow = frame.outputWidth;
  const oh = frame.outputHeight;
  for (let y = 0; y < oh; y += 1) {
    for (let x = 0; x < ow; x += 1) {
      resolvePixel(frame, x, y, TAP, RECORD, SWING);
      history.set(TAP, (y * ow + x) * 4);
      if (records !== undefined) records.set(RECORD, (y * ow + x) * 4);
      if (swings !== undefined) swings[y * ow + x] = SWING[0] as number;
    }
  }
  for (let y = 0; y < oh; y += 1) {
    for (let x = 0; x < ow; x += 1) {
      sampleBilinear(history, x, y, ow, oh, 4, CENTRE);
      for (let n = 0; n < 4; n += 1) {
        const offset = OFFSETS[n] as readonly [number, number];
        sampleBilinear(history, x + offset[0], y + offset[1], ow, oh, 4, TAP);
        AROUND.set(TAP.subarray(0, 3), n * 3);
      }
      sharpen(SHOWN, CENTRE, AROUND, frame.quality.sharpen);
      shown.set(SHOWN, (y * ow + x) * 3);
    }
  }
}
