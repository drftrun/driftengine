/**
 * The district's look: a colour grade that is vivid and hard rather than soft, the way a neon
 * city is shot — colour that holds its saturation into the highlights, cyan in the shade and warm
 * magenta where it is brightest, and by night blacks that are black.
 *
 * **A lookup table built by hand over display values**, which is what the engine's grade takes
 * (`setColourGrade`): the grade is a look and comes after the output transform, so these numbers
 * are about how the frame reads on a screen and not about light. Five steps, in order:
 *
 * - **black point**, set down a little by night so a night reads black and not milky, and not at
 *   all by day, when a city out of the sun is still a bright thing;
 * - **contrast**, an S about middle grey;
 * - **saturation**, about the pixel's own luma, so a grey stays grey and a sign gets louder;
 * - **vibrance**, more saturation the less a colour already has, so a pastel facade comes up to
 *   its paint while a sign already at full colour is not pushed past it;
 * - **split tone**, cyan into the shadows and warm magenta into the highlights, each weighted by
 *   how far into its end the pixel is, so the midtones keep their own colour.
 *
 * **One grade for day and one for night, and the frame between them is between them**: the table
 * is rebuilt as the night moves, into one of two buffers in turn, because the renderer uploads a
 * table when it is handed a different one. It was one grade blended toward none by day, and
 * turning its contrast down for the shade turned its colour down with it.
 *
 * What it gives up: an exact match to any one renderer's tone, which is not the target. What would
 * make it wrong is a frame whose output transform already crushes its blacks, which ACES does not.
 */
import { identityGradeLut } from '../../packages/core/src/index';
import type { ColourGradeLut } from '../../packages/core/src/index';

export interface GradeLook {
  readonly black: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly vibrance: number;
  readonly shadow: readonly [number, number, number];
  readonly highlight: readonly [number, number, number];
}

/*
 * Near the paint by day: a city in the sun is shot clear rather than loud, its colour coming from
 * the light — gold where the sun lands, teal in the shade — so saturation is barely lifted and the
 * split tone does the work. Pushed to a third more, every facade read as poster paint.
 */
export const DAY_LOOK: GradeLook = {
  black: 0,
  contrast: 0.24,
  saturation: 1.06,
  vibrance: 0.12,
  shadow: [-0.018, 0.012, 0.03],
  highlight: [0.035, 0.014, -0.016],
};

/* More by night, where the colour is the neon's and a sign should read as light. */
export const NIGHT_LOOK: GradeLook = {
  black: 0.012,
  contrast: 0.3,
  saturation: 1.18,
  vibrance: 0.12,
  shadow: [-0.02, 0.022, 0.045],
  highlight: [0.045, -0.01, 0.022],
};

const SIZE = 33;
/** How far the night moves before the table is rebuilt: twenty steps across a dusk. */
const STEP = 0.05;

export class DistrictGrade {
  private readonly tables: [ColourGradeLut, ColourGradeLut] = [
    identityGradeLut(SIZE),
    identityGradeLut(SIZE),
  ];
  private next = 0;
  private built = -1;

  /** The table for `night`, rebuilt only when it has moved a step; null when it has not. */
  at(night: number): ColourGradeLut | null {
    const stepped = Math.round(night / STEP) * STEP;
    if (stepped === this.built) return null;
    this.built = stepped;
    const table = this.tables[this.next] as ColourGradeLut;
    this.next = 1 - this.next;
    fill(table, DAY_LOOK, NIGHT_LOOK, stepped);
    return table;
  }
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function fill(lut: ColourGradeLut, day: GradeLook, night: GradeLook, t: number): void {
  const black = mix(day.black, night.black, t);
  const contrast = mix(day.contrast, night.contrast, t);
  const saturation = mix(day.saturation, night.saturation, t);
  const vibrance = mix(day.vibrance, night.vibrance, t);
  const shadow = [0, 1, 2].map((k) => mix(day.shadow[k] as number, night.shadow[k] as number, t));
  const highlight = [0, 1, 2].map((k) =>
    mix(day.highlight[k] as number, night.highlight[k] as number, t),
  );
  const data = lut.data;
  const c = [0, 0, 0];
  for (let b = 0; b < SIZE; b++) {
    for (let g = 0; g < SIZE; g++) {
      for (let r = 0; r < SIZE; r++) {
        const at = ((b * SIZE + g) * SIZE + r) * 4;
        c[0] = r / (SIZE - 1);
        c[1] = g / (SIZE - 1);
        c[2] = b / (SIZE - 1);
        for (let k = 0; k < 3; k++) {
          const v = Math.max(0, (c[k] as number) - black) / (1 - black);
          c[k] = v + (v * v * (3 - 2 * v) - v) * contrast;
        }
        const luma =
          0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
        const chroma =
          Math.max(c[0] as number, c[1] as number, c[2] as number) -
          Math.min(c[0] as number, c[1] as number, c[2] as number);
        const gain = saturation * (1 + vibrance * (1 - Math.min(1, chroma * 2)));
        const shade = (1 - luma) * (1 - luma);
        const light = luma * luma;
        for (let k = 0; k < 3; k++) {
          const v =
            luma +
            ((c[k] as number) - luma) * gain +
            (shadow[k] as number) * shade +
            (highlight[k] as number) * light;
          data[at + k] = Math.round(Math.min(1, Math.max(0, v)) * 255);
        }
      }
    }
  }
}
