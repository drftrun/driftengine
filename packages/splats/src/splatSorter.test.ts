import { describe, expect, it } from 'vitest';
import { SplatSorter } from './splatSorter.ts';
import { packSplats } from './splatData.ts';
import { createSplatViewLocal } from './splatView.ts';
import type { SplatData } from './splatData.ts';
import type { SplatSortRequest, SplatSortResult } from './splatSort.ts';
import type { SplatViewLocal } from './splatView.ts';

/**
 * A sorter whose completion the test controls.
 *
 * **Injected rather than a real worker**, which is what the capability is for: `vitest` has no
 * `Worker`, and a test that waited on one would be measuring the environment. Every property
 * below — one in flight, newest wins, no re-sort below the threshold, a rejection leaving the
 * previous order alone — is about the scheduler and not about where the work happens.
 */
function controllable(): {
  sort: (request: SplatSortRequest) => Promise<SplatSortResult>;
  calls: SplatSortRequest[];
  settle: (index?: number, kept?: number) => Promise<void>;
  fail: (index?: number) => Promise<void>;
} {
  const calls: SplatSortRequest[] = [];
  const resolvers: {
    resolve: (value: SplatSortResult) => void;
    reject: (reason: Error) => void;
  }[] = [];
  return {
    calls,
    sort(request) {
      calls.push(request);
      return new Promise<SplatSortResult>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    },
    async settle(index = resolvers.length - 1, kept?: number) {
      const call = calls[index];
      const resolver = resolvers[index];
      if (call === undefined || resolver === undefined) throw new Error(`no call ${index}`);
      /* Something recognisable, so a test can tell which sort's result is standing. */
      call.out[0] = index + 100;
      resolver.resolve({ order: call.out, count: kept ?? call.count });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    async fail(index = resolvers.length - 1) {
      resolvers[index]?.reject(new Error('sort failed'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Three splats a metre apart along z, so the capture has a radius a move can be measured against. */
function capture(): SplatData {
  return packSplats({
    count: 3,
    positions: new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3]),
    scales: new Float32Array(9).fill(0.1),
    rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    opacities: new Float32Array([1, 1, 1]),
  });
}

/** A local view looking down the axis given, from wherever it says. */
function looking(
  dir: readonly [number, number, number],
  origin: readonly [number, number, number] = [0, 0, 0],
): SplatViewLocal {
  const view = createSplatViewLocal();
  view.dirX = dir[0];
  view.dirY = dir[1];
  view.dirZ = dir[2];
  view.originX = origin[0];
  view.originY = origin[1];
  view.originZ = origin[2];
  return view;
}

describe('SplatSorter', () => {
  it('has no order until the first sort lands', () => {
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    sorter.frame(looking([0, 0, 1]));

    expect(sorter.order, 'nothing to draw yet').toBeNull();
    expect(sorter.sorting).toBe(true);
  });

  it('publishes the order and bumps its version when one lands', async () => {
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    expect(sorter.version).toBe(0);

    sorter.frame(looking([0, 0, 1]));
    await fake.settle();

    expect(sorter.order?.[0]).toBe(100);
    expect(sorter.version, 'so a caller uploads once rather than every frame').toBe(1);
    expect(sorter.sorting).toBe(false);
  });

  it('publishes how many splats survived the budget, not how many the capture has', async () => {
    /*
     * A budget answers with fewer indices than the capture holds, and the pass draws the number
     * the sort returned. Taking the capture's own count instead would walk off the end of a valid
     * order into whatever the buffer held before — which draws stale indices rather than nothing,
     * and reads as a corrupt capture.
     */
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort, budget: 2 });
    sorter.frame(looking([0, 0, 1]));
    await fake.settle(undefined, 2);

    expect(sorter.drawCount).toBe(2);
    expect(fake.calls[0]?.budget, 'and the budget reached the sort').toBe(2);
  });

  it('holds at most one sort in flight and drops the rest', async () => {
    /*
     * Dropped rather than queued: the newest view is the only one worth sorting for. A queue
     * sorts for a camera position the player has already left and then sorts again, which turns a
     * busy moment into a backlog that never catches up.
     */
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });

    sorter.frame(looking([0, 0, 1]));
    sorter.frame(looking([1, 0, 0]));
    sorter.frame(looking([0, 1, 0]));

    expect(fake.calls.length, 'three frames, one sort').toBe(1);
    await fake.settle();
    expect(fake.calls.length, 'and none queued behind it').toBe(1);
  });

  it('does not re-sort for a view that has barely turned', async () => {
    /*
     * A still camera must sort zero times a second, and 0.999 is about 2.6 degrees. Below that the
     * ordering changes by a few adjacent swaps among splats that overlap anyway.
     */
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    sorter.frame(looking([0, 0, 1]));
    await fake.settle();
    expect(fake.calls.length).toBe(1);

    /* Exactly the same direction, then one degree off: cos 1 degree is 0.99985, above the gate. */
    sorter.frame(looking([0, 0, 1]));
    const radians = Math.PI / 180;
    sorter.frame(looking([Math.sin(radians), 0, Math.cos(radians)]));
    expect(fake.calls.length, 'neither is worth a sort').toBe(1);

    /* Ten degrees is 0.985, below it. */
    const ten = 10 * radians;
    sorter.frame(looking([Math.sin(ten), 0, Math.cos(ten)]));
    expect(fake.calls.length, 'and this one is').toBe(2);
  });

  it('ignores a camera that only moved, because a translation cannot reorder anything', async () => {
    /*
     * **The reason there was no move gate before there was a budget.** Depth is measured along the
     * view axis, so moving the camera shifts every splat's depth by the *same* amount and the
     * ordering comes out identical. A sorter that re-sorted on movement would burn a sort per step
     * of a walk for an order it already had.
     */
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    sorter.frame(looking([0, 0, 1]));
    await fake.settle();

    sorter.frame(looking([0, 0, 1], [0, 0, -900]));

    expect(fake.calls.length, 'the order it has is still the right one').toBe(1);
  });

  it('re-sorts a budgeted capture once the camera has moved across it', async () => {
    /*
     * **And the reason there is one now.** A budget keeps the splats largest on *screen*, which is
     * the extent over the distance — so where the camera stands decides which splats are drawn even
     * when it has not turned by a degree. The gate is a fraction of the capture's own radius, so it
     * scales with the thing being looked at rather than being a distance in metres that means
     * something different for a room and for a landscape.
     */
    const fake = controllable();
    const sorter = new SplatSorter({
      splats: capture(),
      sort: fake.sort,
      budget: 2,
      moveFraction: 0.5,
    });
    sorter.frame(looking([0, 0, 1], [0, 0, 0]));
    await fake.settle(undefined, 2);
    expect(fake.calls.length).toBe(1);

    /* The capture spans z = 1 to 3, so its radius is 1 and half of that is 0.5. */
    sorter.frame(looking([0, 0, 1], [0, 0, 0.2]));
    expect(fake.calls.length, 'a shuffle is not worth a sort').toBe(1);

    sorter.frame(looking([0, 0, 1], [0, 0, 0.9]));
    expect(fake.calls.length, 'crossing the capture is').toBe(2);
  });

  it('re-sorts on demand even when the view has not moved', async () => {
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    sorter.frame(looking([0, 0, 1]));
    await fake.settle();

    sorter.frame(looking([0, 0, 1]), true);
    expect(fake.calls.length, 'a capture whose transform moved wants this').toBe(2);
  });

  it('leaves the previous order drawing when a sort is rejected', async () => {
    /*
     * The honest degradation: a capture one camera step out of order is very slightly wrong at
     * some silhouettes; a capture with no order is not drawn at all. And the loop may not throw.
     */
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    sorter.frame(looking([0, 0, 1]));
    await fake.settle();
    const standing = sorter.order?.[0];

    sorter.frame(looking([1, 0, 0]));
    await fake.fail();

    expect(sorter.order?.[0], 'unchanged').toBe(standing);
    expect(sorter.version, 'and no new version to upload').toBe(1);
    expect(sorter.sorting, 'and it is not stuck in flight').toBe(false);
  });

  it('ping-pongs two buffers, so a landing sort never rewrites what is being drawn', async () => {
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort });
    sorter.frame(looking([0, 0, 1]));
    await fake.settle();
    const first = sorter.order;

    sorter.frame(looking([1, 0, 0]));
    expect(sorter.order, 'the standing order is still readable mid-sort').toBe(first);
    expect(fake.calls[1]?.out, 'and the sorter is filling the other one').not.toBe(first);
  });

  it('does nothing at all for an empty capture', () => {
    const fake = controllable();
    const empty = packSplats({
      count: 0,
      positions: new Float32Array(0),
      scales: new Float32Array(0),
      rotations: new Float32Array(0),
      colors: new Float32Array(0),
      opacities: new Float32Array(0),
    });
    const sorter = new SplatSorter({ splats: empty, sort: fake.sort });
    sorter.frame(looking([0, 0, 1]), true);
    expect(fake.calls.length).toBe(0);
    expect(sorter.order).toBeNull();
  });
});

describe('a capture that is still arriving', () => {
  it('sorts only the splats that have landed', () => {
    /*
     * **A streaming capture is allocated at its final count and filled progressively**, so the
     * tail is zeroed until it arrives — every unarrived splat sitting at the origin with no size.
     * Sorting those would order a cloud of phantoms into the middle of the capture and draw them,
     * which reads as a corrupt file rather than as a load in progress.
     */
    const fake = controllable();
    let arrived = 2;
    const sorter = new SplatSorter({
      splats: capture(),
      sort: fake.sort,
      ready: () => arrived,
    });

    sorter.frame(looking([0, 0, 1]));

    expect(fake.calls[0]?.count, 'two of the three').toBe(2);
    expect(arrived, 'and the capacity is untouched').toBe(2);
  });

  it('does nothing at all until the first block lands', () => {
    const fake = controllable();
    const sorter = new SplatSorter({ splats: capture(), sort: fake.sort, ready: () => 0 });
    sorter.frame(looking([0, 0, 1]), true);
    expect(fake.calls.length).toBe(0);
  });

  it('sorts again when a block arrives, even though the view has not moved', async () => {
    /*
     * The order it has is an order over fewer splats, so it is not the order it wants — and the
     * camera has no reason to have turned during a load. Without this a capture stops densifying
     * the moment a viewer stands still, which is exactly when they are watching it.
     */
    const fake = controllable();
    let arrived = 1;
    const sorter = new SplatSorter({
      splats: capture(),
      sort: fake.sort,
      ready: () => arrived,
    });

    sorter.frame(looking([0, 0, 1]));
    await fake.settle();
    expect(fake.calls.length).toBe(1);

    sorter.frame(looking([0, 0, 1]));
    expect(fake.calls.length, 'nothing new has arrived').toBe(1);

    arrived = 3;
    sorter.frame(looking([0, 0, 1]));
    expect(fake.calls.length, 'and now it has').toBe(2);
    expect(fake.calls[1]?.count).toBe(3);
  });
});
