/**
 * A transform gizmo: what a ray is over, what a drag does to a transform, and the lines
 * that draw it.
 *
 * **A generator and not a pass**, which is the argument `debugLines.ts` makes and which
 * holds here with more force. `drawLines` has been on both backends since the polyline
 * batch landed; what a gizmo adds is the arithmetic. Nothing in this file touches a
 * context, so one implementation answers for WebGL2 and WebGPU alike and every test runs
 * without either.
 *
 * **It says what, and dispatches nothing.** `registerPickable` settled this for picking
 * and the same reasoning applies: enter, leave, capture and the difference between a click
 * and a drag belong to the consumer, which already has that logic for anything with a drag
 * in it. This is asked what a ray is over, and told when a drag begins, moves and ends.
 *
 * **It does not own the transform it edits.** `position`, `rotation` and `scale` are here
 * because a drag has to put its answer somewhere; the caller copies them onto whatever it
 * actually moves. A gizmo reaching into a `SceneNode` would be render code mutating scene
 * state, which `ARCHITECTURE.md` forbids.
 *
 * **Nothing here throws and nothing allocates after construction**, for the reason
 * `DebugLines` gives: a tool that threw would take the frame down at the moment somebody
 * was trying to move something.
 *
 * A caller wires it in four lines:
 *
 * ```ts
 * camera.rayThrough(origin, direction, cssX, cssY, cssWidth, cssHeight);
 * gizmo.size = gizmoScaleFor(camera, gizmo.position, cssHeight, 90);
 * if (down && !wasDown) gizmo.beginDrag(origin, direction);
 * else if (down) gizmo.updateDrag(origin, direction);
 * else { gizmo.endDrag(); gizmo.hover(origin, direction); }
 * ```
 */
import { quat, vec3 } from 'gl-matrix';
import { rayClosestOnLine, rayPlane, raySphere } from '../math/intersect.ts';
import { createLineSegments } from './linePoints.ts';
import type { LineSegments } from './linePoints.ts';
import type { Camera } from './camera.ts';
import type { Vec3 } from '../math/color.ts';

export const GIZMO_NONE = 0;
export const GIZMO_TRANSLATE_X = 1;
export const GIZMO_TRANSLATE_Y = 2;
export const GIZMO_TRANSLATE_Z = 3;
/** The plane handles are named for the axes they slide in, so `YZ` is normal to x. */
export const GIZMO_TRANSLATE_YZ = 4;
export const GIZMO_TRANSLATE_ZX = 5;
export const GIZMO_TRANSLATE_XY = 6;
export const GIZMO_ROTATE_X = 7;
export const GIZMO_ROTATE_Y = 8;
export const GIZMO_ROTATE_Z = 9;
export const GIZMO_SCALE_X = 10;
export const GIZMO_SCALE_Y = 11;
export const GIZMO_SCALE_Z = 12;
export const GIZMO_SCALE_UNIFORM = 13;

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoSpace = 'world' | 'local';

/** Buffer indices. Three axes, one neutral, one for whatever is highlighted. */
export const GIZMO_GROUP_X = 0;
export const GIZMO_GROUP_Y = 1;
export const GIZMO_GROUP_Z = 2;
export const GIZMO_GROUP_NEUTRAL = 3;
export const GIZMO_GROUP_ACTIVE = 4;
export const GIZMO_GROUP_COUNT = 5;

/**
 * A colour per group, in the order the groups are indexed.
 *
 * Exported as data rather than baked into a draw call because this file draws nothing.
 * A consumer with its own palette overrides them and nothing here notices.
 */
export const GIZMO_GROUP_COLORS: readonly Vec3[] = [
  [0.9, 0.25, 0.25],
  [0.35, 0.85, 0.3],
  [0.3, 0.5, 0.95],
  [0.75, 0.75, 0.78],
  [1.0, 0.85, 0.2],
];

/* Every length below is a fraction of `size`, so the whole gizmo scales as one thing. */
const ARM_START = 0.15;
const ARM_END = 1.0;
const ARM_PICK_RADIUS = 0.08;
const HEAD_LENGTH = 0.2;
const HEAD_RADIUS = 0.06;
const PLANE_INNER = 0.28;
const PLANE_OUTER = 0.58;
const RING_RADIUS = 1.0;
const RING_PICK_HALF_WIDTH = 0.07;
/** Inside this radius a ring drag's angle is noise, so the drag holds what it had. */
const RING_MIN_GRAB = 0.2;
const CENTRE_RADIUS = 0.13;
const TIP_RADIUS = 0.07;
/** A scale can be driven small but never to zero, which is not invertible, or negative. */
const MIN_SCALE = 0.01;

const TWO_PI = Math.PI * 2;

const BASIS: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * The world size that covers `pixels` screen pixels at the target's distance.
 *
 * A separate function rather than a method, which is what keeps every intersection and
 * every drag in this file testable against a bare ray: the gizmo never learns what a
 * camera is. A caller assigns the result to `size` once a frame.
 *
 * Perspective only, because `Camera` is. An orthographic camera's answer does not depend
 * on distance at all, and the day one exists this grows a branch rather than a caller.
 */
export function gizmoScaleFor(
  camera: Camera,
  target: ArrayLike<number>,
  cssHeight: number,
  pixels: number,
): number {
  const dx = (target[0] as number) - (camera.position[0] as number);
  const dy = (target[1] as number) - (camera.position[1] as number);
  const dz = (target[2] as number) - (camera.position[2] as number);
  const distance = Math.hypot(dx, dy, dz);
  const halfFov = (camera.fovYDeg * Math.PI) / 360;
  const worldPerPixel = (2 * distance * Math.tan(halfFov)) / Math.max(cssHeight, 1);
  return worldPerPixel * pixels;
}

export class Gizmo {
  mode: GizmoMode = 'translate';
  space: GizmoSpace = 'world';
  /** The gizmo's own world size. See `gizmoScaleFor`. Non-positive draws and picks nothing. */
  size = 1;

  /** The transform being edited. Written by a drag; the caller copies it where it belongs. */
  readonly position = new Float32Array(3);
  /** A quaternion, `xyzw`, identity at construction. */
  readonly rotation = new Float32Array([0, 0, 0, 1]);
  readonly scale = new Float32Array([1, 1, 1]);

  private readonly groups: LineSegments[] = [];
  private readonly ringSegments: number;

  /**
   * The basis the handles point along, rebuilt on every pick and frozen for a drag.
   *
   * Three standing `Float32Array`s rather than one of nine with a `subarray` per read:
   * `subarray` allocates a view object, and these are read several times per handle per
   * pointer move.
   */
  private readonly axes = [new Float32Array(3), new Float32Array(3), new Float32Array(3)];
  private readonly dragAxes = [new Float32Array(3), new Float32Array(3), new Float32Array(3)];

  private hoveredHandle = GIZMO_NONE;
  private activeHandle = GIZMO_NONE;

  /* Anchors, all captured by `beginDrag` and read by `updateDrag`. */
  private readonly grabPosition = new Float32Array(3);
  private readonly grabRotation = new Float32Array(4);
  private readonly grabScale = new Float32Array(3);
  private readonly grabPoint = new Float32Array(3);
  private readonly grabViewNormal = new Float32Array(3);
  private grabParam = 0;
  private grabRadius = 0;
  private previousAngle = 0;
  private accumulated = 0;

  /* Scratch, so a pointer move allocates nothing. */
  private readonly closest = new Float32Array(3);
  private readonly point = new Float32Array(3);
  private readonly offset = new Float32Array(3);
  private readonly turn = new Float32Array(4);
  private readonly corners = new Float32Array(18);

  /**
   * `ringSegments` is the resolution of a rotation ring, and it also sets every buffer's
   * capacity because a ring is the largest thing any one of them holds.
   */
  constructor(ringSegments = 48) {
    if (!(ringSegments >= 8))
      throw new Error(`Gizmo: ringSegments must be at least 8, got ${ringSegments}`);
    this.ringSegments = Math.floor(ringSegments);
    const capacity = this.ringSegments + 16;
    for (let group = 0; group < GIZMO_GROUP_COUNT; group++)
      this.groups.push(createLineSegments(capacity));
  }

  /** What a `hover` last found, or `GIZMO_NONE`. */
  get hovered(): number {
    return this.hoveredHandle;
  }

  /** The handle a drag is on, or `GIZMO_NONE`. */
  get active(): number {
    return this.activeHandle;
  }

  get dragging(): boolean {
    return this.activeHandle !== GIZMO_NONE;
  }

  /**
   * How far the current rotation drag has turned, in radians, signed and unbounded.
   *
   * **This is the only place the unwrap in `dragRing` is observable, and that is not
   * obvious.** The orientation is not: `quat.setAxisAngle` is 2π-periodic and a quaternion
   * double-covers the rotations, so an accumulated angle that is wrong by a whole turn
   * produces the same orientation, negated — which is the same rotation. What the unwrap
   * buys is a continuous *number*: a readout that says 270° rather than −90°, and a caller
   * that wants to snap to fifteen degrees or stop at a limit, both of which need the turn
   * and not the pose. Zero when no rotation drag is running.
   */
  get dragAngle(): number {
    return this.activeHandle >= GIZMO_ROTATE_X && this.activeHandle <= GIZMO_ROTATE_Z
      ? this.accumulated
      : 0;
  }

  /** One group's geometry, filled by the last `build`. Draw it with `GIZMO_GROUP_COLORS[group]`. */
  segments(group: number): LineSegments {
    const at = this.groups[group];
    if (at === undefined) throw new Error(`Gizmo: no group ${group}`);
    return at;
  }

  /**
   * The handle a ray is over, or `GIZMO_NONE`. No side effects; `hover` is the one that
   * remembers.
   *
   * **Nearest along the ray wins, except that the centre handle wins outright**, which is
   * one documented exception rather than a priority table: a priority table would let a
   * plane handle behind the camera beat an arm in front of it, which a user sees as a
   * click landing on the wrong thing.
   *
   * **As the radii stand the exception decides nothing**, and that is worth saying rather
   * than implying otherwise: an arm's pick cylinder starts at `ARM_START` of the size and
   * the centre's sphere ends at `CENTRE_RADIUS`, which is smaller, so the two regions do
   * not meet. The ordering is what keeps a later change to either radius from quietly
   * producing a centre nobody can click, which is the failure it is here to prevent.
   *
   * `direction` must be unit length. `camera.rayThrough` gives one.
   */
  pick(origin: ArrayLike<number>, direction: ArrayLike<number>): number {
    if (!(this.size > 0)) return GIZMO_NONE;
    this.refreshAxes(this.axes);

    if (this.mode === 'scale') {
      const centre = raySphere(origin, direction, this.position, this.size * CENTRE_RADIUS);
      if (centre >= 0) return GIZMO_SCALE_UNIFORM;
    }

    let best = Infinity;
    let handle = GIZMO_NONE;

    for (let axis = 0; axis < 3; axis++) {
      if (this.mode === 'rotate') {
        const t = this.pickRing(origin, direction, axis, this.axes);
        if (t >= 0 && t < best) {
          best = t;
          handle = GIZMO_ROTATE_X + axis;
        }
        continue;
      }

      const arm = this.pickArm(origin, direction, axis, this.axes);
      if (arm >= 0 && arm < best) {
        best = arm;
        handle = (this.mode === 'translate' ? GIZMO_TRANSLATE_X : GIZMO_SCALE_X) + axis;
      }

      if (this.mode === 'translate') {
        const plane = this.pickPlane(origin, direction, axis, this.axes);
        if (plane >= 0 && plane < best) {
          best = plane;
          handle = GIZMO_TRANSLATE_YZ + axis;
        }
      }
    }

    return handle;
  }

  /** `pick`, remembered. Returns what it found. Ignored while a drag is running. */
  hover(origin: ArrayLike<number>, direction: ArrayLike<number>): number {
    if (this.dragging) return this.activeHandle;
    this.hoveredHandle = this.pick(origin, direction);
    return this.hoveredHandle;
  }

  /**
   * Grab whatever the ray is over. Returns whether a drag started.
   *
   * **The transform and the axes are both captured here and neither is re-read until the
   * drag ends.** Recomputing the basis from a rotation the drag is changing feeds the
   * answer back into its own input, and what that looks like is a ring that accelerates
   * away from the pointer.
   *
   * A grab whose anchor cannot be computed — a ray parallel to the axis it is grabbing —
   * refuses rather than starting a drag with an arbitrary origin.
   */
  beginDrag(origin: ArrayLike<number>, direction: ArrayLike<number>): boolean {
    const handle = this.pick(origin, direction);
    if (handle === GIZMO_NONE) return false;

    for (let axis = 0; axis < 3; axis++)
      (this.dragAxes[axis] as Float32Array).set(this.axes[axis] as Float32Array);
    this.grabPosition.set(this.position);
    this.grabRotation.set(this.rotation);
    this.grabScale.set(this.scale);
    this.accumulated = 0;

    if (!this.anchor(handle, origin, direction)) return false;
    this.activeHandle = handle;
    this.hoveredHandle = handle;
    return true;
  }

  /**
   * Move the drag. Returns whether the transform changed.
   *
   * **Every answer is absolute, computed from the anchor rather than accumulated from the
   * last call**, so a drag cannot drift however many frames it runs for. Rotation is the
   * one exception and §5 of the design says why: an angle has to be unwrapped against the
   * previous one to survive the seam at ±π, so the total is accumulated and the *total* is
   * what the transform is built from.
   *
   * **A degenerate ray keeps the previous value rather than producing one.** The
   * alternative is the object teleporting at the moment the pointer crosses the plane it
   * is dragging in, which is the single most annoying thing a gizmo can do.
   */
  updateDrag(origin: ArrayLike<number>, direction: ArrayLike<number>): boolean {
    const handle = this.activeHandle;
    if (handle === GIZMO_NONE) return false;

    if (handle >= GIZMO_TRANSLATE_X && handle <= GIZMO_TRANSLATE_Z) {
      return this.dragAlongArm(origin, direction, handle - GIZMO_TRANSLATE_X, true);
    }
    if (handle >= GIZMO_TRANSLATE_YZ && handle <= GIZMO_TRANSLATE_XY) {
      return this.dragInPlane(origin, direction, handle - GIZMO_TRANSLATE_YZ);
    }
    if (handle >= GIZMO_ROTATE_X && handle <= GIZMO_ROTATE_Z) {
      return this.dragRing(origin, direction, handle - GIZMO_ROTATE_X);
    }
    if (handle >= GIZMO_SCALE_X && handle <= GIZMO_SCALE_Z) {
      return this.dragAlongArm(origin, direction, handle - GIZMO_SCALE_X, false);
    }
    return this.dragUniform(origin, direction);
  }

  /** Let go. Safe to call on a frame with no drag running. */
  endDrag(): void {
    this.activeHandle = GIZMO_NONE;
  }

  /**
   * Fill the five buffers for this frame's mode, transform and highlight.
   *
   * Cheap enough to call every frame — a rotation ring at the default resolution is 48
   * segments of arithmetic — and it has to be, because the highlight changes with the
   * pointer.
   */
  build(): void {
    for (const group of this.groups) group.count = 0;
    if (!(this.size > 0)) return;
    /* A running drag draws against the basis it grabbed. Refreshing it here would undo the
     * freeze `beginDrag` took, and a local-space ring would chase its own rotation. */
    if (!this.dragging) this.refreshAxes(this.axes);
    const axes = this.dragging ? this.dragAxes : this.axes;
    const lit = this.dragging ? this.activeHandle : this.hoveredHandle;

    if (this.mode === 'translate') {
      for (let axis = 0; axis < 3; axis++) {
        this.buildArm(axis, axes, this.groupFor(GIZMO_TRANSLATE_X + axis, axis, lit), true);
        this.buildPlane(axis, axes, this.groupFor(GIZMO_TRANSLATE_YZ + axis, axis, lit));
      }
      return;
    }

    if (this.mode === 'rotate') {
      for (let axis = 0; axis < 3; axis++) {
        this.buildRing(axis, axes, this.groupFor(GIZMO_ROTATE_X + axis, axis, lit));
      }
      return;
    }

    for (let axis = 0; axis < 3; axis++) {
      this.buildArm(axis, axes, this.groupFor(GIZMO_SCALE_X + axis, axis, lit), false);
    }
    this.buildOctahedron(
      this.position[0] as number,
      this.position[1] as number,
      this.position[2] as number,
      this.size * CENTRE_RADIUS,
      axes,
      lit === GIZMO_SCALE_UNIFORM ? GIZMO_GROUP_ACTIVE : GIZMO_GROUP_NEUTRAL,
    );
  }

  /** A handle's own colour group, unless it is the one lit. */
  private groupFor(handle: number, axis: number, lit: number): number {
    return handle === lit ? GIZMO_GROUP_ACTIVE : axis;
  }

  /**
   * The basis the handles point along.
   *
   * **Scale is always local whatever `space` says.** A non-uniform scale along a world
   * axis is not representable in a translation-rotation-scale transform, so a gizmo
   * offering it would shear the object and call it scaling.
   */
  private refreshAxes(into: readonly Float32Array[]): void {
    const local = this.space === 'local' || this.mode === 'scale';
    for (let axis = 0; axis < 3; axis++) {
      const source = BASIS[axis] as Vec3;
      const target = into[axis] as Float32Array;
      if (local) vec3.transformQuat(target, source, this.rotation);
      else target.set(source);
    }
  }

  /**
   * Where a ray meets an arm's cylinder, or `-1`.
   *
   * The region is a cylinder without caps: a closest point past either end of the segment
   * is a miss rather than being clamped to the cap. It costs a sliver of pickable area at
   * the two ends of a handle a user aims at the middle of, and it keeps this to one
   * intersection.
   */
  private pickArm(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    axis: number,
    axes: readonly Float32Array[],
  ): number {
    const ray = this.closest;
    if (!rayClosestOnLine(origin, direction, this.position, axes[axis] as Float32Array, ray)) {
      return -1;
    }
    const along = ray[1] as number;
    if (along < this.size * ARM_START || along > this.size * ARM_END) return -1;
    if ((ray[2] as number) > this.size * ARM_PICK_RADIUS) return -1;
    const distance = ray[0] as number;
    return distance >= 0 ? distance : -1;
  }

  /**
   * Where a ray meets a plane handle's quad, or `-1`.
   *
   * The quad sits in the positive quadrant of its two axes and stays there. Following the
   * camera into whichever quadrant faces it is what a mature editor does and it is a
   * second thing to get right; a fixed quadrant is honest and is visible from where it is.
   */
  private pickPlane(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    normalAxis: number,
    axes: readonly Float32Array[],
  ): number {
    const normal = axes[normalAxis] as Float32Array;
    const distance = rayPlane(origin, direction, this.position, normal);
    if (distance < 0) return -1;

    this.offsetAt(origin, direction, distance);
    const first = (normalAxis + 1) % 3;
    const second = (normalAxis + 2) % 3;
    const a = this.along(first, axes);
    const b = this.along(second, axes);
    const inner = this.size * PLANE_INNER;
    const outer = this.size * PLANE_OUTER;
    if (a < inner || a > outer || b < inner || b > outer) return -1;
    return distance;
  }

  /** Where a ray meets a rotation ring's annulus, or `-1`. */
  private pickRing(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    axis: number,
    axes: readonly Float32Array[],
  ): number {
    const normal = axes[axis] as Float32Array;
    const distance = rayPlane(origin, direction, this.position, normal);
    if (distance < 0) return -1;

    this.offsetAt(origin, direction, distance);
    const radius = Math.hypot(
      this.offset[0] as number,
      this.offset[1] as number,
      this.offset[2] as number,
    );
    if (Math.abs(radius - this.size * RING_RADIUS) > this.size * RING_PICK_HALF_WIDTH) return -1;
    return distance;
  }

  /** Capture whatever the handle being grabbed needs. `false` refuses the drag. */
  private anchor(handle: number, origin: ArrayLike<number>, direction: ArrayLike<number>): boolean {
    if (handle >= GIZMO_TRANSLATE_X && handle <= GIZMO_TRANSLATE_Z) {
      return this.anchorArm(origin, direction, handle - GIZMO_TRANSLATE_X);
    }
    if (handle >= GIZMO_TRANSLATE_YZ && handle <= GIZMO_TRANSLATE_XY) {
      return this.anchorPlane(origin, direction, handle - GIZMO_TRANSLATE_YZ);
    }
    if (handle >= GIZMO_ROTATE_X && handle <= GIZMO_ROTATE_Z) {
      return this.anchorRing(origin, direction, handle - GIZMO_ROTATE_X);
    }
    if (handle >= GIZMO_SCALE_X && handle <= GIZMO_SCALE_Z) {
      return this.anchorArm(origin, direction, handle - GIZMO_SCALE_X);
    }
    return this.anchorUniform(origin, direction);
  }

  private anchorArm(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    axis: number,
  ): boolean {
    const ray = this.closest;
    const line = this.dragAxes[axis] as Float32Array;
    if (!rayClosestOnLine(origin, direction, this.grabPosition, line, ray)) return false;
    this.grabParam = ray[1] as number;
    return true;
  }

  private anchorPlane(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    normalAxis: number,
  ): boolean {
    const normal = this.dragAxes[normalAxis] as Float32Array;
    const distance = rayPlane(origin, direction, this.grabPosition, normal);
    if (distance < 0) return false;
    this.grabPoint[0] = (origin[0] as number) + (direction[0] as number) * distance;
    this.grabPoint[1] = (origin[1] as number) + (direction[1] as number) * distance;
    this.grabPoint[2] = (origin[2] as number) + (direction[2] as number) * distance;
    return true;
  }

  private anchorRing(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    axis: number,
  ): boolean {
    const angle = this.ringAngle(origin, direction, axis);
    if (angle === null) return false;
    this.previousAngle = angle;
    return true;
  }

  private anchorUniform(origin: ArrayLike<number>, direction: ArrayLike<number>): boolean {
    /* The view plane at the moment of grabbing: the pointer's own direction is its normal,
     * which is the view direction at that point and asks nothing of a camera. */
    this.grabViewNormal[0] = direction[0] as number;
    this.grabViewNormal[1] = direction[1] as number;
    this.grabViewNormal[2] = direction[2] as number;
    const distance = rayPlane(origin, direction, this.grabPosition, this.grabViewNormal);
    if (distance < 0) return false;
    this.offsetAt(origin, direction, distance);
    this.grabRadius = Math.hypot(
      this.offset[0] as number,
      this.offset[1] as number,
      this.offset[2] as number,
    );
    return true;
  }

  /** Translate along an arm, or scale along it. One intersection answers both. */
  private dragAlongArm(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    axis: number,
    translate: boolean,
  ): boolean {
    const ray = this.closest;
    const line = this.dragAxes[axis] as Float32Array;
    if (!rayClosestOnLine(origin, direction, this.grabPosition, line, ray)) return false;
    const moved = (ray[1] as number) - this.grabParam;

    if (translate) {
      for (let component = 0; component < 3; component++) {
        this.position[component] =
          (this.grabPosition[component] as number) + (line[component] as number) * moved;
      }
      return true;
    }

    this.scale[axis] = Math.max(
      (this.grabScale[axis] as number) * (1 + moved / this.size),
      MIN_SCALE,
    );
    return true;
  }

  private dragInPlane(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    normalAxis: number,
  ): boolean {
    const normal = this.dragAxes[normalAxis] as Float32Array;
    const distance = rayPlane(origin, direction, this.grabPosition, normal);
    if (distance < 0) return false;
    for (let component = 0; component < 3; component++) {
      const hit = (origin[component] as number) + (direction[component] as number) * distance;
      this.position[component] =
        (this.grabPosition[component] as number) + (hit - (this.grabPoint[component] as number));
    }
    return true;
  }

  /**
   * Turn about a ring.
   *
   * **`atan2` answers in `(−π, π]`, so a drag crossing the seam reads as a jump of nearly
   * a full turn.** Each update is unwrapped against the previous angle and the total
   * accumulates, which is what makes a three-quarter turn a three-quarter turn instead of
   * a quarter the other way — in the number. See `dragAngle` for why the orientation
   * cannot show the difference, and why the unwrap is still not dead code.
   */
  private dragRing(origin: ArrayLike<number>, direction: ArrayLike<number>, axis: number): boolean {
    const angle = this.ringAngle(origin, direction, axis);
    if (angle === null) return false;

    let delta = angle - this.previousAngle;
    if (delta > Math.PI) delta -= TWO_PI;
    else if (delta < -Math.PI) delta += TWO_PI;
    this.previousAngle = angle;
    this.accumulated += delta;

    quat.setAxisAngle(this.turn, this.dragAxes[axis] as Float32Array, this.accumulated);
    quat.multiply(this.rotation, this.turn, this.grabRotation);
    return true;
  }

  private dragUniform(origin: ArrayLike<number>, direction: ArrayLike<number>): boolean {
    const distance = rayPlane(origin, direction, this.grabPosition, this.grabViewNormal);
    if (distance < 0) return false;
    this.offsetAt(origin, direction, distance);
    const radius = Math.hypot(
      this.offset[0] as number,
      this.offset[1] as number,
      this.offset[2] as number,
    );
    const factor = 1 + (radius - this.grabRadius) / this.size;
    for (let component = 0; component < 3; component++) {
      this.scale[component] = Math.max((this.grabScale[component] as number) * factor, MIN_SCALE);
    }
    return true;
  }

  /**
   * The angle a ray makes in a ring's plane, or `null` when there is none to speak of.
   *
   * Near the centre the hit is a point whose angle is dominated by whatever the last
   * floating-point bit did, so a drag there would spin. Refusing keeps what the drag had.
   */
  private ringAngle(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    axis: number,
  ): number | null {
    const normal = this.dragAxes[axis] as Float32Array;
    const distance = rayPlane(origin, direction, this.grabPosition, normal);
    if (distance < 0) return null;

    for (let component = 0; component < 3; component++) {
      this.offset[component] =
        (origin[component] as number) +
        (direction[component] as number) * distance -
        (this.grabPosition[component] as number);
    }
    const radius = Math.hypot(
      this.offset[0] as number,
      this.offset[1] as number,
      this.offset[2] as number,
    );
    if (radius < this.size * RING_MIN_GRAB) return null;

    const first = (axis + 1) % 3;
    const second = (axis + 2) % 3;
    return Math.atan2(this.along(second, this.dragAxes), this.along(first, this.dragAxes));
  }

  /** `offset` becomes the vector from the gizmo to the ray's point at `distance`. */
  private offsetAt(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    distance: number,
  ): void {
    for (let component = 0; component < 3; component++) {
      this.offset[component] =
        (origin[component] as number) +
        (direction[component] as number) * distance -
        (this.position[component] as number);
    }
  }

  /** How far `offset` reaches along one of the axes. */
  private along(axis: number, axes: readonly Float32Array[]): number {
    const vector = axes[axis] as Float32Array;
    return (
      (this.offset[0] as number) * (vector[0] as number) +
      (this.offset[1] as number) * (vector[1] as number) +
      (this.offset[2] as number) * (vector[2] as number)
    );
  }

  private emit(
    group: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    const target = this.groups[group];
    if (target === undefined) return;
    const at = target.count;
    /* Discarded rather than thrown, for the reason `DebugLines.dropped` exists. */
    if (at >= target.capacity) return;
    target.from[at * 3] = ax;
    target.from[at * 3 + 1] = ay;
    target.from[at * 3 + 2] = az;
    target.to[at * 3] = bx;
    target.to[at * 3 + 1] = by;
    target.to[at * 3 + 2] = bz;
    target.count = at + 1;
  }

  /** `point` becomes the gizmo origin plus a combination of the three axes. */
  private at(
    axes: readonly Float32Array[],
    a: number,
    u: number,
    b: number,
    v: number,
    c: number,
    w: number,
  ): void {
    const first = axes[a] as Float32Array;
    const second = axes[b] as Float32Array;
    const third = axes[c] as Float32Array;
    for (let component = 0; component < 3; component++) {
      this.point[component] =
        (this.position[component] as number) +
        (first[component] as number) * u +
        (second[component] as number) * v +
        (third[component] as number) * w;
    }
  }

  private buildArm(
    axis: number,
    axes: readonly Float32Array[],
    group: number,
    arrow: boolean,
  ): void {
    const first = (axis + 1) % 3;
    const second = (axis + 2) % 3;
    const tip = this.size * ARM_END;
    const base = arrow ? tip - this.size * HEAD_LENGTH : tip - this.size * TIP_RADIUS;

    this.at(axes, axis, this.size * ARM_START, first, 0, second, 0);
    const sx = this.point[0] as number,
      sy = this.point[1] as number,
      sz = this.point[2] as number;
    this.at(axes, axis, base, first, 0, second, 0);
    this.emit(
      group,
      sx,
      sy,
      sz,
      this.point[0] as number,
      this.point[1] as number,
      this.point[2] as number,
    );

    if (!arrow) {
      this.at(axes, axis, tip, first, 0, second, 0);
      this.buildOctahedron(
        this.point[0] as number,
        this.point[1] as number,
        this.point[2] as number,
        this.size * TIP_RADIUS,
        axes,
        group,
      );
      return;
    }

    /* A four-spoke cone: the tip to four points around the base, and the base square. */
    this.at(axes, axis, tip, first, 0, second, 0);
    const tx = this.point[0] as number,
      ty = this.point[1] as number,
      tz = this.point[2] as number;
    const radius = this.size * HEAD_RADIUS;
    let px = 0,
      py = 0,
      pz = 0;
    for (let corner = 0; corner < 4; corner++) {
      const angle = (corner / 4) * TWO_PI;
      this.at(axes, axis, base, first, Math.cos(angle) * radius, second, Math.sin(angle) * radius);
      const cx = this.point[0] as number,
        cy = this.point[1] as number,
        cz = this.point[2] as number;
      this.emit(group, tx, ty, tz, cx, cy, cz);
      if (corner > 0) this.emit(group, px, py, pz, cx, cy, cz);
      if (corner === 3) {
        this.at(axes, axis, base, first, radius, second, 0);
        this.emit(
          group,
          cx,
          cy,
          cz,
          this.point[0] as number,
          this.point[1] as number,
          this.point[2] as number,
        );
      }
      px = cx;
      py = cy;
      pz = cz;
    }
  }

  private buildPlane(normalAxis: number, axes: readonly Float32Array[], group: number): void {
    const first = (normalAxis + 1) % 3;
    const second = (normalAxis + 2) % 3;
    const inner = this.size * PLANE_INNER;
    const outer = this.size * PLANE_OUTER;
    let px = 0,
      py = 0,
      pz = 0;
    let fx = 0,
      fy = 0,
      fz = 0;
    for (let corner = 0; corner < 4; corner++) {
      const u = corner === 1 || corner === 2 ? outer : inner;
      const v = corner >= 2 ? outer : inner;
      this.at(axes, first, u, second, v, normalAxis, 0);
      const cx = this.point[0] as number,
        cy = this.point[1] as number,
        cz = this.point[2] as number;
      if (corner === 0) {
        fx = cx;
        fy = cy;
        fz = cz;
      } else {
        this.emit(group, px, py, pz, cx, cy, cz);
      }
      if (corner === 3) this.emit(group, cx, cy, cz, fx, fy, fz);
      px = cx;
      py = cy;
      pz = cz;
    }
  }

  private buildRing(axis: number, axes: readonly Float32Array[], group: number): void {
    const first = (axis + 1) % 3;
    const second = (axis + 2) % 3;
    const radius = this.size * RING_RADIUS;
    let px = 0,
      py = 0,
      pz = 0;
    for (let step = 0; step <= this.ringSegments; step++) {
      const angle = (step / this.ringSegments) * TWO_PI;
      this.at(axes, first, Math.cos(angle) * radius, second, Math.sin(angle) * radius, axis, 0);
      const cx = this.point[0] as number,
        cy = this.point[1] as number,
        cz = this.point[2] as number;
      if (step > 0) this.emit(group, px, py, pz, cx, cy, cz);
      px = cx;
      py = cy;
      pz = cz;
    }
  }

  /**
   * Six vertices on the axes and the twelve edges between them.
   *
   * Drawn as an octahedron and picked as a sphere of the same radius, so the region that
   * responds is slightly larger than the shape — which errs toward being easy to grab.
   */
  private buildOctahedron(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    axes: readonly Float32Array[],
    group: number,
  ): void {
    const vertices = this.corners;
    for (let axis = 0; axis < 3; axis++) {
      const vector = axes[axis] as Float32Array;
      for (let component = 0; component < 3; component++) {
        const offset = (vector[component] as number) * radius;
        const centre = component === 0 ? cx : component === 1 ? cy : cz;
        vertices[axis * 6 + component] = centre + offset;
        vertices[axis * 6 + 3 + component] = centre - offset;
      }
    }
    /* Every +/- vertex of one axis joins every +/- vertex of the next: four edges a pair. */
    for (let axis = 0; axis < 3; axis++) {
      const next = (axis + 1) % 3;
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          this.emit(
            group,
            vertices[axis * 6 + a * 3] as number,
            vertices[axis * 6 + a * 3 + 1] as number,
            vertices[axis * 6 + a * 3 + 2] as number,
            vertices[next * 6 + b * 3] as number,
            vertices[next * 6 + b * 3 + 1] as number,
            vertices[next * 6 + b * 3 + 2] as number,
          );
        }
      }
    }
  }
}
