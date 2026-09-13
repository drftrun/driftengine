import { expect, test } from 'vitest';
import { TouchControls } from './touchControls.ts';
import type { TouchControlsOptions } from './touchControls.ts';
import type { InputCallbacks, InputSource, TouchPoint } from './input.ts';

/**
 * A stand-in for the browser. Only three things are touched: the subscription, the
 * surface's bounding box (to find the zone split) and two elements the stick moves.
 *
 * DOM is not otherwise tested here (AGENTS.md) — but which *gesture* owns the primary
 * action is a decision, not a rendering, and it is the decision a player feels.
 */
function harness(
  options: TouchControlsOptions = {},
  /* How the controls are constructed, so the same gestures can be driven through either form of
     the constructor. Absent is the positional form, which is what every test here used. */
  build?: (
    input: InputSource,
    element: HTMLElement,
    options: TouchControlsOptions,
  ) => TouchControls,
): {
  controls: TouchControls;
  element: HTMLElement;
  start: (id: number, x: number, y: number, t: number) => TouchPoint;
  move: (point: TouchPoint, x: number, y: number) => void;
  end: (point: TouchPoint, durationMs: number) => void;
} {
  const callbacks: InputCallbacks[] = [];
  const element = {
    hidden: true,
    style: {} as CSSStyleDeclaration,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLElement;
  const input = {
    target: element,
    subscribe: (c: InputCallbacks) => {
      callbacks.push(c);
      return () => {};
    },
  } as unknown as InputSource;

  const controls =
    build === undefined
      ? new TouchControls(input, element, element, options)
      : build(input, element, options);
  const fire = (name: 'onTouchStart' | 'onTouchMove', point: TouchPoint): void => {
    for (const c of callbacks) c[name]?.(point);
  };

  return {
    controls,
    element,
    start: (id, x, y, t) => {
      const point: TouchPoint = { id, x, y, startX: x, startY: y, startTime: t };
      fire('onTouchStart', point);
      return point;
    },
    move: (point, x, y) => {
      point.x = x;
      point.y = y;
      fire('onTouchMove', point);
    },
    end: (point, durationMs) => {
      for (const c of callbacks) c.onTouchEnd?.(point, durationMs);
    },
  };
}

/** The right half of an 800px surface. */
const RIGHT_X = 600;

test('a still thumb holds the primary without firing it', () => {
  /*
   * Reported from phone testing: a single tap fired the primary action, so there was
   * no way to hold position and look — the action had become the priority.
   *
   * The zone has three jobs — look, tap-to-fire, hold-to-hold — and the hold is the one
   * that bites: a thumb placed down and held still is what *looking around* starts with,
   * and after `holdResolveMs` it fired. No threshold separates "still thumb" from "about
   * to look", because they are the same input.
   *
   * So the motionless press now only *holds*. The held form still exists, because verbs
   * like a glide need it; what is gone is the edge nobody asked for. A dedicated on-screen
   * button was tried first and rejected, which is the better answer anyway: one less
   * thing on a phone screen.
   */
  const zone = harness();
  const point = zone.start(1, RIGHT_X, 300, 0);

  // Held perfectly still, well past the hold threshold.
  zone.controls.tick(2000);
  expect(zone.controls.consumePrimaryPress(), 'a motionless thumb fired').toBe(false);
  expect(zone.controls.primaryHeld, 'the held form was lost with it').toBe(true);

  zone.end(point, 2000);
  expect(zone.controls.primaryHeld).toBe(false);
});

test('a look keeps every pixel that resolved it', () => {
  // The other half: the camera must not pay for the classification, including the travel
  // that decided it was a look in the first place.
  const zone = harness();
  const point = zone.start(1, RIGHT_X, 300, 0);
  zone.move(point, RIGHT_X + 40, 320);
  zone.move(point, RIGHT_X + 60, 320);

  const look = { dx: 0, dy: 0 };
  zone.controls.consumeLook(look);
  expect(look.dx).toBeCloseTo(60, 5);
  expect(look.dy).toBeCloseTo(20, 5);
});

test('a tap still fires, and a caller can ask for the old hold-fires behaviour', () => {
  /*
   * The tap is where the intent is, and it is the whole of how a touch player jumps, so
   * losing it would be worse than the bug. And `fireOnHold` stays available because this
   * is engine input: a scheme with nothing but a zone — no buttons at all — may genuinely
   * want a motionless press to fire.
   */
  const zone = harness();
  const tap = zone.start(1, RIGHT_X, 300, 0);
  zone.end(tap, 90);
  expect(zone.controls.consumePrimaryPress(), 'a tap no longer fires').toBe(true);

  const eager = harness({ fireOnHold: true });
  eager.start(2, RIGHT_X, 300, 0);
  eager.controls.tick(2000);
  expect(eager.controls.consumePrimaryPress(), 'fireOnHold did nothing').toBe(true);
});

test('a tap fires after the hold has resolved, because the caller ticks every frame', () => {
  /*
   * The bug this file's own tap test could not see, reported from phone testing: the
   * primary action fired only sometimes, and taps went missing at no obvious rate.
   *
   * A caller runs `tick` once per frame, so a touch that lasts longer than
   * `holdResolveMs` is *always* promoted to the held form before it is released — and
   * the press used to be queued only from `pending`. Every tap past 90 ms was
   * discarded, which on a phone is most of them. The test above passes only because it
   * never ticks between the start and the end, which is the one sequence the real loop
   * never skips.
   */
  const zone = harness();
  const tap = zone.start(1, RIGHT_X, 300, 0);

  zone.controls.tick(120);
  expect(zone.controls.primaryHeld, 'the hold no longer resolves').toBe(true);

  zone.end(tap, 140);
  expect(zone.controls.consumePrimaryPress(), 'a promoted tap was eaten').toBe(true);
  expect(zone.controls.primaryHeld).toBe(false);
});

test('a long press is a hold and never a tap', () => {
  // The other side of the same rule: `tapMaxMs` still bounds it, so somebody holding
  // the zone down to glide does not also fire a jump when they let go.
  const zone = harness();
  const held = zone.start(1, RIGHT_X, 300, 0);
  zone.controls.tick(120);
  zone.end(held, 900);
  expect(zone.controls.consumePrimaryPress(), 'a long hold fired the primary').toBe(false);
});

test('a look never fires the primary, however briefly it lasted', () => {
  /*
   * The one-way bias `classifyRightGesture` documents, restated at the release: a
   * touch that moved the camera did its work there. Firing a press on its release as
   * well would put a jump on the end of every quick camera correction, which is
   * the complaint the scheme was built to fix — from the other direction.
   */
  const zone = harness();
  const drag = zone.start(1, RIGHT_X, 300, 0);
  zone.move(drag, RIGHT_X + 90, 300);
  zone.end(drag, 100);
  expect(zone.controls.consumePrimaryPress(), 'a drag fired the primary').toBe(false);
});

test('a held thumb can still steer', () => {
  // The hold used to be terminal: once a still thumb resolved into it, that thumb
  // could never move the camera again. A held verb is precisely the one you need to
  // steer through, so the hold and the look now coexist.
  const zone = harness();
  const point = zone.start(1, RIGHT_X, 300, 0);
  zone.controls.tick(120);
  zone.move(point, RIGHT_X + 60, 300);

  const look = { dx: 0, dy: 0 };
  zone.controls.consumeLook(look);
  expect(look.dx, 'a holding thumb could not look').toBeCloseTo(60, 5);
  expect(zone.controls.primaryHeld, 'looking dropped the hold').toBe(true);
});

test('a second finger taps while the first one is looking', () => {
  /*
   * Every touch after the first used to be dropped outright, so a player steering
   * through a corner could not jump out of it without letting go of the corner.
   *
   * The extra finger owns edges only. Its drag must not reach the camera: two thumbs
   * on one axis is a fight, not a control.
   */
  const zone = harness();
  const steering = zone.start(1, RIGHT_X, 300, 0);
  zone.move(steering, RIGHT_X + 80, 300);

  const tap = zone.start(2, RIGHT_X + 150, 400, 0);
  zone.move(tap, RIGHT_X + 250, 400);
  zone.end(tap, 100);
  expect(zone.controls.consumePrimaryPress(), 'a second finger could not tap').toBe(false);

  const clean = zone.start(3, RIGHT_X + 150, 400, 0);
  zone.end(clean, 100);
  expect(zone.controls.consumePrimaryPress(), 'a second finger could not tap').toBe(true);

  const look = { dx: 0, dy: 0 };
  zone.controls.consumeLook(look);
  expect(look.dx, 'the second finger reached the camera').toBeCloseTo(80, 5);
});

/**
 * **Which way is forward on the stick**, pinned because a consumer has to negate it or not and
 * nothing else in the codebase says which.
 *
 * `ActionDefinition`'s `y` follows the gamepad convention, negative upward, so a scene reading an
 * action negates it to get "forward". This is the opposite: `updateStick` already writes
 * `-dy / length`, so pushing the stick up reports a *positive* `moveY` and a consumer that
 * negates it again sends the player backwards. The voxel sandbox did exactly that, and it was
 * wrong only on a phone, which is the hardest place to notice it.
 */
test('pushing the stick up reports forward as positive', () => {
  const { controls, start, move } = harness();
  /* Well inside the left zone, which is the stick. */
  const thumb = start(1, 100, 400, 0);
  move(thumb, 100, 300);

  expect(controls.moveY, 'up the screen is forward, and forward is positive').toBeGreaterThan(0);
  expect(Math.abs(controls.moveX), 'a straight pull up does not strafe').toBeLessThan(1e-6);

  move(thumb, 100, 500);
  expect(controls.moveY, 'down the screen is backward, and backward is negative').toBeLessThan(0);

  move(thumb, 200, 400);
  expect(controls.moveX, 'right of the origin is positive').toBeGreaterThan(0);
});

/*
 * **The two elements are an output channel, and a caller may decline them.**
 *
 * Reported by a consumer that could not reach the page: they read
 * `new TouchControls(input, stickBase, stickNub)`, concluded two `HTMLElement`s were required, and
 * constructed two `div`s they never appended anywhere so the input maths would run. Reading the
 * class rather than its signature settles it — the nodes are only ever assigned `.hidden` and
 * `.style`, never measured, and every touch comes from `input.target`.
 */
test('the stick works with no elements to draw it with', () => {
  const h = harness({}, (input) => new TouchControls(input));
  const point = h.start(1, 100, 300, 0);
  h.move(point, 140, 300);
  expect(h.controls.moveX).toBeGreaterThan(0);
});

/* The positional form is kept working rather than deprecated: consumers are using it. */
test('the positional form still draws the stick', () => {
  const h = harness();
  const point = h.start(1, 100, 300, 0);
  h.move(point, 140, 300);
  expect(h.controls.moveX).toBeGreaterThan(0);
  expect(h.element.hidden).toBe(false);
});

/* And the options form reaches the same code, so neither is a second implementation. */
test('the options form draws it the same way', () => {
  const h = harness(
    {},
    (input, element, options) =>
      new TouchControls(input, { ...options, stickBase: element, stickNub: element }),
  );
  const point = h.start(1, 100, 300, 0);
  h.move(point, 140, 300);
  expect(h.controls.moveX).toBeGreaterThan(0);
  expect(h.element.hidden).toBe(false);
});
