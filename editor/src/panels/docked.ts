/**
 * Which panels the editor docks, where each opens, and what each is bound to.
 *
 * **The panels existed for days before anything docked them, and that is the shape of drift this
 * file exists to end.** Every panel here was written, tested and left in a directory: a scene tree
 * that reparents, an inspector driven by a schema, an asset browser, a profiler, a console, a
 * script view and three graph panels. None of them was in the product, so none of them could be
 * wrong in a way anybody would notice — which is exactly what a closed plan looks like when the
 * assembly is the step that was left out.
 *
 * **A region shows one panel at a time.** `dock/layout.ts` has splits and leaves and no tabs, so
 * an arrangement with seven panels visible would be seven slivers. The honest arrangement is three
 * regions, each opening on one panel and able to show any of the others — which is what `View`
 * and the palette are for. Tabs are a rough edge, written down in `editor/README.md` rather than
 * remembered.
 *
 * **The title strip belongs to the binding, not to the panel and not to the dock.** A panel is
 * handed the site less the strip, and a pointer event is moved by the same amount before the panel
 * sees it — one number, used by both, which is the rule the picker had to learn the hard way. A
 * panel that measured its own header would be a second place for the two to disagree.
 *
 * **Bound means bound to what the editor is holding**, not to a fixture. The inspector reads the
 * transforms of the scene the viewport draws, the tree reads the hierarchy that scene came from,
 * the console reads the log the commands write to, and the profiler reads the frame history the
 * host pushes. A panel wired to nothing builds the same empty tree forever and is indistinguishable
 * from one that works.
 */
import { addUiChild, createTextModel, createUiNode, type UiNode } from '@driftengine/ui2d';
import {
  consolePanel,
  createConsoleView,
  createFrameHistory,
  createInspectorView,
  createNetworkView,
  createProfilerView,
  inspectorPanel,
  networkPanel,
  profilerPanel,
  type Command,
  type FrameHistory,
  type InspectableWorld,
  type LogRing,
  type NetworkReadout,
  type Panel,
  type Selection,
  type UiEvent,
} from '@driftengine/tools';
import type { PassTimings } from '@driftengine/core';

import { assetsPanel, createAssetView, type AssetIndex } from './assets.ts';
import { capturePanel, createCaptureView, type CaptureModel } from './capture.ts';
import { createGraphPanel, createGraphPanelView, type GraphWorld } from './graph.ts';
import { createScriptView, scriptPanel } from './script.ts';
import {
  createSceneModel,
  createSceneTreeView,
  sceneTreePanel,
  type SceneModel,
} from './sceneTree.ts';

/** The regions the editor arranges, in the order `PANEL_IDS` names their sites. */
export const panelRegions = ['left', 'right', 'bottom'] as const;
export type DockRegion = (typeof panelRegions)[number];

/**
 * How tall the strip carrying a panel's own title is.
 *
 * **One number for the drawing and the hit test.** It was two — `frontEnd.ts` drew the title at a
 * height it worked out locally and the capture panel's click subtracted a constant of its own — and
 * a pair like that is right until somebody changes one of them.
 */
export const PANEL_TITLE_HEIGHT = 20;

/** How far a panel's rows and its title are inset from its left edge. */
export const PANEL_INSET = 6;

/** A panel with its world, its view and its region already attached. */
export interface DockedPanel {
  readonly id: string;
  readonly title: string;
  /** Where it opens. Any region can be made to show it; this is the one it starts in. */
  readonly region: DockRegion;
  build(root: UiNode): void;
  route(event: UiEvent): Command | null;
}

/**
 * Close a panel's two type parameters over the state it is bound to.
 *
 * **The generics close here and not in the application**, for the reason `bindPanel` gives: seven
 * panels are seven pairs of types, which no single list can express without erasing to `unknown`
 * and casting on the way out.
 */
export function dockPanel<W, V>(
  panel: Panel<W, V>,
  region: DockRegion,
  world: () => Readonly<W>,
  view: V,
): DockedPanel {
  /*
   * The panel's own node, made once. **Not the root moved down**: the application re-assigns the
   * root's rectangle before every build, so a root that shifted itself would be right on the first
   * frame and a strip lower on each one after.
   */
  const content = createUiNode({
    direction: 'column',
    absolute: true,
    x: 0,
    y: PANEL_TITLE_HEIGHT,
    clip: true,
    name: `dock:${panel.id}`,
  });
  /* A row flush against the panel's edge reads as text that has overflowed rather than as a list.
     The left side only, and set here because `padding` in the options is all four at once. */
  content.paddingLeft = PANEL_INSET;

  return {
    id: panel.id,
    title: panel.title,
    region,

    build(root: UiNode): void {
      const height = typeof root.height === 'number' ? root.height : 0;
      content.width = typeof root.width === 'number' ? root.width : 'grow';
      /* Never negative: a region shorter than its own title gives the panel nothing, and a
         negative height lays out as a rectangle that reaches back up over the strip. */
      content.height = Math.max(0, height - PANEL_TITLE_HEIGHT);
      if (root.children[0] !== content) {
        root.children.length = 0;
        addUiChild(root, content);
      }
      panel.build(world(), view, content);
    },

    route(event: UiEvent): Command | null {
      return panel.route(world(), view, shiftUp(event));
    },
  };
}

/** The same event moved up by the title strip. Keys carry no position and pass through. */
function shiftUp(event: UiEvent): UiEvent {
  if (event.kind === 'pointer' || event.kind === 'wheel') {
    return { ...event, y: event.y - PANEL_TITLE_HEIGHT };
  }
  return event;
}

/** What the inspector reads and the tree walks: whatever the viewport is drawing. */
export interface TransformWorld {
  entities(): readonly number[];
  positionOf(entity: number, out: Float32Array): boolean;
  setPosition(entity: number, x: number, y: number, z: number): void;
}

export interface EditorPanelOptions {
  /** Held by reference: the tree, the inspector and the viewport are looking at one selection. */
  readonly selection: Selection;
  readonly scene: TransformWorld;
  /** The hierarchy, read fresh each build — the host replaces it when it opens something. */
  readonly sceneModel?: () => SceneModel;
  readonly capture?: CaptureModel;
  readonly assets?: AssetIndex;
  readonly log?: LogRing;
  readonly timings?: PassTimings;
  readonly frames?: FrameHistory;
  readonly network?: () => NetworkReadout | null;
  /** A graph per kind, where the host has one. A kind with none is not docked. */
  readonly graphs?: readonly GraphWorld[];
  /** What the script panel opens on. Empty where the host has nothing. */
  readonly source?: string;
}

const GRAPH_TITLES: Readonly<Record<GraphWorld['kind'], string>> = {
  material: 'Material graph',
  particle: 'Particle graph',
  behaviour: 'Behaviour graph',
};

/**
 * The editor's own panel set, in the order each region opens.
 *
 * **The first panel declared for a region is what that region opens with**, so a capture takes the
 * left dock when there is one and the scene tree takes it when there is not. That ordering is the
 * whole of the default arrangement, which is why it is one list rather than a layout constant and
 * a set of bindings that have to agree with it.
 */
export function editorPanels(options: EditorPanelOptions): DockedPanel[] {
  const panels: DockedPanel[] = [];
  const emptyModel = createSceneModel();
  const model = options.sceneModel ?? ((): SceneModel => emptyModel);

  if (options.capture !== undefined) {
    const capture = options.capture;
    panels.push(dockPanel(capturePanel, 'left', () => capture, createCaptureView()));
  }

  panels.push(
    dockPanel(
      sceneTreePanel,
      'left',
      () => ({ model: model() }),
      createSceneTreeView({ selection: options.selection }),
    ),
  );

  const inspectable = transformInspector(options.scene);
  panels.push(
    dockPanel(
      inspectorPanel,
      'right',
      () => ({ world: inspectable }),
      createInspectorView({ selection: options.selection }),
    ),
  );

  const timings = options.timings ?? {
    ms: new Float64Array(0),
    measured: new Uint8Array(0),
    labels: [],
  };
  const frames = options.frames ?? createFrameHistory(120);
  panels.push(
    dockPanel(
      profilerPanel,
      'right',
      () => ({ timings, history: frames, residency: null }),
      createProfilerView({}),
    ),
  );

  const network = options.network ?? ((): NetworkReadout | null => null);
  panels.push(
    dockPanel(networkPanel, 'right', () => ({ session: network() }), createNetworkView({})),
  );

  const assets = options.assets ?? { entries: [] };
  panels.push(dockPanel(assetsPanel, 'bottom', () => ({ index: assets }), createAssetView({})));

  if (options.log !== undefined) {
    const log = options.log;
    panels.push(dockPanel(consolePanel, 'bottom', () => ({ log }), createConsoleView({})));
  }

  panels.push(
    dockPanel(
      scriptPanel,
      'bottom',
      () => ({}),
      createScriptView(createTextModel(options.source ?? ''), null),
    ),
  );

  for (const graph of options.graphs ?? []) {
    panels.push(
      dockPanel(
        createGraphPanel(`${graph.kind}-graph`, GRAPH_TITLES[graph.kind]),
        'bottom',
        () => graph,
        createGraphPanelView(),
      ),
    );
  }

  return panels;
}

/**
 * The scene's transforms as something the inspector can read.
 *
 * **One component, because one is what this seam can honestly offer.** `ShellScene` is five
 * methods and a position is the only field any of them can change; a name is shown by the tree and
 * cannot be written back through the seam, so putting it here would be a row somebody edits and
 * watches do nothing. Adding and removing refuse rather than returning quietly, because a scene
 * that has a transform for every entity has no way to be handed another one.
 */
export function transformInspector(scene: TransformWorld): InspectableWorld {
  const at = new Float32Array(3);
  const axes = 'xyz';
  const present = (entity: number): boolean => scene.positionOf(entity, at);

  return {
    componentsOf: (entity) => (present(entity) ? ['transform'] : []),
    schemaOf: (component) =>
      component === 'transform'
        ? [
            { name: 'position.x', type: 'f32' },
            { name: 'position.y', type: 'f32' },
            { name: 'position.z', type: 'f32' },
          ]
        : [],
    read(entity, component, field): unknown {
      if (component !== 'transform' || !present(entity)) return undefined;
      const axis = axes.indexOf(field.slice(field.lastIndexOf('.') + 1));
      return axis < 0 ? undefined : at[axis];
    },
    write(entity, component, field, value): void {
      if (component !== 'transform' || typeof value !== 'number' || !present(entity)) return;
      const axis = axes.indexOf(field.slice(field.lastIndexOf('.') + 1));
      if (axis < 0) return;
      at[axis] = value;
      scene.setPosition(entity, at[0] as number, at[1] as number, at[2] as number);
    },
    hasComponent: (entity, component) => component === 'transform' && present(entity),
    addComponent(): void {
      throw new Error('every entity in this scene has a transform, and it has no other component');
    },
    removeComponent(): void {
      throw new Error('a transform is what this scene is made of, and cannot be taken off one');
    },
  };
}
