/**
 * The forward grade on the CPU: what `applyOutputTransform` in `shaders/outputTransform.ts` does to
 * a colour, for a colour no shader draws — a clear colour, written to a target before any pass runs.
 *
 * **Why a clear colour is graded at all.** Every pass grades what it draws when nothing after it
 * will, so a colour handed to the renderer means one thing wherever it lands: linear light. A clear
 * left as it was given is the one colour in the frame read as a display value, so a scene whose fog
 * fades to its background colour fades to a different colour than the background it meets; with
 * `hdrScene` the resolve grades the clear with everything else, and a frame without it has to agree.
 *
 * **A second copy of the curve, and what holds the two together** is the hand-derived values in
 * `gradeColor.test.ts`, the same ones the shader's own constants give: the sRGB encode's two
 * segments, the ACES fit through its two matrices, and the highlight shoulder. Code 4, the filmic
 * curve, is the composite's alone, so a forward code never carries it (`forwardTransformCode`).
 */
import type { Vec3 } from '../math/color.ts';

/* Columns as the shader's `mat3` reads them, written here as rows of the product. */
const IN_R = [0.59719, 0.35458, 0.04823];
const IN_G = [0.076, 0.90834, 0.01566];
const IN_B = [0.0284, 0.13383, 0.83777];
const OUT_R = [1.60475, -0.53108, -0.07367];
const OUT_G = [-0.10208, 1.10813, -0.00605];
const OUT_B = [-0.00327, -0.07276, 1.07602];

/**
 * `color` graded by forward code `code` at `exposure` into `out`, which may be `color`: 0 leaves it
 * as it is, 1 encodes it as sRGB, 2 runs ACES first and 3 the highlight shoulder. Allocates nothing.
 */
export function gradeColorInto(
  code: number,
  exposure: number,
  color: Readonly<Vec3>,
  out: Vec3,
): Vec3 {
  let r = color[0];
  let g = color[1];
  let b = color[2];
  if (code === 0) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }
  if (code === 2) {
    const x = r * exposure;
    const y = g * exposure;
    const z = b * exposure;
    const ir = fit(dot(IN_R, x, y, z));
    const ig = fit(dot(IN_G, x, y, z));
    const ib = fit(dot(IN_B, x, y, z));
    r = clamp01(dot(OUT_R, ir, ig, ib));
    g = clamp01(dot(OUT_G, ir, ig, ib));
    b = clamp01(dot(OUT_B, ir, ig, ib));
  } else if (code === 3) {
    r *= exposure;
    g *= exposure;
    b *= exposure;
    const m = Math.max(r, g, b);
    if (m > 0.8) {
      const e = m - 0.8;
      const k = (0.8 + (0.2 * e) / (e + 0.2)) / m;
      r *= k;
      g *= k;
      b *= k;
    }
  }
  out[0] = encode(r);
  out[1] = encode(g);
  out[2] = encode(b);
  return out;
}

function dot(row: readonly number[], x: number, y: number, z: number): number {
  return (row[0] as number) * x + (row[1] as number) * y + (row[2] as number) * z;
}

/** The RRT and ODT fit, `rrtAndOdtFit` in the shader. */
function fit(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

/** Linear to sRGB, the piecewise form the shader uses. */
function encode(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
