import { expect, test } from 'vitest';
import { aabbFromCenter } from '@driftengine/physics';
import { ColliderSet } from '@driftengine/physics';
import { ThirdPersonCamera } from './thirdPersonCamera.ts';
import type { BoomObstruction, ThirdPersonCameraOptions } from './thirdPersonCamera.ts';
import type { BoomTiming } from './boom.ts';

const DT = 1 / 60;
const FLOOR_BOX = aabbFromCenter(0, -1, 0, 80, 1, 80);
const FLOOR = new ColliderSet([FLOOR_BOX]);
const TARGET_Y = 2.15;
const OPTIONS: ThirdPersonCameraOptions = {
  boomDistance: 5,
  boomRadius: 0.28,
  boomMinDistance: 0.9,
  positionLambda: 14,
  fovLambda: 4,
  pitchMin: -1.15,
  pitchMax: 0.65,
  initialPitch: -0.18,
  initialFovYDeg: 70,
};

function settle(camera: ThirdPersonCamera, pitch: number, ticks = 240): void {
  for (let i = 0; i < ticks; i++) {
    camera.update(DT, 0, pitch, 0, TARGET_Y, 0, 70);
  }
}

test('pitching fully down never sinks the camera through the floor', () => {
  const camera = new ThirdPersonCamera(FLOOR, OPTIONS);
  settle(camera, -0.05);
  expect(camera.camera.position[1]).toBeGreaterThan(0);
});

test('pitching fully up never sinks the camera through the floor either', () => {
  const camera = new ThirdPersonCamera(FLOOR, OPTIONS);
  settle(camera, 0.05);
  expect(camera.camera.position[1]).toBeGreaterThan(0);
});

test('a wall behind the target pulls the boom in instead of clipping through', () => {
  const wall = aabbFromCenter(3, 4, 0, 1, 6, 30);
  const camera = new ThirdPersonCamera(new ColliderSet([FLOOR_BOX, wall]), OPTIONS);
  for (let i = 0; i < 240; i++) {
    camera.update(DT, -Math.PI / 2, 0, 0, TARGET_Y, 0, 70);
  }
  expect(camera.camera.position[0]).toBeLessThan(2);
});

test('with nothing in the way the boom keeps its full length', () => {
  const camera = new ThirdPersonCamera(FLOOR, OPTIONS);
  for (let i = 0; i < 240; i++) {
    camera.update(DT, 0, 0, 0, 40, 0, 70);
  }
  expect(Math.abs(camera.camera.position[2])).toBeGreaterThan(4.5);
});

/**
 * A chase camera follows something that is *moving*, and `damp` assumes it is not.
 *
 * `damp(a, b, λ, dt)` is `lerp(a, b, 1 - exp(-λ dt))`, which is the exact answer for a target
 * standing still and a zero-order hold for one that is not: it treats `b` as constant across the
 * interval. A third-person camera's target is a vehicle, so the assumption is wrong every frame
 * the subject is moving, which is every frame anybody is looking at.
 *
 * Two costs fall out of it and this asserts both.
 *
 * **The settled distance depends on the frame rate.** With the hold, the steady-state gap works
 * out to `v·dt·(1-k)/k` for `k = 1 - exp(-λ dt)`, which shrinks as `dt` grows: at λ = 14 and
 * 25 m/s that is 1.586 m at 60 Hz against 1.376 m at 28 Hz. A machine that drops rate silently
 * re-frames the shot, and nothing in the scene moved.
 *
 * **And under jitter the gap oscillates**, which at 90 km/h several times a second is what a
 * consumer reported as the car snapping about inside the picture when the frame rate dipped. The
 * measurement that isolated it is worth keeping: the *car* holds its own world speed to within a
 * twentieth of a per cent through the same jitter, because the fixed step and the interpolation
 * are doing exactly what they are for. What moves is the camera.
 *
 * The exact answer for a ramp settles at `v/λ` whatever `dt` is, and does not move under jitter.
 */
const CHASE_SPEED = 25;

function chaseGap(dtOf: (step: number) => number, steps = 3000): number {
  const camera = new ThirdPersonCamera(FLOOR, OPTIONS);
  const inner = camera as unknown as { smoothX: number };
  let x = 0;
  for (let i = 0; i < steps; i++) {
    const dt = dtOf(i);
    x += CHASE_SPEED * dt;
    camera.update(dt, 0, 0, x, TARGET_Y, 0, 70);
  }
  return x - inner.smoothX;
}

test('a chase camera settles the same distance behind at every frame rate', () => {
  const exact = CHASE_SPEED / OPTIONS.positionLambda;
  const fast = chaseGap(() => 1 / 60);
  const slow = chaseGap(() => 1 / 28);

  expect(fast, 'the settled lag is v/lambda').toBeCloseTo(exact, 3);
  expect(slow, 'and the same at a lower rate').toBeCloseTo(exact, 3);
});

test('a chase camera does not breathe when the frame times are uneven', () => {
  /* Deterministic rather than random, and the swing is what is asserted, not the mean. */
  const jittered = (step: number) => (step % 2 === 0 ? 1 / 35 + 0.02 : 1 / 35 - 0.02);
  const camera = new ThirdPersonCamera(FLOOR, OPTIONS);
  const inner = camera as unknown as { smoothX: number };
  let x = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const dt = jittered(i);
    x += CHASE_SPEED * dt;
    camera.update(dt, 0, 0, x, TARGET_Y, 0, 70);
    /* Only once it has settled, so the approach from the snap is not counted as swing. */
    if (i > 2000) {
      const gap = x - inner.smoothX;
      if (gap < low) low = gap;
      if (gap > high) high = gap;
    }
  }
  expect(high - low, 'the gap holds still through uneven frames').toBeLessThan(0.001);
});

/**
 * The arm is built in a basis, rather than swung about world Y.
 *
 * **The rig could already look banked and could not orbit a banked surface.** `targetRoll`'s own
 * comment says the rig knows nothing about banked surfaces, only that a camera can be tilted, and
 * that roll is damped here so a subject snapping between surfaces cannot snap the view — which is
 * exactly the case this is for. The arm was not carried the same distance: it was
 * `-sin(yaw) cos(pitch)`, `-sin(pitch)`, `cos(yaw) cos(pitch)` about world Y, so a body on a
 * ceiling got an arm that still swung about world up and the rig placed the eye through the
 * ceiling.
 *
 * A consumer without this keeps the damping and loses the collision sweep and the `Boom`
 * smoothing, which is the hard part and the part it should not be writing.
 *
 * Yaw and pitch keep their meaning and become angles inside the frame, so the assertion is a
 * mirror: the pitch that lifts the eye in the default frame lowers it in an inverted one.
 */
const NO_SURFACE = new ColliderSet([]);

function eyeAfterPitch(pitch: number, up: [number, number, number] | null): number {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  if (up !== null) camera.setBoomUp(up[0], up[1], up[2]);
  for (let i = 0; i < 240; i++) camera.update(DT, 0, pitch, 0, TARGET_Y, 0, 70);
  return camera.camera.position[1] - TARGET_Y;
}

test('the boom defaults to world axes, so a rig that never asks is unchanged', () => {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  expect([camera.boomUpX, camera.boomUpY, camera.boomUpZ]).toEqual([0, 1, 0]);
});

test('pitch that lifts the eye in the default frame lowers it in an inverted one', () => {
  /* Negative pitch raises the eye above the subject, which is what it has always done. */
  const upright = eyeAfterPitch(-0.5, null);
  expect(upright, 'the eye rides above the subject').toBeGreaterThan(0.5);

  /* Same angle, a body whose up is world down: the arm goes the other way in world terms. */
  const inverted = eyeAfterPitch(-0.5, [0, -1, 0]);
  expect(inverted, 'and below it when the frame is inverted').toBeLessThan(-0.5);
  expect(Math.abs(inverted + upright), 'by the same distance, mirrored').toBeLessThan(0.02);
});

/**
 * **The arm moved into the boom's frame and the aim did not, until now.**
 *
 * Reported from outside: on any surface that is not a floor the rig put the eye in the right place
 * and pointed it somewhere else, rendering the scene beside the subject with no error anywhere.
 * `update` built the arm in the basis `setBoomUp` was given and then set `yaw`/`pitch`/`roll`,
 * which `Camera.updateMatrices` reads against the world axes — the two agree only at world up.
 *
 * What this asserts is the property, not the arithmetic: wherever the eye ends up, the direction
 * the camera faces goes through the subject.
 */
function lookError(up: [number, number, number] | null, pitch = -0.2, yaw = 0.7): number {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  if (up !== null) camera.setBoomUp(up[0], up[1], up[2]);
  for (let i = 0; i < 240; i++) camera.update(DT, yaw, pitch, 0, TARGET_Y, 0, 70);
  const cam = camera.camera;
  cam.updateMatrices(16 / 9);
  const toSubject = [
    0 - (cam.position[0] as number),
    TARGET_Y - (cam.position[1] as number),
    0 - (cam.position[2] as number),
  ];
  const length = Math.hypot(toSubject[0] as number, toSubject[1] as number, toSubject[2] as number);
  /*
   * **The chord between the two directions, not the angle between them.** `acos` near 1 is
   * ill-conditioned: `cam.position` is a `Float32Array`, so recovering a direction from it carries
   * about 3e-8 of rounding, and `acos(1 - 3e-8)` is 2.5e-4 radians — 0.014 degrees of pure
   * amplification, which is what a first version of this measured on a *floor* and read as a
   * defect. The chord is `2·sin(θ/2)`, which is θ for small angles and does not amplify anything.
   */
  return Math.hypot(
    (toSubject[0] as number) / length - (cam.forward[0] as number),
    (toSubject[1] as number) / length - (cam.forward[1] as number),
    (toSubject[2] as number) / length - (cam.forward[2] as number),
  );
}

test('the camera looks at its subject in every frame, not only on a floor', () => {
  /*
   * 1e-4 of chord is about six thousandths of a degree, three orders above the float32 rounding in
   * `cam.position` and four orders below the failure this holds — a wall put the aim a right angle
   * from the subject.
   */
  const BOUND = 1e-4;
  /* The floor case, which has always worked and is the control. */
  expect(lookError(null)).toBeLessThan(BOUND);
  /* The walls, which are where the two halves disagreed. */
  expect(lookError([1, 0, 0])).toBeLessThan(BOUND);
  expect(lookError([0, 0, 1])).toBeLessThan(BOUND);
  /* A bank that is neither, so nothing here depends on an axis being exactly zero. */
  expect(lookError([0.4, 0.6, -0.7])).toBeLessThan(BOUND);
  /* Upside down, which the mirror case above already places the eye for. */
  expect(lookError([0, -1, 0])).toBeLessThan(BOUND);
});

/**
 * The compatibility claim, and it is the reason the aim is *derived* rather than taken.
 *
 * At the world basis the decomposition is the analytic inverse of what `updateMatrices` builds, so
 * a rig that never calls `setBoomUp` reads back the three numbers it was handed, to the precision a
 * `sin`/`cos`/`atan2` round trip allows. Every consumer of this rig is in that case, which is why
 * the bound matters more here than anywhere else in this file.
 */
test('a rig at world up reads back the angles it was given', () => {
  for (const [yaw, pitch, roll] of [
    [0, 0, 0],
    [0.7, -0.2, 0],
    [-2.4, 0.61, 0.3],
    [3.0, -1.1, -0.45],
  ] as const) {
    const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
    for (let i = 0; i < 400; i++) camera.update(DT, yaw, pitch, 0, TARGET_Y, 0, 70, roll);
    const cam = camera.camera;
    /*
     * **Bounded rather than exact, and the bounds are the measurement rather than a guess.** The
     * arm is built from `sin` and `cos` of these two and the aim reads them back with `atan2`, so
     * the round trip is a transcendental pair and the last bit is not guaranteed. Measured across
     * these four poses: pitch and yaw within 3e-17 radians, roll within 8e-13 — the last through
     * one further `atan2` of a dot product against a basis rebuilt from the other two.
     *
     * For scale, 1e-11 radians is a hundred-millionth of a pixel across a 1080-line frame. An
     * assertion of exactness here would be pinning the last bits of `Math.atan2`, which is a claim
     * about the runtime rather than about this rig.
     */
    expect(Math.abs(cam.pitch - pitch)).toBeLessThan(1e-15);
    const yawDelta = Math.atan2(Math.sin(cam.yaw - yaw), Math.cos(cam.yaw - yaw));
    expect(Math.abs(yawDelta)).toBeLessThan(1e-15);
    const rollDelta = Math.atan2(Math.sin(cam.roll - roll), Math.cos(cam.roll - roll));
    expect(Math.abs(rollDelta)).toBeLessThan(1e-11);
  }
});

/**
 * **A subject with a heading of its own, which the carried forward cannot express.**
 *
 * Reported from outside after the aim was fixed: closing that made it clear the rig still could not
 * be told which way its subject faces. A yaw of π puts the eye opposite the *carried* forward,
 * which on the first frame of a run is world Z re-projected — an axis the caller never chose and,
 * until `boomForward` became readable, could not read either. A subject spawning face-on to a wall
 * got a shot framed at random.
 */
function eyeAfter(
  up: [number, number, number] | null,
  forward: [number, number, number] | null,
  yaw: number,
): number[] {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  if (up !== null) camera.setBoomUp(up[0], up[1], up[2]);
  if (forward !== null) camera.setBoomForward(forward[0], forward[1], forward[2]);
  for (let i = 0; i < 400; i++) camera.update(DT, yaw, 0, 0, TARGET_Y, 0, 70);
  return Array.from(camera.camera.position);
}

test('a boom forward puts the eye behind the subject at yaw pi', () => {
  /* On a wall whose normal is +X, an animal facing up the wall: heading is world +Y. */
  const behind = eyeAfter([1, 0, 0], [0, 1, 0], Math.PI);
  /* Behind a subject facing +Y is below it, at the boom's full length, and level with the wall. */
  expect(behind[1] as number).toBeLessThan(TARGET_Y - 4.9);
  expect(Math.abs(behind[0] as number), 'and out from the wall by nothing').toBeLessThan(1e-4);
  expect(Math.abs(behind[2] as number)).toBeLessThan(1e-4);

  /* And in front of it at yaw 0, which is the same arm reversed. */
  const front = eyeAfter([1, 0, 0], [0, 1, 0], 0);
  expect(front[1] as number).toBeGreaterThan(TARGET_Y + 4.9);
});

test('the forward is orthogonalised against the up, and reads back as what the arm uses', () => {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  camera.setBoomUp(1, 0, 0);
  /* Deliberately not perpendicular: mostly +Y with a lean into the wall's own normal. */
  camera.setBoomForward(0.6, 1, 0);
  const up = [camera.boomUpX, camera.boomUpY, camera.boomUpZ];
  const forward = [camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ];
  expect(Math.hypot(forward[0] as number, forward[1] as number, forward[2] as number)).toBeCloseTo(
    1,
    12,
  );
  const into =
    (up[0] as number) * (forward[0] as number) +
    (up[1] as number) * (forward[1] as number) +
    (up[2] as number) * (forward[2] as number);
  expect(Math.abs(into), 'the lean into the up is projected out').toBeLessThan(1e-12);
  /* What is left is the part that was across the up, which here is world +Y. */
  expect(forward[1] as number).toBeCloseTo(1, 12);
});

test('a forward parallel to the up is refused, keeping the frame rather than inventing one', () => {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  camera.setBoomUp(1, 0, 0);
  camera.setBoomForward(0, 0, 1);
  const before = [camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ];
  /* Straight along the up: there is no forward perpendicular to it, and answering with an
     arbitrary axis is the failure this method exists to fix. */
  camera.setBoomForward(1, 0, 0);
  expect([camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ]).toEqual(before);
  camera.setBoomForward(0, 0, 0);
  expect([camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ]).toEqual(before);
});

test('a later setBoomUp re-orthogonalises a forward that was set, rather than dropping it', () => {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  camera.setBoomUp(1, 0, 0);
  camera.setBoomForward(0, 1, 0);
  /* The subject walks off the wall onto the floor: the heading it was given is still mostly +Y,
     which is now the up — so what survives is whatever of it was across the new up. */
  camera.setBoomUp(0, 1, 0);
  const into =
    camera.boomUpX * camera.boomForwardX +
    camera.boomUpY * camera.boomForwardY +
    camera.boomUpZ * camera.boomForwardZ;
  expect(Math.abs(into)).toBeLessThan(1e-12);
  expect(
    Math.hypot(camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ),
    'and it is still a unit vector rather than a normalised zero',
  ).toBeCloseTo(1, 12);
});

test('a rig that never sets a forward carries it exactly as before', () => {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  expect([camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ]).toEqual([0, 0, 1]);
  camera.setBoomUp(1, 0, 0);
  /* World Z re-projected against +X is world Z, which is what it always was. */
  expect([camera.boomForwardX, camera.boomForwardY, camera.boomForwardZ]).toEqual([0, 0, 1]);
});

/**
 * **An arm 170 mm long, and an obstruction that is the wall its subject lives on.**
 *
 * The boom's default timings were written for an arm of several metres. Their speed ceilings are
 * stated in metres a second, which is the unit a crane is specified in and the wrong one for an arm
 * shorter than a hand: on a 170 mm boom neither ceiling ever binds, only the damping acts, and the
 * trade the ceilings were chosen for is not the trade being made. Easing into a wall costs a frame
 * or two of looking through a post on a big rig; on a subject 46 mm across it renders the inside of
 * the masonry, which is a black screen with the game running perfectly behind it.
 *
 * The three tests below are the reported case, the fix, and the half of the easing worth keeping.
 */
const SMALL: ThirdPersonCameraOptions = {
  boomDistance: 0.17,
  boomRadius: 0.003,
  boomMinDistance: 0.02,
  positionLambda: 14,
  fovLambda: 4,
  pitchMin: -1.15,
  pitchMax: 0.65,
  initialPitch: 0,
  initialFovYDeg: 70,
};

/**
 * A lip that is not there for the first two ticks, appears at `at` metres along the arm, and
 * clears again at `until`.
 *
 * Clear at first because the rig's first update *places* it — `boom.reset`, not `boom.step` — so an
 * obstruction that is already there on tick one is taken outright and no timing is exercised at
 * all. The reported case is an arm out at full length that a lip sweeps into.
 */
function lipSweep(at: number, until = Infinity): BoomObstruction {
  let tick = 0;
  return {
    distance: () => {
      const n = tick++;
      return n >= 2 && n < until ? at : null;
    },
  };
}

/** Where the eye sits, in metres from the subject. */
function reach(camera: ThirdPersonCamera): number {
  const p = camera.camera.position;
  return Math.hypot(p[0] as number, p[1] as number, p[2] as number);
}

/** Every tick's reach over two seconds, for a 170 mm arm meeting a lip at `at`. */
function reachOverTwoSeconds(
  timing: Partial<BoomTiming> | undefined,
  at: number,
  until?: number,
): number[] {
  const camera = new ThirdPersonCamera(
    NO_SURFACE,
    timing === undefined ? SMALL : { ...SMALL, boomTiming: timing },
    null,
    lipSweep(at, until),
  );
  const out: number[] = [];
  for (let i = 0; i < 120; i++) {
    camera.update(DT, 0, 0, 0, 0, 0, 70);
    out.push(reach(camera));
  }
  /* The first two are before the lip exists; nothing about them is a measurement of the timings. */
  return out.slice(2);
}

/** How far past the lip the eye went, and for how many ticks it was past it at all. */
function insideTheWall(reaches: number[], at: number): { ticks: number; worst: number } {
  /* A hair of tolerance for the arithmetic that placed the eye, not for the wall. */
  const past = reaches.map((r) => r - at).filter((d) => d > 1e-6);
  return { ticks: past.length, worst: past.length === 0 ? 0 : Math.max(...past) };
}

test('the default timings ease a short arm into a wall, which is the reported failure', () => {
  const { ticks, worst } = insideTheWall(reachOverTwoSeconds(undefined, 0.08), 0.08);
  /* Reported from outside as 78 ticks of 120 and 71 mm past the lip; at this rate, 48 and 71.3. */
  expect(ticks, 'inside the lip for most of a second').toBeGreaterThan(40);
  expect(worst, 'and deep inside it, on an arm shorter than a hand').toBeGreaterThan(0.07);
});

test('an immediate retraction takes the arm out of the wall on the tick it meets one', () => {
  const { ticks } = insideTheWall(
    reachOverTwoSeconds({ retractLambda: Infinity, retractSpeed: Infinity }, 0.08),
    0.08,
  );
  expect(ticks, 'never past the lip').toBe(0);
});

test('an immediate retraction still eases back out, which is the half that stops the pumping', () => {
  /* Blocked hard at 40 mm from tick 2, clear again from tick 12: a lip sweeping past. */
  const reaches = reachOverTwoSeconds(
    { retractLambda: Infinity, retractSpeed: Infinity },
    0.04,
    12,
  );
  const atClearing = reaches[10] as number;
  expect(atClearing, 'it did not leap back to full length the moment the lip cleared').toBeLessThan(
    0.08,
  );
  expect(atClearing, 'it did start coming back').toBeGreaterThan(0.04);
  expect(reaches[reaches.length - 1] as number, 'and it got all the way back').toBeCloseTo(0.17, 4);
});

test('a rig that asks for no timings keeps the numbers it always had', () => {
  const bare = new ThirdPersonCamera(NO_SURFACE, SMALL, null, lipSweep(0.08));
  const empty = new ThirdPersonCamera(
    NO_SURFACE,
    { ...SMALL, boomTiming: {} },
    null,
    lipSweep(0.08),
  );
  for (let i = 0; i < 60; i++) {
    bare.update(DT, 0, 0, 0, 0, 0, 70);
    empty.update(DT, 0, 0, 0, 0, 0, 70);
  }
  expect(reach(empty)).toBe(reach(bare));
});

/**
 * The second thing that kept a consumer off the rig: it collides against a type that consumer does
 * not have. Its world is a physics world, which exposes no `ColliderSet`, so using the rig at all
 * meant maintaining a second copy of the world for the camera alone.
 */
test('an injected query is used instead of the collider set, not beside it', () => {
  /* A box the collider set stops the arm at, and a query that says the world is clear. */
  const boxed = new ColliderSet([aabbFromCenter(0, TARGET_Y, 3, 1, 1, 1)]);
  const withSet = new ThirdPersonCamera(boxed, OPTIONS);
  const withQuery = new ThirdPersonCamera(boxed, OPTIONS, null, { distance: () => null });
  for (let i = 0; i < 60; i++) {
    withSet.update(DT, 0, 0, 0, TARGET_Y, 0, 70);
    withQuery.update(DT, 0, 0, 0, TARGET_Y, 0, 70);
  }
  const flat = (c: ThirdPersonCamera): number =>
    Math.hypot(c.camera.position[0] as number, c.camera.position[2] as number);
  expect(flat(withSet), 'the box shortened the arm').toBeLessThan(OPTIONS.boomDistance - 0.5);
  expect(flat(withQuery), 'and the query said there was nothing there').toBeCloseTo(
    OPTIONS.boomDistance,
    4,
  );
});

test('an injected query shortens the arm with no collider set behind it at all', () => {
  const camera = new ThirdPersonCamera(NO_SURFACE, OPTIONS, null, { distance: () => 2 });
  for (let i = 0; i < 60; i++) camera.update(DT, 0, 0, 0, TARGET_Y, 0, 70);
  const p = camera.camera.position;
  const arm = Math.hypot(p[0] as number, (p[1] as number) - TARGET_Y, p[2] as number);
  expect(arm, 'cut where the query said, five metres of boom notwithstanding').toBeCloseTo(2, 3);
});

/**
 * The third: a caller that has already damped its roll — and applies the same value to a
 * first-person view, where nothing damps it — cannot have it damped a second time without its
 * comfort setting quietly meaning something else in one view than in the other.
 */
test('a caller can take the roll damping off', () => {
  const damped = new ThirdPersonCamera(NO_SURFACE, OPTIONS);
  const direct = new ThirdPersonCamera(NO_SURFACE, { ...OPTIONS, dampRoll: false });
  const ROLL = 0.4;
  damped.update(DT, 0, 0, 0, TARGET_Y, 0, 70, ROLL);
  direct.update(DT, 0, 0, 0, TARGET_Y, 0, 70, ROLL);
  expect(direct.camera.roll, 'taken as given on the tick it is given').toBeCloseTo(ROLL, 12);
  expect(damped.camera.roll, 'and eased into over several').toBeLessThan(ROLL * 0.2);
  for (let i = 0; i < 240; i++) damped.update(DT, 0, 0, 0, TARGET_Y, 0, 70, ROLL);
  expect(damped.camera.roll, 'which is where it was always going').toBeCloseTo(ROLL, 6);
});
