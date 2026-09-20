/**
 * The panels, on a key, over a running game.
 *
 * **The panels shipped without anything to mount them, and that was the gap.** `@driftengine/tools`
 * exported an inspector, a console, a profiler and a network panel, each of which builds a `UiNode`
 * tree and nothing more. What turned a tree into something a person could see lived in the editor
 * application — a dock, a layout, a painter and the event routing — and that workspace is private
 * and ships to nobody. So every consumer wanting an in-game inspector had to write that half again,
 * and six of them writing it six times is the drift `AGENTS.md` opens by describing.
 *
 * **A column, not a dock.** The editor's dock splits, drags and persists because somebody arranges
 * an editor and then keeps that arrangement. Nobody arranges a debug overlay: they press a key,
 * read a number and press it again. So the panels stack down one edge in the order they were
 * given, and what a dock would have bought is not bought.
 *
 * **The painter is supplied, never reached for.** Four calls — a rectangle, a line of text, a clip
 * and its close — which is every operation `paintOverlay` makes. A host with a 2D context
 * implements them in four lines, a host drawing through `@driftengine/ui2d`'s sprite pass
 * implements them over a batch, and a host with no screen at all implements them into an array,
 * which is what this module's own tests do. That is `AGENTS.md`'s platform rule applied to
 * drawing: take the capability as a parameter, and let the consumer decide what it is.
 *
 * **Nothing here needs a graphics device**, which is the property that makes the whole of it
 * testable. The geometry is arithmetic over a tree, the routing is arithmetic over rectangles, and
 * the drawing is somebody else's four functions. An overlay that could only run against a live
 * adapter is an overlay whose behaviour nobody can assert.
 *
 * **Hidden costs a frame nothing.** While it is closed, `frame` returns before it builds anything
 * and `route` refuses every event but the one that opens it, so a game that never presses the key
 * pays for a boolean.
 */
import { createUiNode, layoutUiTree } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import { createUndoStack, type Command, type UndoStack } from './command.ts';
import { createPanelRoot, type Panel, type UiEvent } from './panel.ts';

/**
 * A panel with its world and its view already attached.
 *
 * **The generics are closed here rather than carried by the host.** `Panel<W, V>` is two type
 * parameters per panel, and a host holding several at once cannot express them in one list without
 * erasing to `unknown` and casting on the way out. Binding closes them where both types are known
 * and hands back something with no parameters at all, so the host never casts and the panel keeps
 * the signature that makes its own rules checkable.
 */
export interface PanelBinding {
  readonly id: string;
  readonly title: string;
  build(root: UiNode): void;
  route(event: UiEvent): Command | null;
}

export function bindPanel<W, V>(
  panel: Panel<W, V>,
  world: () => Readonly<W>,
  view: V,
): PanelBinding {
  return {
    id: panel.id,
    title: panel.title,
    build: (root: UiNode): void => panel.build(world(), view, root),
    route: (event: UiEvent): Command | null => panel.route(world(), view, event),
  };
}

/** Where one panel came out. Read rather than recomputed, so a hit test cannot disagree with a draw. */
export interface OverlaySite {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What a host draws with. Colours are CSS, `#rrggbb` or `#rrggbbaa`. */
export interface OverlayPainter {
  rect(x: number, y: number, w: number, h: number, colour: string): void;
  /** Text on a baseline at `y`, twelve pixels tall. */
  text(content: string, x: number, y: number, colour: string): void;
  clip(x: number, y: number, w: number, h: number): void;
  unclip(): void;
}

export interface ToolsOverlayOptions {
  readonly panels: readonly PanelBinding[];
  /** `KeyboardEvent.key` of the key that opens and closes it. Defaults to `F3`. */
  readonly key?: string;
  readonly side?: 'left' | 'right';
  readonly width?: number;
  readonly undoLimit?: number;
  readonly visible?: boolean;
}

export interface ToolsOverlay {
  /** The tree the whole overlay is in. One absolutely placed child per panel. */
  readonly root: UiNode;
  readonly undo: UndoStack;
  readonly visible: boolean;
  /** How many times the tree has been rebuilt and laid out. Read by tests, and by nothing else. */
  readonly layoutCount: number;
  sites(): readonly OverlaySite[];
  setVisible(visible: boolean): void;
  toggle(): void;
  resize(width: number, height: number): void;
  frame(now: number): void;
  /** Deliver one event. True where the overlay took it, so a host knows not to pass it on. */
  route(event: UiEvent): boolean;
  /** Say the world changed, so the next frame rebuilds. A profiler calls this every frame. */
  invalidate(): void;
  dispose(): void;
}

const DEFAULT_WIDTH = 320;
const DEFAULT_KEY = 'F3';

export function createToolsOverlay(options: ToolsOverlayOptions): ToolsOverlay {
  const root = createUiNode({ name: 'tools-overlay', width: 'grow', height: 'grow' });
  const undo = createUndoStack(options.undoLimit ?? 100);
  const key = options.key ?? DEFAULT_KEY;
  const side = options.side ?? 'right';
  const columnWidth = options.width ?? DEFAULT_WIDTH;

  const panels = options.panels;
  const roots = new Map<string, UiNode>();
  /* Pooled and refilled: this is read every frame the overlay is open and must not allocate. */
  const sites: OverlaySite[] = [];

  let width = 0;
  let height = 0;
  let visible = options.visible ?? false;
  let dirty = true;
  let disposed = false;
  let layoutCount = 0;
  let focused: string | null = null;

  const relayout = (): void => {
    const x = side === 'left' ? 0 : Math.max(0, width - columnWidth);
    const w = Math.min(columnWidth, width);
    const each = panels.length === 0 ? 0 : Math.floor(height / panels.length);

    root.absolute = true;
    root.x = x;
    root.y = 0;
    root.width = w;
    root.height = height;
    root.children.length = 0;
    sites.length = 0;

    for (let at = 0; at < panels.length; at += 1) {
      const panel = panels[at];
      if (panel === undefined) continue;
      /* The last panel takes the remainder, so a height that does not divide leaves no gap. */
      const top = each * at;
      const tall = at === panels.length - 1 ? height - top : each;

      let panelRoot = roots.get(panel.id);
      if (panelRoot === undefined) {
        panelRoot = createPanelRoot(panel);
        roots.set(panel.id, panelRoot);
      }
      panelRoot.absolute = true;
      panelRoot.x = 0;
      panelRoot.y = top;
      panelRoot.width = w;
      panelRoot.height = tall;
      panel.build(panelRoot);
      root.children.push(panelRoot);
      sites.push({ id: panel.id, x: 0, y: top, w, h: tall });
    }

    layoutUiTree(root, x, 0, w, height);
    layoutCount += 1;
    dirty = false;
  };

  return {
    root,
    undo,
    get visible(): boolean {
      return visible;
    },
    get layoutCount(): number {
      return layoutCount;
    },

    sites(): readonly OverlaySite[] {
      if (visible && dirty) relayout();
      return sites;
    },

    setVisible(next: boolean): void {
      if (disposed || next === visible) return;
      visible = next;
      dirty = true;
    },

    toggle(): void {
      this.setVisible(!visible);
    },

    resize(next: number, nextHeight: number): void {
      if (disposed) return;
      if (next === width && nextHeight === height) return;
      width = next;
      height = nextHeight;
      dirty = true;
    },

    frame(_now: number): void {
      if (disposed || !visible) return;
      if (dirty) relayout();
    },

    route(event: UiEvent): boolean {
      if (disposed) return false;
      /*
       * The key is answered whether the overlay is open or closed, and it is the only thing that
       * is. A host that had to know which state it was in to decide whether to forward a press
       * would be holding the same boolean twice.
       */
      if (event.kind === 'key' && event.key === key && !event.ctrl) {
        visible = !visible;
        dirty = true;
        return true;
      }
      if (!visible) return false;

      if (event.kind === 'key') {
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
        const target = panelWith(focused);
        return target === null ? false : take(target.route(event));
      }

      if (dirty) relayout();
      const site = siteAt(event.x, event.y);
      if (site === null) return false;
      if (event.kind === 'pointer' && event.phase === 'down') focused = site.id;
      const panel = panelWith(site.id);
      if (panel === null) return false;
      /* In the panel's own space: a panel never learns where on screen it is. */
      return take(panel.route(shift(event, -(root.rect.x + site.x), -site.y)));
    },

    invalidate(): void {
      dirty = true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      visible = false;
      undo.clear();
      root.children.length = 0;
      roots.clear();
      sites.length = 0;
      focused = null;
    },
  };

  function panelWith(id: string | null): PanelBinding | null {
    if (id === null) return null;
    for (const panel of panels) if (panel.id === id) return panel;
    return null;
  }

  function siteAt(x: number, y: number): OverlaySite | null {
    const localX = x - root.rect.x;
    if (localX < 0 || localX >= root.rect.w) return null;
    for (const site of sites) {
      if (y >= site.y && y < site.y + site.h) return site;
    }
    return null;
  }

  /*
   * **`push` applies, so this must not.** `createUndoStack.push` calls `apply` on the way in — and
   * on the merge path it says in so many words that an absorbed command has already been applied
   * and must not be applied again. Applying here as well ran every panel edit twice, which the
   * row panel's test saw as two rows added by one press and a real inspector would have shown as a
   * field moved twice as far as the pointer.
   */
  function take(command: Command | null): boolean {
    if (command === null) return false;
    undo.push(command);
    dirty = true;
    return true;
  }
}

/** The same event moved by a vector. Returns the event itself where there is nothing to move. */
function shift(event: UiEvent, dx: number, dy: number): UiEvent {
  if (event.kind === 'pointer' || event.kind === 'wheel') {
    return { ...event, x: event.x + dx, y: event.y + dy };
  }
  return event;
}

/**
 * Draw the overlay, or draw nothing because it is closed.
 *
 * A free function rather than a method, so the overlay itself never holds a painter and a host may
 * draw the same overlay into two surfaces — a screen and a capture — without either knowing.
 */
export function paintOverlay(painter: OverlayPainter, overlay: ToolsOverlay): void {
  if (!overlay.visible) return;
  paintNode(painter, overlay.root);
}

/** Where a twelve-pixel line sits inside a row. Rows here are sixteen to eighteen pixels tall. */
const TEXT_BASELINE = 12;

function paintNode(painter: OverlayPainter, node: UiNode): void {
  if (node.hidden) return;
  const { x, y, w, h } = node.rect;
  if (node.background !== null) painter.rect(x, y, w, h, cssColour(node.background));
  if (node.text.length > 0) {
    painter.text(node.text, x, y + TEXT_BASELINE, cssColour(node.tint));
  }
  if (node.children.length === 0) return;
  if (node.clip) painter.clip(x, y, w, h);
  for (const child of node.children) paintNode(painter, child);
  if (node.clip) painter.unclip();
}

function cssColour(rgba: Float32Array | null): string {
  if (rgba === null) return '#ffffff';
  let out = '#';
  for (let at = 0; at < 3; at += 1) {
    const channel = Math.round(Math.min(1, Math.max(0, rgba[at] ?? 0)) * 255);
    out += channel.toString(16).padStart(2, '0');
  }
  return out;
}
