import { expect, test } from 'vitest';
import { createCommandPool, resetPool, takeCommand } from './drawCommand.ts';

test('a taken command is reused rather than replaced', () => {
  const pool = createCommandPool(4);
  const first = pool.commands[takeCommand(pool)];
  resetPool(pool);
  expect(pool.commands[takeCommand(pool)]).toBe(first);
});

test('the pool grows at the frame boundary and keeps what it held', () => {
  const pool = createCommandPool(1);
  const a = takeCommand(pool);
  const b = takeCommand(pool);
  expect(a).toBe(0);
  expect(b).toBe(1);
  expect(pool.commands.length).toBeGreaterThanOrEqual(2);
});

/**
 * The constraint AGENTS.md sets, tested rather than assumed.
 *
 * A pool that replaced its entries on reset would allocate a frame's worth of objects every
 * frame — which is what a recorder most wants to do and what this exists to stop.
 */
test('a full frame taken twice allocates no new entries', () => {
  const pool = createCommandPool(32);
  const snapshot = pool.commands.slice(0, 32);
  for (let pass = 0; pass < 2; pass += 1) {
    resetPool(pool);
    for (let i = 0; i < 32; i += 1) takeCommand(pool);
  }
  for (let i = 0; i < 32; i += 1) expect(pool.commands[i]).toBe(snapshot[i]);
});

test('a command carries four vertex buffer slots, which is one more than any verb uses', () => {
  const pool = createCommandPool(1);
  const command = pool.commands[takeCommand(pool)];
  expect(command?.vertexBuffers.length).toBe(4);
});
