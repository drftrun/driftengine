import { describe, expect, it } from 'vitest';
import {
  GPU_SLOTS,
  createPassTimings,
  passLabel,
  passMs,
  recordPassLabel,
  recordPassSample,
  resetPassTimings,
} from '@driftengine/core';
import { createResidencyTable, markResident, residentCount } from '@driftengine/texture';
import {
  createFrameHistory,
  createGpuPassTimings,
  createProfilerView,
  formatMs,
  historyValues,
  occupancy,
  profilerPanel,
  profilerRows,
  pushFrame,
  recordGpuSample,
} from './profiler.ts';

function timings(): ReturnType<typeof createPassTimings> {
  const t = createPassTimings(4);
  recordPassLabel(t, 0, 'shadow');
  recordPassLabel(t, 1, 'opaque');
  recordPassLabel(t, 2, 'bloom');
  recordPassSample(t, 0, 1.25);
  recordPassSample(t, 1, 4.5);
  return t;
}

describe('the profiler', () => {
  it('shows a row per labelled pass with its milliseconds', () => {
    const rows = profilerRows(timings(), []);
    expect(rows.map((row) => [row.label, row.ms])).toEqual([
      ['shadow', 1.25],
      ['opaque', 4.5],
      ['bloom', null],
    ]);
  });

  /**
   * **A pass that ran no work keeps its row, and its number is not zero.** Wave 1A's labels
   * persisting is what keeps the row; `passMs` returning null is what keeps the number honest. A
   * profiler that cannot tell "took no time" from "nobody measured it" sends somebody optimising a
   * pass that never ran.
   */
  it('keeps the row of a pass that did nothing, and reports it as unmeasured', () => {
    const t = timings();
    resetPassTimings(t);
    recordPassSample(t, 1, 3);

    const rows = profilerRows(t, []);
    expect(
      rows.map((row) => row.label),
      'every row survived the reset',
    ).toEqual(['shadow', 'opaque', 'bloom']);
    expect(rows[0]?.ms, 'shadow ran nothing this frame').toBe(null);
    expect(rows[1]?.ms).toBe(3);
  });

  it('shows an unmeasured pass as unavailable and a measured zero as zero', () => {
    const t = createPassTimings(2);
    recordPassLabel(t, 0, 'idle');
    recordPassLabel(t, 1, 'empty');
    recordPassSample(t, 1, 0);

    expect(formatMs(passMs(t, 0))).toBe('—');
    expect(formatMs(passMs(t, 1)), 'a measured zero is a fact').toBe('0.00');
    expect(passLabel(t, 0)).toBe('idle');
  });

  it('shows nothing for a device that measured nothing at all', () => {
    const t = createPassTimings(3);
    expect(profilerRows(t, [])).toEqual([]);
  });

  /** The rows are pooled, so a profiler rebuilt sixty times a second allocates none of them. */
  it('reuses its rows between builds', () => {
    const t = timings();
    const out = profilerRows(t, []);
    const first = out[0];
    const again = profilerRows(t, out);
    expect(again.length).toBe(3);
    expect(again[0], 'the same object, refilled').toBe(first);
  });
});

describe("the profiler's history", () => {
  it('holds a fixed window and drops the oldest', () => {
    const ring = createFrameHistory(4);
    for (const ms of [1, 2, 3, 4]) pushFrame(ring, ms);
    expect(historyValues(ring)).toEqual([1, 2, 3, 4]);

    pushFrame(ring, 5);
    expect(historyValues(ring), 'the first frame fell off the back').toEqual([2, 3, 4, 5]);
    pushFrame(ring, 6);
    expect(historyValues(ring)).toEqual([3, 4, 5, 6]);
  });

  it('is short before it is full, and oldest first throughout', () => {
    const ring = createFrameHistory(4);
    expect(historyValues(ring)).toEqual([]);
    pushFrame(ring, 9);
    expect(historyValues(ring)).toEqual([9]);
  });
});

describe("the profiler's residency", () => {
  it('reports occupancy out of the page cache', () => {
    const table = createResidencyTable(8);
    markResident(table, 'a', 0);
    markResident(table, 'b', 1);
    expect(residentCount(table)).toBe(2);
    expect(occupancy(table)).toBeCloseTo(0.25, 6);
  });

  /** A capacity of zero is a cache that is not there, and dividing by it is not an answer. */
  it('reports nothing rather than a division by zero', () => {
    expect(occupancy(createResidencyTable(0))).toBe(null);
    expect(occupancy(null)).toBe(null);
  });
});

describe('the profiler panel', () => {
  it('builds a row per pass, then the frame and the cache', () => {
    const view = createProfilerView({});
    const history = createFrameHistory(8);
    pushFrame(history, 16.7);

    profilerPanel.build(
      { timings: timings(), history, residency: createResidencyTable(4) },
      view,
      view.root,
    );

    const text = view.root.children.map((child) => child.text);
    expect(text[0]).toContain('shadow');
    expect(text[0]).toContain('1.25');
    expect(text[2], 'bloom ran nothing').toContain('—');
    expect(text.at(-2)).toContain('frame');
    expect(text.at(-1)).toContain('residency');
  });

  /**
   * **A host with no device still knows how long its frames took**, and the panel was hiding it.
   * `profilerRows` is empty until something labels a pass, and the empty state returned before the
   * frame line was ever added — so an editor docked over a frame history of its own showed
   * `No timings yet` while holding sixty samples. Reporting nothing where there is something is
   * the same fault as reporting zero where there is nothing.
   */
  it('SHOWS THE FRAME TIME IT HAS, EVEN WHERE NO PASS HAS BEEN LABELLED', () => {
    const view = createProfilerView({});
    const history = createFrameHistory(8);
    pushFrame(history, 16);
    pushFrame(history, 18);

    profilerPanel.build(
      { timings: createPassTimings(4), history, residency: null },
      view,
      view.root,
    );

    const text = view.root.children.filter((child) => !child.hidden).map((child) => child.text);
    expect(text.some((line) => line.includes('No timings'))).toBe(false);
    expect(text.some((line) => line.startsWith('frame') && line.includes('17.00'))).toBe(true);
  });

  it('says so when there is nothing to profile yet', () => {
    const view = createProfilerView({});
    profilerPanel.build(
      { timings: createPassTimings(4), history: createFrameHistory(8), residency: null },
      view,
      view.root,
    );
    expect(view.root.children.length).toBe(1);
    expect(view.root.children[0]?.text).toContain('No timings');
  });

  /**
   * **The panel is rebuilt every frame, so it must not allocate every frame.** Asserted by the node
   * pool holding still and by the row objects keeping their identity — a build that allocated would
   * hand back different ones.
   */
  it('allocates nothing on a second build', () => {
    const view = createProfilerView({});
    const world = {
      timings: timings(),
      history: createFrameHistory(8),
      residency: createResidencyTable(4),
    };

    profilerPanel.build(world, view, view.root);
    const nodes = [...view.root.children];
    const rows = [...view.rows];

    profilerPanel.build(world, view, view.root);
    expect(view.root.children.length).toBe(nodes.length);
    expect(view.root.children.every((child, at) => child === nodes[at])).toBe(true);
    expect(view.rows.every((row, at) => row === rows[at])).toBe(true);
  });

  it('shrinks when a pass stops being labelled and grows when one starts', () => {
    const view = createProfilerView({});
    const t = createPassTimings(4);
    recordPassLabel(t, 0, 'opaque');
    recordPassSample(t, 0, 1);
    const world = { timings: t, history: createFrameHistory(8), residency: null };

    profilerPanel.build(world, view, view.root);
    const withOne = view.root.children.filter((child) => !child.hidden).length;

    recordPassLabel(t, 1, 'bloom');
    profilerPanel.build(world, view, view.root);
    expect(view.root.children.filter((child) => !child.hidden).length).toBe(withOne + 1);
  });

  it('asks for nothing, because a profiler reads', () => {
    const view = createProfilerView({});
    expect(
      profilerPanel.route(
        { timings: createPassTimings(1), history: createFrameHistory(1), residency: null },
        view,
        { kind: 'pointer', phase: 'up', x: 0, y: 0, button: 0 },
      ),
    ).toBe(null);
  });
});

/*
 * **The bridge exists because the engine fills no timings for you.** `PassTimings` is a container
 * and `renderer.gpuTimer` is a source, and joining them is the same twenty lines in every game:
 * three labels from `GPU_SLOTS`, then a poll a frame writing three numbers. Six consumers writing
 * it six times is what put the overlay in this package, and this is the same argument one layer
 * down.
 */
describe('the engine’s own GPU brackets, as profiler rows', () => {
  it('labels a row per slot, in the order the engine declares them', () => {
    const timings = createGpuPassTimings();
    const rows = profilerRows(timings, []);
    expect(rows.map((row) => row.label)).toEqual([...GPU_SLOTS]);
  });

  it('reads unmeasured until a sample arrives, and never zero', () => {
    const timings = createGpuPassTimings();
    expect(profilerRows(timings, []).map((row) => row.ms)).toEqual([null, null, null]);
    recordGpuSample(timings, { shadows: 1.5, reflection: 0, rest: 4.25 });
    expect(profilerRows(timings, []).map((row) => row.ms)).toEqual([1.5, 0, 4.25]);
  });

  it('takes the newest sample rather than accumulating them', () => {
    const timings = createGpuPassTimings();
    recordGpuSample(timings, { shadows: 9, reflection: 9, rest: 9 });
    recordGpuSample(timings, { shadows: 1, reflection: 2, rest: 3 });
    expect(profilerRows(timings, []).map((row) => row.ms)).toEqual([1, 2, 3]);
  });
});
