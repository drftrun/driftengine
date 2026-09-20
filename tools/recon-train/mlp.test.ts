import { describe, expect, it } from 'vitest';

import { buildNnet, readNnet } from '../../packages/drft/src/nnet.ts';
import { evalNetwork } from '../../packages/texture/src/inference.ts';

import { Mlp } from './mlp.ts';

/**
 * **What this file is for: a trainer whose weights mean, to the runtime, what they meant to it.**
 * The trainer and `evalNetwork` are two implementations of one network, and the seam between them
 * is where a transposed matrix or a misplaced bias hides — a network that trained well and infers
 * badly. So its forward pass is held to `evalNetwork` on weights that went through the `NNET` chunk
 * and back, and its gradients to the numerical derivative of its own loss.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('the refinement trainer', () => {
  it('COMPUTES WHAT THE RUNTIME COMPUTES, on weights that went through the chunk and back', () => {
    const random = seeded(7);
    const mlp = new Mlp({ inputs: 5, hidden: [6, 4], outputs: 3 }, random);
    /* A few steps of training first, so the weights are not the initialiser's symmetric ones. */
    const input = new Float32Array(5);
    const target = new Float32Array(3);
    for (let step = 0; step < 50; step += 1) {
      for (let i = 0; i < 5; i += 1) input[i] = random() * 2 - 1;
      target[0] = input[0] as number;
      target[1] = (input[1] as number) - (input[2] as number);
      target[2] = 0.5;
      mlp.accumulate(input, target);
      mlp.step(1e-2);
    }
    const chunk = buildNnet({
      networks: [{ role: 'RTST', inputs: 5, hidden: [6, 4], outputs: 3, weights: mlp.weights }],
    });
    const back = readNnet(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
    const exported = back.networks[0]?.weights as Float32Array;
    const trainer = new Float32Array(3);
    const runtime = new Float32Array(3);
    for (let k = 0; k < 64; k += 1) {
      for (let i = 0; i < 5; i += 1) input[i] = random() * 2 - 1;
      mlp.forward(input, trainer);
      evalNetwork(
        { inputs: 5, hidden: [6, 4], outputs: 3 },
        exported,
        input,
        runtime,
        new Float32Array(12),
      );
      for (let o = 0; o < 3; o += 1) {
        expect(Math.abs((runtime[o] as number) - (trainer[o] as number))).toBeLessThan(1e-6);
      }
    }
  });

  it('DIFFERENTIATES ITS LOSS CORRECTLY, against the numerical derivative of every weight', () => {
    const random = seeded(11);
    const mlp = new Mlp({ inputs: 3, hidden: [4], outputs: 2 }, random);
    const input = Float32Array.from([0.3, -0.7, 0.9]);
    const target = Float32Array.from([0.25, -0.5]);
    const loss = (): number => {
      const out = new Float32Array(2);
      mlp.forward(input, out);
      let sum = 0;
      for (let o = 0; o < 2; o += 1) sum += ((out[o] as number) - (target[o] as number)) ** 2;
      return sum / 2;
    };
    mlp.accumulate(input, target);
    const analytic = Float64Array.from(mlp.gradient);
    const h = 1e-3;
    for (let w = 0; w < mlp.weights.length; w += 1) {
      const held = mlp.weights[w] as number;
      mlp.weights[w] = held + h;
      const up = loss();
      mlp.weights[w] = held - h;
      const down = loss();
      mlp.weights[w] = held;
      const numerical = (up - down) / (2 * h);
      expect(Math.abs(numerical - (analytic[w] as number))).toBeLessThan(2e-3);
    }
  });

  it('LEARNS A FUNCTION IT CAN REPRESENT, which is the loop working at all', () => {
    const random = seeded(3);
    const mlp = new Mlp({ inputs: 2, hidden: [8], outputs: 1 }, random);
    const input = new Float32Array(2);
    const target = new Float32Array(1);
    const out = new Float32Array(1);
    const error = (): number => {
      let sum = 0;
      for (let k = 0; k < 200; k += 1) {
        input[0] = (k % 20) / 10 - 1;
        input[1] = Math.floor(k / 20) / 5 - 1;
        mlp.forward(input, out);
        sum += ((out[0] as number) - Math.abs((input[0] as number) - (input[1] as number))) ** 2;
      }
      return sum / 200;
    };
    const before = error();
    for (let step = 0; step < 3000; step += 1) {
      for (let b = 0; b < 16; b += 1) {
        input[0] = random() * 2 - 1;
        input[1] = random() * 2 - 1;
        target[0] = Math.abs((input[0] as number) - (input[1] as number));
        mlp.accumulate(input, target);
      }
      mlp.step(3e-3);
    }
    expect(error()).toBeLessThan(before / 20);
  });
});
