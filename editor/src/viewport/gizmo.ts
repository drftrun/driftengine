/**
 * Turning a gizmo drag into commands.
 *
 * **Core draws the gizmo; this decides what a drag means.** `core/src/render/gizmo.ts` owns the
 * arms, the rings and the hit test, and it says in its own header that it does not own the
 * transform it edits — a caller copies the result onto whatever it actually moves. For an editor
 * that copying is not an assignment, it is a `Command`, because a change nobody can undo is not an
 * edit anybody will make twice.
 *
 * **The drag arithmetic is here rather than core's, and the reason is a conditioning number.**
 * Core translates by taking the closest point between the ray and the axis line. That is correct,
 * and it refuses only within `1e-6` of parallel; between that cutoff and a comfortable angle the
 * answer is divided by the squared sine, so two degrees off the axis multiplies a pixel of mouse
 * noise by **820**. Core is not wrong for what it is for — somebody dragging a prop is looking at
 * the prop. An editor has orbit cameras, and users who set one down and come back to it.
 *
 * So a drag is computed against a **plane containing the axis, chosen per drag as the one whose
 * normal most faces the camera**. The two candidates are orthogonal, so whichever is chosen takes
 * at least a 45° bite of whatever the view direction has left after the axis: the conditioning is
 * never worse than √2. A fixed choice reaches a billion four times a turn.
 *
 * **What no plane fixes is an axis pointing at the camera.** Then every plane containing it is
 * edge-on and there is no drag to compute — which is why a gizmo hides a handle within a few
 * degrees of the view direction rather than pretending. This module reports the refusal; hiding
 * the handle is the viewport's decision.
 *
 * **A command per frame, merged into one entry.** `UndoStack` applies exactly once and calls
 * `merge` *after* it has applied the next command, so an absorbing command must not apply what it
 * absorbed — it keeps its own starting positions and takes the newer targets. Getting that
 * backwards moves the object twice as far as the pointer, which reads as a sensitivity bug.
 */
import { GIZMO_NONE, rayPlane } from '@driftengine/core';
import {
  GIZMO_TRANSLATE_X,
  GIZMO_TRANSLATE_XY,
  GIZMO_TRANSLATE_Y,
  GIZMO_TRANSLATE_YZ,
  GIZMO_TRANSLATE_Z,
  GIZMO_TRANSLATE_ZX,
} from '@driftengine/core';
import {
  primarySelection,
  selectedEntities,
  type Command,
  type Selection,
} from '@driftengine/tools';

/** A ray through the viewport, as `pick.ts` produces one. */
export interface Ray {
  readonly origin: Float32Array;
  readonly direction: Float32Array;
}

/**
 * Where positions come from and go.
 *
 * Taken as a parameter rather than imported, for the reason `freeze.ts` gives about worlds: the
 * editor must work over whatever a consumer is holding, and two methods is all a translate gizmo
 * reads and writes.
 */
export interface TransformSource {
  /** Write an entity's world position into `out`. False when there is no such entity. */
  positionOf(entity: number, out: Float32Array): boolean;
  setPosition(entity: number, x: number, y: number, z: number): void;
}

export interface GizmoState {
  readonly source: TransformSource;
  /** Held by reference: three panels share one selection, and a copy would drift. */
  readonly selection: Selection;
  /** The handle being dragged, one of core's `GIZMO_*`. `GIZMO_NONE` when idle. */
  axis: number;
  /** Where the pivot was when the drag began. */
  readonly pivot: Float32Array;
  /** The plane the whole drag is computed against, chosen once at the start. */
  readonly planeNormal: Float32Array;
  /** Where the ray met that plane when the drag began. */
  readonly grab: Float32Array;
  /** Entities under the drag, and their positions when it began — three floats each. */
  entities: number[];
  starts: Float32Array;
  /**
   * Identity of the drag in progress, renewed by every `beginGizmoDrag`.
   *
   * **This is what stops two separate drags merging into one undo entry.** Merging on "same
   * entities, same label" would absorb the second drag of the same object into the first, so
   * undo would take back a movement the user had already finished and accepted.
   */
  dragId: symbol;
}

export function createGizmoState(source: TransformSource, selection: Selection): GizmoState {
  return {
    source,
    selection,
    axis: GIZMO_NONE,
    pivot: new Float32Array(3),
    planeNormal: new Float32Array(3),
    grab: new Float32Array(3),
    entities: [],
    starts: new Float32Array(0),
    dragId: Symbol('idle'),
  };
}

/** Which axis a handle runs along, or -1. X is 0. */
function axisOf(handle: number): number {
  if (handle === GIZMO_TRANSLATE_X) return 0;
  if (handle === GIZMO_TRANSLATE_Y) return 1;
  if (handle === GIZMO_TRANSLATE_Z) return 2;
  return -1;
}

/** Which axis a plane handle excludes, or -1. `YZ` excludes X. */
function normalAxisOf(handle: number): number {
  if (handle === GIZMO_TRANSLATE_YZ) return 0;
  if (handle === GIZMO_TRANSLATE_ZX) return 1;
  if (handle === GIZMO_TRANSLATE_XY) return 2;
  return -1;
}

/**
 * The plane a drag on this handle is computed against, for a camera looking along `view`.
 *
 * For a plane handle there is no choice — the handle names its plane. For an axis handle there are
 * two planes containing the axis and this picks the one facing the camera more squarely, which is
 * the whole of why an editor drag does not fling anything.
 *
 * Returns false for a handle that is not a translate.
 */
export function dragPlaneNormal(
  handle: number,
  view: ArrayLike<number>,
  out: Float32Array,
): boolean {
  const excluded = normalAxisOf(handle);
  if (excluded >= 0) {
    out.fill(0);
    out[excluded] = 1;
    return true;
  }
  const axis = axisOf(handle);
  if (axis < 0) return false;

  /* The two axes that are not this one, each the normal of a plane containing it. */
  const first = (axis + 1) % 3;
  const second = (axis + 2) % 3;
  const facingFirst = Math.abs(view[first] as number);
  const facingSecond = Math.abs(view[second] as number);
  out.fill(0);
  out[facingFirst >= facingSecond ? first : second] = 1;
  return true;
}

/**
 * Where the gizmo sits for a selection: the primary's position.
 *
 * **The primary and not the centroid**, because a centroid moves when the selection changes and a
 * drag that started around one point should not finish around another. `Selection` keeps insertion
 * order for exactly this.
 */
export function gizmoPivot(
  selection: Selection,
  source: TransformSource,
  out: Float32Array,
): boolean {
  const primary = primarySelection(selection);
  if (primary === null) return false;
  return source.positionOf(primary, out);
}

/** How square to the camera a plane has to be before a drag against it is worth computing. */
const MIN_FACING = 0.05;

/** Below this, in world units, a drag has not moved and emits nothing. */
const MIN_MOVEMENT = 1e-5;

export function beginGizmoDrag(state: GizmoState, handle: number, ray: Ray): boolean {
  state.axis = GIZMO_NONE;
  if (!gizmoPivot(state.selection, state.source, state.pivot)) return false;
  if (!dragPlaneNormal(handle, ray.direction, state.planeNormal)) return false;

  const facing = Math.abs(dot(ray.direction, state.planeNormal));
  /* Every plane containing this axis is edge-on, which means the axis points at the camera. There
     is no drag to compute and the honest answer is to refuse rather than to invent one. */
  if (facing < MIN_FACING) return false;

  const distance = rayPlane(ray.origin, ray.direction, state.pivot, state.planeNormal);
  if (distance < 0) return false;
  pointAt(ray, distance, state.grab);

  const entities = selectedEntities(state.selection);
  state.entities = [...entities];
  state.starts = new Float32Array(state.entities.length * 3);
  const scratch = new Float32Array(3);
  for (let at = 0; at < state.entities.length; at += 1) {
    if (!state.source.positionOf(state.entities[at] as number, scratch)) continue;
    state.starts.set(scratch, at * 3);
  }
  state.dragId = Symbol('gizmo drag');
  state.axis = handle;
  return true;
}

const HIT = new Float32Array(3);
const DELTA = new Float32Array(3);

/**
 * The command this frame of the drag implies, or `null` when the drag has not moved.
 *
 * `null` rather than a command that changes nothing: a click on a handle is not an edit, and a
 * stack full of entries that move nothing makes undo useless.
 */
export function updateGizmoDrag(state: GizmoState, ray: Ray): Command | null {
  if (state.axis === GIZMO_NONE) return null;

  const distance = rayPlane(ray.origin, ray.direction, state.pivot, state.planeNormal);
  if (distance < 0) return null;
  pointAt(ray, distance, HIT);

  for (let component = 0; component < 3; component += 1) {
    DELTA[component] = (HIT[component] as number) - (state.grab[component] as number);
  }

  const axis = axisOf(state.axis);
  if (axis >= 0) {
    /* Along the arm only: the component of the in-plane offset that lies on the axis. */
    const along = DELTA[axis] as number;
    DELTA.fill(0);
    DELTA[axis] = along;
  }

  if (Math.hypot(DELTA[0] as number, DELTA[1] as number, DELTA[2] as number) < MIN_MOVEMENT) {
    return null;
  }
  return moveCommand(state, DELTA);
}

export function endGizmoDrag(state: GizmoState): void {
  state.axis = GIZMO_NONE;
  state.entities = [];
  state.starts = new Float32Array(0);
}

/** The label a merged drag keeps, so the undo menu says one thing for the whole movement. */
const MOVE_LABEL = 'Move';

interface MoveCommand extends Command {
  readonly gizmoDrag: symbol;
  readonly entities: readonly number[];
  readonly starts: Float32Array;
  targets: Float32Array;
}

function moveCommand(state: GizmoState, delta: Float32Array): Command {
  const entities = [...state.entities];
  const starts = state.starts.slice();
  const targets = new Float32Array(starts.length);
  for (let at = 0; at < entities.length; at += 1) {
    for (let component = 0; component < 3; component += 1) {
      targets[at * 3 + component] =
        (starts[at * 3 + component] as number) + (delta[component] as number);
    }
  }

  const source = state.source;
  const write = (values: Float32Array): void => {
    for (let at = 0; at < entities.length; at += 1) {
      source.setPosition(
        entities[at] as number,
        values[at * 3] as number,
        values[at * 3 + 1] as number,
        values[at * 3 + 2] as number,
      );
    }
  };

  /*
   * **Absolute positions and not a delta, which is what makes this safe against the contract's
   * own trap.** `UndoStack` applies exactly once and calls `merge` afterwards; a command that
   * applied what it absorbed would move a delta-based object twice as far as the pointer. Writing
   * the target position twice writes it once, so the mistake cannot bite here — and the test says
   * so rather than pretending to catch a double-apply it cannot see.
   */
  const command: MoveCommand = {
    label: MOVE_LABEL,
    gizmoDrag: state.dragId,
    entities,
    starts,
    targets,
    apply(): void {
      write(this.targets);
    },
    revert(): void {
      write(starts);
    },
    merge(next: Command): boolean {
      const other = next as Partial<MoveCommand>;
      if (other.gizmoDrag !== this.gizmoDrag) return false;
      /*
       * Absorbed, and **not applied**: the stack has already applied `next`. What changes is that
       * this command's `revert` still restores the positions the drag began at, and its `apply`
       * now puts the object where the drag has reached.
       */
      this.targets = other.targets as Float32Array;
      return true;
    },
  };
  return command;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

function pointAt(ray: Ray, distance: number, out: Float32Array): void {
  for (let component = 0; component < 3; component += 1) {
    out[component] =
      (ray.origin[component] as number) + (ray.direction[component] as number) * distance;
  }
}
