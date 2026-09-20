/**
 * Where panels sit, as a binary tree of splits with panels at the leaves.
 *
 * **Removing one leaf of a split collapses the split.** Leaving a split with one child produces a
 * divider with nothing on one side of it — draggable, meaningless, and the first thing anybody
 * notices after closing a panel.
 *
 * **A saved layout outlives the panel set.** Deserialising a layout that names a panel which no
 * longer exists drops that panel and keeps the rest, because the alternative is that adding or
 * renaming a panel silently discards everyone's arrangement.
 */
export type DockNode =
  | { kind: 'panel'; id: string }
  | {
      kind: 'split';
      direction: 'row' | 'column';
      /** Fraction of the space the first child takes, 0..1. */
      ratio: number;
      first: DockNode;
      second: DockNode;
    };

export interface DockLayout {
  root: DockNode | null;
}

export function createDockLayout(root: DockNode | null): DockLayout {
  return { root };
}

export type DockSide = 'left' | 'right' | 'top' | 'bottom';

/** Split the leaf holding `panelId`, putting `newPanelId` on `side` of it. */
export function splitPanel(
  layout: DockLayout,
  panelId: string,
  side: DockSide,
  newPanelId: string,
): boolean {
  const replace = (node: DockNode): DockNode | null => {
    if (node.kind === 'panel') {
      if (node.id !== panelId) return null;
      const added: DockNode = { kind: 'panel', id: newPanelId };
      const before = side === 'left' || side === 'top';
      return {
        kind: 'split',
        direction: side === 'left' || side === 'right' ? 'row' : 'column',
        ratio: 0.5,
        first: before ? added : node,
        second: before ? node : added,
      };
    }
    const first = replace(node.first);
    if (first !== null) return { ...node, first };
    const second = replace(node.second);
    if (second !== null) return { ...node, second };
    return null;
  };

  if (layout.root === null) return false;
  const next = replace(layout.root);
  if (next === null) return false;
  layout.root = next;
  return true;
}

/** Remove a panel, collapsing any split it leaves with one child. */
export function removePanel(layout: DockLayout, panelId: string): boolean {
  const strip = (node: DockNode): DockNode | null => {
    if (node.kind === 'panel') return node.id === panelId ? null : node;
    const first = strip(node.first);
    const second = strip(node.second);
    if (first === null && second === null) return null;
    /* One survivor takes the split's place: a one-child split is a divider over nothing. */
    if (first === null) return second;
    if (second === null) return first;
    return { ...node, first, second };
  };

  if (layout.root === null) return false;
  const before = layout.root;
  layout.root = strip(layout.root);
  return layout.root !== before || layout.root === null;
}

export function panelIds(layout: DockLayout, out: string[]): number {
  out.length = 0;
  const walk = (node: DockNode): void => {
    if (node.kind === 'panel') {
      out.push(node.id);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  if (layout.root !== null) walk(layout.root);
  return out.length;
}

/**
 * How thick a divider between two docked panels is, in the units the tree is laid out in.
 *
 * The same six pixels `createSplitter` defaults to, and the same arithmetic: the divider comes out
 * of the extent *before* the ratio divides it. Splitting the whole extent and then drawing a
 * divider over the seam puts three pixels of handle on top of each panel's content, and a panel
 * whose first and last few pixels cannot be clicked is the kind of fault people work around
 * without ever reporting.
 */
export const DOCK_DIVIDER = 6;

/** A panel and the rectangle it was given. */
export interface DockSite {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Give every panel in the tree a rectangle. Returns how many there were.
 *
 * **Geometry is computed here rather than held in the tree**, because a dock layout is saved and a
 * rectangle is not: it depends on the window, which is different every time somebody opens the
 * editor. The tree stores what the arrangement *is* and this says what it comes to at a size.
 *
 * `out` is reused entry by entry, so laying out on every resize allocates nothing after the first.
 */
export function dockSites(
  layout: DockLayout,
  width: number,
  height: number,
  out: DockSite[],
): number {
  let count = 0;
  const put = (id: string, x: number, y: number, w: number, h: number): void => {
    const site = out[count];
    if (site === undefined) out.push({ id, x, y, w, h });
    else {
      site.id = id;
      site.x = x;
      site.y = y;
      site.w = w;
      site.h = h;
    }
    count += 1;
  };

  const walk = (node: DockNode, x: number, y: number, w: number, h: number): void => {
    if (node.kind === 'panel') {
      put(node.id, x, y, w, h);
      return;
    }
    const row = node.direction === 'row';
    const extent = row ? w : h;
    /* Never negative: a window narrower than the divider gives two panes of nothing rather than
       two panes that overlap backwards, which is what a subtraction alone would produce. */
    const panes = Math.max(0, extent - DOCK_DIVIDER);
    const first = panes * node.ratio;
    const second = panes - first;
    if (row) {
      walk(node.first, x, y, first, h);
      walk(node.second, x + first + DOCK_DIVIDER, y, second, h);
    } else {
      walk(node.first, x, y, w, first);
      walk(node.second, x, y + first + DOCK_DIVIDER, w, second);
    }
  };

  if (layout.root !== null) walk(layout.root, 0, 0, width, height);
  out.length = count;
  return count;
}

/** The site holding a point, or null. Sites never overlap, so the first match is the only one. */
export function siteAt(sites: readonly DockSite[], x: number, y: number): DockSite | null {
  for (const site of sites) {
    if (x < site.x || y < site.y) continue;
    if (x >= site.x + site.w || y >= site.y + site.h) continue;
    return site;
  }
  return null;
}

export function serialiseDock(layout: DockLayout): string {
  return JSON.stringify(layout.root);
}

/**
 * Read a layout back, dropping panels that no longer exist.
 *
 * `known` is the panels the application actually has. A layout naming anything else still opens —
 * see the header for why that matters more than it looks.
 */
export function deserialiseDock(text: string, known: ReadonlySet<string>): DockLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return createDockLayout(null);
  }

  const build = (node: unknown): DockNode | null => {
    if (node === null || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;
    if (record.kind === 'panel') {
      const id = typeof record.id === 'string' ? record.id : '';
      return known.has(id) ? { kind: 'panel', id } : null;
    }
    if (record.kind !== 'split') return null;
    const first = build(record.first);
    const second = build(record.second);
    if (first === null && second === null) return null;
    if (first === null) return second;
    if (second === null) return first;
    return {
      kind: 'split',
      direction: record.direction === 'column' ? 'column' : 'row',
      ratio: typeof record.ratio === 'number' ? record.ratio : 0.5,
      first,
      second,
    };
  };

  return createDockLayout(build(parsed));
}
