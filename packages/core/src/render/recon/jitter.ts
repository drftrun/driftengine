/**
 * The sub-pixel sequence a frame is rasterised along, for the temporal resolve and for
 * reconstruction.
 *
 * **One sequence, two consumers.** `temporalAa.ts` jitters a frame at its output size along eight
 * phases; DriftTR jitters a frame rendered below its output size, and needs more phases for the
 * same reason a smaller render needs more frames to cover the output — each render pixel stands
 * for several output pixels, and the sequence has to visit each of their positions before it
 * repeats. The eight-phase sequence is the numbers the temporal resolve always used, so its
 * captures do not move.
 *
 * **What is reused rather than rebuilt**, from `temporalAa.ts`: Halton in bases two and three, each
 * period centred on its own mean, and `jitterProjection`, which puts the offset into clip space
 * rather than into the projection's third column. See that function for why the third column is
 * wrong for the combined view-projection this engine draws with.
 */

/**
 * The radical inverse of `index` in `base`: the digits of `index` mirrored about the point.
 *
 * Consecutive indices land as far from each other as the base allows, which is what lets eight of
 * them cover a pixel evenly where eight random ones leave holes and pairs.
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1;
  let i = index;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

/* One table a phase count, built once: x then y a phase. */
const TABLES = new Map<number, Float64Array>();

/**
 * The period's offsets, centred so they sum to zero.
 *
 * **Halton's own mean is not the middle of the pixel** — eight points in base two average 57/128 —
 * and accumulating towards an off-centre mean resolves to a picture displaced from the depth
 * buffer it is tested against and from every pass that did not jitter. Subtracting the period's
 * own mean costs nothing and makes the property exact.
 */
export function jitterTable(phases: number): Float64Array {
  const count = Math.max(1, Math.floor(phases));
  let table = TABLES.get(count);
  if (table !== undefined) return table;
  table = new Float64Array(count * 2);
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < count; i += 1) {
    table[i * 2] = halton(i + 1, 2);
    table[i * 2 + 1] = halton(i + 1, 3);
    meanX += table[i * 2] as number;
    meanY += table[i * 2 + 1] as number;
  }
  meanX /= count;
  meanY /= count;
  for (let i = 0; i < count; i += 1) {
    table[i * 2] = (table[i * 2] as number) - meanX;
    table[i * 2 + 1] = (table[i * 2 + 1] as number) - meanY;
  }
  TABLES.set(count, table);
  return table;
}

/**
 * Where in its pixel frame `frame` samples, in pixels and centred on zero, on a sequence of
 * `phases` positions. Written into `out`, two floats.
 */
export function jitterOffset(frame: number, phases: number, out: Float32Array): void {
  const table = jitterTable(phases);
  const count = table.length / 2;
  const at = ((frame % count) + count) % count;
  out[0] = table[at * 2] as number;
  out[1] = table[at * 2 + 1] as number;
}

/** The temporal resolve's own count, and the fewest a reconstruction takes. */
const BASE_PHASES = 8;

/**
 * How many phases a reconstruction from `renderWidth` to `outputWidth` takes: eight for every
 * output pixel one render pixel covers, rounded up — and eight where the render is not smaller.
 *
 * The count the published temporal upscalers use, and the reason is coverage rather than taste: a
 * render pixel two thirds of an output pixel wide stands for 2.25 output pixels, and eight positions
 * an output pixel is what the temporal resolve already found enough.
 */
export function reconJitterPhases(renderWidth: number, outputWidth: number): number {
  if (!(renderWidth > 0) || !(outputWidth > renderWidth)) return BASE_PHASES;
  const ratio = outputWidth / renderWidth;
  return Math.ceil(BASE_PHASES * ratio * ratio);
}

/**
 * `source` moved in clip space by `jitter`, which is what a contributed pass does with the frame's
 * jitter (`PrepareContext.jitter`) to draw where the renderer's own verbs drew this frame.
 *
 * **In the camera's own convention, before any correction**: `jitter` is a fraction of the clip
 * square, x rightward and y upward as `mat4.perspective` has them, so the matrix it applies to is
 * the one the consumer built — a pass then multiplies by `clipCorrection` or `depthCorrection`
 * exactly as it would have, and the offset arrives on screen where the renderer's did. Scaled by w,
 * as `jitterProjection` is, so it is a constant screen offset at every depth.
 *
 * **A zero jitter leaves a finite matrix bit for bit** — each term gains a zero — so a frame that is
 * not reconstructed draws exactly what it drew before this existed.
 */
export function jitterClip(
  out: Float32Array,
  source: ArrayLike<number>,
  jitter: ArrayLike<number>,
): Float32Array {
  for (let i = 0; i < 16; i += 1) out[i] = source[i] as number;
  const x = jitter[0] as number;
  const y = jitter[1] as number;
  for (let column = 0; column < 4; column += 1) {
    const w = source[column * 4 + 3] as number;
    out[column * 4] = (out[column * 4] as number) + x * w;
    out[column * 4 + 1] = (out[column * 4 + 1] as number) + y * w;
  }
  return out;
}
