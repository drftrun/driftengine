/**
 * Debugging a running game from inside it: six bouncing balls and the engine's tools overlay.
 *
 * Press F3 for the overlay: an inspector on the selected ball, a console the page fills with what
 * the balls do, and a profiler of frame times. Tab selects the next ball; [ and ] give it less or
 * more bounce, as an edit the overlay can undo with Ctrl+Z; R drops every ball again. `balls.drs`
 * holds the rules, and the frame meter in the corner is core's.
 */
import { FpsMeter, MeshBuilder, computeLightMatrix, createEnvironment } from '@driftengine/core';
import type { Vec3 } from '@driftengine/core';
import { World, buildSchedule, runSchedule } from '@driftengine/entities';
import type { ComponentType, Entity, Schedule } from '@driftengine/entities';
import { bindModule, registerEntityModule } from '@driftengine/script';
import type { ComponentRegistry } from '@driftengine/script';
import {
  appendLog,
  bindPanel,
  consolePanel,
  createConsoleView,
  createFrameHistory,
  createGpuPassTimings,
  createInspectorView,
  createLogRing,
  createProfilerView,
  createSelection,
  createToolsOverlay,
  entitiesInspectable,
  inspectorPanel,
  keyEvent,
  paintOverlay,
  pointerEvent,
  primarySelection,
  profilerPanel,
  pushFrame,
  recordGpuSample,
  selectOnly,
  setFieldCommand,
  wheelEvent,
} from '@driftengine/tools';
import type { OverlayPainter, Severity, ToolsOverlay } from '@driftengine/tools';
import { loadModule, patchModule } from 'driftscript';
import { controls, flag, openStage } from '../common/stage';
import * as ballsScript from './balls.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
  /* WebGPU times its passes only when asked, since it costs every pass two queries. This page is
     asking: the profiler shows what they measure. WebGL2 times them either way. */
  gpuTiming: true,
});
const { renderer, camera } = stage;
/* Core's frame meter, which makes its own element in the corner. */
const meter = new FpsMeter();

// #region world
/* The rules registered once; a save rebuilds the schedule and keeps every ball. */
const balls = loadModule(ballsScript as Record<string, unknown>);
const registry: ComponentRegistry = new Map();
let schedule: Schedule = buildSchedule(registerEntityModule(balls, registry).systems);
const bound = bindModule(balls, { entities: { components: registry, prefabs: new Map() } });
if (!bound.bound) throw new Error(bound.reason);
if (import.meta.hot) {
  import.meta.hot.accept('./balls.drs', (next) => {
    if (next === undefined) return;
    patchModule(balls, next as Record<string, unknown>);
    schedule = buildSchedule(registerEntityModule(balls, registry).systems);
  });
}
const Ball = registry.get('Ball') as ComponentType;
const world = new World();
const COUNT = 6;
const entities: Entity[] = [];
function drop(): void {
  for (const ball of entities) world.destroy(ball);
  entities.length = 0;
  for (let i = 0; i < COUNT; i += 1) {
    const ball = world.create();
    world.add(ball, Ball, { y: 2 + i * 0.6, bounce: 0.55 + i * 0.07 });
    entities.push(ball);
  }
}
drop();
// #endregion

// #region panels
/* What each panel reads. The inspector reads the entity world through an adapter; the console a
   ring of entries the page appends to; the profiler the frame's times and the GPU's. */
const selection = createSelection();
selectOnly(selection, entities[0] as number);
const inspectable = entitiesInspectable(world, [Ball]);
/* Five lines, which the console shows whole on a phone held sideways: the overlay does not scroll
   it yet, so a longer ring would show its oldest lines and hide the newest. */
const log = createLogRing(5);
const ROW = 16;
const consoleView = createConsoleView({ rowHeight: ROW });
consoleView.filter.minSeverity = level(flag('level', 'debug'));
const history = createFrameHistory(120);
const timings = createGpuPassTimings();

function panels() {
  return [
    bindPanel(
      inspectorPanel,
      () => ({ world: inspectable }),
      createInspectorView({ selection, rowHeight: ROW }),
    ),
    bindPanel(consolePanel, () => ({ log }), consoleView),
    bindPanel(
      profilerPanel,
      () => ({ timings, history, residency: null }),
      createProfilerView({ rowHeight: ROW }),
    ),
  ];
}
// #endregion

// #region overlay
/* Closed until F3. The overlay lays itself out in a column of its own space and paints through
   four calls, which here go to a 2D canvas over the stage. Where that space sits on the page is the
   page's choice: here, below the hint and above the switches, so the page's own controls stay
   clear. */
let side: 'left' | 'right' = flag('side', 'right') === 'left' ? 'left' : 'right';
let overlay: ToolsOverlay = makeOverlay(flag('open', 'no') === 'yes');
function makeOverlay(open: boolean): ToolsOverlay {
  return createToolsOverlay({ panels: panels(), key: 'F3', side, visible: open });
}

const layer = document.querySelector<HTMLCanvasElement>('#tools');
const ink = layer?.getContext('2d') ?? null;
const painter: OverlayPainter = {
  rect(x, y, w, h, colour) {
    if (ink === null) return;
    ink.fillStyle = colour;
    ink.fillRect(x, y, w, h);
  },
  text(content, x, y, colour) {
    if (ink === null) return;
    ink.fillStyle = colour;
    ink.font = '12px ui-monospace, monospace';
    ink.fillText(content, x + 8, y);
  },
  clip(x, y, w, h) {
    if (ink === null) return;
    ink.save();
    ink.beginPath();
    ink.rect(x, y, w, h);
    ink.clip();
  },
  unclip() {
    ink?.restore();
  },
};

let top = 0;
function fit(): void {
  if (layer === null || ink === null) return;
  const scale = devicePixelRatio;
  const above = document.querySelector('#hint')?.getBoundingClientRect().bottom ?? 0;
  const below = document.querySelector('#controls')?.getBoundingClientRect().top ?? innerHeight;
  top = Math.round(above + 8);
  layer.width = Math.round(innerWidth * scale);
  layer.height = Math.round(innerHeight * scale);
  ink.setTransform(scale, 0, 0, scale, 0, top * scale);
  overlay.resize(innerWidth, Math.max(0, Math.round(below - 8) - top));
}
addEventListener('resize', fit);
// #endregion

// #region input
/* Every event goes to the overlay first; what it takes, the game never sees. */
addEventListener('keydown', (event) => {
  if (overlay.route(keyEvent(event.key, event.shiftKey, event.ctrlKey))) {
    event.preventDefault();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    const at = entities.indexOf(primarySelection(selection) ?? -1);
    selectOnly(selection, entities[(at + 1) % entities.length] as number);
    overlay.invalidate();
  } else if (event.key === '[' || event.key === ']') {
    nudgeBounce(event.key === ']' ? 0.05 : -0.05);
  } else if (event.key === 'r' || event.key === 'R') {
    drop();
    selectOnly(selection, entities[0] as number);
    appendLog(log, 'info', 'every ball dropped again');
    overlay.invalidate();
  }
});
/* Pointer events in the overlay's space, which starts `top` pixels down the page. */
addEventListener('pointerdown', (event) => {
  if (overlay.route(pointerEvent('down', event.clientX, event.clientY - top, event.button)))
    event.preventDefault();
});
addEventListener('pointerup', (event) => {
  overlay.route(pointerEvent('up', event.clientX, event.clientY - top, event.button));
});
addEventListener(
  'wheel',
  (event) => {
    if (overlay.route(wheelEvent(event.clientX, event.clientY - top, event.deltaX, event.deltaY)))
      event.preventDefault();
  },
  { passive: false },
);
// #endregion

// #region edit
/* An edit is a command: pushed onto the overlay's stack, it is applied once and can be taken
   back with Ctrl+Z while the overlay is open. */
function nudgeBounce(by: number): void {
  const ball = primarySelection(selection);
  if (ball === null) return;
  const now = world.read(ball, Ball, 'bounce') as number;
  const next = Math.round(Math.min(0.95, Math.max(0, now + by)) * 100) / 100;
  const command = setFieldCommand(inspectable, [ball], 'Ball', ['bounce'], [next]);
  if (command === null) return;
  overlay.undo.push(command);
  appendLog(
    log,
    'debug',
    `ball ${entities.indexOf(ball) + 1} bounce ${now.toFixed(2)} to ${next.toFixed(2)}`,
  );
  overlay.invalidate();
}
// #endregion

// #region log
/* What the balls did this step, said once each. Every entry names where the rule lives, so a click
   on it in the console moves the source cursor there. */
const seen = new Map<Entity, { hits: number; resting: boolean }>();
function report(): void {
  entities.forEach((ball, index) => {
    const hits = world.read(ball, Ball, 'hits') as number;
    const resting = (world.read(ball, Ball, 'vy') as number) === 0;
    const before = seen.get(ball) ?? { hits: 0, resting: false };
    if (hits > before.hits) {
      const impact = world.read(ball, Ball, 'impact') as number;
      const severity: Severity = impact > 6 ? 'warn' : 'info';
      appendLog(
        log,
        severity,
        `ball ${index + 1} hit the floor at ${impact.toFixed(1)} m/s`,
        'examples/tools/balls.drs',
        26,
      );
    }
    if (resting && !before.resting) appendLog(log, 'info', `ball ${index + 1} has come to rest`);
    seen.set(ball, { hits, resting });
  });
}
// #endregion

function level(value: string): Severity {
  return value === 'info' || value === 'warn' ? value : 'debug';
}

controls([
  {
    key: 'side',
    label: 'overlay',
    value: side,
    options: ['right', 'left'].map((s) => ({ text: s, value: s })),
    change: (value) => {
      side = value === 'left' ? 'left' : 'right';
      const open = overlay.visible;
      overlay.dispose();
      overlay = makeOverlay(open);
      fit();
    },
  },
  {
    key: 'level',
    label: 'console',
    value: consoleView.filter.minSeverity,
    options: (['debug', 'info', 'warn'] as const).map((s) => ({ text: s, value: s })),
    change: (value) => {
      consoleView.filter.minSeverity = level(value);
      overlay.invalidate();
    },
  },
]);
/* Fitted once the switches are drawn, since the overlay stops above them. */
fit();

/* The scene: a floor and six balls in a row, the selected one ringed. */
const COLORS: Vec3[] = [
  [0.9, 0.3, 0.25],
  [0.95, 0.65, 0.2],
  [0.85, 0.85, 0.3],
  [0.35, 0.8, 0.4],
  [0.3, 0.55, 0.95],
  [0.65, 0.4, 0.9],
];
const floorMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, -0.1, 0], [7, 0.1, 3], [0.2, 0.21, 0.24]).build(),
);
const ballMeshes = COLORS.map((color) =>
  renderer.createMesh(new MeshBuilder().addSphere([0, 0, 0], 0.35, color, 0, 24, 16, 0.5).build()),
);
const ringMesh = renderer.createMesh(
  new MeshBuilder().addCylinder([0, 0, 0], 0.5, 0.02, 'y', [1, 1, 1], 1, 32).build(),
);
const env = createEnvironment({
  directionalDir: [0.35, 0.85, 0.4],
  directionalColor: [1.4, 1.35, 1.25],
  ambient: [0.3, 0.32, 0.4],
  ambientGround: [0.1, 0.1, 0.12],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.6;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  10,
  renderer.shadowMapSize,
  lightMatrix,
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const models = entities.map(() => new Float32Array(IDENTITY));
const ringModel = new Float32Array(IDENTITY);
let tick = 0;
let last = performance.now();

function place(): void {
  camera.fovYDeg = 45;
  camera.position[0] = 0;
  camera.position[1] = 3.2;
  camera.position[2] = 9;
  camera.lookAt(0, 1.4, 0);
  entities.forEach((ball, i) => {
    const model = models[i] as Float32Array;
    model[12] = (i - (COUNT - 1) / 2) * 1.6;
    model[13] = world.read(ball, Ball, 'y') as number;
  });
}

function drawShadows(): void {
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters((sink) => {
    ballMeshes.forEach((mesh, i) => sink.mesh(mesh, models[i] as Float32Array));
  });
  renderer.endShadowPass();
}

function drawScene(): void {
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floorMesh, IDENTITY);
  ballMeshes.forEach((mesh, i) => renderer.drawMesh(mesh, models[i] as Float32Array));
  const chosen = entities.indexOf(primarySelection(selection) ?? -1);
  if (chosen >= 0) {
    ringModel[12] = (models[chosen] as Float32Array)[12] as number;
    ringModel[13] = 0.02;
    renderer.drawMesh(ringMesh, ringModel);
  }
}

stage.run({
  simulate() {
    runSchedule(world, schedule, tick);
    tick += 1;
    report();
  },
  render() {
    const now = performance.now();
    place();
    // #region timing
    /* The frame's time from the clock, and the GPU's in the engine's three brackets: the renderer
       opens shadows and reflection itself, and the game opens rest around the rest of its drawing.
       A sample arrives a few frames after its frame, and never where the device cannot time. */
    pushFrame(history, now - last);
    meter.sample((now - last) / 1000, now);
    last = now;
    const timer = renderer.gpuTimer;
    timer.beginFrame();
    drawShadows();
    renderer.beginFrame([0.08, 0.09, 0.12]);
    timer.begin('rest');
    drawScene();
    timer.end();
    renderer.endFrame();
    timer.endFrame();
    const sample = timer.poll();
    if (sample !== null) recordGpuSample(timings, sample);
    // #endregion

    // #region paint
    /* The overlay over all of it, rebuilt each frame because the profiler changes every frame. */
    if (ink !== null) ink.clearRect(0, -top, innerWidth, innerHeight);
    overlay.invalidate();
    overlay.frame(now);
    paintOverlay(painter, overlay);
    // #endregion
  },
});
