/**
 * Overlapping style runs, normalised into disjoint ones that cover every character once.
 *
 * **The normalisation is the whole job.** A syntax highlighter emits overlapping runs — a rule for
 * the string, a more specific one for the escape inside it — and a renderer needs disjoint runs in
 * order with no gaps. Every consumer that skips this step draws a character twice or not at all,
 * and both look like a font problem.
 *
 * **Later wins the overlap**, because a later rule is the more specific one in every highlighter
 * that emits them in that order.
 */
export interface TextRun {
  from: number;
  to: number;
  colour: number;
  bold: boolean;
  italic: boolean;
}

/* Reused across calls: this runs per frame for a visible document. */
const BOUNDS: number[] = [];

/**
 * Fill `out` with disjoint, ordered, gap-free runs covering `[0, text.length)`.
 *
 * Returns how many were written. With no input runs the answer is one run covering everything,
 * which is what a plain string is.
 */
export function runsFor(text: string, runs: readonly TextRun[], out: TextRun[]): number {
  const end = text.length;
  if (end === 0) return 0;

  BOUNDS.length = 0;
  BOUNDS.push(0, end);
  for (const run of runs) {
    const from = Math.max(0, Math.min(end, run.from));
    const to = Math.max(0, Math.min(end, run.to));
    if (to > from) BOUNDS.push(from, to);
  }
  BOUNDS.sort((a, b) => a - b);

  let count = 0;
  let previous = -1;
  for (let i = 0; i < BOUNDS.length - 1; i += 1) {
    const from = BOUNDS[i] as number;
    const to = BOUNDS[i + 1] as number;
    if (from === to || from === previous) continue;
    previous = from;

    /* Last covering run wins; none covering means the default, which is what index -1 encodes. */
    let chosen = -1;
    for (let r = 0; r < runs.length; r += 1) {
      const run = runs[r] as TextRun;
      if (run.from <= from && run.to >= to) chosen = r;
    }
    const style = chosen === -1 ? null : (runs[chosen] as TextRun);

    const slot = out[count] ?? { from: 0, to: 0, colour: 0xffffffff, bold: false, italic: false };
    slot.from = from;
    slot.to = to;
    slot.colour = style?.colour ?? 0xffffffff;
    slot.bold = style?.bold ?? false;
    slot.italic = style?.italic ?? false;
    out[count] = slot;
    count += 1;
  }
  out.length = count;
  return count;
}
