import { describe, expect, it } from 'vitest';

import { addUiChild, createUiNode } from './uiNode.ts';
import type { UiNode, UiNodeOptions } from './uiNode.ts';
import { layoutUiTree } from './uiLayout.ts';

function tree(root: UiNodeOptions, children: UiNodeOptions[]): UiNode {
  const node = createUiNode(root);
  for (const child of children) addUiChild(node, createUiNode(child));
  return node;
}

function boxes(node: UiNode): number[][] {
  return node.children.map((child) => [child.rect.x, child.rect.y, child.rect.w, child.rect.h]);
}

describe('fixed sizes', () => {
  it('stacks a column from the top, in order', () => {
    const root = tree({ direction: 'column', width: 100, height: 100 }, [
      { width: 40, height: 10 },
      { width: 40, height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 100, 100);
    expect(boxes(root)).toEqual([
      [0, 0, 40, 10],
      [0, 10, 40, 20],
    ]);
  });

  it('lays a row out left to right', () => {
    const root = tree({ direction: 'row', width: 100, height: 100 }, [
      { width: 10, height: 40 },
      { width: 20, height: 40 },
    ]);
    layoutUiTree(root, 0, 0, 100, 100);
    expect(boxes(root)).toEqual([
      [0, 0, 10, 40],
      [10, 0, 20, 40],
    ]);
  });

  it('puts a gap between children and none at the ends', () => {
    const root = tree({ direction: 'row', width: 100, height: 100, gap: 5 }, [
      { width: 10, height: 40 },
      { width: 10, height: 40 },
      { width: 10, height: 40 },
    ]);
    layoutUiTree(root, 0, 0, 100, 100);
    expect(boxes(root).map((box) => box[0])).toEqual([0, 15, 30]);
  });

  /* Four different paddings, because one number for all four passes with any two of them swapped. */
  it('insets children by each padding separately', () => {
    const root = createUiNode({ direction: 'column', width: 100, height: 100 });
    root.paddingLeft = 3;
    root.paddingTop = 5;
    root.paddingRight = 7;
    root.paddingBottom = 11;
    addUiChild(root, createUiNode({ width: 'grow', height: 'grow' }));
    layoutUiTree(root, 0, 0, 100, 100);
    expect(boxes(root)).toEqual([[3, 5, 90, 84]]);
  });

  it('places the root where it was told, not at the origin', () => {
    const root = tree({ direction: 'row', width: 50, height: 50 }, [{ width: 10, height: 10 }]);
    layoutUiTree(root, 200, 300, 50, 50);
    expect([root.rect.x, root.rect.y]).toEqual([200, 300]);
    expect(boxes(root)).toEqual([[200, 300, 10, 10]]);
  });
});

describe('fit', () => {
  it('measures a leaf as the content it declares', () => {
    const root = tree({ direction: 'row', width: 'fit', height: 'fit', padding: 4 }, [
      { width: 'fit', height: 'fit', contentWidth: 30, contentHeight: 12 },
    ]);
    layoutUiTree(root, 0, 0, 500, 500);
    expect([root.rect.w, root.rect.h]).toEqual([38, 20]);
  });

  it('measures a row as the sum along it and the largest across it', () => {
    const root = tree({ direction: 'row', width: 'fit', height: 'fit', gap: 2 }, [
      { width: 10, height: 5 },
      { width: 20, height: 9 },
    ]);
    layoutUiTree(root, 0, 0, 500, 500);
    expect([root.rect.w, root.rect.h]).toEqual([32, 9]);
  });

  it('measures a column the other way round, which a square parent would hide', () => {
    const root = tree({ direction: 'column', width: 'fit', height: 'fit', gap: 2 }, [
      { width: 10, height: 5 },
      { width: 20, height: 9 },
    ]);
    layoutUiTree(root, 0, 0, 500, 500);
    expect([root.rect.w, root.rect.h]).toEqual([20, 16]);
  });
});

describe('grow', () => {
  it('gives one growing child everything that is left', () => {
    const root = tree({ direction: 'row', width: 100, height: 20 }, [
      { width: 30, height: 20 },
      { width: 'grow', height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root)).toEqual([
      [0, 0, 30, 20],
      [30, 0, 70, 20],
    ]);
  });

  it('splits what is left equally between two, gaps taken off first', () => {
    const root = tree({ direction: 'row', width: 100, height: 20, gap: 10 }, [
      { width: 'grow', height: 20 },
      { width: 'grow', height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root)).toEqual([
      [0, 0, 45, 20],
      [55, 0, 45, 20],
    ]);
  });

  it('gives a growing child nothing rather than a negative size when it is over', () => {
    const root = tree({ direction: 'row', width: 20, height: 20 }, [
      { width: 30, height: 20 },
      { width: 'grow', height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 20, 20);
    expect(root.children[1]?.rect.w).toBe(0);
  });

  /*
   * A `grow` child inside a `fit` parent has nothing to take a share of, so it contributes its own
   * natural size to the measurement. Without this a menu sized to its contents collapses the moment
   * one row asks to fill it.
   */
  it('measures as its own contents when its parent is sized by its contents', () => {
    const root = tree({ direction: 'column', width: 'fit', height: 'fit' }, [
      { width: 'grow', height: 8, contentWidth: 25 },
    ]);
    layoutUiTree(root, 0, 0, 500, 500);
    expect(root.rect.w).toBe(25);
  });
});

describe('align, across the main axis', () => {
  const build = (align: 'start' | 'center' | 'end' | 'stretch'): UiNode =>
    tree({ direction: 'row', width: 100, height: 50, align }, [{ width: 10, height: 20 }]);

  it('puts a child at the near edge by default', () => {
    const root = build('start');
    layoutUiTree(root, 0, 0, 100, 50);
    expect(boxes(root)).toEqual([[0, 0, 10, 20]]);
  });

  it('centres it', () => {
    const root = build('center');
    layoutUiTree(root, 0, 0, 100, 50);
    expect(boxes(root)).toEqual([[0, 15, 10, 20]]);
  });

  it('pushes it to the far edge', () => {
    const root = build('end');
    layoutUiTree(root, 0, 0, 100, 50);
    expect(boxes(root)).toEqual([[0, 30, 10, 20]]);
  });

  it('stretches it across, overriding the size it asked for', () => {
    const root = build('stretch');
    layoutUiTree(root, 0, 0, 100, 50);
    expect(boxes(root)).toEqual([[0, 0, 10, 50]]);
  });

  it('aligns along x in a column, which is the other axis', () => {
    const root = tree({ direction: 'column', width: 100, height: 50, align: 'center' }, [
      { width: 10, height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 100, 50);
    expect(boxes(root)).toEqual([[45, 0, 10, 20]]);
  });
});

describe('justify, along the main axis', () => {
  const build = (justify: 'start' | 'center' | 'end' | 'between'): UiNode =>
    tree({ direction: 'row', width: 100, height: 20, justify }, [
      { width: 10, height: 20 },
      { width: 10, height: 20 },
    ]);

  it('packs from the near edge by default', () => {
    const root = build('start');
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root).map((b) => b[0])).toEqual([0, 10]);
  });

  it('centres the whole run', () => {
    const root = build('center');
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root).map((b) => b[0])).toEqual([40, 50]);
  });

  it('packs against the far edge', () => {
    const root = build('end');
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root).map((b) => b[0])).toEqual([80, 90]);
  });

  it('spreads the leftover between them and not outside them', () => {
    const root = build('between');
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root).map((b) => b[0])).toEqual([0, 90]);
  });

  it('has nothing to spend when a child grew, so it does not move anything', () => {
    const root = tree({ direction: 'row', width: 100, height: 20, justify: 'center' }, [
      { width: 10, height: 20 },
      { width: 'grow', height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 100, 20);
    expect(boxes(root).map((b) => b[0])).toEqual([0, 10]);
  });
});

describe('out of the flow', () => {
  it('places an absolute child at its own offset inside the content box, taking no space', () => {
    const root = tree({ direction: 'row', width: 100, height: 100, padding: 10 }, [
      { width: 20, height: 20 },
      { width: 5, height: 5, absolute: true, x: 3, y: 4 },
      { width: 20, height: 20 },
    ]);
    layoutUiTree(root, 0, 0, 100, 100);
    // The two flow children sit next to each other; the absolute one is off at its own offset.
    expect(boxes(root)[0]).toEqual([10, 10, 20, 20]);
    expect(boxes(root)[2]).toEqual([30, 10, 20, 20]);
    expect(boxes(root)[1]).toEqual([13, 14, 5, 5]);
  });

  it('leaves a hidden child out of the flow and out of the measurement', () => {
    const root = tree({ direction: 'row', width: 'fit', height: 'fit', gap: 5 }, [
      { width: 10, height: 10 },
      { width: 10, height: 10, hidden: true },
      { width: 10, height: 10 },
    ]);
    layoutUiTree(root, 0, 0, 500, 500);
    expect(root.rect.w).toBe(25);
    expect(boxes(root)[2]?.[0]).toBe(15);
  });
});

describe('nesting', () => {
  it("carries a parent's placement down to a grandchild", () => {
    const root = createUiNode({ direction: 'column', width: 100, height: 100, padding: 10 });
    const middle = addUiChild(
      root,
      createUiNode({ direction: 'row', width: 'grow', height: 30, padding: 5 }),
    );
    const leaf = addUiChild(middle, createUiNode({ width: 10, height: 10 }));
    layoutUiTree(root, 1000, 2000, 100, 100);
    expect([middle.rect.x, middle.rect.y, middle.rect.w]).toEqual([1010, 2010, 80]);
    expect([leaf.rect.x, leaf.rect.y]).toEqual([1015, 2015]);
  });

  it('allocates nothing on a second pass over the same tree', () => {
    const root = tree({ direction: 'row', width: 100, height: 100, gap: 4 }, [
      { width: 'grow', height: 'grow' },
      { width: 20, height: 'fit', contentHeight: 9 },
    ]);
    layoutUiTree(root, 0, 0, 100, 100);
    const first = boxes(root);
    const rects = root.children.map((child) => child.rect);
    layoutUiTree(root, 0, 0, 100, 100);
    expect(boxes(root)).toEqual(first);
    // The same rect objects were rewritten rather than replaced.
    expect(root.children.map((child) => child.rect)).toEqual(rects);
  });
});
