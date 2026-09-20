import { describe, expect, it } from 'vitest';
import {
  createUndoStack,
  createSelection,
  isSelected,
  selectedEntities,
  pointerEvent,
  treeShape,
} from '@driftengine/tools';
import {
  createSceneModel,
  createSceneTreeView,
  deleteEntityCommand,
  duplicateEntityCommand,
  isDescendantOf,
  renameCommand,
  reparentCommand,
  sceneTreeItems,
  sceneTreePanel,
  type SceneModel,
} from './sceneTree.ts';

/**
 * ```
 * world        0
 *   hero       1
 *     sword    2
 *     shield   3
 *   prop       4
 * ```
 */
function world(): SceneModel {
  const model = createSceneModel();
  model.add(0, -1, 'world');
  model.add(1, 0, 'hero');
  model.add(2, 1, 'sword');
  model.add(3, 1, 'shield');
  model.add(4, 0, 'prop');
  return model;
}

const ROW = 18;

describe('the scene tree', () => {
  it('shows a parent as expandable and a leaf as not', () => {
    const items = sceneTreeItems(world());
    expect(items.map((item) => [item.id, item.depth, item.hasChildren])).toEqual([
      [0, 0, true],
      [1, 1, true],
      [2, 2, false],
      [3, 2, false],
      [4, 1, false],
    ]);
  });

  it('builds a row per visible entity, and nothing under a collapsed one', () => {
    const model = world();
    const view = createSceneTreeView({ selection: createSelection(), rowHeight: ROW });

    view.tree.collapsed.add(1);
    sceneTreePanel.build({ model }, view, view.root);
    expect(view.tree.visible.map((item) => item.id)).toEqual([0, 1, 4]);
  });

  /**
   * **The defect that makes a tree collapse itself during ordinary work.** Keyed by row index,
   * adding an entity above a collapsed branch shifts every index below it and the collapse lands
   * on whatever moved into that slot.
   */
  it('keeps a branch shut when an entity is added above it', () => {
    const model = world();
    const view = createSceneTreeView({ selection: createSelection(), rowHeight: ROW });
    const state = { model };

    view.tree.collapsed.add(1);
    sceneTreePanel.build(state, view, view.root);
    expect(view.tree.visible.map((item) => item.id)).toEqual([0, 1, 4]);

    /* A new entity arrives as the first child of the world, above the hero. */
    model.add(9, 0, 'newcomer');
    model.moveBefore(9, 1);
    sceneTreePanel.build(state, view, view.root);
    expect(
      view.tree.visible.map((item) => item.id),
      'the hero is still shut',
    ).toEqual([0, 9, 1, 4]);
  });

  it('selects the row that was clicked and changes nothing in the world', () => {
    const model = world();
    const selection = createSelection();
    const view = createSceneTreeView({ selection, rowHeight: ROW });
    const state = { model };
    sceneTreePanel.build(state, view, view.root);
    const before = treeShape(view.root);

    /* The third row: world, hero, sword. */
    /* x = 40 is well past any twisty, so this is a click on the row rather than on its arrow. */
    expect(sceneTreePanel.route(state, view, pointerEvent('down', 40, ROW * 2 + 2))).toBe(null);
    expect(sceneTreePanel.route(state, view, pointerEvent('up', 40, ROW * 2 + 2))).toBe(null);

    expect(selectedEntities(selection)).toEqual([2]);
    expect(model.parentOf(2), 'the world is untouched').toBe(1);
    expect(treeShape(view.root), 'and the tree was not rebuilt by routing').toBe(before);
  });

  it('adds to the selection when the click is held with shift', () => {
    const model = world();
    const selection = createSelection();
    const view = createSceneTreeView({ selection, rowHeight: ROW });
    const state = { model };
    sceneTreePanel.build(state, view, view.root);

    sceneTreePanel.route(state, view, pointerEvent('down', 40, 2));
    sceneTreePanel.route(state, view, pointerEvent('up', 40, 2));
    view.shift = true;
    sceneTreePanel.route(state, view, pointerEvent('down', 40, ROW + 2));
    sceneTreePanel.route(state, view, pointerEvent('up', 40, ROW + 2));

    expect(isSelected(selection, 0)).toBe(true);
    expect(isSelected(selection, 1)).toBe(true);
  });

  it('clicking a twisty opens and shuts the branch without selecting it', () => {
    const model = world();
    const selection = createSelection();
    const view = createSceneTreeView({ selection, rowHeight: ROW, indent: 12, twistyWidth: 12 });
    const state = { model };
    sceneTreePanel.build(state, view, view.root);

    /* Row 1 is the hero at depth 1, so its twisty sits between x 12 and x 24. */
    sceneTreePanel.route(state, view, pointerEvent('down', 14, ROW + 2));
    sceneTreePanel.route(state, view, pointerEvent('up', 14, ROW + 2));
    expect(view.tree.collapsed.has(1)).toBe(true);
    expect(selectedEntities(selection), 'a twisty is not a selection').toEqual([]);
  });
});

describe('dragging a row onto another', () => {
  it('asks for a reparent and does not reparent', () => {
    const model = world();
    const view = createSceneTreeView({ selection: createSelection(), rowHeight: ROW });
    const state = { model };
    sceneTreePanel.build(state, view, view.root);

    /* Row 2 is the sword; drop it on row 4, the prop. */
    sceneTreePanel.route(state, view, pointerEvent('down', 40, ROW * 2 + 2));
    sceneTreePanel.route(state, view, pointerEvent('move', 40, ROW * 4 + 2));
    const command = sceneTreePanel.route(state, view, pointerEvent('up', 40, ROW * 4 + 2));

    expect(command?.label).toBe('Reparent sword');
    expect(model.parentOf(2), 'asking is not doing').toBe(1);

    const stack = createUndoStack(8);
    stack.push(command!);
    expect(model.parentOf(2)).toBe(4);
    stack.undo();
    expect(model.parentOf(2)).toBe(1);
  });

  /**
   * **A node cannot become its own ancestor**, and the alternative is not a wrong picture: it is a
   * cycle, and the next walk of the hierarchy does not return.
   */
  it('refuses a drop onto its own descendant', () => {
    const model = world();
    expect(isDescendantOf(model, 2, 1), 'the sword is under the hero').toBe(true);
    expect(reparentCommand(model, 1, 2), 'the hero cannot go under its own sword').toBe(null);
    expect(reparentCommand(model, 1, 1), 'nor under itself').toBe(null);
    expect(reparentCommand(model, 2, 4)).not.toBe(null);
  });

  it('refuses a drop through the panel too, and leaves no drag behind', () => {
    const model = world();
    const view = createSceneTreeView({ selection: createSelection(), rowHeight: ROW });
    const state = { model };
    sceneTreePanel.build(state, view, view.root);

    /* Drag the hero (row 1) onto the sword (row 2), which is its own child. */
    sceneTreePanel.route(state, view, pointerEvent('down', 40, ROW + 2));
    const command = sceneTreePanel.route(state, view, pointerEvent('up', 40, ROW * 2 + 2));
    expect(command).toBe(null);
    expect(model.parentOf(1)).toBe(0);
    expect(view.dragFrom, 'the drag is over either way').toBe(-1);
  });

  it('is a selection and not a drag when it is let go where it started', () => {
    const model = world();
    const selection = createSelection();
    const view = createSceneTreeView({ selection, rowHeight: ROW });
    const state = { model };
    sceneTreePanel.build(state, view, view.root);

    sceneTreePanel.route(state, view, pointerEvent('down', 40, ROW * 2 + 2));
    const command = sceneTreePanel.route(state, view, pointerEvent('up', 40, ROW * 2 + 2));
    expect(command).toBe(null);
    expect(selectedEntities(selection)).toEqual([2]);
  });
});

describe('the commands a scene tree emits', () => {
  it('renames, and puts the old name back', () => {
    const model = world();
    const stack = createUndoStack(8);
    stack.push(renameCommand(model, 1, 'protagonist')!);
    expect(model.nameOf(1)).toBe('protagonist');
    stack.undo();
    expect(model.nameOf(1)).toBe('hero');
  });

  it('refuses to rename something that is not there', () => {
    expect(renameCommand(world(), 77, 'ghost')).toBe(null);
  });

  /** Deleting a parent takes its subtree, and one press of undo brings the subtree back. */
  it('deletes a whole subtree in one entry', () => {
    const model = world();
    const stack = createUndoStack(8);
    stack.push(deleteEntityCommand(model, 1)!);

    expect(model.has(1)).toBe(false);
    expect(model.has(2)).toBe(false);
    expect(model.has(3)).toBe(false);
    expect(model.has(0), 'and nothing else').toBe(true);
    expect(model.has(4)).toBe(true);

    stack.undo();
    expect(sceneTreeItems(model).map((item) => item.id)).toEqual([0, 1, 2, 3, 4]);
    expect(model.nameOf(3), 'names came back too').toBe('shield');
  });

  it('restores a deleted subtree where it was, not at the end', () => {
    const model = world();
    const stack = createUndoStack(8);
    stack.push(deleteEntityCommand(model, 1)!);
    stack.undo();
    expect(sceneTreeItems(model).map((item) => item.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('duplicates a subtree under the same parent', () => {
    const model = world();
    let next = 100;
    const stack = createUndoStack(8);
    stack.push(duplicateEntityCommand(model, 1, () => next++)!);

    const ids = sceneTreeItems(model).map((item) => item.id);
    expect(ids.length, 'three more entities').toBe(8);
    expect(model.parentOf(100), 'the copy sits beside the original').toBe(0);
    expect(model.nameOf(100)).toBe('hero copy');

    stack.undo();
    expect(sceneTreeItems(model).map((item) => item.id)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('a scene tree of ten thousand entities', () => {
  function huge(): SceneModel {
    const model = createSceneModel();
    model.add(0, -1, 'world');
    for (let i = 1; i <= 10_000; i += 1) model.add(i, 0, `entity ${i}`);
    return model;
  }

  it('builds a screenful of rows and not ten thousand', () => {
    const model = huge();
    const view = createSceneTreeView({
      selection: createSelection(),
      rowHeight: ROW,
      viewHeight: 360,
      overscan: 2,
    });
    sceneTreePanel.build({ model }, view, view.root);

    expect(view.tree.visible.length).toBe(10_001);
    expect(view.tree.node.children.length).toBeLessThan(30);
    expect(view.root.children.length, 'the tree is the panel’s only child').toBe(1);
  });

  it('routes a click at the bottom of the list to the right entity', () => {
    const model = huge();
    const selection = createSelection();
    const view = createSceneTreeView({ selection, rowHeight: ROW, viewHeight: 360, overscan: 2 });
    const state = { model };
    view.tree.scrollY = ROW * 9_000;
    sceneTreePanel.build(state, view, view.root);

    /* The first row on screen is 9,000 rows down, which is entity 9,000. */
    sceneTreePanel.route(state, view, pointerEvent('down', 40, 2));
    sceneTreePanel.route(state, view, pointerEvent('up', 40, 2));
    expect(selectedEntities(selection)).toEqual([9_000]);
  });
});
