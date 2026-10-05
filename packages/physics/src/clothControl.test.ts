import { expect, it } from 'vitest';

import { ClothControl } from './clothControl.ts';
import type { ClothDevice } from './clothControl.ts';
import type { SkinnedClothSetup } from './skinnedClothSetup.ts';

/** Two particles, one link: the schedule is what is under test, not the cloth. */
function setup(parameters: SkinnedClothSetup['parameters']): SkinnedClothSetup {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    inverseMass: new Float32Array([0, 1]),
    distance: {
      pairs: new Uint32Array([0, 1]),
      rest: new Float32Array([1]),
      compliance: new Float32Array(1),
    },
    parameters,
  };
}

/** A device that writes down what it was asked, in order. */
function recorder(): { device: ClothDevice; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    device: {
      targetsChanged: (change) => calls.push(change),
      rest: () => calls.push('rest'),
      step: (fraction, blend) => calls.push(`step ${fraction} ${blend}`),
    },
  };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const moved = (x: number): Float32Array => {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  return m;
};

/*
 * **What a device is told, in the order it is told it** — the contract the GPU solver keeps its own
 * copy of the skinned positions by. The first pose resets: posed, settled, every particle to rest,
 * the settle steps at the whole pose, unblended. A frame's time is whole steps at even fractions of
 * the way to its pose, each blended by the share a reset's blend has reached — ½ then 1 over two
 * steps, then none — and then the pose is consumed. A jump past the teleport distance resets again.
 */
it('TELLS ITS DEVICE EACH POSE, RESET, STEP AND BLEND, IN ORDER', () => {
  const { device, calls } = recorder();
  const control = new ClothControl(
    setup({ step: 0.25, settleSteps: 2, blendSteps: 2, teleportDistance: 5 }),
    device,
    false,
  );
  control.setPose(IDENTITY, IDENTITY);
  expect(calls.splice(0)).toEqual(['posed', 'settled', 'rest', 'step 1 0', 'step 1 0']);

  control.setPose(IDENTITY, moved(1));
  expect(control.advance(0.5)).toBe(2);
  expect(calls.splice(0)).toEqual(['posed', 'step 0.5 0.5', 'step 1 1', 'consumed']);

  control.setPose(IDENTITY, moved(2));
  control.advance(0.3);
  expect(calls.splice(0)).toEqual(['posed', 'step 1 0', 'consumed']);
  expect(control.alpha).toBeCloseTo(0.2, 6);

  /* No whole step: nothing stepped and nothing consumed — the next frame still starts from here. */
  control.advance(0.1);
  expect(calls.splice(0)).toEqual([]);

  control.setPose(IDENTITY, moved(20));
  expect(calls.splice(0)).toEqual(['posed', 'settled', 'rest', 'step 1 0', 'step 1 0']);
});
