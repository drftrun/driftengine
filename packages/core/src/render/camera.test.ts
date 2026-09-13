import { expect, test } from 'vitest';
import { Camera } from './camera.ts';

/** A point at the centre of view lands at the centre of the viewport. */
test('project puts a point straight ahead in the middle of the canvas', () => {
  const camera = new Camera();
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 0;
  camera.lookAt(0, 0, -10);
  camera.updateMatrices(2);

  const out = [0, 0];
  expect(camera.project(out, 0, 0, -10, 800, 400)).toBe(true);
  expect(out[0]).toBeCloseTo(400, 3);
  expect(out[1]).toBeCloseTo(200, 3);
});

/*
 * Behind the camera is not a small number, it is no answer at all: the perspective
 * divide flips the sign and a caller that trusted it would place an affordance on the
 * opposite side of the screen from the thing it belongs to.
 */
test('project refuses a point behind the camera rather than mirroring it', () => {
  const camera = new Camera();
  camera.lookAt(0, 0, -10);
  camera.updateMatrices(2);

  const out = [-1, -1];
  expect(camera.project(out, 0, 0, 10, 800, 400)).toBe(false);
  expect(out).toEqual([-1, -1]);
});

/** Y is measured down the page, because that is where a DOM affordance goes. */
test('project reports y downward, as CSS does', () => {
  const camera = new Camera();
  camera.lookAt(0, 0, -10);
  camera.updateMatrices(1);

  const above = [0, 0];
  camera.project(above, 0, 1, -10, 500, 500);
  const below = [0, 0];
  camera.project(below, 0, -1, -10, 500, 500);
  expect(above[1]).toBeLessThan(below[1]);
});

/** The centre pixel gives the camera's own forward, which is the one ray we can name. */
test('rayThrough the centre pixel points along the camera forward', () => {
  const camera = new Camera();
  camera.lookAt(0, 0, -10);
  camera.updateMatrices(1.6);

  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  camera.rayThrough(origin, direction, 400, 250, 800, 500);

  expect(direction[0]).toBeCloseTo(camera.forward[0], 4);
  expect(direction[1]).toBeCloseTo(camera.forward[1], 4);
  expect(direction[2]).toBeCloseTo(camera.forward[2], 4);
});

test('rayThrough returns a unit direction', () => {
  const camera = new Camera();
  camera.lookAt(3, -1, -8);
  camera.updateMatrices(1.6);

  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  camera.rayThrough(origin, direction, 137, 42, 800, 500);
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  expect(length).toBeCloseTo(1, 6);
});

/*
 * Round trip: project a known point, cast a ray back through the pixel it landed on, and
 * the ray must pass through the point. This is the property that actually matters, and it
 * is the one that catches a y-flip — which no single-axis assertion does, because a
 * flipped ray through the centre pixel is still correct.
 */
test('a ray through a projected point passes back through that point', () => {
  const camera = new Camera();
  camera.position[1] = 2;
  camera.lookAt(0, 0, -10);
  camera.updateMatrices(1.6);

  const target = [1.5, -0.75, -6];
  const screen = [0, 0];
  expect(camera.project(screen, target[0], target[1], target[2], 800, 500)).toBe(true);

  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  camera.rayThrough(origin, direction, screen[0], screen[1], 800, 500);

  const toTarget = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const distance = Math.hypot(toTarget[0], toTarget[1], toTarget[2]);
  expect(direction[0] * distance).toBeCloseTo(toTarget[0], 3);
  expect(direction[1] * distance).toBeCloseTo(toTarget[1], 3);
  expect(direction[2] * distance).toBeCloseTo(toTarget[2], 3);
});

/*
 * Straight up and straight down, from somewhere that is not the origin.
 *
 * **The position is the whole test and it is why an earlier version of it passed while the bug
 * shipped.** At a pitch of ±π/2 the forward vector's horizontal part is `cos(π/2)`, which is
 * 6.1e-17 rather than zero, and a view built by aiming at `position + forward` keeps a usable
 * basis only while that epsilon survives the addition. In a `Float32Array` it survives at the
 * origin and is rounded away by any coordinate above about half a metre — so the same aim is
 * well conditioned at (0, 1.4, 0) and singular at (0, 1.4, 5), and every test written at the
 * origin reports the healthy case.
 *
 * What a singular view costs is not a wrong angle, it is no picture: every vertex collapses to
 * one point, the face keeps its clear colour, and the inverse silently keeps whatever the
 * previous aim left in it. Measured on a reflection probe, whose up and down faces are the only
 * two that ever aim there: both came back holding the same stale image of a sideways face.
 */
const OFF_ORIGIN: readonly [number, number, number] = [-0.023, 1.116, -1.389];

function aimed(pitch: number, roll = 0): Camera {
  const camera = new Camera();
  camera.position[0] = OFF_ORIGIN[0];
  camera.position[1] = OFF_ORIGIN[1];
  camera.position[2] = OFF_ORIGIN[2];
  camera.pitch = pitch;
  camera.roll = roll;
  camera.updateMatrices(1);
  return camera;
}

/** Where a world point lands in clip space, normalised. */
function ndcOf(camera: Camera, x: number, y: number, z: number): readonly [number, number] {
  const m = camera.viewProjection;
  const cx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  const cy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  const cw = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
  return [cx / cw, cy / cw];
}

test('a camera aimed straight up from off the origin keeps an invertible view', () => {
  const camera = aimed(Math.PI / 2);

  /* The right and up axes, which are the two a collapsing basis loses. Rows of the view
     matrix, so columns 0, 1 and 2 of each row in gl-matrix's layout. */
  const right = Math.hypot(camera.view[0] ?? 0, camera.view[4] ?? 0, camera.view[8] ?? 0);
  const up = Math.hypot(camera.view[1] ?? 0, camera.view[5] ?? 0, camera.view[9] ?? 0);
  expect(right).toBeCloseTo(1, 5);
  expect(up).toBeCloseTo(1, 5);

  /* And the inverse is this aim's own rather than the last one's, which is what a failed
     invert leaves behind. */
  const a = camera.viewProjection;
  const b = camera.invViewProjection;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[row + k * 4] ?? 0) * (b[k + col * 4] ?? 0);
      expect(sum).toBeCloseTo(row === col ? 1 : 0, 4);
    }
  }
});

test('a camera aimed straight down from off the origin keeps an invertible view', () => {
  const camera = aimed(-Math.PI / 2);
  const right = Math.hypot(camera.view[0] ?? 0, camera.view[4] ?? 0, camera.view[8] ?? 0);
  const up = Math.hypot(camera.view[1] ?? 0, camera.view[5] ?? 0, camera.view[9] ?? 0);
  expect(right).toBeCloseTo(1, 5);
  expect(up).toBeCloseTo(1, 5);
});

/*
 * Which way up the vertical faces are, stated rather than left to whatever a basis happens to
 * produce: a cubemap face rendered with the wrong roll is a reflection that is rotated against
 * the five faces around it, and the seam is what a viewer sees.
 *
 * The orientation asserted is the limit of the yaw/pitch convention approached from below the
 * pole: tilting up at yaw 0 rolls screen-up from +Y round to +Z, and tilting down rolls it to
 * -Z. Screen right stays +X through both, because right never depends on pitch.
 */
test('straight up at yaw 0 puts +Z at the top of the frame and +X to the right', () => {
  const camera = aimed(Math.PI / 2);
  const [, upward] = ndcOf(camera, OFF_ORIGIN[0], OFF_ORIGIN[1] + 10, OFF_ORIGIN[2] + 1);
  expect(upward).toBeGreaterThan(0.01);
  const [rightward] = ndcOf(camera, OFF_ORIGIN[0] + 1, OFF_ORIGIN[1] + 10, OFF_ORIGIN[2]);
  expect(rightward).toBeGreaterThan(0.01);
});

test('straight down at yaw 0 puts -Z at the top of the frame and +X to the right', () => {
  const camera = aimed(-Math.PI / 2);
  const [, upward] = ndcOf(camera, OFF_ORIGIN[0], OFF_ORIGIN[1] - 10, OFF_ORIGIN[2] - 1);
  expect(upward).toBeGreaterThan(0.01);
  const [rightward] = ndcOf(camera, OFF_ORIGIN[0] + 1, OFF_ORIGIN[1] - 10, OFF_ORIGIN[2]);
  expect(rightward).toBeGreaterThan(0.01);
});

/* Two aims that differ must give two views. Identical matrices are the failure that put the
   same image on a probe's up and down faces. */
test('up and down are two different views', () => {
  const up = aimed(Math.PI / 2);
  const down = aimed(-Math.PI / 2);
  let differs = false;
  for (let i = 0; i < 16; i++) {
    if (Math.abs((up.view[i] ?? 0) - (down.view[i] ?? 0)) > 1e-6) differs = true;
  }
  expect(differs).toBe(true);
});

/* Roll still leans the frame at the pole, where the old construction had nothing to lean. */
test('roll turns the frame when the camera is aimed straight up', () => {
  const level = aimed(Math.PI / 2, 0);
  const leaned = aimed(Math.PI / 2, 0.6);
  const point: readonly [number, number, number] = [
    OFF_ORIGIN[0],
    OFF_ORIGIN[1] + 10,
    OFF_ORIGIN[2] + 1,
  ];
  const a = ndcOf(level, point[0], point[1], point[2]);
  const b = ndcOf(leaned, point[0], point[1], point[2]);
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(0.05);
  /* And it is a turn rather than a drift: the point keeps its distance from the centre. */
  expect(Math.hypot(b[0], b[1])).toBeCloseTo(Math.hypot(a[0], a[1]), 4);
});
