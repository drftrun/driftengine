/**
 * The district's day, over the city scene's sky (`sprawl/sky.ts`): the same sun, moon and night,
 * and a day made for a neon city rather than for that scene's reference.
 *
 * **What it changes, against that reference's day**: a warmer, stronger sun, so what the sun
 * reaches is gold; a sky light as strong as the reference's but bluer, so what it does not reach is
 * a cool shade with its colour still in it — set lower, a street's shaded side went to black and
 * the whole skyline with it; a deeper teal sky; two thirds of the haze, in the sky's own pale blue, so a street a block away is
 * clear and the far towers go pale into it, as a city's air takes them — at a third of it they stood
 * black against the sky; and the signs keep most of their glow at noon, because a
 * billboard is lit by day too.
 *
 * What it gives up: the reference's own colours, which the city scene still draws. What would make
 * it wrong is a midday that clips every pale wall in the sun, which the grade's highlight end is
 * the first thing to look at.
 */
import type { SkyLook } from '../sprawl/sky';

export const DISTRICT_SKY: SkyLook = {
  day: {
    sunColor: [2, 1.42, 0.92],
    skyTop: [0.07, 0.26, 0.52],
    skyHorizon: [0.7, 0.8, 0.86],
    skyDeep: [0.22, 0.28, 0.32],
    ambient: [0.5, 0.56, 0.66],
    ambientGround: [0.24, 0.21, 0.17],
    fogColor: [0.66, 0.74, 0.82],
    shadowStrength: 1,
  },
  fogNight: 0.0035,
  fogDay: 0.0022,
  daySigns: 0.8,
};
