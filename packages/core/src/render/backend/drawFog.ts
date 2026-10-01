/**
 * How a draw meets the medium between it and the eye: the value of the mesh shader's
 * `uFogEnabled`, which both backends write from this one rule.
 *
 * **A surface recedes into the medium; light added to the frame fades in it.** A surface that
 * covers what is behind it is mixed toward the medium's colour with distance, which is the haze
 * standing in front of it. An additive draw covers nothing: what is behind it has already been
 * fogged, and mixing the draw toward the medium's colour and then *adding* it puts that haze into
 * the frame a second time. So a glow by day added the sky's grey in the shape of the glow, and
 * added more of it the thicker the air — reported as solid grey cones under every street lamp on
 * a hazy morning. Faded instead, added light loses what the medium scatters out of it and adds
 * nothing of its own, which is how the same shader already treats the glow behind frosted glass.
 *
 * What fading gives up is the one thing mixing did for a glow: at great distance it disappears
 * into the air instead of greying into it. That is what light in fog does. What would make it
 * wrong is an additive draw standing for *lit air* rather than light — and that is what
 * `drawLightVolume` is for, which is fogged by neither rule.
 */

/** Out of the medium entirely: `TranslucentMeshOptions.fog` set to false. */
export const FOG_OFF = 0;
/** Mixed toward the medium's colour with distance: every surface, and the pass's default. */
export const FOG_RECEDE = 1;
/** Scaled down by what the medium scatters and given none of its colour: added light. */
export const FOG_FADE = 2;

/** The medium rule for a draw that asked for fog or not, and adds its light or covers. */
export function fogModeOf(fog: boolean, additive: boolean): number {
  if (!fog) return FOG_OFF;
  return additive ? FOG_FADE : FOG_RECEDE;
}
