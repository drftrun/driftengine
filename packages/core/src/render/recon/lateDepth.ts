/**
 * The depth a reconstructing frame's late draws are tested against at an output pixel, taken from
 * the render's jittered depth. `shaders/recon/lateDepth.wgsl.ts` is the same arithmetic on the device.
 *
 * **Each surface taken to the pixel, and the nearest of them.** A late draw — a glow, a pane, a
 * caption — is drawn unjittered at the output size, and it has to meet the depth of what it lies on
 * where *it* is. Each of the four render texels about the pixel, placed where the jitter put it,
 * carries its surface on to the pixel's unjittered centre along that surface's own slope; the
 * nearest of the four so carried stands, and a quarter of its slope is given back toward the far
 * side so that a draw lying exactly on the surface is not decided by rounding. On a plane all four
 * arrive at the plane's own depth at the pixel: exact, and the same whatever the jitter was.
 *
 * **A texel's slope is the smaller of its two differences along each axis, and none where they
 * disagree in sign** — the minmod limiter. Beside an edge one difference is the jump, so it is the
 * other, the surface's own, that is taken; a sliver one texel wide disagrees both ways and keeps its
 * own depth, the nearest of the four as before. So a translucent draw still never comes through an
 * opaque edge the render covered by more than the render's own texel.
 *
 * **Why this replaced the nearest of the four.** On a wall seen aslant the nearest of four neighbours
 * stands up to a texel's step in front of the wall at the pixel, so a glow lying a few centimetres
 * proud of it was judged behind the wall; and which neighbour was nearest moved with the jitter, so
 * the glow was drawn one frame and not the next. Measured on a street of lit facades: every strip of
 * glow on every tower flickered frame by frame, 12,415 pixels of one tower between two frames.
 *
 * What it gives up: a surface curving within a texel is carried on as a plane, which a quarter-step
 * tolerance covers. What would make it wrong is depth that is not affine on a plane — a depth written
 * from the fragment stage — which nothing drawn before the late pass writes.
 */
import { REVERSED_DEPTH } from '../depthConvention.ts';

/** The share of a surface's slope given back toward the far side, for a draw lying on it. */
const TOLERANCE_SHARE = 0.25;

/** The smaller of two differences, or none where they disagree in sign. */
function minmod(a: number, b: number): number {
  if (a * b <= 0) return 0;
  return Math.abs(a) < Math.abs(b) ? a : b;
}

/**
 * Where output pixel (`outX`, `outY`) — its centre, in pixels — falls among the render texels
 * jittered by (`jitterX`, `jitterY`) render texels: into `out`, the cell's first texel and the
 * fraction across it, `[x, y, fx, fy]`.
 */
export function lateDepthCell(
  outX: number,
  outY: number,
  renderWidth: number,
  renderHeight: number,
  outputWidth: number,
  outputHeight: number,
  jitterX: number,
  jitterY: number,
  out: Float64Array | Float32Array,
): void {
  /* A texel stands at its index plus a half less the jitter, as the resolve places it. */
  const x = (outX * renderWidth) / outputWidth - 0.5 + jitterX;
  const y = (outY * renderHeight) / outputHeight - 0.5 + jitterY;
  out[0] = Math.floor(x);
  out[1] = Math.floor(y);
  out[2] = x - Math.floor(x);
  out[3] = y - Math.floor(y);
}

/**
 * The depth to test against, from `taps` — a 4x4 block of render texels, row-major, starting one
 * texel up and left of the cell's first — at (`fx`, `fy`) across the cell.
 */
export function lateDepthAt(taps: ArrayLike<number>, fx: number, fy: number): number {
  const t = (x: number, y: number): number => taps[(y + 1) * 4 + x + 1] as number;
  let depth = REVERSED_DEPTH ? -Infinity : Infinity;
  for (let oy = 0; oy < 2; oy += 1) {
    for (let ox = 0; ox < 2; ox += 1) {
      const d = t(ox, oy);
      const gx = minmod(t(ox + 1, oy) - d, d - t(ox - 1, oy));
      const gy = minmod(t(ox, oy + 1) - d, d - t(ox, oy - 1));
      const carried = d + gx * (fx - ox) + gy * (fy - oy);
      const give = TOLERANCE_SHARE * Math.max(Math.abs(gx), Math.abs(gy));
      depth = REVERSED_DEPTH ? Math.max(depth, carried - give) : Math.min(depth, carried + give);
    }
  }
  return depth;
}
