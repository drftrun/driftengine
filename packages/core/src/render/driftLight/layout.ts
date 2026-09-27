/**
 * Where DriftLight's volume exists: the bricks some light reaches, the grid that finds them, and
 * which lights reach each one.
 *
 * **Sparse, because light is.** A candle reaches a metre and a courtyard is forty, so a dense grid
 * would be almost entirely zeros: a brick is kept only where a light's reach touches it, by the
 * exact sphere-against-box test rather than the box-against-box one, which takes the corner bricks a
 * sphere's box reaches and the sphere does not.
 *
 * **A brick is four samples a side and shares its faces with its neighbours**, so it spans three
 * spacings and two bricks that meet agree on the samples between them. That is what lets the shader
 * filter inside one brick with the hardware's trilinear lookup and never see a seam where it crosses
 * into the next.
 *
 * **Numbered in the index's own order**, x fastest, so a layout depends on where the lights are and
 * not on the order a scene listed them in: two loads of one scene produce one atlas.
 *
 * What it gives up: the index is dense over the lights' bounding box, so lights spread thinly over a
 * kilometre would make a large, mostly empty grid. It refuses one past `MAX_INDEX_AXIS` bricks on
 * any axis and says to make one field per region instead; what would change that is a hashed
 * index, which costs the shader a probe loop.
 */

/** Samples on each axis of a brick. The first and last are shared with the neighbour. */
export const BRICK_SAMPLES = 4;

/**
 * Bricks on each axis of the index, which is a 3D texture: 256 is the least `MAX_3D_TEXTURE_SIZE`
 * WebGL2 promises, and a limit on the cell count alone would pass a grid 300 bricks long and one
 * wide that a device is free to refuse. At a metre a brick, a field 256 m on a side.
 */
export const MAX_INDEX_AXIS = 256;

/** What the layout reads of a light: where it is and how far it reaches. */
export interface LightReach {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export interface LightFieldLayout {
  /** Metres between two samples. */
  readonly spacing: number;
  /** Metres a brick spans: three spacings. */
  readonly span: number;
  /** The world position of brick (0, 0, 0)'s first sample. */
  readonly origin: readonly [number, number, number];
  /** Bricks on each axis of the index. */
  readonly dims: readonly [number, number, number];
  /** Per index cell, x fastest: the brick's number plus one, or 0 where there is no brick. */
  readonly index: Uint32Array;
  /** How many bricks there are. */
  readonly count: number;
  /** Each brick's cell in the index, three integers a brick. */
  readonly brickCoords: Int32Array;
  /** Where brick `b`'s lights start in `lights`; `lightStart[b + 1]` is where they end. */
  readonly lightStart: Uint32Array;
  /** The lights reaching each brick, in the order the scene listed them. */
  readonly lights: Uint32Array;
}

const EMPTY: LightFieldLayout = {
  spacing: 0,
  span: 0,
  origin: [0, 0, 0],
  dims: [0, 0, 0],
  index: new Uint32Array(0),
  count: 0,
  brickCoords: new Int32Array(0),
  lightStart: new Uint32Array(1),
  lights: new Uint32Array(0),
};

/** The bricks `lights` reach at `spacing` metres between samples. Built once; not a frame path. */
export function layoutLightField(lights: readonly LightReach[], spacing: number): LightFieldLayout {
  if (!(spacing > 0)) {
    throw new Error(`layoutLightField: spacing is ${String(spacing)} and must be positive.`);
  }
  const span = spacing * (BRICK_SAMPLES - 1);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let reaching = 0;
  for (const light of lights) {
    if (!(light.radius > 0)) continue;
    reaching += 1;
    const at = [light.x, light.y, light.z];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] as number, (at[axis] as number) - light.radius);
      max[axis] = Math.max(max[axis] as number, (at[axis] as number) + light.radius);
    }
  }
  if (reaching === 0) return EMPTY;

  const origin = min.map((value) => Math.floor(value / span) * span) as [number, number, number];
  const dims = max.map(
    (value, axis) => Math.floor((value - (origin[axis] as number)) / span) + 1,
  ) as [number, number, number];
  if (dims.some((across) => across > MAX_INDEX_AXIS)) {
    throw new Error(
      `layoutLightField: these lights span ${dims.join(' x ')} bricks against a limit of ` +
        `${MAX_INDEX_AXIS} on each axis. Give each region of the world a field of its own, or a ` +
        'coarser spacing.',
    );
  }
  const cells = dims[0] * dims[1] * dims[2];

  /* Which cells a light reaches, visited twice: once to mark and count, once to list. */
  const visit = (each: (light: number, cell: number) => void): void => {
    lights.forEach((light, number) => {
      if (!(light.radius > 0)) return;
      const at = [light.x, light.y, light.z];
      const low = [0, 0, 0];
      const high = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        const o = origin[axis] as number;
        const p = at[axis] as number;
        low[axis] = Math.max(0, Math.floor((p - light.radius - o) / span));
        high[axis] = Math.min(
          (dims[axis] as number) - 1,
          Math.floor((p + light.radius - o) / span),
        );
      }
      const reach2 = light.radius * light.radius;
      for (let k = low[2] as number; k <= (high[2] as number); k++) {
        for (let j = low[1] as number; j <= (high[1] as number); j++) {
          for (let i = low[0] as number; i <= (high[0] as number); i++) {
            const cell = [i, j, k];
            let d2 = 0;
            for (let axis = 0; axis < 3; axis++) {
              const lo = (origin[axis] as number) + (cell[axis] as number) * span;
              const p = at[axis] as number;
              const out = Math.max(lo - p, 0, p - (lo + span));
              d2 += out * out;
            }
            if (d2 <= reach2) each(number, i + dims[0] * (j + dims[1] * k));
          }
        }
      }
    });
  };

  const index = new Uint32Array(cells);
  let pairs = 0;
  visit((_, cell) => {
    index[cell] = 1;
    pairs += 1;
  });
  let count = 0;
  for (let cell = 0; cell < cells; cell++) if (index[cell] !== 0) index[cell] = ++count;

  const brickCoords = new Int32Array(count * 3);
  for (let cell = 0; cell < cells; cell++) {
    const brick = (index[cell] as number) - 1;
    if (brick < 0) continue;
    brickCoords[brick * 3] = cell % dims[0];
    brickCoords[brick * 3 + 1] = Math.floor(cell / dims[0]) % dims[1];
    brickCoords[brick * 3 + 2] = Math.floor(cell / (dims[0] * dims[1]));
  }

  const lightStart = new Uint32Array(count + 1);
  visit((_, cell) => {
    lightStart[index[cell] as number] = (lightStart[index[cell] as number] as number) + 1;
  });
  for (let brick = 0; brick < count; brick++) {
    lightStart[brick + 1] = (lightStart[brick + 1] as number) + (lightStart[brick] as number);
  }
  const filled = lightStart.slice(0, count);
  const listed = new Uint32Array(pairs);
  visit((light, cell) => {
    const brick = (index[cell] as number) - 1;
    listed[filled[brick] as number] = light;
    filled[brick] = (filled[brick] as number) + 1;
  });

  return { spacing, span, origin, dims, index, count, brickCoords, lightStart, lights: listed };
}
