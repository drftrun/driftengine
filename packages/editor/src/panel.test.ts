import { SceneNode } from '@driftengine/core';
import { World, defineComponent } from '@driftengine/entities';
import { createUiNode } from '@driftengine/ui2d';
import { expect, test } from 'vitest';
import { Inspector } from './inspector.ts';
import { SceneTree } from './sceneTree.ts';
import {
  FIELD_ROW_PREFIX,
  TREE_ROW_PREFIX,
  buildInspectorPanel,
  buildTreePanel,
  formatValue,
  rowIndexOf,
} from './panel.ts';

const Health = defineComponent('PanelHealth', { current: 'f32', alive: 'bool' });

function hierarchy(): { root: SceneNode; a: SceneNode; leaf: SceneNode } {
  const root = new SceneNode();
  const a = new SceneNode();
  const leaf = new SceneNode();
  root.attachChild(a);
  a.attachChild(leaf);
  return { root, a, leaf };
}

test('a tree panel gets one row per line of the tree', () => {
  const { root } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const panel = createUiNode({ direction: 'column' });
  expect(buildTreePanel(tree, panel)).toBe(3);
  expect(panel.children.filter((child) => !child.hidden).length).toBe(3);
});

test('a row is indented by its depth and carries the name', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  tree.setName(a, 'lamp');
  tree.rebuild(root);
  const panel = createUiNode({ direction: 'column' });
  buildTreePanel(tree, panel);
  expect(panel.children[0]!.paddingLeft).toBe(0);
  expect(panel.children[1]!.paddingLeft).toBe(12);
  expect(panel.children[2]!.paddingLeft).toBe(24);
  expect(panel.children[1]!.text).toContain('lamp');
});

test('a row with children shows whether it is open', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const panel = createUiNode({ direction: 'column' });
  buildTreePanel(tree, panel);
  expect(panel.children[1]!.text.startsWith('-')).toBe(true);
  tree.setExpanded(a, false);
  tree.rebuild(root);
  buildTreePanel(tree, panel);
  expect(panel.children[1]!.text.startsWith('+')).toBe(true);
});

/*
 * A builder that made fresh nodes every frame would allocate in a frame path, which `AGENTS.md`
 * forbids. Rows past what is needed are hidden rather than removed, so the pool survives a shrink.
 */
test('rebuilding reuses the nodes and hides the ones it no longer needs', () => {
  const { root, a } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const panel = createUiNode({ direction: 'column' });
  buildTreePanel(tree, panel);
  const first = panel.children[0];
  const third = panel.children[2];

  tree.setExpanded(a, false);
  tree.rebuild(root);
  expect(buildTreePanel(tree, panel)).toBe(2);
  expect(panel.children[0]).toBe(first);
  expect(panel.children.length).toBe(3);
  expect(third!.hidden).toBe(true);

  tree.setExpanded(a, true);
  tree.rebuild(root);
  buildTreePanel(tree, panel);
  expect(third!.hidden).toBe(false);
  expect(panel.children.length).toBe(3);
});

test('rows are interactive and focusable, so the pointer router can find them', () => {
  const { root } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const panel = createUiNode({ direction: 'column' });
  buildTreePanel(tree, panel);
  expect(panel.children.every((child) => child.interactive && child.focusable)).toBe(true);
});

test('a row name parses back to the row it is', () => {
  const { root } = hierarchy();
  const tree = new SceneTree();
  tree.rebuild(root);
  const panel = createUiNode({ direction: 'column' });
  buildTreePanel(tree, panel);
  expect(rowIndexOf(panel.children[2]!, TREE_ROW_PREFIX)).toBe(2);
});

test('a node that is not a row parses to -1, and so does null', () => {
  expect(rowIndexOf(null, TREE_ROW_PREFIX)).toBe(-1);
  expect(rowIndexOf(createUiNode({ name: 'something-else' }), TREE_ROW_PREFIX)).toBe(-1);
  expect(rowIndexOf(createUiNode({ name: 'field:2' }), TREE_ROW_PREFIX)).toBe(-1);
});

test('the two prefixes do not answer for each other', () => {
  const inspector = new Inspector();
  inspector.showNode(new SceneNode());
  const panel = createUiNode({ direction: 'column' });
  buildInspectorPanel(inspector, panel);
  expect(rowIndexOf(panel.children[0]!, FIELD_ROW_PREFIX)).toBe(0);
  expect(rowIndexOf(panel.children[0]!, TREE_ROW_PREFIX)).toBe(-1);
});

test('an inspector panel gets one row per field', () => {
  const inspector = new Inspector();
  inspector.showNode(new SceneNode());
  const panel = createUiNode({ direction: 'column' });
  expect(buildInspectorPanel(inspector, panel)).toBe(10);
});

test('a transform row is labelled without a group and a component row with one', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 3 });
  const inspector = new Inspector();

  const panel = createUiNode({ direction: 'column' });
  inspector.showNode(new SceneNode());
  buildInspectorPanel(inspector, panel);
  expect(panel.children[0]!.text.startsWith('position.x')).toBe(true);

  inspector.showEntity(world, entity, [Health]);
  buildInspectorPanel(inspector, panel);
  expect(panel.children[0]!.text.startsWith('PanelHealth.current')).toBe(true);
});

test('an empty inspector hides every row it had', () => {
  const inspector = new Inspector();
  inspector.showNode(new SceneNode());
  const panel = createUiNode({ direction: 'column' });
  buildInspectorPanel(inspector, panel);
  inspector.showNothing();
  expect(buildInspectorPanel(inspector, panel)).toBe(0);
  expect(panel.children.every((child) => child.hidden)).toBe(true);
});

test('a number shows a decimal and an integer kind does not', () => {
  expect(formatValue(1.5, 'number')).toBe('1.500');
  expect(formatValue(2, 'number')).toBe('2.0');
  expect(formatValue(7, 'integer')).toBe('7');
  expect(formatValue(3.9, 'enum')).toBe('3');
  expect(formatValue(12, 'entity')).toBe('12');
});

test('an absent value shows as a dash rather than as the word undefined', () => {
  expect(formatValue(null, 'number')).toBe('—');
  expect(formatValue(undefined, 'text')).toBe('—');
});

test('text shows itself', () => {
  expect(formatValue('anvil', 'text')).toBe('anvil');
});
