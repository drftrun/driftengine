import { expect, test } from 'vitest';
import {
  TILE_ABSENT,
  TILE_REQUESTED,
  TILE_RESIDENT,
  createResidencyTable,
  evict,
  leastRecentlyUsed,
  markRequested,
  markResident,
  residentCount,
  slotFor,
  tileState,
  touchTile,
} from './table.ts';
import { createPrefetchQueue, enqueue, queueSize, takeBatch } from './queue.ts';
import { runPrediction } from './predictor.ts';
import type { Predictor } from './predictor.ts';
import type { SimulationHandle } from './predict.ts';

test('an unknown tile is absent', () => {
  expect(tileState(createResidencyTable(4), 'a')).toBe(TILE_ABSENT);
});

test('a requested tile is requested and not yet resident', () => {
  const table = createResidencyTable(4);
  markRequested(table, 'a');
  expect(tileState(table, 'a')).toBe(TILE_REQUESTED);
});

test('a resident tile reports its slot', () => {
  const table = createResidencyTable(4);
  markResident(table, 'a', 7);
  expect(tileState(table, 'a')).toBe(TILE_RESIDENT);
  expect(slotFor(table, 'a')).toBe(7);
});

test('requesting an already-resident tile is a no-op, not a second fetch of bytes we hold', () => {
  const table = createResidencyTable(4);
  markResident(table, 'a', 1);
  markRequested(table, 'a');
  expect(tileState(table, 'a')).toBe(TILE_RESIDENT);
});

test('eviction frees the slot', () => {
  const table = createResidencyTable(4);
  markResident(table, 'a', 3);
  evict(table, 'a');
  expect(tileState(table, 'a')).toBe(TILE_ABSENT);
  expect(slotFor(table, 'a')).toBe(-1);
  expect(residentCount(table)).toBe(0);
});

test('a tile touched this frame is never offered for eviction', () => {
  const table = createResidencyTable(4);
  markResident(table, 'old', 0);
  markResident(table, 'inUse', 1);
  const frameStart = table.clock;
  touchTile(table, 'inUse');
  const out: string[] = [];
  leastRecentlyUsed(table, frameStart, out, 4);
  expect(out).toEqual(['old']);
});

test('the least recently used comes first, and ties break deterministically', () => {
  const table = createResidencyTable(8);
  markResident(table, 'b', 0);
  markResident(table, 'a', 1);
  const out: string[] = [];
  leastRecentlyUsed(table, table.clock, out, 8);
  expect(out).toEqual(['b', 'a']);
});

test('a higher priority comes out of the queue first', () => {
  const queue = createPrefetchQueue(8);
  enqueue(queue, 'far', 8);
  enqueue(queue, 'near', 1);
  const out: string[] = [];
  takeBatch(queue, () => false, 1000, 10, out);
  expect(out[0]).toBe('near');
});

test('enqueueing the same tile twice keeps the better claim and stores one entry', () => {
  const queue = createPrefetchQueue(8);
  enqueue(queue, 'a', 8);
  enqueue(queue, 'a', 2);
  expect(queueSize(queue)).toBe(1);
  expect(queue.priority.get('a')).toBe(2);
});

test('the byte budget limits a batch and the remainder stays queued', () => {
  const queue = createPrefetchQueue(8);
  enqueue(queue, 'a', 1);
  enqueue(queue, 'b', 2);
  enqueue(queue, 'c', 3);
  const out: string[] = [];
  expect(takeBatch(queue, () => false, 20, 10, out)).toBe(2);
  expect(queueSize(queue)).toBe(1);
});

test('a tile that became resident while queued is dropped at dequeue, not fetched again', () => {
  const queue = createPrefetchQueue(8);
  enqueue(queue, 'here', 1);
  enqueue(queue, 'missing', 2);
  const out: string[] = [];
  takeBatch(queue, (h) => h === 'here', 1000, 10, out);
  expect(out).toEqual(['missing']);
});

test('a full queue drops its worst entry rather than refusing the best one', () => {
  const queue = createPrefetchQueue(2);
  enqueue(queue, 'a', 1);
  enqueue(queue, 'b', 9);
  enqueue(queue, 'c', 2);
  expect(queueSize(queue)).toBe(2);
  expect(queue.priority.has('b')).toBe(false);
});

function toySim(): { state: { x: number }; handle: SimulationHandle } {
  const state = { x: 0 };
  let saved = 0;
  return {
    state,
    handle: {
      save() {
        saved = state.x;
      },
      restore() {
        state.x = saved;
      },
      advance(dt) {
        state.x += dt;
      },
      viewAt(out) {
        out[12] = state.x;
      },
    },
  };
}

test('prediction is generic, and asks the predictor once per predicted frame', () => {
  const { handle } = toySim();
  const seen: number[] = [];
  const predictor: Predictor<number> = {
    needs(view, out) {
      seen.push(view[12] as number);
      out[0] = view[12] as number;
      return 1;
    },
    resident: () => false,
    request: () => {},
  };
  runPrediction(handle, predictor, 3, 1, 100);
  expect(seen).toEqual([1, 2, 3]);
});

test('items already here are not requested', () => {
  const { handle } = toySim();
  let requests = 0;
  runPrediction(
    handle,
    {
      needs(_view, out) {
        out[0] = 1;
        return 1;
      },
      resident: () => true,
      request: () => {
        requests += 1;
      },
    },
    4,
    1,
    100,
  );
  expect(requests).toBe(0);
});

test('priority falls with how far ahead the frame is', () => {
  const { handle } = toySim();
  const priorities: number[] = [];
  runPrediction(
    handle,
    {
      needs(view, out) {
        out[0] = view[12] as number;
        return 1;
      },
      resident: () => false,
      request: (_item, priority) => priorities.push(priority),
    },
    3,
    1,
    100,
  );
  expect(priorities).toEqual([0, 1, 2]);
});

test('within a frame, the order the predictor named its items in survives into the queue', () => {
  /*
   * `tilesForView` names a view's tiles most important first. A priority of the frame alone
   * would tie them all, and the queue breaks a tie by hash — so a byte budget that cut a frame
   * short would keep an arbitrary part of it rather than its coarse tiles.
   */
  const { handle } = toySim();
  const requested: [number, number][] = [];
  runPrediction<number>(
    handle,
    {
      needs(view, out) {
        const frame = view[12] as number;
        out[0] = frame * 10 + 1;
        out[1] = frame * 10 + 2;
        out[2] = frame * 10 + 3;
        return 3;
      },
      resident: (item) => item === 12,
      request: (item, priority) => requested.push([item, priority]),
    },
    2,
    1,
    100,
  );
  expect(requested).toEqual([
    [11, 0],
    [13, 2 / 3],
    [21, 1],
    [22, 1 + 1 / 3],
    [23, 1 + 2 / 3],
  ]);
});

test('the budget bounds requests across every predicted frame, not per frame', () => {
  const { handle } = toySim();
  let requests = 0;
  runPrediction(
    handle,
    {
      needs(_view, out) {
        out[0] = 1;
        out[1] = 2;
        return 2;
      },
      resident: () => false,
      request: () => {
        requests += 1;
      },
    },
    8,
    1,
    3,
  );
  expect(requests).toBe(3);
});

test('the simulation is unchanged afterwards, asserted again at the seam Wave 4B will use', () => {
  const { state, handle } = toySim();
  state.x = 11;
  runPrediction(handle, { needs: () => 0, resident: () => false, request: () => {} }, 8, 1, 10);
  expect(state.x).toBe(11);
});
