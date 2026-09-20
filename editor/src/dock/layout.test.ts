import { expect, test } from 'vitest';
import {
  createDockLayout,
  deserialiseDock,
  panelIds,
  removePanel,
  serialiseDock,
  splitPanel,
} from './layout.ts';
import type { DockNode } from './layout.ts';

const panel = (id: string): DockNode => ({ kind: 'panel', id });
const ids = (layout: ReturnType<typeof createDockLayout>) => {
  const out: string[] = [];
  panelIds(layout, out);
  return out;
};

test('splitting a leaf makes a split with two leaves', () => {
  const layout = createDockLayout(panel('viewport'));
  expect(splitPanel(layout, 'viewport', 'left', 'tree')).toBe(true);
  expect(ids(layout)).toEqual(['tree', 'viewport']);
});

test('the side decides which child comes first', () => {
  const layout = createDockLayout(panel('viewport'));
  splitPanel(layout, 'viewport', 'right', 'inspector');
  expect(ids(layout)).toEqual(['viewport', 'inspector']);
});

test('splitting a panel that is not there does nothing', () => {
  const layout = createDockLayout(panel('viewport'));
  expect(splitPanel(layout, 'nowhere', 'left', 'x')).toBe(false);
  expect(ids(layout)).toEqual(['viewport']);
});

test('removing one leaf of a split collapses the split', () => {
  const layout = createDockLayout(panel('viewport'));
  splitPanel(layout, 'viewport', 'left', 'tree');
  removePanel(layout, 'tree');
  expect(layout.root).toEqual(panel('viewport'));
});

test('removing the last panel leaves a valid empty layout', () => {
  const layout = createDockLayout(panel('viewport'));
  removePanel(layout, 'viewport');
  expect(layout.root).toBe(null);
  expect(ids(layout)).toEqual([]);
});

test('a layout round-trips through serialisation', () => {
  const layout = createDockLayout(panel('viewport'));
  splitPanel(layout, 'viewport', 'left', 'tree');
  splitPanel(layout, 'viewport', 'bottom', 'console');
  const back = deserialiseDock(serialiseDock(layout), new Set(['viewport', 'tree', 'console']));
  expect(ids(back)).toEqual(ids(layout));
});

test('a saved layout naming a panel that has gone still opens', () => {
  const layout = createDockLayout(panel('viewport'));
  splitPanel(layout, 'viewport', 'left', 'retired');
  const back = deserialiseDock(serialiseDock(layout), new Set(['viewport']));
  expect(ids(back)).toEqual(['viewport']);
});

test('a layout naming nothing that exists opens empty rather than failing', () => {
  const layout = createDockLayout(panel('gone'));
  expect(deserialiseDock(serialiseDock(layout), new Set(['other'])).root).toBe(null);
});

test('unparseable text opens empty rather than throwing', () => {
  expect(deserialiseDock('{not json', new Set(['a'])).root).toBe(null);
});

test('a split ratio survives the round trip', () => {
  const layout = createDockLayout({
    kind: 'split',
    direction: 'row',
    ratio: 0.3,
    first: panel('a'),
    second: panel('b'),
  });
  const back = deserialiseDock(serialiseDock(layout), new Set(['a', 'b']));
  expect(back.root?.kind === 'split' && back.root.ratio).toBe(0.3);
});
