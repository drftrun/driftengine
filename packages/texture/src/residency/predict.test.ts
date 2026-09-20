import { expect, test } from 'vitest';
import { predictViews } from './predict.ts';
import type { SimulationHandle } from './predict.ts';

/** A simulation that is one moving number, which is enough to test the contract. */
function toySim() {
  const state = { x: 0, saves: 0, restores: 0 };
  let saved = 0;
  const handle: SimulationHandle = {
    save() {
      state.saves += 1;
      saved = state.x;
    },
    restore() {
      state.restores += 1;
      state.x = saved;
    },
    advance(dt) {
      state.x += dt;
    },
    viewAt(out) {
      out[12] = state.x;
    },
  };
  return { state, handle };
}

test('predicting hands back one view per predicted frame', () => {
  const { handle } = toySim();
  expect(predictViews(handle, 4, 1 / 60, new Float32Array(16 * 4))).toBe(4);
});

test('the predicted views are the future ones, not the present one repeated', () => {
  const { handle } = toySim();
  const out = new Float32Array(16 * 3);
  predictViews(handle, 3, 1, out);
  expect(out[12]).toBeCloseTo(1, 6);
  expect(out[16 + 12]).toBeCloseTo(2, 6);
  expect(out[32 + 12]).toBeCloseTo(3, 6);
});

test('the simulation is exactly where it was afterwards, which is the whole contract', () => {
  const { state, handle } = toySim();
  state.x = 42;
  predictViews(handle, 8, 1, new Float32Array(16 * 8));
  expect(state.x).toBe(42);
});

test('it saves once and restores once, however many frames it predicts', () => {
  const { state, handle } = toySim();
  predictViews(handle, 16, 1, new Float32Array(16 * 16));
  expect(state.saves).toBe(1);
  expect(state.restores).toBe(1);
});

test('predicting zero frames touches the simulation not at all', () => {
  const { state, handle } = toySim();
  expect(predictViews(handle, 0, 1, new Float32Array(16))).toBe(0);
  expect(state.saves).toBe(0);
});

test('an output buffer too small for the horizon predicts as far as it fits', () => {
  const { handle } = toySim();
  expect(predictViews(handle, 8, 1, new Float32Array(16 * 2))).toBe(2);
});

test('predicting twice from one state gives the same views, because the simulation is deterministic', () => {
  const { handle } = toySim();
  const a = new Float32Array(16 * 4);
  const b = new Float32Array(16 * 4);
  predictViews(handle, 4, 0.5, a);
  predictViews(handle, 4, 0.5, b);
  expect(Array.from(a)).toEqual(Array.from(b));
});
