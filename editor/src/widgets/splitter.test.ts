import { describe, expect, it } from 'vitest';
import { createPointerState, layoutUiTree } from '@driftengine/ui2d';
import { createSplitter, routeSplitterPointer, splitterSizes, type Splitter } from './splitter.ts';

function laidOut(splitter: Splitter): Splitter {
  layoutUiTree(splitter.node, 500, 0, 6, 800);
  return splitter;
}

describe('a splitter', () => {
  it('divides an extent by its ratio', () => {
    const splitter = createSplitter({ axis: 'x', ratio: 0.25, thickness: 6 });
    const sizes = splitterSizes(splitter, 1000);
    expect(sizes.first).toBe(248.5);
    expect(sizes.second).toBe(745.5);
    expect(sizes.first + sizes.second + 6, 'the handle takes its own width').toBe(1000);
  });

  /**
   * **A ratio is a share of the pane space, not of the whole extent**, because the handle occupies
   * some of the extent and belongs to neither pane. So the extents here are 1006 and 806: a
   * thousand and eight hundred pixels of panes, which makes the arithmetic exact rather than
   * merely close.
   */
  it('moves the boundary as the pointer moves', () => {
    const splitter = laidOut(createSplitter({ axis: 'x', ratio: 0.5, thickness: 6 }));
    const pointer = createPointerState();

    routeSplitterPointer(splitter, pointer, 'down', 502, 100, 1006);
    routeSplitterPointer(splitter, pointer, 'move', 602, 100, 1006);
    expect(splitter.ratio, 'a hundred pixels of a thousand is a tenth').toBeCloseTo(0.6, 9);

    routeSplitterPointer(splitter, pointer, 'up', 602, 100, 1006);
    expect(splitter.dragging).toBe(false);
  });

  it('moves along y when that is its axis', () => {
    const splitter = createSplitter({ axis: 'y', ratio: 0.5, thickness: 6 });
    layoutUiTree(splitter.node, 0, 400, 800, 6);
    const pointer = createPointerState();

    routeSplitterPointer(splitter, pointer, 'down', 100, 402, 806);
    routeSplitterPointer(splitter, pointer, 'move', 100, 322, 806);
    expect(splitter.ratio).toBeCloseTo(0.4, 9);
  });

  /**
   * The grab point is kept for the whole drag, so the divider does not jump to centre itself under
   * the cursor on the first pixel of movement — which is what setting the ratio from the pointer's
   * absolute position does, and it is visible on every drag that starts anywhere but dead centre.
   */
  it('moves by the distance dragged and does not jump to the cursor', () => {
    const splitter = laidOut(createSplitter({ axis: 'x', ratio: 0.5, thickness: 6 }));
    const pointer = createPointerState();

    /* Pressed near the right-hand edge of the six-pixel handle rather than on its centre. */
    routeSplitterPointer(splitter, pointer, 'down', 505, 100, 1006);
    expect(splitter.ratio, 'pressing moves nothing').toBe(0.5);
    routeSplitterPointer(splitter, pointer, 'move', 515, 100, 1006);
    expect(splitter.ratio, 'ten pixels, from wherever it was grabbed').toBeCloseTo(0.51, 9);
  });

  /**
   * **Capture is what makes a splitter usable at all.** A drag that leaves the divider — which it
   * does immediately, because the divider is six pixels wide and a hand is not that steady — stops
   * arriving the moment routing is by hit test. The pointer is held from press to release.
   */
  it('keeps the pointer once it has it, wherever the pointer goes', () => {
    const splitter = laidOut(createSplitter({ axis: 'x', ratio: 0.5, thickness: 6 }));
    const pointer = createPointerState();

    routeSplitterPointer(splitter, pointer, 'down', 502, 100, 1006);
    expect(pointer.captured).toBe(splitter.node);

    /* Far outside the window, above and to the left of everything. */
    routeSplitterPointer(splitter, pointer, 'move', -400, -900, 1006);
    expect(splitter.dragging, 'still dragging').toBe(true);
    expect(splitter.ratio, 'and clamped rather than negative').toBe(0);

    routeSplitterPointer(splitter, pointer, 'up', -400, -900, 1006);
    expect(pointer.captured).toBe(null);
  });

  it('starts no drag from a press that missed the handle', () => {
    const splitter = laidOut(createSplitter({ axis: 'x', ratio: 0.5, thickness: 6 }));
    const pointer = createPointerState();

    routeSplitterPointer(splitter, pointer, 'down', 100, 100, 1000);
    expect(pointer.captured).toBe(null);
    routeSplitterPointer(splitter, pointer, 'move', 700, 100, 1000);
    expect(splitter.ratio, 'nothing moved').toBe(0.5);
  });
});

describe("a splitter's minimum sizes", () => {
  it('will not drag either pane below its minimum', () => {
    const splitter = laidOut(
      createSplitter({ axis: 'x', ratio: 0.5, thickness: 6, minFirst: 200, minSecond: 300 }),
    );
    const pointer = createPointerState();

    routeSplitterPointer(splitter, pointer, 'down', 502, 100, 1000);
    routeSplitterPointer(splitter, pointer, 'move', 0, 100, 1000);
    expect(splitterSizes(splitter, 1000).first).toBe(200);

    routeSplitterPointer(splitter, pointer, 'move', 1000, 100, 1000);
    expect(splitterSizes(splitter, 1000).second).toBe(300);
  });

  /**
   * **The ratio the person chose is kept, and the minimum is applied at the last moment.** Storing
   * the clamped ratio is the tempting version and it loses the setting: narrow the window until a
   * minimum bites, widen it again, and the pane comes back at the minimum's proportion instead of
   * where it was put. The panel then walks across the screen over a session of resizing.
   */
  it('gives the chosen ratio back when there is room for it again', () => {
    const splitter = createSplitter({
      axis: 'x',
      ratio: 0.8,
      thickness: 6,
      minFirst: 100,
      minSecond: 300,
    });

    /* Narrow: the second pane's minimum wins and the first is squeezed. */
    expect(splitterSizes(splitter, 500).second).toBe(300);
    expect(splitterSizes(splitter, 500).first).toBe(194);

    /* Wide again: back to four fifths, not to whatever the squeeze implied. */
    const wide = splitterSizes(splitter, 2000);
    expect(wide.first / (wide.first + wide.second)).toBeCloseTo(0.8, 3);
    expect(splitter.ratio, 'and the stored ratio never moved').toBe(0.8);
  });

  /**
   * An extent too small for both minimums has no correct answer, so it has a stated one: each pane
   * gets its share of what there is, in proportion to what it asked for. Zero and a negative are
   * the alternatives, and both produce a pane that cannot be seen or a layout that inverts.
   */
  it('splits in proportion to the minimums when neither can be met', () => {
    const splitter = createSplitter({
      axis: 'x',
      ratio: 0.5,
      thickness: 0,
      minFirst: 100,
      minSecond: 300,
    });
    const sizes = splitterSizes(splitter, 200);
    expect(sizes.first).toBe(50);
    expect(sizes.second).toBe(150);
    expect(sizes.first + sizes.second).toBe(200);
  });

  it('reports nothing for an extent of nothing', () => {
    const splitter = createSplitter({ axis: 'x', ratio: 0.5, thickness: 6 });
    const sizes = splitterSizes(splitter, 0);
    expect(sizes.first).toBe(0);
    expect(sizes.second).toBe(0);
  });
});
