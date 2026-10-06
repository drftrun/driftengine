/**
 * Reflections traced through the frame's own materials: `RenderQuality.screenSpaceReflections`.
 *
 * **Every opaque lit surface reflects the frame by its own material**, where `ReflectiveSurface`
 * reflects it by a box's: the lit stage leaves, per pixel, how much of the environment it showed and
 * at what roughness (`shaders/flat/reflectionSurface.ts`), and a ray marched against the frame's
 * depth swaps that share for what it finds — so a glossy panel mirrors the figures on it and the
 * matte panel beside it barely does, in one mesh with one material map. Past `maxRoughness` a
 * surface keeps the probes' reflection alone, which is what a march cannot do better than: a rough
 * lobe wants many rays, and one ray blurred is only a fair stand-in for a narrow one.
 *
 * **What a surface reflects is what the lit stage already reflected**: a metal by its metalness, a
 * dielectric where `setSurfaceReflectivity` or its material asks for one. A surface that reflects
 * no environment reflects no frame either, which is what keeps the two from disagreeing.
 */

/** How the frame's materials reflect it. Every field optional; see `DEFAULT_FRAME_REFLECTIONS`. */
export interface FrameReflections {
  /** The roughness past which a surface reflects the probes alone, faded over the last quarter. */
  readonly maxRoughness?: number;
  /** How far a ray travels before it gives up, in metres. */
  readonly reachM?: number;
  /** How deep a depth sample is believed to be, in metres. See `ScreenSpaceMarch.thicknessM`. */
  readonly thicknessM?: number;
  /** Samples along a ray, at most 32. */
  readonly steps?: number;
  /** How far a fully rough reflection is smeared, as a share of the frame's height. */
  readonly blur?: number;
}

export type ResolvedFrameReflections = Required<FrameReflections>;

/** The march `ReflectiveSurface` defaults to, a ceiling at satin, and a smear of 3% of the frame. */
export const DEFAULT_FRAME_REFLECTIONS: ResolvedFrameReflections = Object.freeze({
  maxRoughness: 0.6,
  reachM: 8,
  thicknessM: 0.25,
  steps: 24,
  blur: 0.03,
});

const finite = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

/**
 * The option as the renderers read it: null where it is off, and every number held where the
 * shader can use it — a ceiling above zero, a reach and a thickness above zero, a whole number of
 * steps from 1 to 32, and a blur from none to a fifth of the frame. Clamped rather than refused,
 * since a quality option is read at construction and a renderer that threw there would draw nothing.
 */
export function resolveFrameReflections(
  asked: boolean | FrameReflections | undefined,
): ResolvedFrameReflections | null {
  if (asked === undefined || asked === false) return null;
  const given = asked === true ? {} : asked;
  const d = DEFAULT_FRAME_REFLECTIONS;
  return {
    maxRoughness: Math.min(Math.max(finite(given.maxRoughness, d.maxRoughness), 0.01), 1),
    reachM: Math.max(finite(given.reachM, d.reachM), 0.01),
    thicknessM: Math.max(finite(given.thicknessM, d.thicknessM), 0.001),
    steps: Math.min(Math.max(Math.round(finite(given.steps, d.steps)), 1), 32),
    blur: Math.min(Math.max(finite(given.blur, d.blur), 0), 0.2),
  };
}

/** What a renderer says once where the frame cannot carry these reflections, and why. */
export function frameReflectionsRefused(reason: string): string {
  return (
    `screenSpaceReflections is not drawn: ${reason}. Surfaces keep the probes' reflection; ` +
    'the trace needs `screenEffects` and `hdrScene`, and a frame of one sample.'
  );
}
