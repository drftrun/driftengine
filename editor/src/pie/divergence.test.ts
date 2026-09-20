import { describe, expect, it } from 'vitest';
import { createTimeline, recordFrame, type Timeline, type TimelineOptions } from './timeline.ts';
import {
  NO_DIVERGENCE,
  NO_OVERLAP,
  firstDivergentFrame,
  type DivergenceSearch,
} from './divergence.ts';

interface Slot {
  n: number;
}

/** A timeline of hand-written fingerprints: `at(frame)` says what the run hashed to. */
function timelineOf(
  frames: number,
  at: (frame: number) => string,
  options: { first?: number; capacity?: number } = {},
): Timeline<Slot, number> & TimelineOptions<Slot> {
  const timeline = createTimeline<Slot, number>({
    interval: 8,
    capacity: options.capacity ?? 10000,
    createSnapshot: (): Slot => ({ n: 0 }),
    saveSnapshot: (): void => {},
  });
  const first = options.first ?? 0;
  for (let frame = first; frame < first + frames; frame += 1) {
    recordFrame(timeline, frame, frame, at(frame));
  }
  return timeline;
}

const same = (frame: number): string => `h${String(frame)}`;

describe('the first frame two runs stop agreeing on', () => {
  it('says they agree, and says it as itself rather than as frame zero', () => {
    const a = timelineOf(100, same);
    const b = timelineOf(100, same);
    expect(firstDivergentFrame(a, b)).toBe(NO_DIVERGENCE);
    expect(NO_DIVERGENCE).not.toBe(0);
  });

  it('finds the frame, and not the one either side of it', () => {
    for (const frame of [1, 2, 37, 63, 64, 98, 99]) {
      const a = timelineOf(100, same);
      const b = timelineOf(100, (at) => (at < frame ? same(at) : `x${String(at)}`));
      expect(firstDivergentFrame(a, b), `divergence at ${String(frame)}`).toBe(frame);
    }
  });

  it('finds a divergence on the very first frame', () => {
    const a = timelineOf(100, same);
    const b = timelineOf(100, (at) => `x${String(at)}`);
    expect(firstDivergentFrame(a, b)).toBe(0);
  });

  it('compares only the frames both still hold', () => {
    /* One side has scrolled away from the beginning; the overlap is what can be compared. */
    const a = timelineOf(100, same);
    const b = timelineOf(60, (at) => (at < 70 ? same(at) : `x${String(at)}`), { first: 40 });
    expect(firstDivergentFrame(a, b)).toBe(70);
  });

  it('reports no overlap as itself, which is not agreement', () => {
    const a = timelineOf(20, same);
    const b = timelineOf(20, same, { first: 500 });
    expect(firstDivergentFrame(a, b)).toBe(NO_OVERLAP);
    expect(firstDivergentFrame(a, timelineOf(0, same))).toBe(NO_OVERLAP);
    expect(NO_OVERLAP).not.toBe(NO_DIVERGENCE);
  });
});

describe('the search is logarithmic', () => {
  it('answers a matching pair in one comparison', () => {
    const search: DivergenceSearch = { comparisons: 0 };
    firstDivergentFrame(timelineOf(4096, same), timelineOf(4096, same), search);
    /* The last frame agreeing means they all do, and that is the common case. */
    expect(search.comparisons).toBe(1);
  });

  it('halves rather than walks', () => {
    const search: DivergenceSearch = { comparisons: 0 };
    const a = timelineOf(4096, same);
    const b = timelineOf(4096, (at) => (at < 2999 ? same(at) : `x${String(at)}`));
    expect(firstDivergentFrame(a, b, search)).toBe(2999);
    /* Log2 of 4096 is 12, plus the two end probes. A walk would be 3000. */
    expect(search.comparisons).toBeLessThanOrEqual(16);
    expect(search.comparisons).toBeGreaterThan(4);
  });
});

describe('what the search assumes, and what happens when it does not hold', () => {
  it('reports agreement for a pair that diverged and came back together', () => {
    /*
     * Pinned rather than hidden, and it is the sharpest form of the limitation: a pair agreeing on
     * the last frame is reported as agreeing, whatever happened in between. The search assumes
     * agreement is a prefix — true of a deterministic simulation, because differing state keeps
     * differing — and a world that clamps or quantises can break that assumption.
     */
    const a = timelineOf(100, same);
    const b = timelineOf(100, (at) => (at >= 20 && at < 60 ? `x${String(at)}` : same(at)));
    expect(firstDivergentFrame(a, b)).toBe(NO_DIVERGENCE);

    /* Cut the timeline where the difference is still live and it is found exactly. */
    const cut = timelineOf(40, (at) => (at >= 20 ? `x${String(at)}` : same(at)));
    expect(firstDivergentFrame(timelineOf(40, same), cut)).toBe(20);
  });
});
