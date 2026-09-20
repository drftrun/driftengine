/**
 * A city after Manhattan, generated from one seed: the 1811 grid, a street wall of lots, and the
 * buildings the 1916 zoning shaped.
 *
 * **Generated because the repository carries no models, and deterministic because it is
 * published.** Every building, every window's place in its facade and every sheet of glass comes
 * from a hash of the seed and the block's place, so `shots.mjs` can hold the demo to zero pixels
 * and a reader reporting a defect reports one anybody can reproduce. Nothing here reads a clock or
 * `Math.random`, and a test replaces both with functions that throw.
 *
 * **What it copies, and from where.** The Commissioners' Plan of 1811: blocks about 61 m north to
 * south and 240 m east to west, 30 m avenues running north and 18 m cross streets. A street wall:
 * buildings are built to the lot line, shoulder to shoulder, so a street is a corridor rather than
 * a field of pillars. And five kinds of building, by how busy the district is:
 *
 * - **Walk-ups**, four to six storeys of brick with a cornice, and on some roofs the timber water
 *   tank a New York roof is known by.
 * - **Prewar** blocks of ten to sixteen storeys in limestone or brick, punched windows, a cornice
 *   and often a tank of their own.
 * - **Setback towers**, the 1916 Zoning Resolution's "wedding cake": a podium to the street wall's
 *   height across the whole lot, tiers stepping in as they rise, and above them a tower on no more
 *   than a quarter of the lot, finished with a stepped crown, floodlit on most, and a spire on some.
 * - **Glass boxes** of the fifties on their open forecourts: a curtain wall over lit office floors, which is
 *   where the second pipeline's blended half is in the published frame.
 * - **Supertalls**, few and slender, where the district is busiest.
 *
 * **Why the walls are cut a window at a time.** Occlusion culling is the pipeline's signature, and
 * a wall that was one quad would be one cluster the cull keeps or drops whole; a wall of windows is
 * clusters of a hundred and twenty-eight triangles, and the ones a nearer building hides are the
 * ones it drops. **A party wall is cut where its neighbour ends**: the part of a wall another
 * building stands against is never seen, and drawing it would be triangles the count claims and
 * the frame never shows.
 *
 * **A window is one unit of facade UV**, a bay wide and a storey high, whatever the storey's height,
 * so each style's image (`styles.ts`) reads at one scale everywhere.
 */
import type { RawMesh } from '../gpuDrivenRig';

/** A block's lot, east to west and north to south, in metres. */
export const LOT_X = 240;
export const LOT_Z = 61;
/** An avenue, between two blocks east to west, and a cross street, between two north to south. */
export const AVENUE = 30;
export const STREET = 18;
/** From one block's corner to the next's. */
export const PITCH_X = LOT_X + AVENUE;
export const PITCH_Z = LOT_Z + STREET;
/** The pavement round a lot, inside the street. */
export const SIDEWALK = 4.5;
/** Metres a window column, the same in every style. */
export const BAY = 3;

/** The published grid: six avenues' worth of blocks across and twenty-four streets' worth down. */
export const CITY_COLS = 6;
export const CITY_ROWS = 24;

/**
 * Triangles in the published grid at the demo's seed, which `manhattan.test.ts` counts rather than
 * trusts. **Past a million**, because the spec asks for it and says why.
 */
export const CITY_TRIANGLES = 1_844_094;

/** The materials a block's meshes come in, and the order `palette.ts` declares them in. */
export const MATERIAL = {
  brick: 0,
  limestone: 1,
  deco: 2,
  office: 3,
  glass: 4,
  roof: 5,
  trim: 6,
  tank: 7,
  crown: 8,
  spire: 9,
  street: 10,
  sidewalk: 11,
  lamp: 12,
  pole: 13,
  neon: 14,
} as const;
export const MATERIAL_COUNT = 15;

/**
 * What the street level is signed with: the saturated tubes a city at night is photographed for.
 * A sign's colour is its vertices', so one material draws all of them.
 */
const NEONS: readonly (readonly [number, number, number])[] = [
  [1, 0.08, 0.55],
  [0.05, 0.85, 1],
  [0.2, 0.35, 1],
  [1, 0.55, 0.08],
  [1, 0.1, 0.12],
  [0.6, 0.2, 1],
];

/** A sign over a shopfront: a band along it, or a blade standing out from its wall. */
export interface Sign {
  readonly shape: 'band' | 'blade';
  readonly colour: readonly [number, number, number];
  /** A blade's height in metres. */
  readonly height: number;
}

export type Kind = 'walkup' | 'prewar' | 'setback' | 'glass' | 'supertall';

/** Metres a storey, by kind: a flat's is lower than an office's. */
export const STOREY: Readonly<Record<Kind, number>> = {
  walkup: 3.2,
  prewar: 3.4,
  setback: 3.8,
  glass: 3.9,
  supertall: 4,
};

/** One stacked box of a building, in the block's own metres, and what its walls are made of. */
export interface Mass {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly y0: number;
  readonly y1: number;
  /** The facade material its walls take. */
  readonly material: number;
}

/** A building as the generator decided it, before any triangle exists. */
export interface Building {
  readonly kind: Kind;
  /** Its lot, in the block's own metres. */
  readonly lot: {
    readonly x0: number;
    readonly z0: number;
    readonly x1: number;
    readonly z1: number;
  };
  /** Its masses, lowest first. The last is the top of the building proper. */
  readonly masses: readonly Mass[];
  /** Metres to the top of its highest mass, not counting a spire. */
  readonly height: number;
  /** A skin of glass over an office core, rather than a facade. */
  readonly glass: boolean;
  /** A water tank on its roof. */
  readonly tank: boolean;
  /** Its crown is floodlit. */
  readonly lit: boolean;
  /** A spire above its crown, in metres, or zero. */
  readonly spire: number;
  /** A neon sign over its shopfront, or none. */
  readonly sign: Sign | null;
  /** Multiplied into its facade image. */
  readonly tint: readonly [number, number, number];
  /** Where it starts in its style's repeating image, in whole windows. */
  readonly offset: readonly [number, number];
}

/** murmur3's finaliser: every input bit reaches every output bit. */
function mix(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A stream of numbers in [0, 1) from a seed and two integers, alone.
 *
 * **Per block rather than per city**, because the demo streams: a block built when the camera
 * reaches it has to be the block that would have been built at load, whatever else was built
 * first, and one stream drawn from in arrival order would make every block depend on the flight.
 */
export function blockStream(seed: number, bx: number, bz: number): () => number {
  let state = mix(mix(seed) ^ mix(bx * 0x27d4eb2d) ^ mix(bz * 0x165667b1 + 0x9e3779b9));
  return () => {
    /* splitmix32. */
    state = (state + 0x9e3779b9) >>> 0;
    return mix(state) / 4294967296;
  };
}

/** Where a block's lot starts, in the world: its transform's translation. */
export function blockOrigin(bx: number, bz: number): [number, number] {
  return [bx * PITCH_X + AVENUE / 2, bz * PITCH_Z + STREET / 2];
}

/**
 * How busy the district is at a point, zero to one: a midtown north of the middle and a smaller
 * downtown to the south, falling away between them — so the skyline has two clusters and a valley,
 * as Manhattan's does.
 */
export function busy(x: number, z: number): number {
  const midtown = Math.exp(-((x / 520) ** 2 + ((z + 420) / 520) ** 2));
  const downtown = 0.75 * Math.exp(-(((x + 120) / 320) ** 2 + ((z - 760) / 300) ** 2));
  return Math.min(1, midtown + downtown);
}

/** Every block of the published grid, row by row. */
export function cityBlocks(): [number, number][] {
  const blocks: [number, number][] = [];
  for (let bz = -CITY_ROWS / 2; bz < CITY_ROWS / 2; bz += 1) {
    for (let bx = -CITY_COLS / 2; bx < CITY_COLS / 2; bx += 1) blocks.push([bx, bz]);
  }
  return blocks;
}

/** Whether a block is one of the published grid's. */
export function inCity(bx: number, bz: number): boolean {
  return bx >= -CITY_COLS / 2 && bx < CITY_COLS / 2 && bz >= -CITY_ROWS / 2 && bz < CITY_ROWS / 2;
}

/** Brick, from red to brown to the pale Roman brick of the twenties. */
const BRICKS: readonly (readonly [number, number, number])[] = [
  [0.72, 0.42, 0.34],
  [0.62, 0.4, 0.33],
  [0.78, 0.55, 0.44],
  [0.56, 0.36, 0.3],
  [0.84, 0.7, 0.56],
];
/** Limestone and the buff terracotta that imitated it. */
const STONES: readonly (readonly [number, number, number])[] = [
  [0.86, 0.8, 0.7],
  [0.8, 0.76, 0.68],
  [0.9, 0.84, 0.72],
  [0.76, 0.72, 0.66],
];

function pick<T>(list: readonly T[], roll: number): T {
  return list[Math.min(list.length - 1, Math.floor(roll * list.length))] as T;
}

/** A tint, a little lighter or darker than its base. */
function shade(base: readonly [number, number, number], roll: number): [number, number, number] {
  const lift = 0.88 + 0.2 * roll;
  return [base[0] * lift, base[1] * lift, base[2] * lift];
}

/** Windows a side of every style's repeating image; a building starts at an offset into it. */
export const STYLE_WINDOWS = 32;

function offsetOf(next: () => number): [number, number] {
  return [Math.floor(next() * STYLE_WINDOWS), Math.floor(next() * STYLE_WINDOWS)];
}

/**
 * A stretch of one frontage, filled with walk-ups and prewar buildings shoulder to shoulder.
 *
 * `z0`–`z1` is the half of the block's depth the row stands on, and `x0`–`x1` the stretch.
 */
function row(
  next: () => number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  district: number,
  out: Building[],
): void {
  let x = x0;
  while (x1 - x > 0.5) {
    const kind: Kind = next() < 0.25 + 0.6 * district ? 'prewar' : 'walkup';
    /* A walk-up is a house or two wide; a prewar block a few more. */
    const wanted = kind === 'walkup' ? 8 + next() * 12 : 18 + next() * 26;
    const left = x1 - x;
    /* The last lot takes what is left rather than leaving a sliver no building fits. */
    const width = left - wanted < 8 ? left : wanted;
    const floors =
      kind === 'walkup' ? 4 + Math.floor(next() * 3) : 10 + Math.floor(next() * (5 + 6 * district));
    const height = floors * STOREY[kind];
    const brick = kind === 'walkup' || next() < 0.45;
    const material = brick ? MATERIAL.brick : MATERIAL.limestone;
    const tint = shade(brick ? pick(BRICKS, next()) : pick(STONES, next()), next());
    const masses: Mass[] = [{ x0: x, z0, x1: x + width, z1, y0: 0, y1: height, material }];
    /* A prewar block's top storeys step back from the street, as its penthouse. */
    const penthouse = next();
    if (kind === 'prewar' && penthouse < 0.5 && width > 14) {
      const front = z0 === 0;
      masses.push({
        x0: x + 2,
        z0: front ? z0 + 3 : z0,
        x1: x + width - 2,
        z1: front ? z1 : z1 - 3,
        y0: height,
        y1: height + 2 * STOREY.prewar,
        material,
      });
    }
    const top = masses[masses.length - 1] as Mass;
    out.push({
      kind,
      lot: { x0: x, z0, x1: x + width, z1 },
      masses,
      height: top.y1,
      glass: false,
      tank: next() < (kind === 'walkup' ? 0.3 : 0.55),
      lit: false,
      spire: 0,
      sign: signOf(next, 0.55 + 0.35 * district),
      tint,
      offset: offsetOf(next),
    });
    x += width;
  }
}

/** A sign with the chance given, its shape, colour and height drawn whether or not it is there. */
function signOf(next: () => number, chance: number): Sign | null {
  const there = next() < chance;
  const shape = next() < 0.6 ? 'band' : 'blade';
  const colour = pick(NEONS, next());
  const height = 3 + next() * 5;
  return there ? { shape, colour, height } : null;
}

/**
 * A setback tower on a lot running through the block.
 *
 * **The 1916 rule, as geometry**: a podium to the street wall's height across the whole lot, then
 * tiers that step in as they rise until what is left covers no more than a quarter of the lot, and
 * a tower on that quarter as high as the owner likes — the envelope that gave New York the wedding
 * cake. Above the tower a crown of two or three shrinking tiers, floodlit on most, and on some a
 * spire.
 */
function setback(next: () => number, x0: number, x1: number, district: number): Building {
  const storey = STOREY.setback;
  const podium = (7 + Math.floor(next() * 6)) * storey;
  const floors = 26 + Math.floor(next() * (18 + 40 * district));
  const top = floors * storey;
  const lotArea = (x1 - x0) * LOT_Z;
  const masses: Mass[] = [
    { x0, z0: 0, x1, z1: LOT_Z, y0: 0, y1: podium, material: MATERIAL.limestone },
  ];
  let a = x0;
  let b = 0;
  let c = x1;
  let d = LOT_Z;
  let y = podium;
  /* Step in until the footprint is a quarter of the lot, keeping the tower at least 16 m wide. */
  while ((c - a) * (d - b) > 0.25 * lotArea) {
    const inset = 3 + next() * 3;
    const across = Math.min(inset, Math.max(0, (c - a - 16) / 2));
    const deep = Math.min(inset, Math.max(0, (d - b - 16) / 2));
    if (across <= 0 && deep <= 0) break;
    a += across;
    c -= across;
    b += deep;
    d -= deep;
    const rise = Math.min(top - y, (3 + Math.floor(next() * 4)) * storey);
    if (rise <= 0) break;
    masses.push({ x0: a, z0: b, x1: c, z1: d, y0: y, y1: y + rise, material: MATERIAL.deco });
    y += rise;
  }
  if (y < top) masses.push({ x0: a, z0: b, x1: c, z1: d, y0: y, y1: top, material: MATERIAL.deco });
  /* The crown: two or three tiers, each two storeys, each two metres in. */
  const tiers = 2 + Math.floor(next() * 2);
  let crown = Math.max(y, top);
  for (let t = 0; t < tiers; t += 1) {
    if (c - a < 8 || d - b < 8) break;
    a += 2;
    c -= 2;
    b += 2;
    d -= 2;
    masses.push({
      x0: a,
      z0: b,
      x1: c,
      z1: d,
      y0: crown,
      y1: crown + 2 * storey,
      material: MATERIAL.crown,
    });
    crown += 2 * storey;
  }
  const lit = next() < 0.65;
  const spire = next() < 0.35 ? 18 + next() * 36 : 0;
  return {
    kind: 'setback',
    lot: { x0, z0: 0, x1, z1: LOT_Z },
    masses,
    height: crown,
    glass: false,
    tank: false,
    lit,
    spire,
    sign: null,
    tint: shade(pick(STONES, next()), next()),
    offset: offsetOf(next),
  };
}

/** A glass box on its open forecourt, set back from the streets, on a lot through the block. */
function glassBox(next: () => number, x0: number, x1: number, district: number): Building {
  const storey = STOREY.glass;
  const across = 6 + next() * 8;
  const deep = 5 + next() * 4;
  const floors = 20 + Math.floor(next() * (14 + 26 * district));
  const top = floors * storey;
  const a = x0 + across;
  const c = x1 - across;
  const masses: Mass[] = [
    { x0: a, z0: deep, x1: c, z1: LOT_Z - deep, y0: 0, y1: top, material: MATERIAL.office },
    /* The mechanical penthouse, dark and set in. */
    {
      x0: a + 5,
      z0: deep + 5,
      x1: c - 5,
      z1: LOT_Z - deep - 5,
      y0: top,
      y1: top + 2 * storey,
      material: MATERIAL.roof,
    },
  ];
  return {
    kind: 'glass',
    lot: { x0, z0: 0, x1, z1: LOT_Z },
    masses,
    height: top + 2 * storey,
    glass: true,
    tank: false,
    lit: false,
    spire: 0,
    sign: null,
    tint: [1, 1, 1],
    offset: offsetOf(next),
  };
}

/** A supertall: slender, very high, stone piers or glass, a small crown. */
function supertall(next: () => number, x0: number, x1: number): Building {
  const storey = STOREY.supertall;
  const side = Math.min(x1 - x0 - 6, 22 + next() * 6);
  const cx = (x0 + x1) / 2;
  const cz = LOT_Z / 2;
  const floors = 70 + Math.floor(next() * 26);
  const top = floors * storey;
  const glass = next() < 0.5;
  const shaft: Mass = {
    x0: cx - side / 2,
    z0: cz - side / 2,
    x1: cx + side / 2,
    z1: cz + side / 2,
    y0: 0,
    y1: top,
    material: glass ? MATERIAL.office : MATERIAL.deco,
  };
  const crown: Mass = {
    x0: shaft.x0 + 2,
    z0: shaft.z0 + 2,
    x1: shaft.x1 - 2,
    z1: shaft.z1 - 2,
    y0: top,
    y1: top + 3 * storey,
    material: MATERIAL.crown,
  };
  const lit = next() < 0.5;
  const spire = next() < 0.5 ? 30 + next() * 40 : 0;
  return {
    kind: 'supertall',
    lot: { x0, z0: 0, x1, z1: LOT_Z },
    masses: [shaft, crown],
    height: crown.y1,
    glass,
    tank: false,
    lit,
    spire,
    sign: null,
    tint: shade(pick(STONES, next()), next()),
    offset: offsetOf(next),
  };
}

/**
 * The buildings of one block.
 *
 * Walked east along the block: a stretch is either one tall building on a lot through the block,
 * or a run of walk-ups and prewar blocks along each frontage, the two frontages filled
 * independently and meeting back to back at the block's middle. How often a stretch is a tower
 * rises with how busy the district is.
 */
export function cityBuildings(bx: number, bz: number, seed: number): Building[] {
  const next = blockStream(seed, bx, bz);
  const [ox, oz] = blockOrigin(bx, bz);
  const out: Building[] = [];
  let x = 0;
  while (LOT_X - x > 0.5) {
    const district = busy(ox + x + 30, oz + LOT_Z / 2);
    const left = LOT_X - x;
    /*
     * **Squared, so the valleys are low.** Between Manhattan's two business districts the city is
     * walk-ups and prewar blocks with a tower now and then; a chance that fell off linearly put a
     * tower on nearly every block of the valley and the skyline had no shape.
     */
    const tower = next() < 0.03 + 0.7 * district * district && left >= 34;
    const which = next();
    const spread = next();
    if (tower) {
      const tall = which < 0.12 * district;
      const wanted = tall ? 30 + spread * 8 : which < 0.6 ? 44 + spread * 46 : 40 + spread * 30;
      const width = left - wanted < 20 ? left : Math.min(wanted, left);
      if (tall) out.push(supertall(next, x, x + width));
      else if (which < 0.6) out.push(setback(next, x, x + width, district));
      else out.push(glassBox(next, x, x + width, district));
      x += width;
    } else {
      const wanted = 30 + spread * 50;
      const width = left - wanted < 20 ? left : Math.min(wanted, left);
      /* The frontage on the north street, and the one on the south, back to back. */
      row(next, x, x + width, 0, LOT_Z / 2, district, out);
      row(next, x, x + width, LOT_Z / 2, LOT_Z, district, out);
      x += width;
    }
  }
  return out;
}

/** Vertices and triangles for one material, gathered before they are packed. */
class Gather {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colours: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  /**
   * A flat rectangle cut into cells, wound so its normal is `along x upward`.
   *
   * `origin` is its lowest corner; `along` and `upward` unit axes and `width` and `height` the
   * metres along each. The UV of a vertex is `uv0` plus the metres from the origin in `unitU` and
   * `unitV` — a bay and a storey on a facade — which is what makes a window one unit.
   */
  rectangle(
    origin: readonly [number, number, number],
    along: readonly [number, number, number],
    upward: readonly [number, number, number],
    width: number,
    height: number,
    unitU: number,
    unitV: number,
    colour: readonly [number, number, number],
    uv0: readonly [number, number],
  ): void {
    if (!(width > 1e-3) || !(height > 1e-3)) return;
    const across = Math.max(1, Math.round(width / unitU));
    const up = Math.max(1, Math.round(height / unitV));
    const normal = [
      along[1] * upward[2] - along[2] * upward[1],
      along[2] * upward[0] - along[0] * upward[2],
      along[0] * upward[1] - along[1] * upward[0],
    ];
    const base = this.positions.length / 3;
    for (let j = 0; j <= up; j += 1) {
      for (let i = 0; i <= across; i += 1) {
        const s = (width * i) / across;
        const t = (height * j) / up;
        for (let axis = 0; axis < 3; axis += 1) {
          this.positions.push(
            (origin[axis] as number) + (along[axis] as number) * s + (upward[axis] as number) * t,
          );
          this.normals.push(normal[axis] as number);
          this.colours.push(colour[axis] as number);
        }
        this.uvs.push(uv0[0] + s / unitU, uv0[1] + t / unitV);
      }
    }
    const stride = across + 1;
    for (let j = 0; j < up; j += 1) {
      for (let i = 0; i < across; i += 1) {
        const a = base + j * stride + i;
        /* (b - a) x (c - a) is along x upward, which is the normal: the engine's winding. */
        this.indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride);
      }
    }
  }

  /**
   * The walls of a box from `y0` to `y1`, each starting where `cover` says a neighbour stops
   * hiding it, the pattern running on round the corners.
   */
  walls(
    m: {
      readonly x0: number;
      readonly z0: number;
      readonly x1: number;
      readonly z1: number;
      readonly y0: number;
      readonly y1: number;
    },
    cover: Cover,
    colour: readonly [number, number, number],
    offset: readonly [number, number],
    storey: number,
  ): void {
    const width = m.x1 - m.x0;
    const depth = m.z1 - m.z0;
    const wall = (
      x: number,
      z: number,
      along: readonly [number, number, number],
      length: number,
      from: number,
      u: number,
    ): void => {
      const start = Math.max(m.y0, from);
      if (start >= m.y1) return;
      this.rectangle([x, start, z], along, [0, 1, 0], length, m.y1 - start, BAY, storey, colour, [
        u,
        offset[1] + start / storey,
      ]);
    };
    let u = offset[0];
    wall(m.x0, m.z1, [1, 0, 0], width, cover.south, u);
    u += width / BAY;
    wall(m.x1, m.z1, [0, 0, -1], depth, cover.east, u);
    u += depth / BAY;
    wall(m.x1, m.z0, [-1, 0, 0], width, cover.north, u);
    u += width / BAY;
    wall(m.x0, m.z0, [0, 0, 1], depth, cover.west, u);
  }

  /** A flat top at `y`, facing up, cut `cells` a side. */
  top(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number,
    colour: readonly [number, number, number],
    cells = 1,
  ): void {
    const cellX = Math.max(1e-3, (x1 - x0) / cells);
    const cellZ = Math.max(1e-3, (z1 - z0) / cells);
    this.rectangle(
      [x0, y, z1],
      [1, 0, 0],
      [0, 0, -1],
      x1 - x0,
      z1 - z0,
      cellX,
      cellZ,
      colour,
      [0, 0],
    );
  }

  /** A closed box, four walls and a top, for small solids with no facade. */
  box(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y0: number,
    y1: number,
    colour: readonly [number, number, number],
  ): void {
    const big = Math.max(x1 - x0, z1 - z0, y1 - y0);
    const h = y1 - y0;
    this.rectangle([x0, y0, z1], [1, 0, 0], [0, 1, 0], x1 - x0, h, big, big, colour, [0, 0]);
    this.rectangle([x1, y0, z1], [0, 0, -1], [0, 1, 0], z1 - z0, h, big, big, colour, [0, 0]);
    this.rectangle([x1, y0, z0], [-1, 0, 0], [0, 1, 0], x1 - x0, h, big, big, colour, [0, 0]);
    this.rectangle([x0, y0, z0], [0, 0, 1], [0, 1, 0], z1 - z0, h, big, big, colour, [0, 0]);
    this.top(x0, z0, x1, z1, y1, colour);
  }

  /** An eight-sided tank round a vertical axis and a cone for its lid: a New York water tank. */
  tank(
    cx: number,
    cz: number,
    radius: number,
    y0: number,
    y1: number,
    lid: number,
    colour: readonly [number, number, number],
  ): void {
    const sides = 8;
    const corner = (k: number): [number, number] => {
      const angle = (k / sides) * Math.PI * 2;
      return [cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius];
    };
    const vertex = (x: number, y: number, z: number, n: readonly number[]): void => {
      this.positions.push(x, y, z);
      this.normals.push(n[0] as number, n[1] as number, n[2] as number);
      this.colours.push(colour[0], colour[1], colour[2]);
      this.uvs.push(0, 0);
    };
    for (let k = 0; k < sides; k += 1) {
      const [ax, az] = corner(k);
      const [bx, bz] = corner(k + 1);
      const middle = ((k + 0.5) / sides) * Math.PI * 2;
      const n = [Math.cos(middle), 0, Math.sin(middle)];
      /* Going round from b to a with y up puts `along x up` outward, as every wall here is. */
      const at = this.positions.length / 3;
      vertex(bx, y0, bz, n);
      vertex(ax, y0, az, n);
      vertex(ax, y1, az, n);
      vertex(bx, y1, bz, n);
      this.indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
      /* The lid's facet over this side, its normal its own. */
      const e1 = [ax - bx, 0, az - bz];
      const e2 = [cx - bx, lid, cz - bz];
      const facet = [
        (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
        (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
        (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
      ];
      const length = Math.hypot(facet[0] as number, facet[1] as number, facet[2] as number) || 1;
      const unit = facet.map((value) => value / length);
      const lidAt = this.positions.length / 3;
      vertex(bx, y1, bz, unit);
      vertex(ax, y1, az, unit);
      vertex(cx, y1 + lid, cz, unit);
      this.indices.push(lidAt, lidAt + 1, lidAt + 2);
    }
  }

  mesh(material: number, transform: Float32Array, withUvs: boolean): RawMesh | null {
    if (this.indices.length === 0) return null;
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      colours: Float32Array.from(this.colours),
      indices: Uint32Array.from(this.indices),
      material,
      ...(withUvs ? { uvs: Float32Array.from(this.uvs) } : {}),
      transform,
    };
  }
}

/** Metres of each of a mass's four walls another building stands against. */
interface Cover {
  south: number;
  east: number;
  north: number;
  west: number;
}

/** Whether a material's walls read a facade image. */
export const TEXTURED: ReadonlySet<number> = new Set<number>([
  MATERIAL.brick,
  MATERIAL.limestone,
  MATERIAL.deco,
  MATERIAL.office,
  MATERIAL.glass,
]);

const WHITE: readonly [number, number, number] = [1, 1, 1];
/** Metres a glass skin stands proud of its core. */
export const SKIN = 1.2;
/** Metres between two street lights along a kerb. */
const LAMP_SPACING = 24;
const EPSILON = 1e-6;

/**
 * How much of each wall of `mass` another building hides: its height where it stands against the
 * whole of that wall, and nothing where it covers only part of it — a partial cover shows.
 */
function covered(mass: Mass, buildings: readonly Building[], self: Building): Cover {
  const cover: Cover = { south: 0, east: 0, north: 0, west: 0 };
  for (const other of buildings) {
    if (other === self) continue;
    for (const m of other.masses) {
      const spansZ = m.z0 <= mass.z0 + EPSILON && m.z1 >= mass.z1 - EPSILON;
      const spansX = m.x0 <= mass.x0 + EPSILON && m.x1 >= mass.x1 - EPSILON;
      if (spansZ && Math.abs(m.x0 - mass.x1) < EPSILON) cover.east = Math.max(cover.east, m.y1);
      if (spansZ && Math.abs(m.x1 - mass.x0) < EPSILON) cover.west = Math.max(cover.west, m.y1);
      if (spansX && Math.abs(m.z0 - mass.z1) < EPSILON) cover.south = Math.max(cover.south, m.y1);
      if (spansX && Math.abs(m.z1 - mass.z0) < EPSILON) cover.north = Math.max(cover.north, m.y1);
    }
  }
  return cover;
}

const NONE: Cover = { south: 0, east: 0, north: 0, west: 0 };

/**
 * One block's geometry, one mesh a material that has any, in the block's own metres and placed by
 * a translation — so a block streamed in far from the origin keeps its precision.
 */
export function cityBlock(bx: number, bz: number, seed: number): RawMesh[] {
  const gathers: Gather[] = [];
  for (let material = 0; material < MATERIAL_COUNT; material += 1) gathers.push(new Gather());
  const at = (material: number): Gather => gathers[material] as Gather;
  const buildings = cityBuildings(bx, bz, seed);
  /* Its own stream, for placing details, so a change to them leaves the buildings where they are. */
  const next = blockStream(seed ^ 0x51ab, bx, bz);

  for (const building of buildings) {
    const storey = STOREY[building.kind];
    for (const mass of building.masses) {
      const cover = covered(mass, buildings, building);
      if (building.glass && mass.material === MATERIAL.office) {
        /*
         * **A skin of glass over an office core.** Glass draws only what is behind it and casts no
         * shadow on this pipeline, so the core is what a reader sees lit through it — a floor at a
         * time, as an office tower at dusk is — and what shades the street.
         */
        at(MATERIAL.glass).walls(mass, cover, WHITE, building.offset, storey);
        at(MATERIAL.office).walls(
          {
            x0: mass.x0 + SKIN,
            z0: mass.z0 + SKIN,
            x1: mass.x1 - SKIN,
            z1: mass.z1 - SKIN,
            y0: mass.y0,
            y1: mass.y1,
          },
          NONE,
          WHITE,
          building.offset,
          storey,
        );
      } else if (mass.material === MATERIAL.crown) {
        at(building.lit ? MATERIAL.crown : MATERIAL.trim).walls(
          mass,
          cover,
          building.tint,
          [0, 0],
          storey,
        );
      } else if (TEXTURED.has(mass.material)) {
        at(mass.material).walls(mass, cover, building.tint, building.offset, storey);
      } else {
        at(mass.material).walls(mass, cover, WHITE, [0, 0], storey);
      }
      at(MATERIAL.roof).top(mass.x0, mass.z0, mass.x1, mass.z1, mass.y1, WHITE);
    }

    const first = building.masses[0] as Mass;
    const top = building.masses[building.masses.length - 1] as Mass;
    /* A cornice on the low buildings: a stone band proud of the wall at the roofline. */
    if (building.kind === 'walkup' || building.kind === 'prewar') {
      at(MATERIAL.trim).box(
        first.x0 - 0.4,
        first.z0 - 0.4,
        first.x1 + 0.4,
        first.z1 + 0.4,
        first.y1,
        first.y1 + 0.7,
        WHITE,
      );
    }
    if (building.tank) {
      const cx = (top.x0 + top.x1) / 2 + (next() - 0.5) * Math.max(0, top.x1 - top.x0 - 8);
      const cz = (top.z0 + top.z1) / 2 + (next() - 0.5) * Math.max(0, top.z1 - top.z0 - 8);
      const roof = top.y1 + (top === first ? 0.7 : 0);
      for (const [dx, dz] of [
        [-1.6, -1.6],
        [1.6, -1.6],
        [-1.6, 1.6],
        [1.6, 1.6],
      ] as const) {
        at(MATERIAL.pole).box(
          cx + dx - 0.15,
          cz + dz - 0.15,
          cx + dx + 0.15,
          cz + dz + 0.15,
          roof,
          roof + 2.2,
          WHITE,
        );
      }
      at(MATERIAL.tank).tank(cx, cz, 2.3, roof + 2.2, roof + 6.4, 1.6, WHITE);
    }
    if (building.sign !== null) {
      /* Over the shopfront on the street side: the north row faces north, the south row south. */
      const { lot } = building;
      const north = lot.z0 === 0;
      const face = north ? lot.z0 : lot.z1;
      const out = north ? -1 : 1;
      const width = lot.x1 - lot.x0;
      const sign = building.sign;
      if (sign.shape === 'band') {
        const z0 = Math.min(face, face + out * 0.35);
        at(MATERIAL.neon).box(
          lot.x0 + width * 0.12,
          z0,
          lot.x1 - width * 0.12,
          z0 + 0.35,
          3.1,
          3.9,
          sign.colour,
        );
      } else {
        const z0 = Math.min(face, face + out * 1.3);
        at(MATERIAL.neon).box(
          lot.x0 + 1.2,
          z0,
          lot.x0 + 1.5,
          z0 + 1.3,
          4,
          4 + sign.height,
          sign.colour,
        );
      }
    }
    if (building.spire > 0) {
      const cx = (top.x0 + top.x1) / 2;
      const cz = (top.z0 + top.z1) / 2;
      at(MATERIAL.spire).box(
        cx - 0.7,
        cz - 0.7,
        cx + 0.7,
        cz + 0.7,
        top.y1,
        top.y1 + building.spire,
        WHITE,
      );
    }
  }

  /* The streets, to the middle of each, and the pavement round the lot, a kerb above them. */
  at(MATERIAL.street).top(
    -AVENUE / 2,
    -STREET / 2,
    LOT_X + AVENUE / 2,
    LOT_Z + STREET / 2,
    0,
    WHITE,
    6,
  );
  at(MATERIAL.sidewalk).box(
    -SIDEWALK,
    -SIDEWALK,
    LOT_X + SIDEWALK,
    LOT_Z + SIDEWALK,
    0,
    0.15,
    WHITE,
  );
  /* Street lights along every kerb, the warm points a street at dusk is drawn by. */
  const lamp = (x: number, z: number): void => {
    at(MATERIAL.pole).box(x - 0.1, z - 0.1, x + 0.1, z + 0.1, 0.15, 7, WHITE);
    at(MATERIAL.lamp).box(x - 0.35, z - 0.25, x + 0.35, z + 0.25, 7, 7.3, WHITE);
  };
  const kerb = SIDEWALK - 0.8;
  for (let x = 6; x < LOT_X; x += LAMP_SPACING) {
    lamp(x, -kerb);
    lamp(x, LOT_Z + kerb);
  }
  for (let z = 10; z < LOT_Z; z += LAMP_SPACING) {
    lamp(-kerb, z);
    lamp(LOT_X + kerb, z);
  }

  const [ox, oz] = blockOrigin(bx, bz);
  const transform = new Float32Array(16);
  transform[0] = 1;
  transform[5] = 1;
  transform[10] = 1;
  transform[15] = 1;
  transform[12] = ox;
  transform[14] = oz;

  const meshes: RawMesh[] = [];
  for (let material = 0; material < MATERIAL_COUNT; material += 1) {
    const made = at(material).mesh(material, transform, TEXTURED.has(material));
    if (made !== null) meshes.push(made);
  }
  return meshes;
}
