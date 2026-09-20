/**
 * The city's facades: one repeating image a style, a mask of which of its windows are lit, and the
 * glass of a curtain wall.
 *
 * **One window to a cell, and a cell to a unit of facade UV.** `manhattan.ts` makes a window one
 * unit on every wall — a bay wide and a storey high — so every style is a tile of `STYLE_WINDOWS`
 * cells a side that repeats over its buildings at one scale, each building starting at its own
 * whole-window offset into it. A cell's rows run up the building, because a facade's V counts
 * storeys from the street and an image's rows count down from its top: row 0 of a cell is the floor.
 *
 * **What each style is, after the buildings it stands for:**
 *
 * - **Brick**: a tall punched window in a brick wall, a stone lintel above it and a sill below —
 *   the walk-up and the brick prewar block. The wall is near white, so a building's own colour is
 *   what colours it.
 * - **Limestone**: a wider punched window in dressed stone, a darker joint at each floor line.
 * - **Deco**: the setback tower's verticality — light stone piers between every bay, and between
 *   them windows stacked over dark spandrel panels, so a tower reads as rising lines.
 * - **Office**: ribbon windows the width of the bay over a concrete band, lit a floor at a time —
 *   the floors behind a curtain wall.
 * - **Curtain**: the glass itself, its colour and its coverage. Mullions and the band at each floor
 *   are opaque; the panes let three quarters of what is behind them through, which is how the lit
 *   office floors show.
 *
 * **Lit at dusk as a city is**: flats warm and a little under half of them, offices cooler and most
 * of a floor at once. The mask is black on every wall, because the second pipeline glows as the
 * albedo times the mask times the material's emissive, and a wall that glowed would light the
 * whole city from within.
 */
import { ADDRESS_MODE } from '@driftengine/texture';

import { linearImage, srgbImage } from '../imageProgram';
import { STYLE_WINDOWS, blockStream } from './manhattan';

import type { GpuDrivenProgram } from '../../packages/core/src/index';

/** Texels a side of one window's cell. */
export const CELL = 16;
/** Texels a side of every style's image. A power of two, so the chain reaches one texel. */
export const STYLE_EDGE = STYLE_WINDOWS * CELL;

type Rgb = readonly [number, number, number];

/** What a flat is lit by: tungsten and warm LED, mostly, and a television now and then. sRGB. */
const HOMES: readonly Rgb[] = [
  [255, 176, 96],
  [255, 190, 120],
  [255, 204, 148],
  [236, 168, 104],
  [150, 176, 255],
];
/** What an office is lit by: cool and neutral white. sRGB. */
const OFFICES: readonly Rgb[] = [
  [255, 238, 214],
  [246, 244, 236],
  [236, 242, 255],
];

/** A window's glass with nothing lit behind it: the evening's reflection, a little different each. */
function darkGlass(roll: number): Rgb {
  return [22 + Math.round(12 * roll), 28 + Math.round(12 * roll), 40 + Math.round(14 * roll)];
}

/** What one texel of a cell is: wall, trim, frame, glass or spandrel. */
type Part = 'wall' | 'trim' | 'glass' | 'dark';

export interface Style {
  readonly baseColour: GpuDrivenProgram;
  readonly emissive: GpuDrivenProgram;
}

interface Painter {
  /** What texel (x, y) of a cell is. */
  part(x: number, y: number): Part;
  /** The share of this row's windows lit, given a roll for the row. */
  busy(roll: number): number;
  /** What lights a lit window. */
  lamps: readonly Rgb[];
  wall: Rgb;
  trim: Rgb;
  dark: Rgb;
  /** A texel of wall moves this far up or down, so a wall is a material rather than a fill. */
  grain: number;
}

const inside = (x: number, y: number, x0: number, x1: number, y0: number, y1: number): boolean =>
  x >= x0 && x < x1 && y >= y0 && y < y1;

export const BRICK: Painter = {
  part: (x, y) =>
    inside(x, y, 5, 11, 3, 12)
      ? 'glass'
      : inside(x, y, 4, 12, 12, 13) || inside(x, y, 4, 12, 2, 3)
        ? 'trim'
        : 'wall',
  busy: (roll) => 0.18 + 0.45 * roll,
  lamps: HOMES,
  wall: [232, 226, 220],
  trim: [250, 246, 236],
  dark: [70, 64, 60],
  grain: 18,
};

export const LIMESTONE: Painter = {
  part: (x, y) =>
    inside(x, y, 3, 13, 3, 13)
      ? 'glass'
      : y === 0
        ? 'dark'
        : inside(x, y, 3, 13, 2, 3)
          ? 'trim'
          : 'wall',
  busy: (roll) => 0.15 + 0.45 * roll,
  lamps: HOMES,
  wall: [240, 236, 228],
  trim: [252, 250, 244],
  dark: [150, 144, 136],
  grain: 8,
};

export const DECO: Painter = {
  part: (x, y) => (x < 3 || x >= 13 ? 'wall' : y < 4 ? 'dark' : 'glass'),
  busy: (roll) => 0.3 + 0.5 * roll,
  lamps: OFFICES,
  wall: [244, 240, 232],
  trim: [252, 250, 244],
  dark: [74, 66, 58],
  grain: 6,
};

export const OFFICE: Painter = {
  part: (x, y) => (y < 3 || y > 13 ? 'dark' : 'glass'),
  busy: (roll) => 0.35 + 0.6 * roll,
  lamps: OFFICES,
  wall: [90, 90, 94],
  trim: [255, 255, 250],
  dark: [58, 60, 64],
  grain: 0,
};

/**
 * One style's two images. `salt` keeps the styles' lit windows from being the same pattern.
 *
 * **Lit a floor at a time.** Each row of the tile draws how busy its floor is, and each window in
 * it is lit with that chance — and an office's lit windows run on in groups, because an office floor
 * is lit a room at a time rather than a window at a time.
 */
export function paintStyle(painter: Painter, seed: number, salt: number): Style {
  const next = blockStream(seed, 0x57e1e, salt);
  const edge = STYLE_EDGE;
  const colour = new Uint8Array(edge * edge * 4);
  const glow = new Uint8Array(edge * edge * 4);
  const office = painter.lamps === OFFICES;

  for (let row = 0; row < STYLE_WINDOWS; row += 1) {
    const busy = painter.busy(next());
    let run = 0;
    let lit = false;
    let lamp = painter.lamps[0] as Rgb;
    for (let col = 0; col < STYLE_WINDOWS; col += 1) {
      if (run <= 0) {
        lit = next() < busy;
        lamp = painter.lamps[Math.floor(next() * painter.lamps.length)] as Rgb;
        run = office ? 2 + Math.floor(next() * 5) : 1;
      }
      run -= 1;
      const dark = darkGlass(next());
      /*
       * **No two lit windows alike.** A lamp across the room, a blind half down, a ceiling light
       * — so a lit window's brightness is its own, it is brighter under its head than at its sill,
       * and one in four has a blind drawn to some depth. Flat squares of one colour read as a
       * grid of screens rather than as rooms.
       */
      const level = 0.45 + 0.55 * next();
      const blind = next() < 0.25 ? 0.3 + 0.6 * next() : 1;
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          const at = ((row * CELL + y) * edge + col * CELL + x) * 4;
          const part = painter.part(x, y);
          let rgb: Rgb;
          if (part === 'glass' && lit) {
            const up = y / CELL;
            const shaded = up > blind ? 0.35 : 1;
            const k = level * shaded * (0.72 + 0.28 * up);
            rgb = [Math.round(lamp[0] * k), Math.round(lamp[1] * k), Math.round(lamp[2] * k)];
          } else if (part === 'glass') rgb = dark;
          else if (part === 'trim') rgb = painter.trim;
          else if (part === 'dark') rgb = painter.dark;
          else {
            const g = Math.round((next() - 0.5) * painter.grain);
            rgb = [painter.wall[0] + g, painter.wall[1] + g, painter.wall[2] + g];
          }
          colour.set([rgb[0], rgb[1], rgb[2], 255], at);
          const on = part === 'glass' && lit ? 255 : 0;
          glow.set([on, on, on, 255], at);
        }
      }
    }
  }
  return {
    baseColour: srgbImage(colour, edge, ADDRESS_MODE.CENTRE_WRAP),
    emissive: linearImage(glow, edge, ADDRESS_MODE.CENTRE_WRAP),
  };
}

/** How much of what is behind a curtain wall's pane shows through it: three quarters. */
export const PANE_COVERAGE = 0.25;

/**
 * The curtain wall's glass: colour and coverage, for the blended half, whose alpha is the material's
 * opacity times this image's.
 */
export function curtainGlass(): GpuDrivenProgram {
  const edge = STYLE_EDGE;
  const colour = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const cx = x % CELL;
      const cy = y % CELL;
      const at = (y * edge + x) * 4;
      if (cx === 0) colour.set([46, 52, 58, 255], at);
      else if (cy < 3) colour.set([34, 44, 52, 235], at);
      else colour.set([120, 158, 176, Math.round(PANE_COVERAGE * 255)], at);
    }
  }
  return srgbImage(colour, edge, ADDRESS_MODE.CENTRE_WRAP);
}

export interface CityStyles {
  readonly brick: Style;
  readonly limestone: Style;
  readonly deco: Style;
  readonly office: Style;
  readonly curtain: GpuDrivenProgram;
}

export function cityStyles(seed: number): CityStyles {
  return {
    brick: paintStyle(BRICK, seed, 1),
    limestone: paintStyle(LIMESTONE, seed, 2),
    deco: paintStyle(DECO, seed, 3),
    office: paintStyle(OFFICE, seed, 4),
    curtain: curtainGlass(),
  };
}
