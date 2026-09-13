import { quat, vec3 } from 'gl-matrix';
import { expect, test } from 'vitest';
import {
  GIZMO_GROUP_ACTIVE,
  GIZMO_GROUP_COUNT,
  GIZMO_GROUP_NEUTRAL,
  GIZMO_GROUP_X,
  GIZMO_NONE,
  GIZMO_ROTATE_X,
  GIZMO_ROTATE_Y,
  GIZMO_SCALE_UNIFORM,
  GIZMO_SCALE_X,
  GIZMO_TRANSLATE_X,
  GIZMO_TRANSLATE_XY,
  GIZMO_TRANSLATE_Y,
  Gizmo,
  gizmoScaleFor,
} from './gizmo.ts';

/**
 * Every ray here is built by hand rather than through a camera, which is the property that
 * makes this file possible: nothing in `gizmo.ts` knows what a camera is.
 */
type Ray = [origin: Float32Array, direction: Float32Array];

/** A ray straight down -z through a point on the plane z = 0. */
function rayAt(x: number, y: number): Ray {
  return [new Float32Array([x, y, 8]), new Float32Array([0, 0, -1])];
}

/** A ray from `from` aimed at `at`, normalised, which is what the gizmo requires. */
function rayTo(from: readonly number[], at: readonly number[]): Ray {
  const direction = new Float32Array([at[0]! - from[0]!, at[1]! - from[1]!, at[2]! - from[2]!]);
  vec3.normalize(direction, direction);
  return [new Float32Array(from), direction];
}

test('a ray down the x arm picks the x translate handle', () => {
  const gizmo = new Gizmo();
  const [origin, direction] = rayAt(0.6, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_TRANSLATE_X);
});

test('a ray at the background picks nothing', () => {
  const gizmo = new Gizmo();
  const [origin, direction] = rayAt(4, 4);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_NONE);
});

/* An arm's pick region is a cylinder with no caps, so past the tip is a miss. */
test('a ray past the end of an arm misses it', () => {
  const gizmo = new Gizmo();
  const [origin, direction] = rayAt(1.4, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_NONE);
});

test('a ray inside the arm root, short of where the arm starts, misses it', () => {
  const gizmo = new Gizmo();
  const [origin, direction] = rayAt(0.05, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_NONE);
});

test('the plane handle sits between its two arms and picks as itself', () => {
  const gizmo = new Gizmo();
  const [origin, direction] = rayAt(0.43, 0.43);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_TRANSLATE_XY);
});

/*
 * A mode's handles are the only ones that exist. Picking one belonging to another mode
 * would move something the user cannot see a handle for.
 */
test('a rotate gizmo does not pick a translate arm', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  const [origin, direction] = rayAt(0.6, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_NONE);
});

test('a ray at the ring radius picks the ring whose plane it lies in', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  /* Looking down -z: the ring in the xy plane is the one normal to z. */
  const [origin, direction] = rayAt(1, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_ROTATE_X + 2);
});

/*
 * Edge-on, a ring is a line. Refusing is what stops a tool grabbing a ring nobody can see,
 * and it is `rayPlane`'s parallel refusal doing the work.
 */
test('a ring seen edge-on is not pickable', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  /* This ray lies in the xz plane, which is the plane of the ring normal to y. */
  const [origin, direction] = rayTo([-8, 0, 0], [1, 0, 0]);
  expect(gizmo.pick(origin, direction)).not.toBe(GIZMO_ROTATE_Y);
});

test('a ray through the middle of a scale gizmo picks the uniform handle', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'scale';
  const [origin, direction] = rayAt(0.05, 0.05);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_SCALE_UNIFORM);
});

test('a scale gizmo still picks its arms', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'scale';
  const [origin, direction] = rayAt(0.6, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_SCALE_X);
});

test('a non-positive size picks nothing at all', () => {
  const gizmo = new Gizmo();
  gizmo.size = 0;
  const [origin, direction] = rayAt(0.6, 0);
  expect(gizmo.pick(origin, direction)).toBe(GIZMO_NONE);
});

test('size scales the handles with it', () => {
  const gizmo = new Gizmo();
  gizmo.size = 4;
  expect(gizmo.pick(...rayAt(2.4, 0))).toBe(GIZMO_TRANSLATE_X);
  /* The arm now starts at 0.6 and ends at 4, so what was its middle is inside its root. */
  expect(gizmo.pick(...rayAt(0.3, 0))).toBe(GIZMO_NONE);
});

test('the gizmo follows its position', () => {
  const gizmo = new Gizmo();
  gizmo.position.set([10, 0, 0]);
  expect(gizmo.pick(...rayAt(10.6, 0))).toBe(GIZMO_TRANSLATE_X);
  expect(gizmo.pick(...rayAt(0.6, 0))).toBe(GIZMO_NONE);
});

test('hover remembers what pick found', () => {
  const gizmo = new Gizmo();
  expect(gizmo.hovered).toBe(GIZMO_NONE);
  gizmo.hover(...rayAt(0.6, 0));
  expect(gizmo.hovered).toBe(GIZMO_TRANSLATE_X);
  gizmo.hover(...rayAt(4, 4));
  expect(gizmo.hovered).toBe(GIZMO_NONE);
});

test('a drag on nothing does not start', () => {
  const gizmo = new Gizmo();
  expect(gizmo.beginDrag(...rayAt(4, 4))).toBe(false);
  expect(gizmo.dragging).toBe(false);
  expect(gizmo.updateDrag(...rayAt(2, 0))).toBe(false);
  expect(gizmo.position[0]).toBe(0);
});

test('an x drag moves along x and leaves the other two components alone', () => {
  const gizmo = new Gizmo();
  expect(gizmo.beginDrag(...rayAt(0.6, 0))).toBe(true);
  expect(gizmo.updateDrag(...rayAt(2.6, 0.4))).toBe(true);
  expect(gizmo.position[0]).toBeCloseTo(2, 5);
  expect(gizmo.position[1]).toBe(0);
  expect(gizmo.position[2]).toBe(0);
});

/* Absolute from the anchor, not accumulated, so a hundred frames add no drift. */
test('a drag returned to where it began puts the target back exactly', () => {
  const gizmo = new Gizmo();
  gizmo.beginDrag(...rayAt(0.6, 0));
  for (let step = 0; step < 50; step++) gizmo.updateDrag(...rayAt(0.6 + step * 0.1, 0));
  gizmo.updateDrag(...rayAt(0.6, 0));
  expect(gizmo.position[0]).toBeCloseTo(0, 6);
});

/*
 * The degenerate case the whole drag table promises to survive. A ray along the axis has
 * no closest point on it, and the alternative to refusing is the target teleporting.
 */
test('a ray parallel to the axis it is dragging changes nothing', () => {
  const gizmo = new Gizmo();
  gizmo.beginDrag(...rayAt(0.6, 0));
  gizmo.updateDrag(...rayAt(2.6, 0));
  const held = gizmo.position[0];
  expect(gizmo.updateDrag(...rayTo([-8, 0, 0], [1, 0, 0]))).toBe(false);
  expect(gizmo.position[0]).toBe(held);
});

test('a grab whose anchor cannot be computed does not start a drag', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  /* Aimed at the ring's own centre, where an angle is noise rather than a direction. */
  const [origin, direction] = rayAt(0, 0);
  expect(gizmo.beginDrag(origin, direction)).toBe(false);
  expect(gizmo.dragging).toBe(false);
});

test('a plane drag moves in both of its axes and not in its normal', () => {
  const gizmo = new Gizmo();
  gizmo.beginDrag(...rayAt(0.43, 0.43));
  expect(gizmo.updateDrag(...rayAt(1.43, 2.43))).toBe(true);
  expect(gizmo.position[0]).toBeCloseTo(1, 5);
  expect(gizmo.position[1]).toBeCloseTo(2, 5);
  expect(gizmo.position[2]).toBeCloseTo(0, 6);
});

test('a ray parallel to the plane it is dragging in changes nothing', () => {
  const gizmo = new Gizmo();
  gizmo.beginDrag(...rayAt(0.43, 0.43));
  expect(gizmo.updateDrag(...rayTo([-8, 0, 0], [1, 0, 0]))).toBe(false);
  expect(gizmo.position[0]).toBeCloseTo(0, 6);
});

test('a quarter turn about the z ring is a quarter turn about z', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  expect(gizmo.beginDrag(...rayAt(1, 0))).toBe(true);
  expect(gizmo.updateDrag(...rayAt(0, 1))).toBe(true);

  const expected = quat.setAxisAngle(quat.create(), [0, 0, 1], Math.PI / 2);
  for (let component = 0; component < 4; component++) {
    expect(gizmo.rotation[component]).toBeCloseTo(expected[component]!, 5);
  }
});

/*
 * The unwrap, and the only place it shows. Three quarters of a turn crosses the ±π seam
 * once; without the unwrap this reads −π/2. The *orientation* is the same either way —
 * `dragAngle` says why — so the number is what has to be asserted.
 */
test('a three-quarter turn accumulates three quarters of a turn through the seam', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  gizmo.beginDrag(...rayAt(1, 0));
  for (let step = 1; step <= 24; step++) {
    const angle = (step / 24) * (Math.PI * 1.5);
    gizmo.updateDrag(...rayAt(Math.cos(angle), Math.sin(angle)));
  }
  expect(gizmo.dragAngle).toBeCloseTo(Math.PI * 1.5, 4);
});

test('dragAngle is zero when the drag is not a rotation', () => {
  const gizmo = new Gizmo();
  gizmo.beginDrag(...rayAt(0.6, 0));
  expect(gizmo.dragAngle).toBe(0);
});

/** A quarter turn dragged around the ring the ray at `(1, 0)` lands on. */
function quarterTurn(gizmo: Gizmo): void {
  expect(gizmo.beginDrag(...rayAt(1, 0))).toBe(true);
  for (let step = 1; step <= 12; step++) {
    const angle = (step / 12) * (Math.PI / 2);
    gizmo.updateDrag(...rayAt(Math.cos(angle), Math.sin(angle)));
  }
  expect(gizmo.dragAngle).toBeCloseTo(Math.PI / 2, 4);
}

/*
 * A local-space ring turns about the axis it was grabbed on, and this is the pair that
 * says so: the same drag on the same screen pixels, once in each space, against a target
 * already turned a quarter about x — which sends its local y to world z. World space turns
 * about world z because that is the ring the ray met; local space turns about the local
 * axis whose ring the ray met, which is a different rotation composed the other way.
 *
 * The two would be indistinguishable against an unrotated target, which is the whole
 * reason this one starts turned.
 */
test('a world-space ring drag turns about the world axis', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  quat.setAxisAngle(gizmo.rotation, [1, 0, 0], Math.PI / 2);
  const before = quat.clone(gizmo.rotation);
  quarterTurn(gizmo);

  const expected = quat.multiply(
    quat.create(),
    quat.setAxisAngle(quat.create(), [0, 0, 1], Math.PI / 2),
    before,
  );
  for (let component = 0; component < 4; component++) {
    expect(gizmo.rotation[component]).toBeCloseTo(expected[component]!, 5);
  }
});

test('a local-space ring drag turns about the axis it grabbed, not a moving one', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'rotate';
  gizmo.space = 'local';
  quat.setAxisAngle(gizmo.rotation, [1, 0, 0], Math.PI / 2);
  const before = quat.clone(gizmo.rotation);
  quarterTurn(gizmo);

  /* Local y at the moment of grabbing is world z, and it stays that for the whole drag —
   * recomputing it from a rotation the drag is writing feeds the answer into its own
   * input, which looks like a ring accelerating away from the pointer. */
  const grabbedAxis = vec3.transformQuat(vec3.create(), [0, 1, 0], before);
  const expected = quat.multiply(
    quat.create(),
    quat.setAxisAngle(quat.create(), grabbedAxis, Math.PI / 2),
    before,
  );
  for (let component = 0; component < 4; component++) {
    expect(gizmo.rotation[component]).toBeCloseTo(expected[component]!, 5);
  }
});

test('dragging an arm one gizmo length outward doubles that axis of the scale', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'scale';
  expect(gizmo.beginDrag(...rayAt(0.6, 0))).toBe(true);
  expect(gizmo.updateDrag(...rayAt(1.6, 0))).toBe(true);
  expect(gizmo.scale[0]).toBeCloseTo(2, 5);
  expect(gizmo.scale[1]).toBe(1);
  expect(gizmo.scale[2]).toBe(1);
});

/* Exactly one at the grab, which is what the linear form buys over the multiplicative. */
test('a scale drag that has not moved leaves the scale exactly where it was', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'scale';
  gizmo.scale.set([3, 3, 3]);
  gizmo.beginDrag(...rayAt(0.6, 0));
  gizmo.updateDrag(...rayAt(0.6, 0));
  expect(gizmo.scale[0]).toBeCloseTo(3, 6);
});

test('a scale dragged hard inward clamps rather than reaching zero or going negative', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'scale';
  gizmo.beginDrag(...rayAt(0.6, 0));
  gizmo.updateDrag(...rayAt(-40, 0));
  expect(gizmo.scale[0]).toBeGreaterThan(0);
  expect(gizmo.scale[0]).toBeLessThan(0.02);
});

test('the uniform handle scales all three axes together', () => {
  const gizmo = new Gizmo();
  gizmo.mode = 'scale';
  expect(gizmo.beginDrag(...rayAt(0.05, 0))).toBe(true);
  expect(gizmo.updateDrag(...rayAt(1.05, 0))).toBe(true);
  expect(gizmo.scale[0]).toBeCloseTo(gizmo.scale[1]!, 6);
  expect(gizmo.scale[1]).toBeCloseTo(gizmo.scale[2]!, 6);
  expect(gizmo.scale[0]).toBeGreaterThan(1);
});

test('ending a drag stops it moving anything', () => {
  const gizmo = new Gizmo();
  gizmo.beginDrag(...rayAt(0.6, 0));
  gizmo.endDrag();
  expect(gizmo.dragging).toBe(false);
  expect(gizmo.updateDrag(...rayAt(4.6, 0))).toBe(false);
  expect(gizmo.position[0]).toBe(0);
});

test('every group is empty before a build and filled after one', () => {
  const gizmo = new Gizmo();
  for (let group = 0; group < GIZMO_GROUP_COUNT; group++) {
    expect(gizmo.segments(group).count).toBe(0);
  }
  gizmo.build();
  expect(gizmo.segments(GIZMO_GROUP_X).count).toBeGreaterThan(0);
});

test('a non-positive size builds nothing', () => {
  const gizmo = new Gizmo();
  gizmo.build();
  gizmo.size = -1;
  gizmo.build();
  for (let group = 0; group < GIZMO_GROUP_COUNT; group++) {
    expect(gizmo.segments(group).count).toBe(0);
  }
});

test('the hovered handle draws in the active group rather than its own', () => {
  const gizmo = new Gizmo();
  gizmo.build();
  const unlit = gizmo.segments(GIZMO_GROUP_X).count;
  expect(gizmo.segments(GIZMO_GROUP_ACTIVE).count).toBe(0);

  gizmo.hover(...rayAt(0.6, 0));
  gizmo.build();
  expect(gizmo.segments(GIZMO_GROUP_ACTIVE).count).toBeGreaterThan(0);
  expect(gizmo.segments(GIZMO_GROUP_X).count).toBeLessThan(unlit);
});

test('the neutral group carries the uniform handle and only in scale mode', () => {
  const gizmo = new Gizmo();
  gizmo.build();
  expect(gizmo.segments(GIZMO_GROUP_NEUTRAL).count).toBe(0);
  gizmo.mode = 'scale';
  gizmo.build();
  expect(gizmo.segments(GIZMO_GROUP_NEUTRAL).count).toBe(12);
});

test('a rotate build is three rings at the resolution it was given', () => {
  const gizmo = new Gizmo(16);
  gizmo.mode = 'rotate';
  gizmo.build();
  expect(gizmo.segments(GIZMO_GROUP_X).count).toBe(16);
});

test('a resolution below the floor is refused at construction', () => {
  expect(() => new Gizmo(4)).toThrow(/at least 8/);
});

test('asking for a group that does not exist throws rather than answering', () => {
  const gizmo = new Gizmo();
  expect(() => gizmo.segments(GIZMO_GROUP_COUNT)).toThrow(/no group/);
});

/*
 * Segments past capacity are dropped rather than thrown, which is `DebugLines`' rule: a
 * tool that threw would take down the frame at the moment somebody was moving something.
 */
test('a build that overflows a group drops segments instead of throwing', () => {
  const gizmo = new Gizmo(8);
  gizmo.mode = 'rotate';
  expect(() => gizmo.build()).not.toThrow();
  expect(gizmo.segments(GIZMO_GROUP_X).count).toBeLessThanOrEqual(
    gizmo.segments(GIZMO_GROUP_X).capacity,
  );
});

test('a build after a drag begins uses the frozen basis', () => {
  const gizmo = new Gizmo();
  gizmo.space = 'local';
  gizmo.beginDrag(...rayAt(0.6, 0));
  gizmo.updateDrag(...rayAt(2.6, 0));
  expect(() => gizmo.build()).not.toThrow();
  expect(gizmo.segments(GIZMO_GROUP_ACTIVE).count).toBeGreaterThan(0);
});

test('the scale a camera needs grows with distance and shrinks with resolution', () => {
  const camera = { position: new Float32Array([0, 0, 10]), fovYDeg: 60 } as never;
  const near = gizmoScaleFor(camera, new Float32Array([0, 0, 5]), 1000, 100);
  const far = gizmoScaleFor(camera, new Float32Array([0, 0, 0]), 1000, 100);
  expect(far / near).toBeCloseTo(2, 6);
  const tall = gizmoScaleFor(camera, new Float32Array([0, 0, 0]), 2000, 100);
  expect(tall).toBeCloseTo(far / 2, 6);
});

/*
 * The arithmetic, checked against the definition rather than against itself: a gizmo of
 * `pixels` screen pixels spans that fraction of the viewport's world height.
 */
test('the scale is the world height of the pixels asked for', () => {
  const camera = { position: new Float32Array([0, 0, 10]), fovYDeg: 90 } as never;
  /* At distance 10 with a 90 degree field, the visible height is 20 world units. */
  expect(gizmoScaleFor(camera, new Float32Array([0, 0, 0]), 1000, 1000)).toBeCloseTo(20, 5);
});

test('translate and y are wired the same way as x', () => {
  const gizmo = new Gizmo();
  expect(gizmo.pick(...rayAt(0, 0.6))).toBe(GIZMO_TRANSLATE_Y);
  gizmo.beginDrag(...rayAt(0, 0.6));
  gizmo.updateDrag(...rayAt(0.5, 3.6));
  expect(gizmo.position[1]).toBeCloseTo(3, 5);
  expect(gizmo.position[0]).toBe(0);
});
