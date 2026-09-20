import { describe, expect, it, vi } from 'vitest';
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import {
  createPanelRoot,
  emptyPanel,
  panelIdOf,
  pointerEvent,
  treeShape,
  type Panel,
  type UiEvent,
} from './panel.ts';

interface CountWorld {
  readonly rows: readonly string[];
}

/** What the panel itself owns: which row the pointer last went down on. */
interface CountView {
  pressed: number;
}

const view = (): CountView => ({ pressed: -1 });

/** A panel with just enough behaviour to exercise the contract and nothing more. */
function countPanel(applied: () => void): Panel<CountWorld, CountView> {
  return {
    id: 'count',
    title: 'Count',
    build(world, _view, root) {
      if (world.rows.length === 0) {
        emptyPanel(root, 'nothing to count');
        return;
      }
      root.children.length = 0;
      for (const row of world.rows) {
        addUiChild(root, createUiNode({ width: 'grow', height: 18, text: row, name: row }));
      }
    },
    route(world, panelView, event) {
      if (event.kind !== 'pointer') return null;
      if (event.phase === 'down') {
        /* View state, written in place. This is the half the world parameter may not do. */
        panelView.pressed = 0;
        return null;
      }
      if (event.phase !== 'up') return null;
      const row = world.rows[0];
      if (row === undefined) return null;
      return { label: `Count ${row}`, apply: applied, revert: applied };
    },
  };
}

describe('a panel', () => {
  it('is a function of its state, so building twice gives the same tree', () => {
    const panel = countPanel(() => {});
    const state: CountWorld = { rows: ['a', 'b', 'c'] };

    const first = createPanelRoot(panel);
    panel.build(state, view(), first);
    const once = treeShape(first);

    panel.build(state, view(), first);
    expect(treeShape(first), 'a second build over the same root').toBe(once);

    const second = createPanelRoot(panel);
    panel.build(state, view(), second);
    expect(treeShape(second), 'and a fresh root reaches the same place').toBe(once);
  });

  /**
   * **The signature is the rule.** `route` is handed the state and returns a command or nothing, so
   * a panel physically cannot change the world — there is no route through which it could. Frozen
   * state turns "does not mutate" from a convention into something that throws if it is broken,
   * because a module is strict mode and an assignment to a frozen object is a `TypeError` there.
   */
  it('cannot change the world it is routing against', () => {
    const panel = countPanel(() => {});
    const world: CountWorld = Object.freeze({ rows: Object.freeze(['a']) as readonly string[] });
    expect(() => panel.route(world, view(), pointerEvent('up', 1, 1))).not.toThrow();
  });

  /** And the other half: what the panel owns, it writes, because a drag lives nowhere else. */
  it('writes its own view state in place', () => {
    const panel = countPanel(() => {});
    const panelView = view();
    expect(panel.route({ rows: ['a'] }, panelView, pointerEvent('down', 1, 1))).toBe(null);
    expect(panelView.pressed).toBe(0);
  });

  it('changes nothing when it has nothing to say', () => {
    const panel = countPanel(() => {});
    const state: CountWorld = { rows: ['a'] };
    const root = createPanelRoot(panel);
    panel.build(state, view(), root);
    const before = treeShape(root);

    expect(panel.route(state, view(), pointerEvent('move', 1, 1))).toBe(null);
    expect(treeShape(root)).toBe(before);
  });

  /** The panel asks; the stack decides. A panel that applied its own command would bypass undo. */
  it('does not apply the command it returns', () => {
    const applied = vi.fn();
    const panel = countPanel(applied);
    const command = panel.route({ rows: ['a'] }, view(), pointerEvent('up', 1, 1));

    expect(command?.label).toBe('Count a');
    expect(applied, 'returning is not applying').not.toHaveBeenCalled();

    command?.apply();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  /**
   * The dock stores which panel is in which site by identifier, so the identifier has to survive a
   * rebuild. It lives on the root node, where the dock can read it off whatever it is holding.
   */
  it('keeps its identifier on the root across rebuilds', () => {
    const panel = countPanel(() => {});
    const root = createPanelRoot(panel);
    expect(panelIdOf(root)).toBe('count');

    panel.build({ rows: ['a'] }, view(), root);
    expect(panelIdOf(root)).toBe('count');
    panel.build({ rows: [] }, view(), root);
    expect(panelIdOf(root)).toBe('count');
  });

  it('reports no identifier for a node that is not a panel root', () => {
    expect(panelIdOf(createUiNode({ name: 'row:3' }))).toBe(null);
    expect(panelIdOf(null)).toBe(null);
  });

  /**
   * **Nothing to show is a state, not a failure.** A panel with no selection, an asset browser
   * before the project has loaded and a profiler before the first frame all reach here, and an
   * empty dock with an exception behind it is the least useful thing an editor can show.
   */
  it('shows an empty state rather than throwing', () => {
    const panel = countPanel(() => {});
    const root = createPanelRoot(panel);
    expect(() => panel.build({ rows: [] }, view(), root)).not.toThrow();
    expect(root.children.length).toBe(1);
    expect(root.children[0]?.text).toBe('nothing to count');
    expect(root.children[0]?.interactive, 'and it is not clickable').toBe(false);
  });

  it('goes back to an empty state after having had content', () => {
    const panel = countPanel(() => {});
    const root = createPanelRoot(panel);
    panel.build({ rows: ['a', 'b'] }, view(), root);
    expect(root.children.length).toBe(2);

    panel.build({ rows: [] }, view(), root);
    expect(root.children.length).toBe(1);
    expect(root.children[0]?.text).toBe('nothing to count');
  });
});

describe('the shape of a tree', () => {
  it('describes structure, text and geometry, and not identity', () => {
    const a = createUiNode({ direction: 'column', name: 'root' });
    addUiChild(a, createUiNode({ width: 'grow', height: 18, text: 'one', name: 'r0' }));
    const b = createUiNode({ direction: 'column', name: 'root' });
    addUiChild(b, createUiNode({ width: 'grow', height: 18, text: 'one', name: 'r0' }));

    expect(treeShape(a)).toBe(treeShape(b));
  });

  it('notices a difference in text, in depth and in order', () => {
    const base = createUiNode({ name: 'root' });
    addUiChild(base, createUiNode({ text: 'one', name: 'a' }));
    addUiChild(base, createUiNode({ text: 'two', name: 'b' }));

    const different = createUiNode({ name: 'root' });
    addUiChild(different, createUiNode({ text: 'two', name: 'b' }));
    addUiChild(different, createUiNode({ text: 'one', name: 'a' }));
    expect(treeShape(base)).not.toBe(treeShape(different));

    /* The same two rows, one nested under the other instead of beside it. */
    const deeper = createUiNode({ name: 'root' });
    const parent = createUiNode({ text: 'one', name: 'a' });
    addUiChild(deeper, parent);
    addUiChild(parent, createUiNode({ text: 'two', name: 'b' }));
    expect(treeShape(base)).not.toBe(treeShape(deeper));
  });

  /** A hidden row is a pooled row that is not showing, and two trees differing only there differ. */
  it('notices that a row is hidden', () => {
    const shown = createUiNode({ name: 'root' });
    addUiChild(shown, createUiNode({ text: 'one', name: 'a' }));
    const hidden = createUiNode({ name: 'root' });
    const row = createUiNode({ text: 'one', name: 'a' });
    row.hidden = true;
    addUiChild(hidden, row);

    expect(treeShape(shown)).not.toBe(treeShape(hidden));
  });
});

describe('an event', () => {
  it('carries what a panel needs to route it', () => {
    const event: UiEvent = pointerEvent('down', 12, 34);
    expect(event).toEqual({ kind: 'pointer', phase: 'down', x: 12, y: 34, button: 0 });
  });
});
