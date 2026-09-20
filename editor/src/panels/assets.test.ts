import { describe, expect, it } from 'vitest';
import {
  DECODE_OP,
  addDecodeNode,
  createDecodeGraph,
  createDecodeRegisters,
} from '@driftengine/texture';
import { pointerEvent } from '@driftengine/tools';
import {
  PREVIEW_SIZE,
  assetsPanel,
  createAssetView,
  decodePreview,
  dragPayloadFor,
  filteredAssets,
  groupByKind,
  type AssetEntry,
  type AssetIndex,
} from './assets.ts';

/** An index the caller supplies. Nothing in this file walks a filesystem, and nothing can. */
function index(entries: AssetEntry[]): AssetIndex {
  return { entries };
}

const SAMPLE: AssetEntry[] = [
  { id: 'car', kind: 'model', name: 'car.drft', bytes: 40_000_000 },
  { id: 'paint', kind: 'material', name: 'paint.dtex', bytes: 2_048 },
  { id: 'rust', kind: 'material', name: 'rust.dtex', bytes: 4_096 },
  { id: 'engine', kind: 'audio', name: 'engine.ogg', bytes: 900_000 },
];

describe('the asset index', () => {
  it('is supplied rather than discovered', () => {
    const view = createAssetView({});
    assetsPanel.build({ index: index(SAMPLE) }, view, view.root);
    expect(view.rows.length).toBeGreaterThan(0);
  });

  it('groups by kind, kinds in a stable order and names sorted inside one', () => {
    const groups = groupByKind(SAMPLE);
    expect(groups.map((group) => group.kind)).toEqual(['model', 'material', 'audio']);
    expect(groups[1]?.entries.map((entry) => entry.name)).toEqual(['paint.dtex', 'rust.dtex']);
  });

  it('narrows by text, case-insensitively, keeping the grouping', () => {
    expect(filteredAssets(SAMPLE, 'DTEX').map((entry) => entry.id)).toEqual(['paint', 'rust']);
    expect(filteredAssets(SAMPLE, '').length).toBe(4);
  });

  /**
   * **A filter must not leave the view scrolled past the end of what is left.** Typing one more
   * letter turns a thousand results into three, and a view still scrolled to row 800 shows an empty
   * panel — which reads as "no matches" when there were three.
   */
  it('pulls the scroll back inside the shorter list', () => {
    const view = createAssetView({ rowHeight: 10, viewHeight: 40 });
    const many: AssetEntry[] = [];
    for (let at = 0; at < 200; at += 1) {
      many.push({ id: `a${at}`, kind: 'model', name: `thing ${at}.drft`, bytes: 1 });
    }
    assetsPanel.build({ index: index(many) }, view, view.root);
    view.scrollY = 1_500;

    view.filter = 'thing 7.drft';
    assetsPanel.build({ index: index(many) }, view, view.root);
    expect(view.rows.length, 'one group heading and one asset').toBe(2);
    expect(view.scrollY, 'and the view came back to where there is something').toBe(0);
  });

  it('says so when a filter matches nothing', () => {
    const view = createAssetView({});
    view.filter = 'nothing at all';
    assetsPanel.build({ index: index(SAMPLE) }, view, view.root);
    expect(view.root.children[0]?.text).toContain('No assets match');
  });

  it('says so when the project is empty', () => {
    const view = createAssetView({});
    assetsPanel.build({ index: index([]) }, view, view.root);
    expect(view.root.children[0]?.text).toContain('No assets');
  });
});

describe('a material preview', () => {
  /** A one-node graph that samples procedural noise, which needs no latents and no network. */
  function noiseGraph(): ReturnType<typeof createDecodeGraph> {
    const graph = createDecodeGraph(2);
    addDecodeNode(graph, DECODE_OP.PROCEDURAL_FBM, 7, 3, 0);
    graph.result = 0;
    return graph;
  }

  it('decodes through the texture package into a square of texels', () => {
    const preview = decodePreview(
      { graph: noiseGraph(), resources: { latents: [], blocks: [], networks: [] } },
      createDecodeRegisters(),
    );
    expect(preview.ok).toBe(true);
    expect(preview.texels.length).toBe(PREVIEW_SIZE * PREVIEW_SIZE * 4);
    expect(
      preview.texels.some((value) => value !== 0),
      'it decoded something',
    ).toBe(true);
  });

  /**
   * **A material that will not decode shows a placeholder, not an empty box.** An empty box is
   * indistinguishable from a material that is genuinely black, so a broken asset would sit in the
   * browser looking like a design decision.
   */
  it('reports a placeholder rather than an empty square when it cannot decode', () => {
    const broken = createDecodeGraph(2);
    /* Reads register 3, which nothing wrote: `validateDecodeGraph` refuses it. */
    addDecodeNode(broken, DECODE_OP.EVAL_NETWORK, 3, 0, 0);
    broken.result = 0;

    const preview = decodePreview(
      { graph: broken, resources: { latents: [], blocks: [], networks: [] } },
      createDecodeRegisters(),
    );
    expect(preview.ok).toBe(false);
    expect(preview.reason.length, 'and it says why').toBeGreaterThan(0);
    expect(preview.texels.length, 'the placeholder is still a square').toBe(
      PREVIEW_SIZE * PREVIEW_SIZE * 4,
    );
  });

  it('reports a placeholder for a material with no decode graph at all', () => {
    const preview = decodePreview(null, createDecodeRegisters());
    expect(preview.ok).toBe(false);
    expect(preview.reason).toContain('no decode graph');
  });
});

describe('dragging an asset', () => {
  it('produces a payload that names the kind and the asset', () => {
    expect(dragPayloadFor(SAMPLE[0]!)).toBe('asset:model:car');
    expect(dragPayloadFor(SAMPLE[1]!)).toBe('asset:material:paint');
  });

  it('begins a drag on a press over an asset and not over a heading', () => {
    const view = createAssetView({ rowHeight: 10, viewHeight: 200 });
    assetsPanel.build({ index: index(SAMPLE) }, view, view.root);

    /* Row 0 is the 'model' heading; row 1 is car.drft. */
    assetsPanel.route({ index: index(SAMPLE) }, view, pointerEvent('down', 5, 5));
    expect(view.dragging, 'a heading is not draggable').toBe('');

    assetsPanel.route({ index: index(SAMPLE) }, view, pointerEvent('down', 5, 15));
    expect(view.dragging).toBe('asset:model:car');

    assetsPanel.route({ index: index(SAMPLE) }, view, pointerEvent('up', 5, 15));
    expect(view.dragging, 'and letting go ends it').toBe('');
  });

  it('emits no command, because dropping is the viewport’s business', () => {
    const view = createAssetView({ rowHeight: 10, viewHeight: 200 });
    const world = { index: index(SAMPLE) };
    assetsPanel.build(world, view, view.root);
    expect(assetsPanel.route(world, view, pointerEvent('down', 5, 15))).toBe(null);
    expect(assetsPanel.route(world, view, pointerEvent('up', 5, 15))).toBe(null);
  });
});

describe('ten thousand assets', () => {
  function many(): AssetEntry[] {
    const out: AssetEntry[] = [];
    for (let at = 0; at < 10_000; at += 1) {
      out.push({ id: `a${at}`, kind: 'model', name: `thing ${at}.drft`, bytes: 1 });
    }
    return out;
  }

  it('cost a screenful of nodes', () => {
    const view = createAssetView({ rowHeight: 16, viewHeight: 320, overscan: 2 });
    assetsPanel.build({ index: index(many()) }, view, view.root);

    expect(view.rows.length, 'one heading and ten thousand assets').toBe(10_001);
    expect(view.root.children.length).toBeLessThan(30);
  });

  it('builds the window the scroll position asks for', () => {
    const view = createAssetView({ rowHeight: 16, viewHeight: 320, overscan: 2 });
    const world = { index: index(many()) };
    assetsPanel.build(world, view, view.root);

    view.scrollY = 16 * 9_980;
    assetsPanel.build(world, view, view.root);

    /* Two rows of overscan above the first row the scroll reaches. */
    expect(view.window.first).toBe(9_978);
    expect(view.root.children[0]?.text).toBe(view.rows[9_978]?.text);
    expect(view.root.children.length).toBeLessThan(30);
  });

  /**
   * **Names sort as strings, so `thing 9977` is nowhere near row 9977.** Worth pinning because it
   * is the assumption a reader brings and it is wrong: `thing 10.drft` sorts between `thing 1` and
   * `thing 2`. A numeric sort would need the browser to know that a name contains a number, which
   * is a guess about somebody's naming scheme rather than a fact about assets.
   */
  it('sorts names as text, which is not numeric order', () => {
    const view = createAssetView({ rowHeight: 16, viewHeight: 320 });
    assetsPanel.build({ index: index(many()) }, view, view.root);
    const names = view.rows.slice(1, 5).map((row) => row.text);
    expect(names).toEqual(['thing 0.drft', 'thing 1.drft', 'thing 10.drft', 'thing 100.drft']);
  });
});
