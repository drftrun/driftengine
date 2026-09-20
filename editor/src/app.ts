/**
 * The editor, as one object a host drives.
 *
 * **The interface is drawn by the engine, into the same canvas as the scene.** Not into elements
 * beside it. That is what every established engine does with its own editor, and it is the decision
 * the rest of this product depends on: an editor made of DOM is an editor that exists only in a
 * browser, and this one has to run under a host that has none.
 *
 * **`canvas: null` is a supported configuration, not a test fixture.** Everything here — the dock
 * geometry, the panel builds, the routing, the undo stack, the accessibility tree — is arithmetic
 * over a `UiNode` tree, and none of it needs a graphics device. An editor whose interface logic can
 * only run with a live device is an editor nobody can test, and the whole of this file's test suite
 * is the evidence that it does not need one.
 *
 * **The hosts are supplied, never reached for.** `TextHost` and `A11yHost` arrive as parameters
 * exactly as `KeyValueStore` does in the engine. That is the rule `AGENTS.md` states for anything
 * under `packages/`, and it applies here for a reason of its own: the native host is a second host,
 * and a product that fetched `document` would have to be rewritten rather than re-hosted.
 *
 * **Laying out is an event, not a frame.** An editor is idle most of the time — nobody is resizing
 * the window or dragging a node on the great majority of frames — so a resize to the size it
 * already is does nothing, and a frame with nothing dirty publishes nothing. The accessibility tree
 * is republished only when it has actually changed, because a screen reader handed an identical
 * tree sixty times a second is a screen reader that says nothing useful.
 */
import { a11yTree, addUiChild, createUiNode, layoutUiTree } from '@driftengine/ui2d';
import type { A11yHost, A11yNode, TextHost, UiNode } from '@driftengine/ui2d';
import {
  createUndoStack,
  type Command,
  type UndoStack,
  createPanelRoot,
  type UiEvent,
} from '@driftengine/tools';
import {
  createDockLayout,
  dockSites,
  siteAt,
  type DockLayout,
  type DockSite,
} from './dock/layout.ts';

/*
 * **`PanelBinding` and `bindPanel` were defined here and are `@driftengine/tools`' now.**
 *
 * Neither had an editor-specific noun in it: closing a `Panel<W, V>`'s two type parameters where
 * both are known is what *any* host holding several panels at once must do, and the in-game
 * overlay needed exactly the same thing. Two implementations of one decision drift, and these two
 * would have drifted the first time one of them grew a clamp — so the definition moved to the
 * package that both hosts already depend on, and this file re-exports it for the callers here that
 * name it.
 */
import type { PanelBinding } from '@driftengine/tools';

export type { PanelBinding } from '@driftengine/tools';
export { bindPanel } from '@driftengine/tools';

export interface EditorAppOptions {
  /**
   * The surface the engine draws into, or null for a host with none.
   *
   * Untyped on purpose: this file never touches it. It is held so a renderer can be attached later
   * without the application learning what a canvas is.
   */
  readonly canvas: unknown;
  readonly textHost: TextHost;
  readonly a11yHost: A11yHost;
  readonly layout?: DockLayout;
  readonly panels?: readonly PanelBinding[];
  readonly undoLimit?: number;
}

export interface EditorApp {
  /** The tree the whole interface is in. One absolutely placed child per docked panel. */
  readonly root: UiNode;
  readonly undo: UndoStack;
  readonly layout: DockLayout;
  /** How many times the tree has been rebuilt and laid out. Read by tests, and by nothing else. */
  readonly layoutCount: number;
  /** The last time `frame` was given. What a panel that animates would read. */
  readonly time: number;
  /** Which panel keys go to: the last one a press landed in. */
  readonly focused: string | null;
  /**
   * Where each docked panel came out, for the frame just laid out.
   *
   * **Read rather than recomputed**, because a consumer that called `dockSites` itself would be
   * computing the same geometry from the same tree at the same size and would still be able to
   * disagree — the way a hit test given its own transform can disagree with the draw that used
   * another. One array, written once per layout.
   */
  sites(): readonly DockSite[];
  frame(now: number): void;
  resize(width: number, height: number): void;
  /** Deliver one event. True where a panel or the application itself took it. */
  route(event: UiEvent): boolean;
  /** Say the world changed, so the next frame rebuilds. */
  invalidate(): void;
  dispose(): void;
}

export function createEditorApp(options: EditorAppOptions): EditorApp {
  const root = createUiNode({ name: 'editor', width: 'grow', height: 'grow' });
  const layout = options.layout ?? createDockLayout(null);
  const undo = createUndoStack(options.undoLimit ?? 200);

  const panels = new Map<string, PanelBinding>();
  for (const binding of options.panels ?? []) panels.set(binding.id, binding);
  const roots = new Map<string, UiNode>();

  const sites: DockSite[] = [];
  const a11y: A11yNode[] = [];

  let width = 0;
  let height = 0;
  /* True at construction, so the first frame builds without anybody having to resize first. */
  let dirty = true;
  let published = false;
  let disposed = false;
  let layoutCount = 0;
  let time = 0;
  let focused: string | null = null;

  const relayout = (): void => {
    dockSites(layout, width, height, sites);
    root.children.length = 0;
    for (const site of sites) {
      const binding = panels.get(site.id);
      /*
       * A site whose panel is not registered still gets a root, and the root stays empty. A saved
       * layout outlives the panel set — `deserialiseDock` says so — so a layout naming a panel this
       * build does not have must leave a hole rather than shifting everything else along.
       */
      let panelRoot = roots.get(site.id);
      if (panelRoot === undefined) {
        panelRoot = createPanelRoot({ id: site.id });
        roots.set(site.id, panelRoot);
      }
      panelRoot.absolute = true;
      panelRoot.x = site.x;
      panelRoot.y = site.y;
      panelRoot.width = site.w;
      panelRoot.height = site.h;
      if (binding !== undefined) binding.build(panelRoot);
      addUiChild(root, panelRoot);
    }
    layoutUiTree(root, 0, 0, width, height);
    layoutCount += 1;
    dirty = false;
    published = false;
  };

  return {
    root,
    undo,
    layout,
    get layoutCount(): number {
      return layoutCount;
    },
    get time(): number {
      return time;
    },
    get focused(): string | null {
      return focused;
    },

    sites(): readonly DockSite[] {
      if (dirty) relayout();
      return sites;
    },

    frame(now: number): void {
      if (disposed) return;
      time = now;
      if (dirty) relayout();
      if (published) return;
      /* Published once per change rather than once per frame: see the header. */
      const count = a11yTree(root, a11y);
      options.a11yHost.publish(a11y, count);
      published = true;
    },

    resize(next: number, nextHeight: number): void {
      if (disposed) return;
      if (next === width && nextHeight === height) return;
      width = next;
      height = nextHeight;
      relayout();
    },

    /*
     * No `disposed` guard here, deliberately, and it had one. `dispose` empties the sites, the
     * focus and the undo stack, so every path through this already returns false afterwards — and
     * a perturbation that deleted the guard failed nothing, because nothing could tell. A second
     * check asserting what the first already guarantees is a line that will be maintained forever
     * and can never be wrong. `frame` and `resize` keep theirs: those two would otherwise rebuild
     * a layout the application still holds, which is a difference a test can see.
     */
    route(event: UiEvent): boolean {
      if (event.kind === 'key') {
        /*
         * Undo and redo are the application's, not a panel's, because the stack is. A panel that
         * owned the shortcut would own a different stack per panel, and undo would mean "take back
         * the last thing I did *here*" — which is not what anybody means by undo.
         */
        if (event.ctrl && event.key === 'z') {
          const moved = event.shift ? undo.redo() : undo.undo();
          if (moved) dirty = true;
          return moved;
        }
        if (event.ctrl && event.key === 'y') {
          const moved = undo.redo();
          if (moved) dirty = true;
          return moved;
        }
        const target = focused === null ? undefined : panels.get(focused);
        return target === undefined ? false : take(target.route(event));
      }

      const site = siteAt(sites, event.x, event.y);
      if (site === null) return false;
      if (event.kind === 'pointer' && event.phase === 'down') focused = site.id;
      const binding = panels.get(site.id);
      if (binding === undefined) return false;
      /* In the panel's own space: a panel never learns where on screen it is, so moving it to
         another dock changes nothing about how it behaves. */
      return take(binding.route(shift(event, -site.x, -site.y)));
    },

    invalidate(): void {
      dirty = true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      /* The host is told the field is gone. A composition window left open over a disposed editor
         is the one piece of state a host cannot work out for itself. */
      options.textHost.blurField();
      undo.clear();
      root.children.length = 0;
      roots.clear();
      sites.length = 0;
      focused = null;
    },
  };

  function take(command: Command | null): boolean {
    if (command === null) return false;
    undo.push(command);
    dirty = true;
    return true;
  }
}

/** The same event moved by a vector. Returns the event itself where there is nothing to move. */
function shift(event: UiEvent, dx: number, dy: number): UiEvent {
  if (event.kind === 'pointer') {
    return { ...event, x: event.x + dx, y: event.y + dy };
  }
  if (event.kind === 'wheel') {
    return { ...event, x: event.x + dx, y: event.y + dy };
  }
  return event;
}
