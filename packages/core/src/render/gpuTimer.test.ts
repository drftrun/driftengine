import { expect, test } from 'vitest';
import { GpuTimer } from './gpuTimer.ts';

const TIME_ELAPSED = 0x88bf;
const DISJOINT = 0x8fbb;
const AVAILABLE = 0x8867;
const RESULT = 0x8866;

/** A GL context that records what was asked of it and answers with fixed timings. */
function stubGl(options: { extension?: boolean; nanos?: number[]; disjoint?: boolean } = {}) {
  const { extension = true, nanos = [], disjoint = false } = options;
  let made = 0;
  const results = new Map<object, number>();
  return {
    getExtension: (name: string) =>
      extension && name === 'EXT_disjoint_timer_query_webgl2'
        ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: DISJOINT }
        : null,
    createQuery: () => {
      const query = { id: made };
      results.set(query, (nanos[made] ?? 0) * 1e6);
      made++;
      return query;
    },
    deleteQuery: () => {},
    beginQuery: () => {},
    endQuery: () => {},
    getQueryParameter: (query: object, name: number) =>
      name === AVAILABLE ? true : (results.get(query) ?? 0),
    getParameter: (name: number) => (name === DISJOINT ? disjoint : 0),
    QUERY_RESULT_AVAILABLE: AVAILABLE,
    QUERY_RESULT: RESULT,
  };
}

const SLOTS = ['shadows', 'reflection', 'rest'] as const;

test('a context without the extension is a silent no-op, never a throw', () => {
  /*
   * The extension is missing or disabled in plenty of Chrome configurations, so absence
   * is a normal state. It must cost nothing and it must not report zeros — a zero that
   * means "not measured" sends somebody looking in the wrong place for an afternoon.
   */
  const timer = new GpuTimer(stubGl({ extension: false }) as never);
  expect(timer.available).toBe(false);
  expect(timer.beginFrame()).toBe(false);
  timer.begin('shadows');
  timer.end();
  expect(timer.poll()).toBe(null);
});

test('a completed frame reports each bracket in milliseconds', () => {
  // 1.85 ms is the High-at-2.07-Mpx frame from the GPU budget spec; the parts here
  // are that frame's shape, and the sum is what a whole-frame query cannot give.
  const timer = new GpuTimer(stubGl({ nanos: [1.2, 0.4, 0.25] }) as never, 1);
  expect(timer.beginFrame()).toBe(true);
  for (const slot of SLOTS) {
    timer.begin(slot);
    timer.end();
  }
  timer.endFrame();
  const sample = timer.poll();
  expect(sample?.shadows).toBeCloseTo(1.2, 6);
  expect(sample?.reflection).toBeCloseTo(0.4, 6);
  expect(sample?.rest).toBeCloseTo(0.25, 6);
});

test('a disjoint frame is dropped rather than believed', () => {
  // The driver is telling us the timing is meaningless. A number from it is worse than
  // no number, because it looks exactly like a real one.
  const timer = new GpuTimer(stubGl({ nanos: [9, 9, 9], disjoint: true }) as never, 1);
  timer.beginFrame();
  for (const slot of SLOTS) {
    timer.begin(slot);
    timer.end();
  }
  timer.endFrame();
  expect(timer.poll()).toBe(null);
  expect(timer.disjointDrops).toBe(1);
});

test('only one frame in eight is measured', () => {
  /*
   * Seven samples a second is ample for a distribution, and sampling every frame is an
   * argument about query overhead on drivers nobody here owns. This removes the
   * argument instead of winning it.
   */
  const timer = new GpuTimer(stubGl({ nanos: Array(64).fill(1) }) as never);
  let measured = 0;
  for (let frame = 0; frame < 32; frame++) if (timer.beginFrame()) measured++;
  expect(measured).toBe(4);
});

test('a shadow pass run once per layer is one shadow number', () => {
  /*
   * The renderer draws shadows in three passes — static, the depth peel, then
   * dynamic — and water reflections may not run at all. So a frame is not three
   * brackets, and the answer for a slot is the sum of its brackets rather than
   * whichever one happened to be written last.
   */
  const timer = new GpuTimer(stubGl({ nanos: [0.5, 0.25, 0.75, 0.4] }) as never, 1);
  timer.beginFrame();
  timer.begin('shadows');
  timer.end();
  timer.begin('shadows');
  timer.end();
  timer.begin('shadows');
  timer.end();
  timer.begin('rest');
  timer.end();
  timer.endFrame();

  const sample = timer.poll();
  expect(sample?.shadows).toBeCloseTo(0.5 + 0.25 + 0.75, 6);
  expect(sample?.rest).toBeCloseTo(0.4, 6);
  // Water was off this frame. Zero here means "did not run", and the report says so.
  expect(sample?.reflection).toBe(0);
});

test('an unmeasured frame issues no queries at all', () => {
  // The point of sampling is that the skipped frames are free. If `begin` still talked
  // to the driver on them, one frame in eight would be a comment rather than a saving.
  let begun = 0;
  const gl = stubGl({ nanos: Array(64).fill(1) });
  const timer = new GpuTimer({ ...gl, beginQuery: () => begun++ } as never, 8);
  timer.beginFrame(); // frame 0: measured
  for (const slot of SLOTS) {
    timer.begin(slot);
    timer.end();
  }
  timer.endFrame();
  const afterMeasured = begun;
  timer.beginFrame(); // frame 1: not measured
  for (const slot of SLOTS) {
    timer.begin(slot);
    timer.end();
  }
  timer.endFrame();
  expect(afterMeasured).toBe(3);
  expect(begun).toBe(3);
});
