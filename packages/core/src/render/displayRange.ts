/**
 * Which dynamic range the frame goes out in, and why: the one decision behind
 * `RenderQuality.highDynamicRange`, made here so both backends answer it in the same words.
 *
 * **A high range is asked for, found, and held, or it is not had.** Three things must all be true:
 * the profile asked; the frame has a composite holding light past white (`screenEffects` and
 * `hdrScene`), since every other pass writes display values already clipped; and the display says
 * it can show more than paper white. The backend then has to be able to configure such a canvas,
 * which only it knows, and it may still answer standard after this says high.
 *
 * **What a high range gives up** is nothing a standard frame had: paper white stays where it is,
 * and only what was above it — a lamp, a flash, a sunlit edge — goes on rising to the display's
 * peak instead of rolling off at white. **What would make it wrong** is a display that reports a
 * high range it cannot show, which a page cannot detect and the platform owns.
 */

export type DisplayRange = 'high' | 'standard';

export interface DisplayRangeChoice {
  readonly range: DisplayRange;
  /** A sentence saying why, for `RendererApi.displayRangeReason`. */
  readonly reason: string;
}

/** The display's own answer, as the browser gives it. A host without a DOM supplies its own. */
export function browserHighDynamicRange(): boolean {
  // platform: browser default — `CreateRendererOptions.highDynamicRangeDisplay` replaces it
  return typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches;
}

/** The range a profile gets on a display, before the backend has tried to configure it. */
export function chooseDisplayRange(
  asked: boolean,
  composite: boolean,
  displayIsHigh: boolean,
): DisplayRangeChoice {
  if (!asked) return { range: 'standard', reason: 'highDynamicRange was not asked for' };
  if (!composite) {
    return {
      range: 'standard',
      reason:
        'highDynamicRange needs screenEffects and hdrScene: without a composite holding light ' +
        'past white, every pass writes values already clipped to it',
    };
  }
  if (!displayIsHigh) {
    return { range: 'standard', reason: 'the display reports a standard dynamic range' };
  }
  return { range: 'high', reason: 'an extended-range canvas on a high dynamic range display' };
}

/**
 * The display's peak over the frame's paper white, as `setDisplayLuminance` is handed it: at
 * least 1, and 1 where the range is standard or a number is not one. Capped at 64, a thousand nits
 * over a sixteen-nit white, which no display reaches and no curve should be asked to.
 */
export function displayHeadroom(range: DisplayRange, paperWhite: number, peak: number): number {
  if (range !== 'high') return 1;
  const ratio = peak / paperWhite;
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 1), 64) : 1;
}
