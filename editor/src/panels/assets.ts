/**
 * The project's assets, grouped, filtered, and draggable into the viewport.
 *
 * **The index is supplied and never discovered.** The editor does not walk a filesystem; the host
 * does, and hands the result here — which is what lets this panel be tested with four objects and
 * no disk, and what lets the same panel serve a browser build with no filesystem at all.
 *
 * **A material that will not decode shows a placeholder rather than an empty box.** An empty box is
 * indistinguishable from a material that is genuinely black, so a broken asset would sit in the
 * browser looking like a design decision — and the reason it failed is carried beside it, because
 * "this one is broken" is the start of the question and not the end of it.
 *
 * **A filter pulls the scroll back inside what is left.** Typing one more letter turns a thousand
 * results into three, and a view still scrolled to row eight hundred shows an empty panel, which
 * reads as "no matches" when there were three.
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import { visibleRange } from '@driftengine/ui2d';
import { decodeCpu, validateDecodeGraph } from '@driftengine/texture';
import type { DecodeGraph, DecodeResources } from '@driftengine/texture';
import { type Command, createPanelRoot, emptyPanel, type Panel } from '@driftengine/tools';

export type AssetKind = 'model' | 'material' | 'texture' | 'audio' | 'script' | 'scene';

export interface AssetEntry {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly bytes: number;
}

/** What the host hands in. An array, because the host already has one and this only reads it. */
export interface AssetIndex {
  readonly entries: readonly AssetEntry[];
}

/**
 * The order kinds appear in, which is deliberate rather than alphabetical.
 *
 * What somebody opens a browser looking for is usually what they are placing, so the things that
 * go in a scene come first. A kind not on this list sorts after everything on it, by name, so an
 * index carrying something this file has never heard of still appears.
 */
const KIND_ORDER: readonly string[] = ['scene', 'model', 'material', 'texture', 'audio', 'script'];

export interface AssetGroup {
  readonly kind: string;
  readonly entries: AssetEntry[];
}

export function groupByKind(entries: readonly AssetEntry[]): AssetGroup[] {
  const byKind = new Map<string, AssetEntry[]>();
  for (const entry of entries) {
    const list = byKind.get(entry.kind);
    if (list === undefined) byKind.set(entry.kind, [entry]);
    else list.push(entry);
  }
  const rank = (kind: string): number => {
    const at = KIND_ORDER.indexOf(kind);
    return at < 0 ? KIND_ORDER.length : at;
  };
  return [...byKind.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([kind, list]) => ({
      kind,
      entries: list.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export function filteredAssets(entries: readonly AssetEntry[], text: string): AssetEntry[] {
  if (text === '') return [...entries];
  const needle = text.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/** How wide a material preview is decoded, in texels. Small: this runs on the main thread. */
export const PREVIEW_SIZE = 16;

export interface MaterialSource {
  readonly graph: DecodeGraph;
  readonly resources: DecodeResources;
}

export interface Preview {
  readonly ok: boolean;
  /** Why not, where `ok` is false. Empty otherwise. */
  readonly reason: string;
  /** `PREVIEW_SIZE * PREVIEW_SIZE * 4`, whether it decoded or not. */
  readonly texels: Float32Array;
}

/** The placeholder: a diagonal so it reads as "not an image" rather than as a dark material. */
function placeholder(reason: string): Preview {
  const texels = new Float32Array(PREVIEW_SIZE * PREVIEW_SIZE * 4);
  for (let y = 0; y < PREVIEW_SIZE; y += 1) {
    for (let x = 0; x < PREVIEW_SIZE; x += 1) {
      const on = x === y || x === PREVIEW_SIZE - 1 - y;
      const at = (y * PREVIEW_SIZE + x) * 4;
      texels[at] = on ? 1 : 0.15;
      texels[at + 1] = on ? 0.2 : 0.15;
      texels[at + 2] = on ? 0.2 : 0.15;
      texels[at + 3] = 1;
    }
  }
  return { ok: false, reason, texels };
}

/**
 * Decode a material to a small square, on the CPU, through `@driftengine/texture`.
 *
 * **Validated before it is run**, because `decodeCpu` is an interpreter over registers and a graph
 * that reads one nothing wrote produces silence rather than an error. `validateDecodeGraph` already
 * says exactly what is wrong, and that sentence is what the browser shows.
 */
export function decodePreview(material: MaterialSource | null, registers: Float32Array): Preview {
  if (material === null) return placeholder('no decode graph for this material');
  const complaint = validateDecodeGraph(material.graph);
  if (complaint !== null) return placeholder(complaint);

  const texels = new Float32Array(PREVIEW_SIZE * PREVIEW_SIZE * 4);
  const out = new Float32Array(4);
  for (let y = 0; y < PREVIEW_SIZE; y += 1) {
    for (let x = 0; x < PREVIEW_SIZE; x += 1) {
      decodeCpu(
        material.graph,
        material.resources,
        (x + 0.5) / PREVIEW_SIZE,
        (y + 0.5) / PREVIEW_SIZE,
        0,
        out,
        registers,
      );
      texels.set(out, (y * PREVIEW_SIZE + x) * 4);
    }
  }
  return { ok: true, reason: '', texels };
}

/**
 * What a drag carries.
 *
 * A string, because `beginDrag` in `@driftengine/ui2d` takes one and calls it opaque — the viewport
 * parses it, and this file and that one agree on the spelling rather than on a type.
 */
export function dragPayloadFor(entry: AssetEntry): string {
  return `asset:${entry.kind}:${entry.id}`;
}

/** A heading or an asset. Headings are rows too, so scrolling and hit testing need no special case. */
export interface AssetRow {
  readonly heading: boolean;
  readonly text: string;
  readonly entry: AssetEntry | null;
}

export interface AssetsWorld {
  readonly index: AssetIndex;
}

export interface AssetsView {
  readonly root: UiNode;
  filter: string;
  rowHeight: number;
  viewHeight: number;
  overscan: number;
  scrollY: number;
  /** What the last build laid out, headings included. */
  rows: AssetRow[];
  /** Which slice of `rows` has nodes right now. */
  window: { first: number; count: number };
  /** The payload of a drag in progress, or empty. */
  dragging: string;
}

export function createAssetView(options: {
  rowHeight?: number;
  viewHeight?: number;
  overscan?: number;
}): AssetsView {
  return {
    root: createPanelRoot(assetsPanel),
    filter: '',
    rowHeight: options.rowHeight ?? 16,
    viewHeight: options.viewHeight ?? 320,
    overscan: options.overscan ?? 2,
    scrollY: 0,
    rows: [],
    window: { first: 0, count: 0 },
    dragging: '',
  };
}

function buildRows(entries: readonly AssetEntry[]): AssetRow[] {
  const rows: AssetRow[] = [];
  for (const group of groupByKind(entries)) {
    rows.push({ heading: true, text: group.kind, entry: null });
    for (const entry of group.entries) {
      rows.push({ heading: false, text: entry.name, entry });
    }
  }
  return rows;
}

export const assetsPanel: Panel<AssetsWorld, AssetsView> = {
  id: 'assets',
  title: 'Assets',

  build(world, view, root): void {
    const matching = filteredAssets(world.index.entries, view.filter);
    view.rows = buildRows(matching);

    if (view.rows.length === 0) {
      view.scrollY = 0;
      view.window = { first: 0, count: 0 };
      emptyPanel(
        root,
        world.index.entries.length === 0 ? 'No assets in this project' : 'No assets match',
      );
      return;
    }

    /* Before the window is computed, or a filter leaves the view past the end of what is left. */
    const limit = Math.max(0, view.rows.length * view.rowHeight - view.viewHeight);
    view.scrollY = Math.min(limit, Math.max(0, view.scrollY));

    const window = visibleRange(
      view.scrollY,
      view.viewHeight,
      view.rowHeight,
      view.rows.length,
      view.overscan,
    );
    view.window = window;
    const children = root.children;
    while (children.length < window.count) {
      const node = createUiNode({ width: 'grow', height: view.rowHeight, interactive: true });
      addUiChild(root, node);
    }
    children.length = window.count;
    for (let at = 0; at < window.count; at += 1) {
      const row = view.rows[window.first + at] as AssetRow;
      const node = children[at] as UiNode;
      node.height = view.rowHeight;
      node.text = row.text;
      node.interactive = !row.heading;
      node.name = row.entry === null ? `kind:${row.text}` : `asset:${row.entry.id}`;
    }
  },

  route(_world, view, event): Command | null {
    if (event.kind !== 'pointer' || event.button !== 0) return null;
    if (event.phase === 'up') {
      view.dragging = '';
      return null;
    }
    if (event.phase !== 'down') return null;

    const at = Math.floor((event.y + view.scrollY) / view.rowHeight);
    const row = view.rows[at];
    view.dragging = row === undefined || row.entry === null ? '' : dragPayloadFor(row.entry);
    /* Dropping is the viewport's business, and what a drop means is the viewport's command. */
    return null;
  },
};
