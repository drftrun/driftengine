/**
 * OWLv2's answer to a set of text queries, on the host: the image graph's patches and the text
 * graph's queries joined into a logit a patch and query, and those into boxes.
 *
 * **The logit is the upstream class head's**: the class embedding and the query each divided by
 * their length plus 10⁻⁶ — the query already once divided by its length alone, as the upstream's
 * model normalises it before the head does again — their dot product, plus the patch's shift, times
 * one plus the ELU of its scale. Every step is rounded to single precision where the upstream's is,
 * with sums taken in double.
 *
 * **A detection is the upstream's post-processing**: each patch's best query, kept when the
 * logistic of its logit is above the threshold, its box turned from centre and size to corners and
 * scaled by the image's longer side — the side of the square the image was padded to, since
 * padding goes after the image's end.
 */
import { exactExp } from '@driftengine/core';

const f = Math.fround;
const APART = f(1e-6);

export interface Owlv2Patches {
  /** `[cells, projection]`. */
  readonly classes: Float32Array;
  /** `[cells]`. */
  readonly shift: Float32Array;
  /** `[cells]`, before the ELU. */
  readonly scale: Float32Array;
}

export interface Owlv2Detection {
  /** The query it answers. */
  readonly label: number;
  readonly score: number;
  /** Left, top, right and bottom, in the original image's pixels. */
  readonly box: readonly [number, number, number, number];
}

/* Each row of `values` divided by its length (plus `apart`), in place, as the upstream rounds it. */
function normalise(values: Float32Array, width: number, apart: number): void {
  for (let at = 0; at < values.length; at += width) {
    let sum = 0;
    for (let i = 0; i < width; i += 1)
      sum += (values[at + i] as number) * (values[at + i] as number);
    const length = f(f(Math.sqrt(sum)) + apart);
    for (let i = 0; i < width; i += 1) values[at + i] = f((values[at + i] as number) / length);
  }
}

/**
 * `out`, `[cells, count]`: every patch's logit for every one of `count` queries, `[count, width]`
 * as the text graph answers them.
 */
export function owlv2Logits(
  patches: Owlv2Patches,
  queries: Float32Array,
  count: number,
  out: Float32Array,
): void {
  const width = queries.length / count;
  const cells = patches.shift.length;
  const query = Float32Array.from(queries);
  normalise(query, width, 0);
  normalise(query, width, APART);
  const classes = Float32Array.from(patches.classes);
  normalise(classes, width, APART);
  for (let cell = 0; cell < cells; cell += 1) {
    const raw = patches.scale[cell] as number;
    const scale = f((raw > 0 ? raw : f(exactExp(raw) - 1)) + 1);
    const shift = patches.shift[cell] as number;
    for (let q = 0; q < count; q += 1) {
      let dot = 0;
      for (let i = 0; i < width; i += 1) {
        dot += (classes[cell * width + i] as number) * (query[q * width + i] as number);
      }
      out[cell * count + q] = f(f(f(dot) + shift) * scale);
    }
  }
}

/**
 * The detections above `threshold` among `logits`, `[cells, count]`, with `boxes`, `[cells, 4]` as
 * the image graph answers them, for an original image of `height` by `width`.
 */
export function owlv2Detections(
  logits: Float32Array,
  boxes: Float32Array,
  count: number,
  threshold: number,
  height: number,
  width: number,
): Owlv2Detection[] {
  const side = Math.max(height, width);
  const found: Owlv2Detection[] = [];
  for (let cell = 0; cell < boxes.length / 4; cell += 1) {
    let label = 0;
    for (let q = 1; q < count; q += 1) {
      if ((logits[cell * count + q] as number) > (logits[cell * count + label] as number))
        label = q;
    }
    const score = f(1 / (1 + exactExp(-(logits[cell * count + label] as number))));
    if (!(score > threshold)) continue;
    const corner = (centre: number, extent: number, sign: number): number =>
      f(
        f(
          (boxes[cell * 4 + centre] as number) +
            sign * f(0.5 * (boxes[cell * 4 + extent] as number)),
        ) * side,
      );
    found.push({
      label,
      score,
      box: [corner(0, 2, -1), corner(1, 3, -1), corner(0, 2, 1), corner(1, 3, 1)],
    });
  }
  return found;
}
