import { expect, test } from 'vitest';
import {
  createArena,
  nodeCount,
  nodeReads,
  nodeVerb,
  nodeWrites,
  recordNode,
  resetArena,
} from './arena.ts';

test('a recorded node reads back exactly what was written', () => {
  const arena = createArena(8);
  const at = recordNode(arena, 3, 0b101, 0b010, 7, 2);
  expect(at).toBe(0);
  expect(nodeCount(arena)).toBe(1);
  expect(nodeVerb(arena, 0)).toBe(3);
  expect(nodeReads(arena, 0)).toBe(0b101);
  expect(nodeWrites(arena, 0)).toBe(0b010);
});

test('reset empties the arena without replacing its storage', () => {
  const arena = createArena(8);
  const storage = arena.nodes;
  recordNode(arena, 1, 0, 0, 0, 0);
  resetArena(arena);
  expect(nodeCount(arena)).toBe(0);
  expect(arena.nodes).toBe(storage);
});

/**
 * The constraint AGENTS.md sets, tested rather than assumed: a frame may not allocate.
 *
 * Recording to capacity and resetting, twice over, must not replace the backing store. A
 * recorder is exactly the shape that wants an object per draw, so this is the assertion that
 * says it did not become one.
 */
test('recording a full frame twice allocates nothing', () => {
  const arena = createArena(64);
  const storage = arena.nodes;
  for (let pass = 0; pass < 2; pass += 1) {
    resetArena(arena);
    for (let i = 0; i < 64; i += 1) recordNode(arena, i & 7, i, i, i, i);
    expect(nodeCount(arena)).toBe(64);
  }
  expect(arena.nodes).toBe(storage);
});

test('going past capacity grows once and keeps every node already recorded', () => {
  const arena = createArena(2);
  recordNode(arena, 1, 0, 0, 0, 0);
  recordNode(arena, 2, 0, 0, 0, 0);
  recordNode(arena, 3, 0, 0, 0, 0);
  expect(nodeCount(arena)).toBe(3);
  expect(nodeVerb(arena, 0)).toBe(1);
  expect(nodeVerb(arena, 2)).toBe(3);
  expect(arena.highWater).toBeGreaterThanOrEqual(3);
});
