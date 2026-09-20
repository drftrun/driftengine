import { describe, expect, it, vi } from 'vitest';
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { A11yHost, A11yNode, TextHost, UiNode } from '@driftengine/ui2d';
import { bindPanel, createEditorApp, type EditorApp, type PanelBinding } from './app.ts';
import {
  type Command,
  keyEvent,
  pointerEvent,
  wheelEvent,
  type Panel,
  type UiEvent,
} from '@driftengine/tools';
import { createDockLayout, dockSites, siteAt, type DockSite } from './dock/layout.ts';

function hosts(): { textHost: TextHost; a11yHost: A11yHost } {
  return {
    textHost: {
      focusField: vi.fn(),
      blurField: vi.fn(),
      readClipboard: async (): Promise<string> => '',
      writeClipboard: async (): Promise<void> => {},
    },
    a11yHost: { publish: vi.fn<(nodes: readonly A11yNode[], count: number) => void>() },
  };
}

interface World {
  readonly value: number;
}
interface View {
  builds: number;
  seen: UiEvent[];
}

/** A panel that records what it was handed and, on a press, asks for the world to change. */
function spy(id: string, emits = false): { binding: PanelBinding; view: View } {
  const view: View = { builds: 0, seen: [] };
  const panel: Panel<World, View> = {
    id,
    title: id,
    build(world, own, root): void {
      own.builds += 1;
      root.children.length = 0;
      addUiChild(root, createUiNode({ name: `${id}:body`, text: String(world.value) }));
    },
    route(_world, own, event): Command | null {
      own.seen.push(event);
      if (!emits || event.kind !== 'pointer' || event.phase !== 'down') return null;
      return { label: `edit ${id}`, apply: (): void => {}, revert: (): void => {} };
    },
  };
  return { binding: bindPanel(panel, () => ({ value: 7 }), view), view };
}

function twoPanels(emits = false): {
  app: EditorApp;
  left: { binding: PanelBinding; view: View };
  right: { binding: PanelBinding; view: View };
  a11yHost: A11yHost;
  textHost: TextHost;
} {
  const left = spy('left', emits);
  const right = spy('right', emits);
  const { textHost, a11yHost } = hosts();
  const app = createEditorApp({
    canvas: null,
    textHost,
    a11yHost,
    layout: createDockLayout({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'panel', id: 'left' },
      second: { kind: 'panel', id: 'right' },
    }),
    panels: [left.binding, right.binding],
  });
  return { app, left, right, a11yHost, textHost };
}

describe('the dock tree becomes rectangles', () => {
  const out: DockSite[] = [];

  it('gives one panel the whole area', () => {
    const layout = createDockLayout({ kind: 'panel', id: 'only' });
    expect(dockSites(layout, 800, 600, out)).toBe(1);
    expect(out[0]).toEqual({ id: 'only', x: 0, y: 0, w: 800, h: 600 });
  });

  it('takes the divider out before the ratio divides', () => {
    /* 806 less a 6px divider is 800 of panes; half each is 400, and the second starts at 406 —
       the same arithmetic `splitterSizes` does, and the reason its extents are 806 rather than
       800 in its own tests. */
    const layout = createDockLayout({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'panel', id: 'a' },
      second: { kind: 'panel', id: 'b' },
    });
    expect(dockSites(layout, 806, 600, out)).toBe(2);
    expect(out[0]).toEqual({ id: 'a', x: 0, y: 0, w: 400, h: 600 });
    expect(out[1]).toEqual({ id: 'b', x: 406, y: 0, w: 400, h: 600 });
  });

  it('splits a column downward, first on top', () => {
    const layout = createDockLayout({
      kind: 'split',
      direction: 'column',
      ratio: 0.25,
      first: { kind: 'panel', id: 'top' },
      second: { kind: 'panel', id: 'bottom' },
    });
    dockSites(layout, 800, 406, out);
    expect(out[0]).toEqual({ id: 'top', x: 0, y: 0, w: 800, h: 100 });
    expect(out[1]).toEqual({ id: 'bottom', x: 0, y: 106, w: 800, h: 300 });
  });

  it('nests, and the inner split divides only its own half', () => {
    const layout = createDockLayout({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'panel', id: 'a' },
      second: {
        kind: 'split',
        direction: 'column',
        ratio: 0.5,
        first: { kind: 'panel', id: 'b' },
        second: { kind: 'panel', id: 'c' },
      },
    });
    expect(dockSites(layout, 806, 606, out)).toBe(3);
    expect(out[0]).toEqual({ id: 'a', x: 0, y: 0, w: 400, h: 606 });
    expect(out[1]).toEqual({ id: 'b', x: 406, y: 0, w: 400, h: 300 });
    expect(out[2]).toEqual({ id: 'c', x: 406, y: 306, w: 400, h: 300 });
  });

  it('gives nothing back for an empty layout', () => {
    expect(dockSites(createDockLayout(null), 800, 600, out)).toBe(0);
    expect(out).toHaveLength(0);
  });

  it('never hands back a negative width, however narrow the window', () => {
    const layout = createDockLayout({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'panel', id: 'a' },
      second: { kind: 'panel', id: 'b' },
    });
    /* Two pixels of window and six of divider. Subtracting alone gives −4, which lays two panels
       out backwards over each other rather than showing nothing. */
    dockSites(layout, 2, 600, out);
    expect(out[0]?.w).toBe(0);
    expect(out[1]?.w).toBe(0);
    expect(out[1]?.x).toBe(6);
  });

  it('reuses its entries, so a resize allocates nothing after the first', () => {
    const layout = createDockLayout({ kind: 'panel', id: 'only' });
    dockSites(layout, 800, 600, out);
    const first = out[0];
    dockSites(layout, 900, 700, out);
    expect(out[0]).toBe(first);
    expect(out[0]?.w).toBe(900);
  });

  it('finds the site under a point and nothing under one outside', () => {
    const layout = createDockLayout({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: { kind: 'panel', id: 'a' },
      second: { kind: 'panel', id: 'b' },
    });
    dockSites(layout, 806, 600, out);
    expect(siteAt(out, 10, 10)?.id).toBe('a');
    expect(siteAt(out, 500, 10)?.id).toBe('b');
    /* On the divider, which belongs to neither. */
    expect(siteAt(out, 402, 10)).toBeNull();
    expect(siteAt(out, 900, 10)).toBeNull();
  });
});

describe('an application runs with no graphics device at all', () => {
  it('starts with a headless canvas', () => {
    const { textHost, a11yHost } = hosts();
    const app = createEditorApp({ canvas: null, textHost, a11yHost });
    expect(app).toBeDefined();
    app.dispose();
  });

  it('runs a frame without a renderer', () => {
    const { textHost, a11yHost } = hosts();
    const app = createEditorApp({ canvas: null, textHost, a11yHost });
    expect(() => app.frame(0)).not.toThrow();
    expect(app.time).toBe(0);
    app.frame(16.5);
    expect(app.time).toBe(16.5);
    app.dispose();
  });

  it('uses the hosts it was given and never one it reached for', () => {
    const { app, a11yHost, textHost } = twoPanels();
    app.resize(806, 600);
    app.frame(0);
    expect(a11yHost.publish).toHaveBeenCalled();
    expect(textHost.blurField).not.toHaveBeenCalled();
    app.dispose();
    expect(textHost.blurField).toHaveBeenCalled();
  });
});

describe('laying out is an event, not a frame', () => {
  it('does not relayout on a resize to the size it already is', () => {
    const { app } = twoPanels();
    app.resize(800, 600);
    const first = app.layoutCount;
    expect(first).toBe(1);
    app.resize(800, 600);
    expect(app.layoutCount).toBe(first);
    app.resize(801, 600);
    expect(app.layoutCount).toBe(2);
  });

  it('lays out once on the first frame, and not again while nothing changes', () => {
    const { app } = twoPanels();
    app.frame(0);
    expect(app.layoutCount).toBe(1);
    app.frame(16);
    app.frame(32);
    expect(app.layoutCount).toBe(1);
  });

  it('publishes the accessibility tree when it changes and not every frame', () => {
    const { app, a11yHost } = twoPanels();
    app.resize(806, 600);
    app.frame(0);
    expect(a11yHost.publish).toHaveBeenCalledTimes(1);
    app.frame(16);
    app.frame(32);
    expect(a11yHost.publish).toHaveBeenCalledTimes(1);
    /* A screen reader handed an identical tree sixty times a second says nothing useful. */
    app.invalidate();
    app.frame(48);
    expect(a11yHost.publish).toHaveBeenCalledTimes(2);
  });
});

describe('a panel is built into its site and routed in its own space', () => {
  it('places one root a panel, at the rectangle the dock gave it', () => {
    const { app, left, right } = twoPanels();
    app.resize(806, 600);
    expect(left.view.builds).toBe(1);
    expect(right.view.builds).toBe(1);

    const roots = app.root.children;
    expect(roots.map((node: UiNode) => node.name)).toEqual(['panel:left', 'panel:right']);
    expect([roots[0]?.rect.x, roots[0]?.rect.w]).toEqual([0, 400]);
    expect([roots[1]?.rect.x, roots[1]?.rect.w]).toEqual([406, 400]);
  });

  it('subtracts the site origin, so a panel never learns where on screen it is', () => {
    const { app, left, right } = twoPanels();
    app.resize(806, 600);
    expect(app.route(pointerEvent('down', 420, 30))).toBe(false);
    expect(left.view.seen).toHaveLength(0);
    /* 420 on screen is 14 inside a panel whose site starts at 406. */
    expect(right.view.seen[0]).toEqual({ kind: 'pointer', phase: 'down', x: 14, y: 30, button: 0 });
  });

  it('moves a wheel event too, which is the one that is easy to forget', () => {
    const { app, right } = twoPanels();
    app.resize(806, 600);
    app.route(wheelEvent(500, 40, 0, -3));
    expect(right.view.seen[0]).toEqual({ kind: 'wheel', x: 94, y: 40, dx: 0, dy: -3 });
  });

  it('ignores a press on the divider, which belongs to neither panel', () => {
    const { app, left, right } = twoPanels();
    app.resize(806, 600);
    expect(app.route(pointerEvent('down', 402, 30))).toBe(false);
    expect(left.view.seen).toHaveLength(0);
    expect(right.view.seen).toHaveLength(0);
  });

  it('leaves a hole for a panel the layout names and this build does not have', () => {
    /* A saved layout outlives the panel set, so the other panel must not shift along to fill it. */
    const { textHost, a11yHost } = hosts();
    const known = spy('right');
    const app = createEditorApp({
      canvas: null,
      textHost,
      a11yHost,
      layout: createDockLayout({
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'panel', id: 'gone' },
        second: { kind: 'panel', id: 'right' },
      }),
      panels: [known.binding],
    });
    app.resize(806, 600);
    expect(app.root.children.map((node: UiNode) => node.name)).toEqual([
      'panel:gone',
      'panel:right',
    ]);
    expect(app.root.children[0]?.children).toHaveLength(0);
    expect(app.route(pointerEvent('down', 10, 10))).toBe(false);
    expect(known.view.seen).toHaveLength(0);
  });
});

describe('the undo stack belongs to the application', () => {
  it('pushes what a panel returns, and a rebuild follows', () => {
    const { app } = twoPanels(true);
    app.resize(806, 600);
    expect(app.layoutCount).toBe(1);
    expect(app.route(pointerEvent('down', 10, 10))).toBe(true);
    expect(app.undo.undoLabel()).toBe('edit left');
    app.frame(0);
    expect(app.layoutCount).toBe(2);
  });

  it('undoes and redoes from the keyboard, whichever panel is focused', () => {
    const { app } = twoPanels(true);
    app.resize(806, 600);
    app.route(pointerEvent('down', 10, 10));
    app.route(pointerEvent('down', 500, 10));
    expect(app.focused).toBe('right');
    expect(app.undo.undoLabel()).toBe('edit right');

    /* Focused on the right, and ctrl+z takes back the right one and then the left one: undo is
       the application's, so it does not mean "the last thing I did in this panel". */
    expect(app.route(keyEvent('z', false, true))).toBe(true);
    expect(app.undo.undoLabel()).toBe('edit left');
    expect(app.route(keyEvent('z', false, true))).toBe(true);
    expect(app.undo.canUndo()).toBe(false);
    expect(app.route(keyEvent('z', false, true))).toBe(false);

    expect(app.route(keyEvent('z', true, true))).toBe(true);
    expect(app.undo.undoLabel()).toBe('edit left');
    expect(app.route(keyEvent('y', false, true))).toBe(true);
    expect(app.undo.undoLabel()).toBe('edit right');
  });

  it('sends every other key to the focused panel and nothing to an unfocused one', () => {
    const { app, left, right } = twoPanels();
    app.resize(806, 600);
    expect(app.route(keyEvent('a'))).toBe(false);
    app.route(pointerEvent('down', 10, 10));
    app.route(keyEvent('a'));
    expect(left.view.seen.at(-1)).toEqual({ kind: 'key', key: 'a', shift: false, ctrl: false });
    expect(right.view.seen).toHaveLength(0);
  });
});

describe('disposing', () => {
  it('stops everything, and can be called twice', () => {
    const { app, a11yHost, textHost } = twoPanels();
    app.resize(806, 600);
    app.frame(0);
    app.dispose();
    app.dispose();
    expect(textHost.blurField).toHaveBeenCalledTimes(1);

    /*
     * Invalidated first, so a frame *would* rebuild and republish. Without it the frame returns
     * early for a reason that has nothing to do with being disposed, and the test proves nothing.
     */
    const laid = app.layoutCount;
    app.invalidate();
    app.frame(16);
    app.resize(900, 700);
    expect(app.layoutCount).toBe(laid);
    expect(a11yHost.publish).toHaveBeenCalledTimes(1);
    expect(app.route(pointerEvent('down', 10, 10))).toBe(false);
    expect(app.root.children).toHaveLength(0);
    expect(app.undo.canUndo()).toBe(false);
  });
});
