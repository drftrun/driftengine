import { expect, test } from 'vitest';
import { localiseNodes } from './localise.ts';
import type { DrftNode, MeshData } from '@driftengine/drft';

/**
 * Turning world-space meshes plus a graph into parts a game can move.
 *
 * **The round trip is the load-bearing assertion.** Checking that a localised part sits at its
 * own origin proves the translation was removed; only carrying it back through the world matrix
 * proves nothing else was lost on the way, which is what a rotation or a scale in the chain
 * would otherwise hide.
 */

function part(positions: number[]): MeshData {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length).fill(0),
    colors: new Float32Array(positions.length).fill(1),
    emissive: new Float32Array(positions.length / 3),
    indices: new Uint32Array([0, 1, 2]),
  };
}

const node = (over: Partial<DrftNode>): DrftNode => ({
  parent: -1,
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  mesh: -1,
  name: 'node',
  ...over,
});

test('moves a world-space mesh into the frame of the node that placed it', () => {
  const nodes = [
    node({ name: 'root' }),
    node({ name: 'WHEEL_LF', parent: 0, translation: [10, 0, 0], mesh: 0 }),
  ];
  const { parts } = localiseNodes([part([10, 0, 0, 11, 0, 0, 10, 1, 0])], nodes);
  expect([...parts[0]!.positions.subarray(0, 3)]).toEqual([0, 0, 0]);
  expect([...parts[0]!.positions.subarray(3, 6)]).toEqual([1, 0, 0]);
});

test('accumulates through a parent, so a nested part lands at its own origin', () => {
  const nodes = [
    node({ name: 'body', translation: [0, 1, 0] }),
    node({ name: 'HUB', parent: 0, translation: [2, 0, 0] }),
    node({ name: 'TYRE', parent: 1, translation: [0, 0, 3], mesh: 0 }),
  ];
  const { parts } = localiseNodes([part([2, 1, 3, 3, 1, 3, 2, 2, 3])], nodes);
  expect([...parts[0]!.positions.subarray(0, 3)]).toEqual([0, 0, 0]);
});

test('a round trip through the world matrix returns the original geometry', () => {
  /* A quarter turn about Y and a non-unit scale, so the check is not translation only. */
  const half = Math.SQRT1_2;
  const nodes = [
    node({
      name: 'p',
      translation: [4, 5, 6],
      rotation: [0, half, 0, half],
      scale: [2, 2, 2],
      mesh: 0,
    }),
  ];
  const original = [4, 5, 6, 5, 5, 6, 4, 6, 6];
  const { parts, world } = localiseNodes([part(original)], nodes);
  const m = world[0]!;
  const back: number[] = [];
  for (let at = 0; at < parts[0]!.positions.length; at += 3) {
    const x = parts[0]!.positions[at]!;
    const y = parts[0]!.positions[at + 1]!;
    const z = parts[0]!.positions[at + 2]!;
    back.push(
      x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
      x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
      x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
    );
  }
  for (let i = 0; i < original.length; i++) expect(back[i]).toBeCloseTo(original[i]!, 4);
});

test('a node with zero scale is named and its mesh left in world space', () => {
  const nodes = [node({ name: 'flattened', scale: [0, 1, 1], mesh: 0 })];
  const { parts, warnings } = localiseNodes([part([7, 0, 0, 8, 0, 0, 7, 1, 0])], nodes);
  expect(warnings.join(' ')).toMatch(/flattened/);
  expect([...parts[0]!.positions.subarray(0, 3)]).toEqual([7, 0, 0]);
});

test('a mesh no node claims is passed through untouched', () => {
  const { parts } = localiseNodes([part([1, 2, 3, 4, 5, 6, 7, 8, 9])], [node({ name: 'empty' })]);
  expect([...parts[0]!.positions]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
