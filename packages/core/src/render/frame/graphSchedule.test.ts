import { expect, test } from 'vitest';
import { createDeps, recordDeps } from './deps.ts';
import { createGraphPasses, createGraphScratch, scheduleGraph } from './graphSchedule.ts';

test('adjacent nodes with the same write set collapse into one pass', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);
  expect(scheduleGraph(deps, 3, [1], ordered, out)).toBe(2);
  expect(out[0]?.count).toBe(2);
});

test('a pass nothing reads and nothing keeps alive is culled', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [], [1]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);
  expect(scheduleGraph(deps, 2, [1], ordered, out)).toBe(1);
});

test('culling is transitive, which is the reason this module exists', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  recordDeps(deps, [1], [2]);
  recordDeps(deps, [], [3]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);
  expect(scheduleGraph(deps, 4, [3], ordered, out)).toBe(1);
  expect(out[0]?.first).toBe(3);
});

test('a live resource keeps its whole producing chain', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  recordDeps(deps, [1], [2]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);
  expect(scheduleGraph(deps, 3, [2], ordered, out)).toBe(3);
});

test('an unordered node may join a neighbouring pass; an ordered one may not', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [], [1]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8);
  expect(scheduleGraph(deps, 2, [0, 1], ordered, out)).toBe(1);

  const strict = new Uint8Array(8).fill(1);
  expect(scheduleGraph(deps, 2, [0, 1], strict, out)).toBe(2);
});

/*
 * **The forward path schedules through this every flush once `identifierGraph` is on**, and a
 * flush is a hot path: `AGENTS.md` forbids allocating in one. So the working set is the caller's,
 * and reusing it has to be indistinguishable from starting fresh — a keep flag or a wanted
 * identifier left over from the last frame would keep a pass alive that this frame culls.
 */
test('a reused scratch answers exactly as a fresh one, frame after frame', () => {
  const scratch = createGraphScratch(2, 2);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);

  /* A long frame that keeps everything, so every flag is set when the short one follows. */
  const long = createDeps(8, 32);
  recordDeps(long, [], [0]);
  recordDeps(long, [0], [1]);
  recordDeps(long, [1], [5]);
  expect(scheduleGraph(long, 3, [5], ordered, out, scratch)).toBe(3);

  /* The same shape of frame with nothing live that the first node feeds. */
  const short = createDeps(8, 32);
  recordDeps(short, [], [0]);
  recordDeps(short, [], [1]);
  const reused = scheduleGraph(short, 2, [1], ordered, out, scratch);
  const firstReused = out[0]?.first;
  const fresh = scheduleGraph(short, 2, [1], ordered, out);
  expect(reused).toBe(fresh);
  expect(reused).toBe(1);
  expect(firstReused).toBe(out[0]?.first);
  expect(firstReused).toBe(1);
});

test('the live set may be a typed array with a count, so a caller need not build one', () => {
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [], [1]);
  recordDeps(deps, [], [2]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);
  /* Only the first two entries count; the 2 beyond them is a stale identifier and must not. */
  const live = new Int32Array([0, 1, 2]);
  expect(scheduleGraph(deps, 3, live, ordered, out, createGraphScratch(3, 3), 2)).toBe(2);
  expect(out[1]?.first).toBe(1);
});

test('a scratch smaller than the frame grows rather than reading past its end', () => {
  const deps = createDeps(8, 32);
  for (let node = 0; node < 6; node += 1)
    recordDeps(deps, node === 0 ? [] : [node + 9], [node + 10]);
  const out = createGraphPasses(8);
  const ordered = new Uint8Array(8).fill(1);
  const scratch = createGraphScratch(1, 1);
  expect(scheduleGraph(deps, 6, [15], ordered, out, scratch)).toBe(6);
  expect(scratch.keep.length).toBeGreaterThanOrEqual(6);
  expect(scratch.wanted.length).toBeGreaterThan(15);
});

/** A top-level function's text, from its declaration to the brace that closes it at column 0. */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  const end = source.indexOf('\n}\n', start);
  return start === -1 || end === -1 ? '' : source.slice(start, end);
}

/*
 * **Read rather than measured**, because a heap figure in a test runner is noise and the defect is a
 * line: the first version of this module built a `Set` and a `Uint8Array` on every call. Growth is
 * allowed, and lives in its own function, because a frame that outgrows the scratch has to be
 * scheduled somehow and the arena grows the same way.
 */
test('a flush allocates nothing: neither the schedule nor the liveness sweep constructs', async () => {
  const path = './graphSchedule.ts?raw';
  const source = ((await import(/* @vite-ignore */ path)) as { default: string }).default;
  for (const declaration of ['export function scheduleGraph(', 'function markLive(']) {
    const body = bodyOf(source, declaration);
    expect(body.length, `${declaration} was found`).toBeGreaterThan(40);
    expect(body, `${declaration} constructs something`).not.toMatch(/\bnew\s|\bSet\(|=\s*\[\s*\]/);
  }
});
