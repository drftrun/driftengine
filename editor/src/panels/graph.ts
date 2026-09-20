/**
 * A graph, docked, with what it compiles to shown beside it.
 *
 * **The preview is open by default, and that is the whole point of the panel.** A visual tool that
 * hides what it produces is a tool nobody can debug: the graph says what you drew and the preview
 * says what the engine will actually run, and the gap between the two is where every real problem
 * lives. A behaviour graph shows its generated DriftScript, a material graph shows the decode
 * program it compiled to and the colours that program returns, and a particle graph shows the
 * emitter parameters and what a second of them comes to.
 *
 * **One panel over three vocabularies, because one canvas already is.** What differs between a
 * material, a particle and a behaviour graph is what the preview says, not how a node is dragged —
 * so the kinds differ by one function and share everything else. A second panel would be a second
 * place for panning, hit testing and the undo stack to be got wrong.
 *
 * **What the preview cannot do without a graphics device is stated rather than faked.** The plan
 * asks for a material previewed on a sphere and a particle system in a viewport inset; both need a
 * renderer, and this repository's rule is that an unlooked-at rendering change is unchecked. So the
 * material preview decodes the compiled program on the CPU — the same `decodeCpu` a baked texture
 * goes through — and shows the colours as swatches, and the particle preview runs the real
 * `ParticlePool` for a second and reports what it did. Both are the arithmetic the frame would do,
 * checked; the pixels are Wave 2C Task 9's, with the rest of the browser host.
 */
import { addUiChild, createUiNode, type Theme, type UiNode } from '@driftengine/ui2d';
import { createDecodeRegisters, decodeCpu, type DecodeResources } from '@driftengine/texture';
import { ParticlePool } from '@driftengine/core';
import { type Command, emptyPanel, type Panel, type UiEvent } from '@driftengine/tools';
import type { Graph, Vocabulary } from '../graph/model.ts';
import {
  buildGraphGeometry,
  createGraphGeometry,
  createGraphView,
  drawGraph,
  routeGraphPointer,
  type GraphGeometry,
  type GraphView,
} from '../graph/view.ts';
import { compileMaterialGraph } from '../graph/material/compile.ts';
import { compileParticleGraph, createEmitStream, pumpEmitter } from '../graph/particle/compile.ts';
import { compileBehaviourGraph } from '../graph/behaviour/compile.ts';
import type { BehaviourOptions } from '../graph/behaviour/compile.ts';

export type GraphKind = 'material' | 'particle' | 'behaviour';

export interface GraphWorld {
  readonly kind: GraphKind;
  readonly graph: Graph;
  readonly vocabulary: Vocabulary;
  /** What a behaviour graph needs and the other two do not: a name and the project's own source. */
  readonly behaviour?: BehaviourOptions;
}

export interface GraphPanelView {
  readonly view: GraphView;
  readonly geometry: GraphGeometry;
  /** Which nodes drag together. Held by reference, as the scene tree's selection is. */
  selected: number[];
  /** Open, because a tool that hides what it produces is one nobody can debug. */
  previewOpen: boolean;
  /** How wide the preview is, in the panel's own units. */
  previewWidth: number;
  /** The panel's size, read off its root each build so the split is always against the real one. */
  width: number;
  height: number;
}

export function createGraphPanelView(previewWidth = 240): GraphPanelView {
  return {
    view: createGraphView(),
    geometry: createGraphGeometry(),
    selected: [],
    previewOpen: true,
    previewWidth,
    width: 0,
    height: 0,
  };
}

/** How wide the canvas is: everything the preview is not using. */
export function canvasWidth(view: GraphPanelView): number {
  if (!view.previewOpen) return view.width;
  return Math.max(0, view.width - view.previewWidth);
}

const LINE_HEIGHT = 14;
/** Enough of a long program to be worth reading; the panel is not a text editor. */
const PREVIEW_LINES = 40;

export function createGraphPanel(id: string, title: string): Panel<GraphWorld, GraphPanelView> {
  return {
    id,
    title,

    build(world, view, root): void {
      if (typeof root.width === 'number') view.width = root.width;
      if (typeof root.height === 'number') view.height = root.height;

      root.children.length = 0;
      if (world.graph.nodes.length === 0 && !view.previewOpen) {
        emptyPanel(root, 'this graph is empty — add a node to begin');
        return;
      }

      /*
       * The canvas is absolute at the panel's own origin, so the screen coordinates
       * `buildGraphGeometry` writes are the panel's coordinates and no second offset exists. It
       * clips, because the graph is larger than the panel by design.
       */
      const canvas = createUiNode({
        absolute: true,
        x: 0,
        y: 0,
        width: canvasWidth(view),
        height: view.height,
        clip: true,
        name: 'graph:canvas',
      });
      buildGraphGeometry(world.graph, world.vocabulary, view.view, view.geometry);
      drawGraph(view.geometry, world.graph, canvas, THEME);
      addUiChild(root, canvas);

      if (!view.previewOpen) return;
      const preview = createUiNode({
        absolute: true,
        x: canvasWidth(view),
        y: 0,
        width: view.previewWidth,
        height: view.height,
        direction: 'column',
        clip: true,
        name: 'graph:preview',
      });
      for (const line of previewLines(world)) {
        addUiChild(
          preview,
          createUiNode({
            width: 'grow',
            height: LINE_HEIGHT,
            text: line,
            name: 'graph:line',
          }),
        );
      }
      addUiChild(root, preview);
    },

    route(world, view, event): Command | null {
      if (event.kind === 'key') {
        /* One key, because the preview is the panel's reason for existing and hiding it is the
           only thing anybody will want to do to it. */
        if (event.key === 'p' && !event.ctrl) {
          view.previewOpen = !view.previewOpen;
          return null;
        }
        return null;
      }
      /* Anything over the preview is not the canvas's, and the canvas must not see a coordinate
         from beyond its own right edge — that is how a node is grabbed through a panel. */
      if (event.x >= canvasWidth(view)) return null;
      return routeGraphPointer(
        view.view,
        view.geometry,
        world.graph,
        world.vocabulary,
        event,
        view.selected,
      );
    },
  };
}

/** Enough that a graph is visible against nothing, so a theme is an override rather than a duty. */
const THEME: Theme = { values: {} };

const RESOURCES: DecodeResources = { latents: [], blocks: [], networks: [] };
const DECODED = new Float32Array(4);

/**
 * What the compiled artefact says, as lines.
 *
 * Text rather than a rendered preview, and the first line always says which artefact it is —
 * because the fact a reader most needs about a material graph is the one they least expect, that
 * it compiled to a decode program and not to a shader.
 */
export function previewLines(world: GraphWorld): readonly string[] {
  if (world.kind === 'behaviour') return behaviourLines(world);
  if (world.kind === 'particle') return particleLines(world);
  return materialLines(world);
}

function behaviourLines(world: GraphWorld): readonly string[] {
  const options = world.behaviour ?? { name: 'Behaviour' };
  const { source, error } = compileBehaviourGraph(world.graph, world.vocabulary, options);
  if (error !== null) return ['DriftScript — not yet', error];
  const lines = source.split('\n');
  const head = ['DriftScript source', ''];
  if (lines.length <= PREVIEW_LINES) return [...head, ...lines];
  return [
    ...head,
    ...lines.slice(0, PREVIEW_LINES),
    `… ${String(lines.length - PREVIEW_LINES)} more`,
  ];
}

function materialLines(world: GraphWorld): readonly string[] {
  const { graph, constants, error } = compileMaterialGraph(world.graph);
  if (error !== null) return ['DTEX decode program — not yet', error];
  const registers = createDecodeRegisters();
  const resources: DecodeResources = { ...RESOURCES, constants };
  const lines = [
    'DTEX decode program',
    `${String(graph.count)} operations, result in register ${String(graph.result)}`,
    '',
    'decoded at t = 0',
  ];
  for (let step = 0; step < 4; step += 1) {
    const u = (step + 0.5) / 4;
    decodeCpu(graph, resources, u, 0.5, 0, DECODED, registers);
    lines.push(`  u ${u.toFixed(3)}  ${channels(DECODED)}`);
  }
  return lines;
}

function particleLines(world: GraphWorld): readonly string[] {
  const { emitter, error } = compileParticleGraph(world.graph);
  if (emitter === null) return ['emitter parameters — not yet', error ?? 'nothing compiled'];
  const pool = new ParticlePool(emitter.pool);
  const stream = createEmitStream(emitter.emission.seed);
  /* A second at sixty steps, which is what the first second on screen would be. */
  for (let step = 0; step < 60; step += 1) {
    pumpEmitter(pool, emitter, stream, 1 / 60);
    pool.update(1 / 60);
  }
  return [
    'emitter parameters',
    `rate ${String(emitter.emission.rate)}/s   life ${String(emitter.pool.lifeSec)}s`,
    `capacity ${String(emitter.pool.capacity)}   seed ${String(emitter.emission.seed)}`,
    `size ${String(emitter.pool.sizeStart)} → ${String(emitter.pool.sizeEnd)}`,
    '',
    'after one second',
    `  ${String(pool.live)} alive of ${String(emitter.pool.capacity)}`,
  ];
}

function channels(rgba: Float32Array): string {
  const at = (index: number): string => (rgba[index] ?? 0).toFixed(3);
  return `${at(0)} ${at(1)} ${at(2)} ${at(3)}`;
}
