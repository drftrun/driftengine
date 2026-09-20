import { describe, expect, test } from 'vitest';
import {
  GIZMO_ROTATE_Y,
  GIZMO_SCALE_X,
  GIZMO_TRANSLATE_X,
  GIZMO_TRANSLATE_XY,
  GIZMO_TRANSLATE_Y,
  GIZMO_TRANSLATE_YZ,
  GIZMO_TRANSLATE_Z,
  GIZMO_TRANSLATE_ZX,
  rayClosestOnLine,
  rayPlane,
} from '@driftengine/core';
import {
  createSelection,
  createUndoStack,
  selectOnly,
  addToSelection,
  type Command,
} from '@driftengine/tools';

import {
  beginGizmoDrag,
  createGizmoState,
  dragPlaneNormal,
  endGizmoDrag,
  gizmoPivot,
  updateGizmoDrag,
  type Ray,
  type TransformSource,
} from './gizmo.ts';

/** A world of positions and nothing else, which is all a translate gizmo reads. */
function sourceOf(
  entries: readonly [number, readonly [number, number, number]][],
): TransformSource {
  const positions = new Map<number, Float32Array>();
  for (const [entity, at] of entries) positions.set(entity, Float32Array.from(at));
  return {
    positionOf(entity: number, out: Float32Array): boolean {
      const at = positions.get(entity);
      if (at === undefined) return false;
      out.set(at);
      return true;
    },
    setPosition(entity: number, x: number, y: number, z: number): void {
      const at = positions.get(entity);
      if (at === undefined) return;
      at[0] = x;
      at[1] = y;
      at[2] = z;
    },
  };
}

function at(source: TransformSource, entity: number): number[] {
  const out = new Float32Array(3);
  source.positionOf(entity, out);
  return [...out];
}

/** A ray from a point, aimed at a target. */
function rayTo(from: readonly number[], to: readonly number[]): Ray {
  const dx = (to[0] as number) - (from[0] as number);
  const dy = (to[1] as number) - (from[1] as number);
  const dz = (to[2] as number) - (from[2] as number);
  const length = Math.hypot(dx, dy, dz);
  return {
    origin: Float32Array.from(from),
    direction: Float32Array.from([dx / length, dy / length, dz / length]),
  };
}

describe('a translate drag along an axis', () => {
  test('moves only that axis', () => {
    const source = sourceOf([[7, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 7);
    const state = createGizmoState(source, selection);

    /* A camera off to the side, looking at the origin: a good angle for dragging X. */
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]))).toBe(true);
    const command = updateGizmoDrag(state, rayTo([0, 6, 8], [3, 0, 0]));
    if (command === null) throw new Error('the drag should have produced a command');
    command.apply();

    const moved = at(source, 7);
    expect(moved[0]).toBeGreaterThan(0.5);
    expect(moved[1]).toBeCloseTo(0, 5);
    expect(moved[2]).toBeCloseTo(0, 5);
  });

  test('moves only that axis when the pointer leaves the axis, which is the case that can tell', () => {
    /*
     * **The test above cannot fail.** Dragging to a point already on the X axis produces an
     * in-plane offset that is already axis-aligned, so projecting onto the axis changes nothing
     * and deleting the projection leaves it green. The case that tells is a pointer that wanders
     * *off* the arm — which is what a hand does — where the hit has a component the drag must
     * throw away.
     */
    const source = sourceOf([[7, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 7);
    const state = createGizmoState(source, selection);
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]))).toBe(true);
    /* Up and across: three along the arm and two off it. */
    const command = updateGizmoDrag(state, rayTo([0, 6, 8], [3, 2, 0]));
    if (command === null) throw new Error('no command');
    command.apply();
    const moved = at(source, 7);
    expect(moved[0]).toBeGreaterThan(0.5);
    expect(moved[1]).toBeCloseTo(0, 5);
    expect(moved[2]).toBeCloseTo(0, 5);
  });

  test('moves the other two axes when the handle is one of them', () => {
    for (const [axis, free, locked] of [
      [GIZMO_TRANSLATE_Y, 1, [0, 2]],
      [GIZMO_TRANSLATE_Z, 2, [0, 1]],
    ] as const) {
      const source = sourceOf([[1, [0, 0, 0]]]);
      const selection = createSelection();
      selectOnly(selection, 1);
      const state = createGizmoState(source, selection);
      expect(beginGizmoDrag(state, axis, rayTo([9, 5, 7], [0, 0, 0]))).toBe(true);
      const target = [0, 0, 0];
      target[free] = 4;
      const command = updateGizmoDrag(state, rayTo([9, 5, 7], target));
      if (command === null) throw new Error('no command');
      command.apply();
      const moved = at(source, 1);
      expect(Math.abs(moved[free] as number)).toBeGreaterThan(0.5);
      for (const other of locked) expect(moved[other]).toBeCloseTo(0, 5);
    }
  });
});

describe('a translate drag on a plane handle', () => {
  test('moves the two axes in the plane and not the third', () => {
    const source = sourceOf([[3, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 3);
    const state = createGizmoState(source, selection);

    /* The YZ handle: X is the plane normal and must not move. */
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_YZ, rayTo([9, 1, 1], [0, 0, 0]))).toBe(true);
    const command = updateGizmoDrag(state, rayTo([9, 1, 1], [0, 2, 3]));
    if (command === null) throw new Error('no command');
    command.apply();

    const moved = at(source, 3);
    expect(moved[0]).toBeCloseTo(0, 5);
    expect(Math.abs(moved[1] as number) + Math.abs(moved[2] as number)).toBeGreaterThan(1);
  });

  test('locks the axis each plane handle is named for', () => {
    for (const [axis, locked] of [
      [GIZMO_TRANSLATE_YZ, 0],
      [GIZMO_TRANSLATE_ZX, 1],
      [GIZMO_TRANSLATE_XY, 2],
    ] as const) {
      const source = sourceOf([[1, [0, 0, 0]]]);
      const selection = createSelection();
      selectOnly(selection, 1);
      const state = createGizmoState(source, selection);
      /* Looking down the locked axis, so the handle's own plane faces the camera. */
      const from = [0, 0, 0];
      from[locked] = 9;
      from[(locked + 1) % 3] = 1;
      expect(beginGizmoDrag(state, axis, rayTo(from, [0, 0, 0]))).toBe(true);
      const target = [1.5, 1.5, 1.5];
      target[locked] = 0;
      const command = updateGizmoDrag(state, rayTo(from, target));
      if (command === null) throw new Error('no command');
      command.apply();
      expect(at(source, 1)[locked]).toBeCloseTo(0, 5);
    }
  });
});

describe('the plane a drag is computed against', () => {
  test('is the one containing the axis whose normal most faces the camera', () => {
    const normal = new Float32Array(3);
    /* Looking along −Z at the X arm: the XY plane, normal Z, faces the camera. */
    dragPlaneNormal(GIZMO_TRANSLATE_X, Float32Array.from([0, 0, -1]), normal);
    expect([...normal].map(Math.abs)).toEqual([0, 0, 1]);
    /* Looking along −Y: the XZ plane, normal Y. */
    dragPlaneNormal(GIZMO_TRANSLATE_X, Float32Array.from([0, -1, 0]), normal);
    expect([...normal].map(Math.abs)).toEqual([0, 1, 0]);
  });

  test('never goes edge-on while the axis itself is worth dragging', () => {
    /*
     * **The defect every first gizmo has, and the measurement that shows it.** Fix the plane —
     * always use the axis's first companion — and there are camera angles where the ray is nearly
     * *inside* that plane, so the intersection is ill-conditioned and a pixel of mouse movement
     * flings the object across the scene. Choosing the better of the two planes per drag cannot:
     * the two candidate normals are orthogonal, so one of them always takes at least a 45° bite of
     * whatever the view has left after the axis.
     *
     * Swept over a full turn of the camera about the X axis, a hundred and twenty positions.
     */
    const axis = Float32Array.from([1, 0, 0]);
    const pivot = Float32Array.from([0, 0, 0]);
    const normal = new Float32Array(3);
    const fixed = Float32Array.from([0, 0, 1]);

    let worstChosen = 0;
    let worstFixed = 0;
    for (let step = 0; step < 120; step += 1) {
      const angle = (step / 120) * Math.PI * 2;
      /* The camera always looks perpendicular to X, which is the best case for dragging it. */
      const view = Float32Array.from([0, Math.cos(angle), Math.sin(angle)]);
      dragPlaneNormal(GIZMO_TRANSLATE_X, view, normal);
      const chosenFacing = Math.abs(
        (view[0] as number) * (normal[0] as number) +
          (view[1] as number) * (normal[1] as number) +
          (view[2] as number) * (normal[2] as number),
      );
      const fixedFacing = Math.abs((view[2] as number) * (fixed[2] as number));
      worstChosen = Math.max(worstChosen, 1 / Math.max(chosenFacing, 1e-9));
      worstFixed = Math.max(worstFixed, 1 / Math.max(fixedFacing, 1e-9));
      void axis;
      void pivot;
    }
    /*
     * √2 exactly for the adaptive choice — the worst case is the diagonal, where both normals take
     * the same 45° bite. The fixed plane reaches a conditioning of a billion, which is the arm
     * pointing straight at the camera four times a turn.
     */
    expect(worstChosen).toBeCloseTo(Math.SQRT2, 6);
    expect(worstFixed).toBeGreaterThan(1e8);
  });

  test('is better conditioned than the closest-point-on-line drag core uses', () => {
    /*
     * **Why this module does not call `Gizmo.updateDrag`.** Core's gizmo translates by taking the
     * closest point between the ray and the axis line, which is right and refuses only at `1e-6`
     * of parallel. Between that cutoff and a comfortable angle the answer is divided by the
     * squared sine, so at two degrees off the axis a pixel of noise is amplified eight hundredfold.
     * Core is not wrong for its own use — a consumer dragging a prop looks at what they drag. An
     * editor has orbit cameras and users who do not.
     */
    const out = new Float32Array(4);
    const pivot = Float32Array.from([0, 0, 0]);
    const axis = Float32Array.from([1, 0, 0]);
    const degrees = 2;
    const radians = (degrees * Math.PI) / 180;
    const view = Float32Array.from([Math.cos(radians), Math.sin(radians), 0]);
    const origin = Float32Array.from([-10 * Math.cos(radians), -10 * Math.sin(radians), 0]);
    expect(rayClosestOnLine(origin, view, pivot, axis, out)).toBe(true);
    /* 1 / sin²(2°) = 820. That is the factor a pixel of mouse noise is multiplied by. */
    const amplification = 1 / (1 - Math.cos(radians) ** 2);
    expect(amplification).toBeGreaterThan(800);
    expect(amplification).toBeLessThan(830);

    /* The plane this module would choose instead takes sin(2°)… of the *view*, which is the same
       hard case — so the honest claim is narrower: the plane choice fixes the plane going edge-on,
       and nothing fixes an axis pointing at the camera. That is why a gizmo hides such a handle. */
    const normal = new Float32Array(3);
    dragPlaneNormal(GIZMO_TRANSLATE_X, view, normal);
    const facing = Math.abs(
      (view[0] as number) * (normal[0] as number) +
        (view[1] as number) * (normal[1] as number) +
        (view[2] as number) * (normal[2] as number),
    );
    expect(facing).toBeLessThan(0.05);
    expect(rayPlane(origin, view, pivot, normal)).toBeGreaterThan(0);
  });
});

describe('a drag is one undo entry', () => {
  test('merges every frame of one drag into a single entry', () => {
    const source = sourceOf([[5, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 5);
    const state = createGizmoState(source, selection);
    const stack = createUndoStack(64);

    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]))).toBe(true);
    for (let frame = 1; frame <= 30; frame += 1) {
      const command = updateGizmoDrag(state, rayTo([0, 6, 8], [frame * 0.2, 0, 0]));
      if (command !== null) stack.push(command);
    }
    endGizmoDrag(state);

    const ended = at(source, 5);
    expect(ended[0]).toBeGreaterThan(4);
    /* One press of undo takes the whole drag back, and there is nothing behind it. */
    expect(stack.undo()).toBe(true);
    expect(at(source, 5)[0]).toBeCloseTo(0, 5);
    expect(stack.canUndo()).toBe(false);
    /* And redo puts it where the drag finished, not where the first frame did. */
    expect(stack.redo()).toBe(true);
    expect(at(source, 5)[0]).toBeCloseTo(ended[0] as number, 5);
  });

  test('applies absolute positions, which is what makes the contract trap harmless here', () => {
    /*
     * **§3 row 6 says the stack applies exactly once and calls `merge` after — and this command
     * survives getting that wrong.** Writing `write(this.targets)` inside `merge` changes nothing,
     * because `apply` writes *absolute* positions rather than adding a delta, and writing the same
     * position twice is writing it once.
     *
     * That is a choice and not luck. A delta-based move command doubles the drag when it applies
     * what it absorbed, which is the failure row 6 exists for, and it looks like a mouse
     * sensitivity bug rather than an undo bug. Absolute targets buy immunity from it, so this
     * asserts the idempotence directly rather than a double-apply it could not detect.
     */
    const source = sourceOf([[2, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 2);
    const state = createGizmoState(source, selection);
    const stack = createUndoStack(64);
    beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]));

    const first = updateGizmoDrag(state, rayTo([0, 6, 8], [1, 0, 0])) as Command;
    stack.push(first);
    const after = at(source, 2)[0] as number;
    const second = updateGizmoDrag(state, rayTo([0, 6, 8], [2, 0, 0])) as Command;
    stack.push(second);
    const twice = at(source, 2)[0] as number;

    /* The second frame's target is roughly double the first's, not quadruple. */
    expect(twice / after).toBeGreaterThan(1.8);
    expect(twice / after).toBeLessThan(2.2);

    /* And applying the merged entry again lands in the same place, which is the property. */
    first.apply();
    expect(at(source, 2)[0]).toBeCloseTo(twice, 6);
    first.apply();
    expect(at(source, 2)[0]).toBeCloseTo(twice, 6);
  });

  test('starts a new entry for the next drag', () => {
    const source = sourceOf([[9, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 9);
    const state = createGizmoState(source, selection);
    const stack = createUndoStack(64);

    for (const reach of [2, 5]) {
      beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]));
      const command = updateGizmoDrag(state, rayTo([0, 6, 8], [reach, 0, 0]));
      if (command !== null) stack.push(command);
      endGizmoDrag(state);
    }
    expect(stack.undo()).toBe(true);
    expect(stack.canUndo()).toBe(true);
  });
});

describe('a drag on several entities', () => {
  test('moves every one by the same delta and pivots on the primary', () => {
    const source = sourceOf([
      [1, [0, 0, 0]],
      [2, [4, 1, -2]],
      [3, [-3, 2, 6]],
    ]);
    const selection = createSelection();
    selectOnly(selection, 1);
    addToSelection(selection, 2);
    addToSelection(selection, 3);

    const pivot = new Float32Array(3);
    expect(gizmoPivot(selection, source, pivot)).toBe(true);
    /* The primary is the most recent addition, which is entity 3. */
    expect([...pivot]).toEqual([-3, 2, 6]);

    const state = createGizmoState(source, selection);
    const eye = [-3, 8, 14];
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo(eye, [-3, 2, 6]))).toBe(true);
    const command = updateGizmoDrag(state, rayTo(eye, [2, 2, 6]));
    if (command === null) throw new Error('no command');
    command.apply();

    const deltas = [1, 2, 3].map((entity, index) => {
      const startX = [0, 4, -3][index] as number;
      return (at(source, entity)[0] as number) - startX;
    });
    expect(deltas[1]).toBeCloseTo(deltas[0] as number, 4);
    expect(deltas[2]).toBeCloseTo(deltas[0] as number, 4);
    expect(Math.abs(deltas[0] as number)).toBeGreaterThan(1);
    /* And nothing moved off its own y and z. */
    expect(at(source, 2)[1]).toBeCloseTo(1, 5);
    expect(at(source, 3)[2]).toBeCloseTo(6, 5);
  });

  test('refuses to begin with nothing selected', () => {
    const source = sourceOf([[1, [0, 0, 0]]]);
    const state = createGizmoState(source, createSelection());
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]))).toBe(false);
  });
});

describe('a click that is not a drag', () => {
  test('pushes no command at all', () => {
    /*
     * An accidental click on a handle must not fill the undo stack with entries that change
     * nothing — which is what a command emitted unconditionally per frame does, and what makes
     * undo useless after five minutes of clicking around.
     */
    const source = sourceOf([[4, [1, 2, 3]]]);
    const selection = createSelection();
    selectOnly(selection, 4);
    const state = createGizmoState(source, selection);
    const ray = rayTo([0, 6, 8], [1, 2, 3]);

    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, ray)).toBe(true);
    for (let frame = 0; frame < 5; frame += 1) {
      expect(updateGizmoDrag(state, ray)).toBeNull();
    }
    endGizmoDrag(state);
    expect(at(source, 4)).toEqual([1, 2, 3]);
  });

  test('answers nothing when no drag is running', () => {
    const source = sourceOf([[4, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 4);
    const state = createGizmoState(source, selection);
    expect(updateGizmoDrag(state, rayTo([0, 6, 8], [2, 0, 0]))).toBeNull();
  });

  test('stops answering after the drag ends', () => {
    const source = sourceOf([[4, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 4);
    const state = createGizmoState(source, selection);
    beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([0, 6, 8], [0, 0, 0]));
    endGizmoDrag(state);
    expect(updateGizmoDrag(state, rayTo([0, 6, 8], [2, 0, 0]))).toBeNull();
  });
});

describe('an axis pointing at the camera', () => {
  test('refuses the drag rather than inventing one', () => {
    /*
     * **The case no plane fixes.** When the axis runs along the view direction, every plane that
     * contains it is edge-on, and a drag computed against any of them divides by something near
     * zero. A gizmo's answer is to hide the handle; this module's answer is to say no, which is
     * what lets the viewport decide to hide it.
     */
    const source = sourceOf([[1, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 1);
    const state = createGizmoState(source, selection);
    /* Looking straight down +X at the X arm. */
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo([-12, 0, 0], [0, 0, 0]))).toBe(false);
    /* And two degrees off it, which is where the closest-point drag amplifies by 820. */
    const radians = (2 * Math.PI) / 180;
    const eye = [-12 * Math.cos(radians), -12 * Math.sin(radians), 0];
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo(eye, [0, 0, 0]))).toBe(false);
    /* Thirty degrees off it is a real drag and is accepted. */
    const wide = (30 * Math.PI) / 180;
    const open = [-12 * Math.cos(wide), -12 * Math.sin(wide), 0];
    expect(beginGizmoDrag(state, GIZMO_TRANSLATE_X, rayTo(open, [0, 0, 0]))).toBe(true);
  });

  test('refuses a handle that is not a translate, since nothing here rotates or scales', () => {
    /* Stated by refusing rather than by absence: a caller passing a rotate handle gets `false`
       instead of a translate along some axis it did not ask for. */
    const source = sourceOf([[1, [0, 0, 0]]]);
    const selection = createSelection();
    selectOnly(selection, 1);
    const state = createGizmoState(source, selection);
    expect(beginGizmoDrag(state, GIZMO_ROTATE_Y, rayTo([0, 6, 8], [0, 0, 0]))).toBe(false);
    expect(beginGizmoDrag(state, GIZMO_SCALE_X, rayTo([0, 6, 8], [0, 0, 0]))).toBe(false);
  });
});
