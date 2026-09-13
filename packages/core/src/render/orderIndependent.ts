/**
 * Order-independent transparency: the arithmetic, so it can be asserted without a device.
 *
 * **Two panes of glass should not depend on which was submitted first.** Sorted alpha blending is
 * order-dependent by construction — `over` does not commute — so a translucent set is drawn back to
 * front and anything the sort cannot separate flickers or wins arbitrarily: two panes that
 * intersect, a pane containing another, a pane and the smoke inside it. A consumer's answer is
 * usually to sort harder, which cannot fix an intersection at all.
 *
 * **Weighted blending replaces the ordering with a sum.** Each fragment contributes its colour
 * scaled by a weight that falls off with distance, and separately multiplies a running
 * transmittance. A sum and a product both commute, so the frame does not depend on the order the
 * fragments arrived in — which is the property the census row asks for, and it is asserted here
 * against numbers rather than argued about.
 *
 * **It is an approximation of the ordering and exact for one layer**, which is the honest way to
 * state what it buys: with a single translucent surface there is no ordering to approximate and
 * this reproduces `over` precisely, and the test beside it pins that. With several, near layers
 * count for more than far ones and the result is plausible rather than correct — which is what a
 * pane of glass needs and what a stained-glass window with eight overlapping leaves does not.
 *
 * McGuire and Bavoil, *Weighted Blended Order-Independent Transparency*, JCGT 2013 — equation 9
 * for the weight, and its recommended constants, which are what the clamps below are.
 *
 * The one thing here that is not arithmetic is `OIT_MULTISAMPLE_REFUSAL`, and it is here for the
 * same reason: it is a decision both backends take, so it is written once where neither owns it.
 */

/** A colour the accumulation is working on, as three numbers rather than a texture fetch. */
export type Rgb = readonly [number, number, number];

/**
 * What the two targets hold between them.
 *
 * `accum` is the weighted sum of premultiplied colour with the weighted alpha in its fourth
 * channel; `reveal` is the running product of what each layer let through. On a GPU these are two
 * render targets with two blend states — additive for one, multiplicative for the other — and this
 * object is the same numbers on the CPU so the algebra has somewhere to be tested.
 */
export interface OitAccumulator {
  accum: [number, number, number, number];
  /** One is "nothing has covered this pixel yet", which is why it is not zero. */
  reveal: number;
}

/** An empty pixel: nothing accumulated, everything still revealed. */
export function newOitAccumulator(): OitAccumulator {
  return { accum: [0, 0, 0, 0], reveal: 1 };
}

/**
 * How much a fragment at `viewDepth` metres and this alpha counts for.
 *
 * **A near fragment must count for more than a far one**, or the accumulation is an unweighted
 * average: a pane thirty metres away would contribute as much as one against the camera, which
 * reads as fog rather than as glass.
 *
 * **Clamped at both ends, and the clamp is what keeps this stable in float.** Without a ceiling a
 * fragment on the near plane takes a weight large enough to swamp every other layer, and their
 * contributions are then lost to rounding inside a 16-bit target; without a floor a distant one
 * rounds to nothing and vanishes rather than fading.
 */
export function oitWeight(viewDepth: number, alpha: number): number {
  const z = Math.max(0, viewDepth) / 200;
  const falloff = 0.03 / (1e-5 + z * z * z * z);
  return alpha * Math.min(3e3, Math.max(1e-2, falloff));
}

/**
 * Fold one fragment in.
 *
 * **A sum and a product, which is the whole mechanism**: both commute, so the pixel does not
 * depend on the order its fragments arrived in. A change that made either depend on order — an
 * `if` on what is already there, a max instead of a sum — breaks the row this exists to close, and
 * the test beside this fails before it reaches a GPU.
 */
export function accumulateOit(
  state: OitAccumulator,
  colour: Rgb,
  alpha: number,
  viewDepth: number,
): void {
  const w = oitWeight(viewDepth, alpha);
  state.accum[0] += colour[0] * alpha * w;
  state.accum[1] += colour[1] * alpha * w;
  state.accum[2] += colour[2] * alpha * w;
  state.accum[3] += alpha * w;
  state.reveal *= 1 - alpha;
}

/**
 * The two targets composited over what is behind them.
 *
 * The weighted sum divided by the weighted alpha is the average colour the layers make; `reveal`
 * says how much of the background still shows through. For one layer that reduces exactly to
 * `colour * alpha + background * (1 - alpha)`, which is `over` — the anchor the test asserts.
 */
export function resolveOit(state: OitAccumulator, background: Rgb): [number, number, number] {
  /* Guarded because a pixel no fragment touched has a weighted alpha of zero, and the reveal of
     one below then discards whatever this produced anyway. */
  const weight = Math.max(state.accum[3], 1e-5);
  const average: [number, number, number] = [
    state.accum[0] / weight,
    state.accum[1] / weight,
    state.accum[2] / weight,
  ];
  const covered = 1 - state.reveal;
  return [
    average[0] * covered + background[0] * state.reveal,
    average[1] * covered + background[1] * state.reveal,
    average[2] * covered + background[2] * state.reveal,
  ];
}

/**
 * What both backends say when a profile asks for this and multisampling excludes it.
 *
 * **One string rather than one per backend, and that is rule 1 of the parity hard rule**:
 * decisions live in backend-neutral code and only the binding is per-backend. The engine already
 * paid for the other arrangement — `compositeWantsDepth` was two copies of one expression, depth
 * of field was added to one of them, and the effect then ran against a discarded attachment. A
 * refusal is a smaller thing than a depth attachment and drifts exactly as easily: the decal and
 * reflection refusals beside this one are duplicated literals whose two halves have to be diffed
 * by eye to know they still agree.
 *
 * **Why the effect is excluded rather than degraded.** Both passes attach the scene target's own
 * depth and test against it, and above one sample the frame is not drawn into that texture — it
 * is drawn into a multisampled renderbuffer, and the texture receives a copy at the end of the
 * frame if anything asked for one. So the panes would be rejected against the frame before, or
 * against a texture nothing has ever written.
 */
export const OIT_MULTISAMPLE_REFUSAL =
  "driftengine: order-independent transparency attaches the scene target's own depth and tests " +
  'against it, and a multisampled frame is not drawn into that texture — so translucent draws ' +
  'stay sorted and blended wherever `sceneSamples` is above one. Antialiasing and this effect ' +
  'are a choice of one.';
