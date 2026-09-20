import { expect, test } from 'vitest';

import { createVolume, fuseDepth, type SurfaceView } from './fusion.ts';
import { lookAt } from './testScene.ts';

/**
 * **Many views averaged into one surface, and what a view does not know left alone.**
 *
 * The scene is a sphere, because a sphere's distance field is known exactly everywhere — so the
 * volume can be compared with the truth rather than with itself. What has to hold: the zero
 * crossing is where the sphere is; space in front of it is carved out; space behind it is
 * untouched, because a depth map knows nothing about the far side of what it sees; a surface only
 * one view saw is kept, at the weight one view is worth; and a grazing view is worth less than a
 * square one.
 */

const WIDTH = 64;
const HEIGHT = 64;
const INTRINSICS = [64, 64, WIDTH / 2, HEIGHT / 2] as const;
const RADIUS = 0.6;

/** Where a camera-space point sits in the world: the projection run backwards. */
function toWorld(
  worldToCamera: Float64Array,
  view: readonly [number, number, number],
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] +=
        (worldToCamera[r * 4 + c] as number) *
        ((view[r] as number) - (worldToCamera[r * 4 + 3] as number));
    }
  }
  return out;
}

/** The sphere at the origin, seen from `eye`: depth along the camera's axis, zero where missed. */
function viewOf(eye: readonly [number, number, number]): SurfaceView {
  const worldToCamera = lookAt(eye, [0, 0, 0]);
  const depth = new Float32Array(WIDTH * HEIGHT);
  const coverage = new Float32Array(WIDTH * HEIGHT);
  const [fx, fy, cx, cy] = INTRINSICS;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      /* A point one metre down this pixel's ray, in the world, and the direction to it. */
      const ahead = toWorld(worldToCamera, [(x + 0.5 - cx) / fx, (y + 0.5 - cy) / fy, 1]);
      const raw = [0, 1, 2].map((k) => (ahead[k] as number) - (eye[k] as number));
      const length = Math.sqrt(
        (raw[0] as number) * (raw[0] as number) +
          (raw[1] as number) * (raw[1] as number) +
          (raw[2] as number) * (raw[2] as number),
      );
      const dir = raw.map((value) => (value as number) / length);
      /* Ray against the sphere at the origin, from the eye. */
      const b =
        2 *
        ((eye[0] as number) * (dir[0] as number) +
          (eye[1] as number) * (dir[1] as number) +
          (eye[2] as number) * (dir[2] as number));
      const c =
        (eye[0] as number) * (eye[0] as number) +
        (eye[1] as number) * (eye[1] as number) +
        (eye[2] as number) * (eye[2] as number) -
        RADIUS * RADIUS;
      const discriminant = b * b - 4 * c;
      if (discriminant < 0) continue;
      const t = (-b - Math.sqrt(discriminant)) / 2;
      if (!(t > 0)) continue;
      const hit = [0, 1, 2].map((k) => (eye[k] as number) + t * (dir[k] as number));
      /* Along the camera's own axis, which is what the fusion compares a sample against. */
      let along = worldToCamera[11] as number;
      for (let k = 0; k < 3; k += 1) along += (worldToCamera[8 + k] as number) * (hit[k] as number);
      depth[y * WIDTH + x] = along;
      coverage[y * WIDTH + x] = 1;
    }
  }
  return {
    depth,
    coverage,
    camera: { width: WIDTH, height: HEIGHT, intrinsics: INTRINSICS, worldToCamera },
  };
}

const SPACING = 0.05;
const SIDE = 41;
const ORIGIN = [-1, -1, -1] as const;

function volumeOf(views: readonly SurfaceView[]) {
  const volume = createVolume([SIDE, SIDE, SIDE], ORIGIN, SPACING);
  fuseDepth(views, volume);
  return volume;
}

/** Where a sample sits and how far it really is from the sphere. */
function truthAt(i: number, j: number, k: number): number {
  const x = (ORIGIN[0] as number) + i * SPACING;
  const y = (ORIGIN[1] as number) + j * SPACING;
  const z = (ORIGIN[2] as number) + k * SPACING;
  return Math.sqrt(x * x + y * y + z * z) - RADIUS;
}

/*
 * The eight corners of a cube about the sphere, rather than the six face directions. **Two of those
 * six would have been a camera looking straight down its own up vector**, which `lookAt` now
 * refuses; and the corners see every part of the surface at a decent angle, which is the arrangement
 * a real capture walking around something produces anyway.
 */
const CORNER = 2.2 / Math.sqrt(3);
const ALL_ROUND: readonly (readonly [number, number, number])[] = [
  [CORNER, CORNER, CORNER],
  [CORNER, CORNER, -CORNER],
  [CORNER, -CORNER, CORNER],
  [CORNER, -CORNER, -CORNER],
  [-CORNER, CORNER, CORNER],
  [-CORNER, CORNER, -CORNER],
  [-CORNER, -CORNER, CORNER],
  [-CORNER, -CORNER, -CORNER],
];

test('A SPHERE SEEN FROM ALL ROUND IS THE SPHERE, and the distance near it is the true one', () => {
  const volume = volumeOf(ALL_ROUND.map(viewOf));
  const truncation = SPACING * 3;
  const errors: number[] = [];
  let compared = 0;
  let worst = 0;
  for (let k = 0; k < SIDE; k += 1) {
    for (let j = 0; j < SIDE; j += 1) {
      for (let i = 0; i < SIDE; i += 1) {
        const at = (k * SIDE + j) * SIDE + i;
        if (!((volume.weight[at] as number) > 0)) continue;
        const truth = truthAt(i, j, k);
        /* Only inside the band the fusion claims to know: past it the value is truncated. */
        if (Math.abs(truth) > truncation * 0.8) continue;
        compared += 1;
        const off = Math.abs((volume.distance[at] as number) - truth);
        errors.push(off);
        worst = Math.max(worst, off);
      }
    }
  }
  expect(compared).toBeGreaterThan(2000);
  /*
   * **Read as a distribution rather than as a worst case**, because the worst case is a sample at
   * the very edge of the band whose value saturates at the truncation — 0.096 m, and it is the same
   * with and without the normal correction that halved everything else. What the fusion is actually
   * doing is in the median and the ninetieth: 11 mm and 43 mm against a sample spacing of 50.
   */
  errors.sort((a, b) => a - b);
  expect(errors[Math.floor(errors.length / 2)] as number).toBeLessThan(0.02);
  expect(errors[Math.floor(errors.length * 0.9)] as number).toBeLessThan(0.06);
  expect(worst).toBeLessThan(SPACING * 3);
});

test('the space in front of a surface is carved out and the space behind it is left alone', () => {
  const volume = volumeOf(ALL_ROUND.map(viewOf));
  const middle = Math.floor(SIDE / 2);
  /* The centre of the sphere: every view has it behind a surface, so nobody may claim it. */
  const centre = (middle * SIDE + middle) * SIDE + middle;
  expect(volume.weight[centre]).toBe(0);
  expect(volume.distance[centre]).toBe(0);

  /*
   * A sample in clear air between the sphere and a camera: 0.55 on every axis, which is 0.95 from
   * the centre and so a third of a metre outside a sphere of 0.6 — past the truncation, so it is
   * free space at the full positive distance rather than a number near a surface.
   */
  const step = Math.round(1.55 / SPACING);
  const air = (step * SIDE + step) * SIDE + step;
  expect(volume.weight[air]).toBeGreaterThan(0);
  expect(volume.distance[air]).toBeCloseTo(SPACING * 3, 5);
});

test('a surface only one view saw is kept, at the weight one view is worth', () => {
  const one = volumeOf([viewOf([2.2, 0, 0])]);
  const all = volumeOf(ALL_ROUND.map(viewOf));
  let seenByOne = 0;
  let lighter = 0;
  for (let at = 0; at < one.weight.length; at += 1) {
    if (!((one.weight[at] as number) > 0)) continue;
    seenByOne += 1;
    /* Kept — and worth less than the same sample is once everything has looked at it. */
    if ((one.weight[at] as number) < (all.weight[at] as number)) lighter += 1;
  }
  expect(seenByOne).toBeGreaterThan(500);
  expect(lighter / seenByOne).toBeGreaterThan(0.5);
});

test('A VIEW THAT GRAZES A SURFACE IS WORTH LESS THAN ONE THAT LOOKS STRAIGHT AT IT', () => {
  /*
   * One view of the sphere, read as a distribution rather than at two named samples — which is what
   * the first attempt did, and it passed with the angle taken out of the weight entirely, because
   * the sample it called the rim was one the view never saw. What the weight actually does is
   * spread: the squarely-seen samples reach 0.999 and **half of everything seen is below 0.7**,
   * which is the sphere turning away. With the angle gone every one of them would be exactly the
   * coverage, and the spread is the whole claim.
   */
  const volume = volumeOf([viewOf(ALL_ROUND[0] as readonly [number, number, number])]);
  let seen = 0;
  let most = 0;
  let oblique = 0;
  for (let at = 0; at < volume.weight.length; at += 1) {
    const weight = volume.weight[at] as number;
    if (!(weight > 0)) continue;
    seen += 1;
    most = Math.max(most, weight);
    if (weight < 0.7) oblique += 1;
  }
  expect(seen).toBeGreaterThan(2000);
  expect(most).toBeGreaterThan(0.95);
  expect(oblique / seen).toBeGreaterThan(0.3);
});

test('fusing in two halves is fusing in one, and the same views give the same volume', () => {
  const views = ALL_ROUND.map(viewOf);
  const once = volumeOf(views);
  const twice = createVolume([SIDE, SIDE, SIDE], ORIGIN, SPACING);
  fuseDepth(views.slice(0, 3), twice);
  fuseDepth(views.slice(3), twice);
  let worst = 0;
  for (let at = 0; at < once.distance.length; at += 1) {
    worst = Math.max(
      worst,
      Math.abs((once.distance[at] as number) - (twice.distance[at] as number)),
    );
    expect(twice.weight[at]).toBeCloseTo(once.weight[at] as number, 5);
  }
  /* A weighted mean accumulated in two passes is the same mean, to single precision. */
  expect(worst).toBeLessThan(1e-6);
});
