/**
 * The courtyard's light through one day, keyed by the sun's elevation in degrees.
 *
 * **From photographs of the real thing, not from taste.** The research brief behind the spec gives
 * each hour a colour temperature and an exposure, and the keys below turn those into linear
 * colours. Noon's sun is about 5,500 K under a sky far bluer. Golden hour is about 3,500 K, falling
 * to 2,000 K at the horizon. Sunset is about 1,850 K. Blue hour is the sun 4–8° under, with the sky
 * the brightest thing in frame. The night is moonlit.
 *
 * **Exposure is in stops relative to noon, because these units are not candela.** What is held from
 * the brief is the *difference* between hours: EV 15 in noon sun, 13 at golden hour, 12 at sunset,
 * 10 in blue hour, and a moonlit courtyard that the eye opens up to by eight or nine stops. The
 * multipliers below are those differences, `2^stops`, softened at night where a camera would ride
 * its ISO. What would make them wrong is a frame at any key that reads as over or under the
 * photograph beside it.
 *
 * **The day's exposures are matched to the model maker's renders, not to taste.** Two views are
 * held against them: the stone alone from inside the courtyard with the sun across it, where the
 * render has a median of 69 on screen and 4.8% of the frame under 16, and the curtains down its
 * length, 41 and 15%. At 1.13 this palette sat a quarter-stop under both, so the day is a quarter
 * up. They were matched to a photograph of the real courtyard until 2026-09-26, with the stone
 * lifted toward limestone under it; the stone is now the file's own, read the way the maker read
 * it (see `packs.ts`), and the photograph and the renders agree about how pale it is.
 *
 * **The moon is a fifteenth of the sun here, not the four-hundred-thousandth it is outside.** A
 * night at the real ratio is black at any exposure a person would choose, and a film's night is
 * the moon brought up and graded blue. What would make it wrong is a night bright enough to read as
 * a grey day; that is what the first version did at a sixth, and what this corrects.
 *
 * **Clear air while the sun is up**, and a thin haze only from the horizon down, two thousandths a
 * metre at most, where it was five until 2026-09-26 and the evening read as fog. The fog is the
 * medium the sun's light scatters in, and a gallery is where the eye opens up the most: at 0.0003 a
 * metre, about what air with thirteen kilometres of visibility scatters, the far end of the upper
 * gallery glowed at 170 of 255 where it reads 94 without, and the whole courtyard read as milk
 * beside the maker's renders and the maintainer's photographs, which are sharp to the far wall.
 *
 * **The sun at 60° and the sky around it are five to one**, which is the ratio of direct sun to
 * skylight on a horizontal surface under a clear sky: about 100,000 lux against 20,000. The
 * arcades are lit by the sky and by bounce alone, and that is what makes them read as shade.
 */
import { createDaylightPalette } from '../../packages/core/src/index';
import type { DaylightKey } from '../../packages/core/src/index';

const NONE: [number, number, number] = [0, 0, 0];

/** The full moon's light at the ground, relative to the palette's sun. The phase scales it. */
export const MOON_LIGHT: [number, number, number] = [0.02, 0.026, 0.042];

const KEYS: DaylightKey[] = [
  {
    at: 68,
    sunColor: [3.2, 2.95, 2.5],
    moonColor: NONE,
    skyTop: [0.3, 0.55, 1.35],
    skyHorizon: [0.95, 1.08, 1.3],
    skyDeep: [0.22, 0.42, 1.0],
    ambient: [0.5, 0.6, 0.82],
    ambientGround: [0.3, 0.26, 0.21],
    fogColor: [0.85, 0.95, 1.15],
    fogDensity: 0,
    shadowStrength: 1,
    emissiveGain: 0,
    exposure: 1.15,
  },
  {
    at: 30,
    sunColor: [3.0, 2.6, 2.05],
    moonColor: NONE,
    skyTop: [0.28, 0.5, 1.2],
    skyHorizon: [1.0, 1.05, 1.15],
    skyDeep: [0.2, 0.38, 0.9],
    ambient: [0.42, 0.5, 0.68],
    ambientGround: [0.26, 0.21, 0.16],
    fogColor: [0.85, 0.9, 1.0],
    fogDensity: 0,
    shadowStrength: 1,
    emissiveGain: 0,
    exposure: 1.15,
  },
  {
    /* Golden hour: the upper wall catches it and the floor is lit by bounce alone. */
    at: 10,
    sunColor: [2.5, 1.75, 1.0],
    moonColor: NONE,
    skyTop: [0.22, 0.38, 0.85],
    skyHorizon: [1.5, 1.08, 0.66],
    skyDeep: [0.2, 0.32, 0.68],
    ambient: [0.26, 0.28, 0.38],
    ambientGround: [0.17, 0.12, 0.08],
    fogColor: [0.95, 0.75, 0.55],
    fogDensity: 0,
    shadowStrength: 1,
    emissiveGain: 0,
    exposure: 1.1,
  },
  {
    at: 3,
    sunColor: [1.7, 0.88, 0.36],
    moonColor: NONE,
    skyTop: [0.16, 0.26, 0.62],
    skyHorizon: [1.45, 0.72, 0.34],
    skyDeep: [0.16, 0.24, 0.52],
    ambient: [0.17, 0.16, 0.21],
    ambientGround: [0.09, 0.06, 0.04],
    fogColor: [0.8, 0.5, 0.32],
    fogDensity: 0.0004,
    shadowStrength: 0.95,
    emissiveGain: 0.25,
    exposure: 0.95,
  },
  {
    /* The sun on the horizon, about 1,850 K, and the first of the lamps. */
    at: 0,
    sunColor: [0.95, 0.38, 0.11],
    moonColor: NONE,
    skyTop: [0.12, 0.18, 0.45],
    skyHorizon: [1.1, 0.48, 0.22],
    skyDeep: [0.12, 0.17, 0.4],
    ambient: [0.12, 0.115, 0.16],
    ambientGround: [0.05, 0.035, 0.028],
    fogColor: [0.6, 0.36, 0.25],
    fogDensity: 0.0007,
    shadowStrength: 0.9,
    emissiveGain: 0.5,
    exposure: 0.8,
  },
  {
    /* Blue hour: no sun, the sky the brightest thing, and the Belt of Venus pink at the horizon. */
    at: -4,
    sunColor: NONE,
    moonColor: NONE,
    skyTop: [0.045, 0.08, 0.22],
    skyHorizon: [0.2, 0.15, 0.25],
    skyDeep: [0.04, 0.07, 0.18],
    ambient: [0.06, 0.075, 0.13],
    ambientGround: [0.018, 0.02, 0.032],
    fogColor: [0.12, 0.13, 0.22],
    fogDensity: 0.0015,
    shadowStrength: 0.8,
    emissiveGain: 0.85,
    exposure: 0.7,
  },
  {
    at: -8,
    sunColor: NONE,
    moonColor: NONE,
    skyTop: [0.018, 0.035, 0.1],
    skyHorizon: [0.055, 0.06, 0.12],
    skyDeep: [0.016, 0.03, 0.085],
    ambient: [0.028, 0.038, 0.07],
    ambientGround: [0.008, 0.009, 0.015],
    fogColor: [0.05, 0.06, 0.1],
    fogDensity: 0.002,
    shadowStrength: 0.7,
    emissiveGain: 1,
    exposure: 0.6,
  },
  {
    /* Night, moonlit: the moon's key light and a sky that has let go of the day. */
    at: -14,
    sunColor: NONE,
    moonColor: MOON_LIGHT,
    skyTop: [0.004, 0.007, 0.02],
    skyHorizon: [0.012, 0.016, 0.03],
    skyDeep: [0.003, 0.005, 0.014],
    ambient: [0.012, 0.016, 0.03],
    ambientGround: [0.004, 0.005, 0.008],
    fogColor: [0.012, 0.015, 0.025],
    fogDensity: 0.002,
    shadowStrength: 0.65,
    emissiveGain: 1,
    exposure: 0.5,
  },
];

/**
 * **No white balance on the light.** It was balanced to the noon sun, and then halfway to it, on
 * 2026-09-26: the grey stone had come out one sepia, but that was the cream tint and the undecoded
 * maps, and with both gone the balance only turned the sky-lit shade lavender, at -12 of red over
 * blue in a gallery the maker's renders show at +12. Unbalanced it reads +9, and the courtyard +5
 * against the renders' +5.
 */
export const PALETTE = createDaylightPalette(KEYS);
