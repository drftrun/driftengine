/**
 * The browser entry: the one file that turns the editor into something you can open.
 *
 * **Everything browser-shaped is either here or in `host/browser/`, and nothing else is here.**
 * This mounts a canvas, turns the page's keys, pointer and size into the front end's calls
 * (`frontEnd.ts`), draws the front end's picture with a 2D context, and drives the frame. What
 * the editor does with a key, and what it draws where, is the front end's, so the native host's
 * entry makes the same editor out of its own events and its own drawing.
 *
 * **It draws the interface tree itself and lets the engine draw the viewport.** The editor's UI is
 * a `UiNode` tree of rectangles and text, which a 2D context draws exactly; the viewport is a
 * scene, which it cannot. So there are two canvases — a canvas has one context, and a 2D context
 * and a GPU device cannot share one — with the engine underneath, sized to the viewport rectangle,
 * and the interface over it with that rectangle left clear.
 *
 * **The camera the engine draws with is the camera the editor picks with.** `shell.setCamera` takes
 * the inverse view-projection, and handing it anything but the one that produced the picture makes
 * clicking land somewhere other than where things look — which reads as broken picking rather than
 * as two cameras.
 */
import { Camera, createEnvironment, createRenderer, MeshBuilder } from '@driftengine/core';
import type { MeshHandle, RendererApi } from '@driftengine/core';

import { appendLog } from '@driftengine/tools';

import { demoCaptureBytes } from './capture/demoCapture.ts';
import {
  captureSceneModel,
  captureShellScene,
  openCapture,
  saveCapture,
  type OpenedCapture,
} from './capture/file.ts';
import { registerCommand } from './command/registry.ts';
import { demoGraphs } from './demoGraphs.ts';
import { CAPTURE_STAGES, createCaptureModel, setProposals, stageDone } from './panels/capture.ts';
import type { AssetEntry } from './panels/assets.ts';
import { createSceneModel, type SceneModel } from './panels/sceneTree.ts';
import { createBrowserA11yHost } from './host/browser/a11yHost.ts';
import { createBrowserTextHost } from './host/browser/textHost.ts';
import { createEditorFrontEnd, type EditorPainter } from './frontEnd.ts';
import { chooseCaptureFile, downloadCaptureFile } from './host/browser/fileHost.ts';
import { MENU_BAR_HEIGHT, type ShellScene } from './shell.ts';
import { drawViewport, viewportItems, type ViewportItem } from './viewport/scene.ts';

const canvas = document.getElementById('surface') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLCanvasElement;
const readout = document.getElementById('readout') as HTMLElement;
const found = canvas.getContext('2d');
if (found === null) throw new Error('this browser has no 2D context');
const context: CanvasRenderingContext2D = found;

const created = await createRenderer(stage, { maxDrawingBufferPixels: 0 }, { splash: false });
const renderer: RendererApi = created.renderer;
/**
 * The light the viewport draws a capture under, and it follows the camera.
 *
 * **A capture is a sheet, and a sheet fused from one side faces the cameras that saw it.** A sun
 * fixed in the world lights it only if the clip happened to be shot from that sun's side; a room
 * reconstructed from a clip opened here came up almost black until this followed the camera
 * instead. **What it gives up** is any sense of where the room's real light was, which is the
 * delighting stage's subject and not the viewport's — until a capture carries recovered materials,
 * a lamp on the viewer's head is the honest thing to look at it under.
 *
 * The exposure suits albedo rather than the untextured white marching produces, which is about a
 * quarter as bright.
 */
const environment = createEnvironment({
  directionalDir: [0.45, 0.72, 0.52],
  directionalColor: [1.9, 1.86, 1.8],
  ambient: [0.6, 0.62, 0.7],
  ambientGround: [0.34, 0.34, 0.4],
  fogDensity: 0,
});
const camera = new Camera();
camera.fovYDeg = 42;
camera.near = 0.05;
camera.far = 200;

/** The marker a region is drawn as, made once: a unit cube scaled to whatever it stands for. */
const markerMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.42, 0.52, 0.62], 0.12).build(),
);
const selectedMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.44, 0.84, 0.63], 0.45).build(),
);
const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** What is open, and the surface mesh the renderer holds for it. */
let capture: OpenedCapture | null = null;
let surfaceMesh: MeshHandle | null = null;
const items: ViewportItem[] = [];

/*
 * **The browser editor opens on a capture, and makes one when nobody hands it a file.** A `.drft`
 * is not something this repository can commit — a captured room is tens of megabytes and is not
 * the engine's to redistribute — and an editor that opens empty cannot be looked at, photographed
 * or handed to somebody as a thing to try. The same reason `demoScene.ts` exists, one stage along.
 *
 * **One scene shape, which is what makes `Delete` honest.** The editor used to open on
 * `demoScene()`, which can delete, and `Ctrl+O` then put a capture underneath it — which cannot.
 * A scene that gains and loses that capability while the command registration was taken once is
 * how `Delete` comes to be offered for something it cannot do, which is the fault a reader found
 * here on 2026-09-20. `?capture=none` is the way to see the editor with nothing open.
 */
const wanted = new URLSearchParams(location.search).get('capture');

/**
 * What `?capture=` names: nothing, the one this file makes, or a file to fetch.
 *
 * **A capture the editor can be pointed at is what makes it checkable.** `Ctrl+O` opens a picker,
 * which a person can drive and a harness cannot, so every automated look at this product has been
 * at a capture the product generated for itself. A name here is fetched from `/capture/<name>.drft`
 * — the same place the capture harness writes one — so the editor can be opened on the output of a
 * real clip and photographed with it.
 */
async function askedCapture(): Promise<OpenedCapture | null> {
  if (wanted === 'none') return null;
  if (wanted === null || wanted === 'demo') return openCapture(demoCaptureBytes());
  const response = await fetch(`/capture/${wanted}.drft`);
  if (!response.ok) throw new Error(`no capture at /capture/${wanted}.drft`);
  return openCapture(await response.arrayBuffer());
}

/*
 * The panel's model, filled from whatever is open. The stages are *reported* into it by whoever
 * runs them; with a file opened rather than captured, the five of them are already done and the
 * panel says so — which is the truthful thing for it to say about a capture somebody else made.
 */
const captureModel = createCaptureModel();
/** What the tree shows with nothing open: no rows, rather than the rows of the last file. */
const EMPTY_TREE: SceneModel = createSceneModel();

/*
 * **One scene and one tree, both reading whatever capture is open now.**
 *
 * They used to be built from the capture that happened to be open at start, so `Ctrl+O` swapped
 * the surface mesh and left the markers, the tree and the picking answering about the previous
 * file — a viewport showing one room's geometry with another room's things in it. Both are
 * rebuilt in `adopt` instead, and everything downstream reads through these.
 */
let sceneOfCapture: ShellScene | null = null;
let treeOfCapture: SceneModel | null = null;
const NO_ENTITIES: readonly number[] = [];

const liveScene: ShellScene = {
  entities: () => sceneOfCapture?.entities() ?? NO_ENTITIES,
  nameOf: (entity) => sceneOfCapture?.nameOf(entity) ?? '',
  radiusOf: (entity) => sceneOfCapture?.radiusOf(entity) ?? 0,
  positionOf: (entity, out) => sceneOfCapture?.positionOf(entity, out) ?? false,
  setPosition: (entity, x, y, z) => {
    sceneOfCapture?.setPosition(entity, x, y, z);
  },
};

/** What this session has opened, which is the only asset index a browser editor can honestly have. */
const assetEntries: AssetEntry[] = [];

/**
 * Where the camera stands and what it looks at, from the open capture's own mesh.
 *
 * Recomputed only when a capture is adopted, because it is a property of the file rather than of
 * the frame — and walking a bounding box of 33,000 triangles every frame would be the one
 * allocation-free rule this file has no excuse for breaking.
 */
let framing = { middle: [0, 0.4, 0] as [number, number, number], span: 4 };

function frameOn(opened: OpenedCapture | null): void {
  const positions = opened?.mesh?.positions;
  if (positions === undefined || positions.length === 0) {
    framing = { middle: [0, 0.4, 0], span: 4 };
    return;
  }
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at + 2 < positions.length; at += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[at + axis] as number;
      low[axis] = Math.min(low[axis] as number, value);
      high[axis] = Math.max(high[axis] as number, value);
    }
  }
  framing = {
    middle: [
      ((low[0] as number) + (high[0] as number)) / 2,
      ((low[1] as number) + (high[1] as number)) / 2,
      ((low[2] as number) + (high[2] as number)) / 2,
    ],
    span: Math.max(
      1,
      (high[0] as number) - (low[0] as number),
      (high[1] as number) - (low[1] as number),
      (high[2] as number) - (low[2] as number),
    ),
  };
}

/** Take a capture as the one being worked on: its mesh, its scene, its tree and its panel. */
function adopt(opened: OpenedCapture | null, name: string): void {
  capture = opened;
  if (surfaceMesh !== null) renderer.disposeMesh(surfaceMesh);
  surfaceMesh = opened?.mesh == null ? null : renderer.createMesh(opened.mesh);
  sceneOfCapture = opened === null ? null : captureShellScene(opened);
  treeOfCapture = opened === null ? null : captureSceneModel(opened);
  frameOn(opened);
  if (opened === null) return;
  for (const stage of CAPTURE_STAGES) stageDone(captureModel, stage.id, 'from the file');
  setProposals(captureModel, opened.proposals);
  assetEntries.push({
    id: `${name}:${String(assetEntries.length)}`,
    kind: 'scene',
    name,
    bytes: opened.triangles * 3 * 4,
  });
}

adopt(
  await askedCapture(),
  wanted === null || wanted === 'demo' ? 'demo room.drft' : `${wanted}.drft`,
);

const editor = createEditorFrontEnd({
  canvas,
  textHost: createBrowserTextHost(),
  /* Under the menu bar, which is where the application's own tree starts. */
  a11yHost: createBrowserA11yHost({ origin: { x: 0, y: MENU_BAR_HEIGHT } }),
  viewportDrawn: true,
  scene: liveScene,
  capture: captureModel,
  sceneModel: () => treeOfCapture ?? EMPTY_TREE,
  assets: { entries: assetEntries },
  graphs: demoGraphs(),
});

/*
 * **Opening is a command like every other**, so the palette, a menu and the key all reach one
 * implementation — `shell.ts` argues that at length and this is the first host-supplied command to
 * take it up. `Ctrl+O` is what every application on every platform has bound for thirty years.
 */
/*
 * **Saving writes what was decided**, and it writes the geometry whatever was decided: a person who
 * opened a capture, looked at it and saved it has not thrown away the hour that produced it.
 */
registerCommand(editor.shell.commands, {
  id: 'capture.save',
  label: 'Save capture',
  binding: 'Ctrl+S',
  run: () => {
    if (capture === null) return;
    downloadCaptureFile('capture.drft', saveCapture(capture, captureModel.decided));
  },
});

registerCommand(editor.shell.commands, {
  id: 'capture.open',
  label: 'Open capture…',
  binding: 'Ctrl+O',
  run: () => {
    void chooseCaptureFile().then((bytes) => {
      if (bytes === null) return;
      adopt(openCapture(bytes), 'capture.drft');
      appendLog(editor.log, 'info', 'opened capture.drft');
      /* The tree, the inspector and the viewport all read through `adopt`'s two, so one
         invalidation is the whole of telling the editor a different room is open. */
      editor.shell.app.invalidate();
    });
  },
});

/** The front end's picture, in this canvas's 2D context. */
const painter: EditorPainter = {
  rect(x, y, w, h, colour) {
    context.fillStyle = colour;
    context.fillRect(x, y, w, h);
  },
  outline(x, y, w, h, colour) {
    context.strokeStyle = colour;
    context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  },
  disc(x, y, radius, colour) {
    context.fillStyle = colour;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  },
  text(content, x, y, colour) {
    context.fillStyle = colour;
    context.fillText(content, x, y);
  },
  clip(x, y, w, h) {
    context.save();
    context.beginPath();
    context.rect(x, y, w, h);
    context.clip();
  },
  unclip() {
    context.restore();
  },
};

function resize(): void {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(window.innerWidth));
  const height = Math.max(1, Math.floor(window.innerHeight));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  editor.resize(width, height);

  /* The engine's canvas *is* the viewport, rather than a corner of a larger one with a scissor. */
  const view = editor.shell.viewport;
  stage.style.left = `${String(view.x)}px`;
  stage.style.top = `${String(view.y)}px`;
  stage.style.width = `${String(view.w)}px`;
  stage.style.height = `${String(view.h)}px`;
  renderer.resize();
}

canvas.addEventListener('pointerdown', (event) => {
  editor.pointerDown(event.clientX, event.clientY, event.shiftKey, event.button);
});
/* A context click is a rejection in the capture panel, so the page's own menu is not wanted. */
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

window.addEventListener('keydown', (event) => {
  const taken = editor.key({
    key: event.key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  });
  if (taken) event.preventDefault();
});

window.addEventListener('resize', resize);
resize();

/** The viewport, drawn with the engine, from whatever the editor says is in it. */
function drawScene(): void {
  const view = editor.shell.viewport;
  const aspect = view.h > 0 ? view.w / view.h : 1;
  /*
   * **Framed on what is actually open**, which for a real capture is nowhere near the origin.
   *
   * The span used to be six times the first marker's radius and the camera always looked at
   * (0, 0.4, 0) — fine for a capture this file generates, which is built around the origin, and
   * wrong for one reconstructed from a clip, whose world is wherever the first camera happened to
   * be. A real room opened in the editor came up as a handful of markers in the middle distance
   * with the geometry behind them too small to read.
   */
  const middle = framing.middle;
  const span = framing.span;
  camera.position[0] = middle[0] + span * 0.75;
  camera.position[1] = middle[1] + span * 0.55;
  camera.position[2] = middle[2] + span * 0.75;
  camera.lookAt(middle[0], middle[1], middle[2]);
  camera.updateMatrices(aspect);
  /* The headlight: from the camera toward what it is looking at. See `environment` above. */
  const toEye = [
    camera.position[0] - middle[0],
    camera.position[1] - middle[1],
    camera.position[2] - middle[2],
  ];
  const reach = Math.hypot(toEye[0] as number, toEye[1] as number, toEye[2] as number) || 1;
  environment.directionalDir[0] = (toEye[0] as number) / reach;
  environment.directionalDir[1] = (toEye[1] as number) / reach;
  environment.directionalDir[2] = (toEye[2] as number) / reach;
  /* The same camera the picture came from, or clicking lands somewhere other than it looks. */
  editor.shell.setCamera(camera.invViewProjection as unknown as Float32Array);

  const count = viewportItems(editor.scene, editor.shell.selection, items);
  renderer.beginFrame([0.08, 0.095, 0.11]);
  renderer.bindMeshPass(camera, environment);
  drawViewport(items, count, {
    surface: () => {
      if (surfaceMesh !== null) renderer.drawMesh(surfaceMesh, IDENTITY);
    },
    marker: (item) => {
      /*
       * **Drawn at exactly the size it is picked at.** The scale used to be worked out here from
       * the region's bounds while the pick radius stayed the bounds itself, so the grab reach was
       * about four times the marker and a click in empty space selected something. One number, in
       * `capture/file.ts`, used by both.
       */
      if (item.radius <= 0) return;
      const scale = item.radius;
      transform[0] = scale;
      transform[5] = scale;
      transform[10] = scale;
      transform[12] = item.x;
      transform[13] = item.y;
      transform[14] = item.z;
      renderer.drawMesh(item.selected ? selectedMesh : markerMesh, transform);
    },
  });
  renderer.endFrame();
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function tick(now: number): void {
  editor.frame(now);
  drawScene();
  /*
   * Cleared rather than painted over: the viewport is a hole in this canvas and the engine is
   * behind it, so anything left from the previous frame inside that rectangle stays visible.
   */
  context.clearRect(0, 0, canvas.width, canvas.height);
  /* Set every frame: resizing the canvas resets its context, font included. */
  context.font = '12px ui-monospace, monospace';
  editor.paint(painter);
  readout.textContent = `${editor.readout()} · ${capture === null ? 'no capture' : `${String(capture.triangles)} triangles`}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* Named so the harness can wait for it, exactly as the demo pages do. */
/*
 * **The editor itself, for the visual gate to drive.**
 *
 * A demo page is a scene and a query string, so `shots.mjs` can photograph one by opening a URL.
 * An editor is a state machine — a menu open, a panel shown, a row clicked — and none of that is
 * expressible in an address. This is the handle that makes it drivable from `cdp.mjs`, and it is
 * how two defects were found on 2026-09-20 that no test could see: the accessibility mirror
 * drawing the whole interface a second time, and this page running the engine from `dist`.
 *
 * It is a handle on the product, not a second way to change it: everything reachable through it is
 * what a key or a click already reaches.
 */
(window as unknown as { editorDebug?: unknown }).editorDebug = editor;
(window as unknown as { editorReady?: boolean }).editorReady = true;
