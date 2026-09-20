import { expect, test } from 'vitest';

import {
  FLIGHT_LENGTH,
  FLIGHT_SPEED,
  LOOK_AHEAD,
  LOOK_TILT,
  TURN_RADIUS,
  flightAt,
  flightLook,
} from './flight';
import {
  AVENUE,
  CITY_COLS,
  CITY_ROWS,
  LOT_X,
  LOT_Z,
  PITCH_X,
  PITCH_Z,
  STREET,
  blockOrigin,
  cityBlocks,
} from './manhattan';

/**
 * **What this file is for: a flight that can be flown at any speed without meeting the city.**
 *
 * The city's camera follows this loop, so a mistake in it is a camera inside a tower. It is
 * sampled every quarter metre round the whole loop, and every sample is held to the three things
 * the flight promises: it moves at the speed it says, it never comes near a lot, and it goes both
 * down a street and above the roofs — the two places whose drawn-cluster counts are its reason.
 */

const STEP = 0.25;

/** Every sample round the loop, and one past the end so the join is checked too. */
function samples(): Float64Array[] {
  const out: Float64Array[] = [];
  for (let s = 0; s <= FLIGHT_LENGTH + STEP; s += STEP) {
    const at = new Float64Array(3);
    flightAt(s, at);
    out.push(at);
  }
  return out;
}

/** How far a point is from the nearest lot of the published grid, along the ground. */
function clearance(x: number, z: number): number {
  let nearest = Infinity;
  for (const [bx, bz] of cityBlocks()) {
    const [ox, oz] = blockOrigin(bx, bz);
    const dx = Math.max(ox - x, 0, x - (ox + LOT_X));
    const dz = Math.max(oz - z, 0, z - (oz + LOT_Z));
    nearest = Math.min(nearest, Math.hypot(dx, dz));
  }
  return nearest;
}

test('THE FLIGHT MOVES A METRE ALONG THE GROUND FOR EVERY METRE ASKED, round the join', () => {
  /*
   * A wrong arc centre, a wrong starting angle or a turn the wrong way is a jump or a stall in
   * this, which the camera would show as a cut.
   */
  const points = samples();
  let least = Infinity;
  let most = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Float64Array;
    const b = points[i] as Float64Array;
    const step = Math.hypot(
      (b[0] as number) - (a[0] as number),
      (b[2] as number) - (a[2] as number),
    );
    least = Math.min(least, step);
    most = Math.max(most, step);
  }
  /* A chord of a quarter metre on a four-metre arc is shorter than its arc by a hair. */
  expect(least).toBeGreaterThan(STEP * 0.999);
  expect(most).toBeLessThan(STEP * 1.0001);
});

test('THE LOOP IS ITS STRAIGHT RUNS WITH EACH CORNER ROUNDED, and no longer', () => {
  /*
   * Six right-angled corners, each replacing two cuts of a radius with a quarter circle; the three
   * waypoints between them set a height and turn nothing.
   */
  const corners = 6;
  const straight = 316 + 270 + 790 + 540 + 1106 + 270;
  expect(FLIGHT_LENGTH).toBeCloseTo(
    straight - corners * (2 * TURN_RADIUS - (Math.PI / 2) * TURN_RADIUS),
    6,
  );
  /* And it is flown in about two minutes, which is what the speed was chosen for. */
  expect(FLIGHT_LENGTH / FLIGHT_SPEED).toBeGreaterThan(100);
  expect(FLIGHT_LENGTH / FLIGHT_SPEED).toBeLessThan(150);
});

test('THE FLIGHT NEVER COMES NEARER A LOT THAN THE MIDDLE OF A CROSS STREET', () => {
  /*
   * **Half a street, and no nearer at a corner.** The narrowest place the loop goes is a cross
   * street's middle, nine metres from each kerb's lot; a corner's arc bulges away from the inside
   * corner, so it adds nothing nearer. An arc on the wrong side, or one wide enough to start its
   * turn past the corner's lot line, comes closer.
   */
  let least = Infinity;
  for (const at of samples()) least = Math.min(least, clearance(at[0] as number, at[2] as number));
  expect(least).toBeCloseTo(STREET / 2, 6);
});

test('IT STAYS OVER THE PUBLISHED GRID, where there are blocks to stream', () => {
  for (const at of samples()) {
    expect(Math.abs(at[0] as number)).toBeLessThan((CITY_COLS / 2) * PITCH_X);
    expect(Math.abs(at[2] as number)).toBeLessThan((CITY_ROWS / 2) * PITCH_Z);
  }
});

test('IT GOES DOWN A CROSS STREET AT THE THIRD FLOOR AND ABOVE THE ROOFS', () => {
  let street = 0;
  let above = 0;
  for (const at of samples()) {
    const x = at[0] as number;
    const y = at[1] as number;
    const z = at[2] as number;
    /* In the middle of a cross street, between the crossings at either end of its block. */
    const onStreet = Math.abs(z / PITCH_Z - Math.round(z / PITCH_Z)) * PITCH_Z < 0.01;
    const offAvenue = Math.abs(x / PITCH_X - Math.round(x / PITCH_X)) * PITCH_X > AVENUE / 2;
    if (onStreet && offAvenue && y <= 12) street += STEP;
    if (y >= 190) above += STEP;
  }
  /* Both cross streets it takes, the whole block of each less its two crossings. */
  expect(street).toBeGreaterThan(2 * (PITCH_X - AVENUE) - 1);
  /*
   * And the high pass is level through the whole of it: on through midtown, across its north and
   * back down the far avenue — three runs of more than four hundred metres each — which is 1,523 m
   * above 190, so a pass that sagged anywhere along it comes in under the three runs.
   */
  expect(above).toBeGreaterThan(3 * 474);
});

test('THE HEIGHT RISES AND FALLS WITHOUT A STEP, and a climb starts and ends gently', () => {
  /*
   * The steepest stretch is the climb into midtown, 188 m over four blocks; and the slope
   * itself changes a little at a time, which is what a smoothstep between level waypoints buys —
   * a straight ramp would jump from level to its whole slope at the foot of the climb.
   */
  const points = samples();
  const height = (i: number) => (points[i] as Float64Array)[1] as number;
  let steepest = 0;
  let sharpest = 0;
  for (let i = 2; i < points.length; i += 1) {
    const slope = (height(i) - height(i - 1)) / STEP;
    const before = (height(i - 1) - height(i - 2)) / STEP;
    steepest = Math.max(steepest, Math.abs(slope));
    sharpest = Math.max(sharpest, Math.abs(slope - before));
  }
  expect(steepest).toBeGreaterThan(0.5);
  expect(steepest).toBeLessThan(1.5);
  expect(sharpest).toBeLessThan(0.01);
  /* And the look ahead is shorter than the shortest run, so the camera never looks through a corner. */
  expect(LOOK_AHEAD).toBeLessThan(PITCH_X - AVENUE);
});

test('A POINT IS WRITTEN INTO WHAT IT IS GIVEN, and any distance is a place on the loop', () => {
  const a = new Float64Array(3);
  const b = [0, 0, 0];
  flightAt(123.5, a);
  expect(Array.from(a)).not.toEqual([0, 0, 0]);
  for (const s of [123.5 + 3 * FLIGHT_LENGTH, 123.5 - FLIGHT_LENGTH]) {
    flightAt(s, b);
    for (let i = 0; i < 3; i += 1) expect(b[i]).toBeCloseTo(a[i] as number, 6);
  }
});

test('THE CAMERA LOOKS WHERE THE FLIGHT GOES, and tilts with a climb by a third of it', () => {
  /*
   * **A drone's shot rather than the path's.** Looking straight at the point sixty metres ahead
   * tilted the camera forty degrees up the climb into midtown and put the city out of the bottom
   * of the frame; the look follows a third of the rise, so the steepest tilt is a gentle one.
   */
  const eye = new Float64Array(3);
  const look = new Float64Array(3);
  const ahead = new Float64Array(3);
  let steepest = 0;
  for (let s = 0; s < FLIGHT_LENGTH; s += 1) {
    flightAt(s, eye);
    flightLook(s, eye, look);
    flightAt(s + LOOK_AHEAD, ahead);
    /* Along the ground it is the point ahead. */
    expect(look[0]).toBeCloseTo(ahead[0] as number, 9);
    expect(look[2]).toBeCloseTo(ahead[2] as number, 9);
    const rise = (look[1] as number) - (eye[1] as number);
    expect(rise).toBeCloseTo(((ahead[1] as number) - (eye[1] as number)) * LOOK_TILT, 9);
    const run = Math.hypot(
      (look[0] as number) - (eye[0] as number),
      (look[2] as number) - (eye[2] as number),
    );
    steepest = Math.max(steepest, (Math.atan2(Math.abs(rise), run) * 180) / Math.PI);
  }
  expect(steepest).toBeGreaterThan(10);
  expect(steepest).toBeLessThan(20);
});
