/**
 * The city's flight: a loop low up an avenue, into a cross street, climbing the next avenue into
 * midtown and on through it between its towers, back above the roofs with the skyline ahead, and
 * down again into the valley.
 *
 * **A path and not an orbit, because a fly-through is what shows occlusion culling.** In a street
 * the district is hidden behind its first building on each side and the drawn-cluster count
 * collapses; above the roofs everything is in view again and the count recovers. An orbit round
 * the skyline would see the same wall of towers all round and show neither.
 *
 * **Along the middle of the avenues and streets and nowhere else**, so it can be flown at any
 * height without meeting a building: every tower stands on its lot, and a lot never reaches past
 * its kerb. The only place the path leaves a centre line is a corner, where it turns on an arc
 * inside the crossing (`TURN_RADIUS`).
 *
 * **Parametrised by metres along the ground**, so a flight's speed is its own number and a held
 * frame at a fixed time is a fixed place. The height rises and falls between waypoints on a
 * smoothstep, level at each, so a climb starts and ends gently.
 */
import { PITCH_X, PITCH_Z, STREET } from './manhattan';

/** Metres a second along the ground: a drone's, once round the loop in under two minutes. */
export const FLIGHT_SPEED = 30;

/**
 * How wide the path turns a corner, in metres: half a cross street, **the widest arc that turns
 * inside the crossing.** A turn from an avenue into a street leaves the avenue's middle this far
 * short of the crossing's middle and joins the street's this far past it, and nine metres is still
 * inside a crossing thirty by eighteen — so the arc never comes nearer a building than the street
 * it turns into does, which `flight.test.ts` measures along the whole loop. The arc bulges away
 * from the inside corner, not toward it; a wider one would start its turn past the corner's lot
 * line.
 */
export const TURN_RADIUS = STREET / 2;

/** How far ahead along the path the camera looks, in metres: it turns its head before a corner. */
export const LOOK_AHEAD = 60;

/**
 * How much of the path's rise or fall ahead the camera tilts with: a third. Looking straight at
 * the point ahead tilted it forty degrees up the climb into midtown, and the city left the bottom
 * of the frame.
 */
export const LOOK_TILT = 1 / 3;

/**
 * The loop's corners and the heights it passes them at, as x, z, height in metres. Avenues are at
 * whole multiples of `PITCH_X` and cross streets at whole multiples of `PITCH_Z`; a waypoint in the
 * middle of a straight run turns nothing and only sets a height.
 */
const WAYPOINTS: readonly (readonly [number, number, number])[] = [
  /* Downtown's edge, low over an avenue: north up it at the third floor, over the street lights. */
  [0, 6 * PITCH_Z, 12],
  /* Left into a cross street: a canyon eighteen metres wide, the count's lowest. */
  [0, 2 * PITCH_Z, 12],
  /* Right, up the next avenue, climbing as midtown's towers rise ahead of it. */
  [-PITCH_X, 2 * PITCH_Z, 12],
  /* On through midtown at two hundred metres, above its setbacks and between its towers. */
  [-PITCH_X, -2 * PITCH_Z, 200],
  [-PITCH_X, -8 * PITCH_Z, 200],
  /* Across its north, and back south down the far avenue with the whole skyline ahead. */
  [PITCH_X, -8 * PITCH_Z, 200],
  [PITCH_X, -2 * PITCH_Z, 190],
  /* Falling into the valley, and west along a last cross street to the start. */
  [PITCH_X, 3 * PITCH_Z, 14],
  [PITCH_X, 6 * PITCH_Z, 12],
];

/**
 * The loop as pieces, worked out once: each a straight run or a corner's arc. Eight numbers a
 * piece — where along the loop it starts, its length, then for a run its first point and direction
 * or for an arc its centre, the angle it starts at and the sign of its turn, then which it is (a
 * run is 0) and one spare so a piece is two vec4s.
 */
const PIECE_FLOATS = 8;

interface Loop {
  readonly pieces: Float64Array;
  readonly count: number;
  /** Where along the loop each waypoint is left — the end of its corner — and its height there. */
  readonly at: Float64Array;
  readonly heights: Float64Array;
  readonly length: number;
}

function buildLoop(): Loop {
  const n = WAYPOINTS.length;
  const point = (i: number) => WAYPOINTS[((i % n) + n) % n] as readonly [number, number, number];
  /* How far each corner's arc reaches back and forward along its two runs. */
  const cut = new Float64Array(n);
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const [ax, az] = point(i - 1);
    const [bx, bz] = point(i);
    const [cx, cz] = point(i + 1);
    const inAngle = Math.atan2(bz - az, bx - ax);
    const outAngle = Math.atan2(cz - bz, cx - bx);
    let angle = outAngle - inAngle;
    if (angle > Math.PI) angle -= 2 * Math.PI;
    if (angle < -Math.PI) angle += 2 * Math.PI;
    turn[i] = angle;
    cut[i] = TURN_RADIUS * Math.tan(Math.abs(angle) / 2);
  }

  const pieces: number[] = [];
  const at = new Float64Array(n);
  const heights = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const [bx, bz, height] = point(i);
    const [cx, cz] = point(i + 1);
    const length = Math.hypot(cx - bx, cz - bz);
    const dx = (cx - bx) / length;
    const dz = (cz - bz) / length;
    /* The run from the end of corner i's arc to the start of corner i + 1's. */
    const run = length - (cut[i] as number) - (cut[(i + 1) % n] as number);
    if (run < 0)
      throw new Error(`[driftengine] the flight's waypoint ${i} is too close to the next`);
    at[i] = s;
    heights[i] = height;
    pieces.push(0, run, bx + dx * (cut[i] as number), bz + dz * (cut[i] as number), dx, dz, 0, 0);
    s += run;
    /* Corner i + 1's arc: centre to the side it turns toward, from the end of this run. */
    const j = (i + 1) % n;
    const angle = turn[j] as number;
    if (angle !== 0) {
      const side = Math.sign(angle);
      const ex = cx - dx * (cut[j] as number);
      const ez = cz - dz * (cut[j] as number);
      /*
       * The centre is a radius off to the side the path turns toward: the heading turned a
       * quarter in the sense `atan2(z, x)` counts, which is (-dz, dx), or against it for a turn
       * to the other side.
       */
      const ox = ex - side * dz * TURN_RADIUS;
      const oz = ez + side * dx * TURN_RADIUS;
      const start = Math.atan2(ez - oz, ex - ox);
      pieces.push(0, Math.abs(angle) * TURN_RADIUS, ox, oz, start, side, 1, 0);
      s += Math.abs(angle) * TURN_RADIUS;
    }
  }
  /* The start of each piece, now that every length is known. */
  let running = 0;
  for (let p = 0; p < pieces.length; p += PIECE_FLOATS) {
    pieces[p] = running;
    running += pieces[p + 1] as number;
  }
  return {
    pieces: Float64Array.from(pieces),
    count: pieces.length / PIECE_FLOATS,
    at,
    heights,
    length: running,
  };
}

const LOOP = buildLoop();

/** Metres along the ground once round the loop. */
export const FLIGHT_LENGTH = LOOP.length;

/** The height at `s` metres along the loop: level at each waypoint, a smoothstep between. */
function heightAt(s: number): number {
  const { at, heights } = LOOP;
  const n = at.length;
  for (let i = 0; i < n; i += 1) {
    const from = at[i] as number;
    const to = at[(i + 1) % n] as number;
    const span = (((to - from) % LOOP.length) + LOOP.length) % LOOP.length;
    const into = (((s - from) % LOOP.length) + LOOP.length) % LOOP.length;
    if (into <= span) {
      const t = span > 0 ? into / span : 0;
      const k = t * t * (3 - 2 * t);
      const a = heights[i] as number;
      const b = heights[(i + 1) % n] as number;
      return a + (b - a) * k;
    }
  }
  return heights[0] as number;
}

/**
 * Where the flight is `s` metres along the ground, into `out` as x, y, z — any `s`, the loop
 * repeating. Allocates nothing, because the city calls it twice a frame.
 */
export function flightAt(s: number, out: Float64Array | number[]): void {
  const { pieces, count, length } = LOOP;
  const along = ((s % length) + length) % length;
  /* The last piece that starts at or before it. */
  let p = 0;
  while (p < count - 1 && along >= (pieces[(p + 1) * PIECE_FLOATS] as number)) p += 1;
  const base = p * PIECE_FLOATS;
  const into = along - (pieces[base] as number);
  const a = pieces[base + 2] as number;
  const b = pieces[base + 3] as number;
  const c = pieces[base + 4] as number;
  const d = pieces[base + 5] as number;
  if (pieces[base + 6] === 0) {
    out[0] = a + c * into;
    out[2] = b + d * into;
  } else {
    const angle = c + (d * into) / TURN_RADIUS;
    out[0] = a + TURN_RADIUS * Math.cos(angle);
    out[2] = b + TURN_RADIUS * Math.sin(angle);
  }
  out[1] = heightAt(along);
}

/**
 * Where the camera at `s` looks, into `out`: the point `LOOK_AHEAD` along the loop, raised or
 * lowered from the eye by `LOOK_TILT` of the path's own change of height. `eye` is `flightAt(s)`.
 */
export function flightLook(s: number, eye: ArrayLike<number>, out: Float64Array | number[]): void {
  flightAt(s + LOOK_AHEAD, out);
  const height = eye[1] as number;
  out[1] = height + ((out[1] as number) - height) * LOOK_TILT;
}
