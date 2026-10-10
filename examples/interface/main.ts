/**
 * A pause menu and an options screen over a scene that keeps running behind them.
 *
 * The page builds the interface as a tree of nodes, lays nothing out by hand, and draws it as one
 * sprite pass with the pixel font over it. `menu.drs` routes the pointer and the keys to the tree,
 * answers what was activated, and paints each button from its own state: Resume closes the menu,
 * Options opens a second panel whose toggles change the scene, and its list scrolls inside its own
 * box. The mouse, the keyboard and a gamepad all reach it. The switches move the menu and change its
 * theme on the running page.
 */
import {
  DEFAULT_TEXT_STYLE,
  InputSource,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  srgbColor,
} from '@driftengine/core';
import type { TextHandle, TextStyle } from '@driftengine/core';
import {
  addUiChild,
  createAffine2D,
  createSpritePass,
  createTheme,
  createUiNode,
  deriveTheme,
  drawUiTree,
  routeScrollWheel,
  screenToNdc,
  themeRgba,
} from '@driftengine/ui2d';
import type { UiNode, UiNodeOptions, UiRect } from '@driftengine/ui2d';
import { patchModule } from 'driftscript';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as menuScript from './menu.drs';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.52, 0.6, 0.72);

const stage = await openStage({ directionalShadows: true, outputTransform: 'aces' });
const { renderer, camera, canvas } = stage;

// #region tree
/* The interface as nodes: a root that fills the screen, the pause menu, and the options panel with
   its toggles and a list that clips and scrolls. Sizes are numbers, `fit` or `grow`; nothing is
   placed by hand. */
const BUTTON: UiNodeOptions = { width: 260, height: 34, interactive: true, focusable: true };
const root = createUiNode({
  direction: 'column',
  width: 'grow',
  height: 'grow',
  justify: 'center',
  padding: 40,
});
const add = (parent: UiNode, options: UiNodeOptions): UiNode =>
  addUiChild(parent, createUiNode(options));
const menu = add(root, {
  direction: 'column',
  padding: 18,
  gap: 8,
  name: 'menu',
  background: [0, 0, 0, 1],
});
add(menu, { width: 260, height: 36, text: 'PAUSED', name: 'title' });
add(menu, { ...BUTTON, text: 'RESUME', name: 'resume' });
add(menu, { ...BUTTON, text: 'OPTIONS', name: 'options' });
add(menu, { ...BUTTON, text: 'RESTART', name: 'restart' });
const options = add(root, {
  direction: 'column',
  padding: 18,
  gap: 8,
  name: 'optionsPanel',
  hidden: true,
  background: [0, 0, 0, 1],
});
add(options, { width: 260, height: 36, text: 'OPTIONS', name: 'optionsTitle' });
add(options, { ...BUTTON, text: 'SPIN  ON', name: 'spin' });
add(options, { ...BUTTON, text: 'SHADOWS  ON', name: 'shadows' });
const help = add(options, {
  direction: 'column',
  width: 260,
  height: 112,
  padding: 8,
  gap: 6,
  clip: true,
  name: 'help',
  background: [0, 0, 0, 1],
});
for (const line of [
  'THE WHEEL SCROLLS IT',
  'TAB OR ARROWS MOVE',
  'ENTER OR SPACE PRESS',
  'ESCAPE GOES BACK',
  'A PAD: D-PAD AND A',
  'START PAUSES',
  'THE LIST CLIPS ROWS',
  'AND SCROLLS IN PLACE',
]) {
  add(help, { width: 'grow', height: 16, text: line });
}
add(options, { ...BUTTON, text: 'BACK', name: 'back' });
// #endregion

// #region theme
/* Colours by name, packed as 0xRRGGBBAA. The light theme is the dark one with four overrides. */
const DARK = createTheme({
  panel: 0x14161dee,
  well: 0x0b0c10ff,
  text: 0xe6e8eeff,
  title: 0xf0b45cff,
});
const LIGHT = deriveTheme(DARK, {
  panel: 0xf2f3f6ee,
  well: 0xdfe2e8ff,
  text: 0x1a1c22ff,
  title: 0xb4602aff,
});
let theme = flag('theme', 'dark') === 'light' ? LIGHT : DARK;
const textColour = new Float32Array(4);
let bodyStyle: TextStyle = DEFAULT_TEXT_STYLE;
let titleStyle: TextStyle = DEFAULT_TEXT_STYLE;
/* Written into the nodes' own colours, and the label styles built here, once a change of theme. */
function applyTheme(): void {
  themeRgba(theme, 'panel', 0x000000ff, menu.background as Float32Array);
  themeRgba(theme, 'panel', 0x000000ff, options.background as Float32Array);
  themeRgba(theme, 'well', 0x000000ff, help.background as Float32Array);
  themeRgba(theme, 'text', 0xffffffff, textColour);
  bodyStyle = {
    ...DEFAULT_TEXT_STYLE,
    cellSize: 2,
    color: [textColour[0] ?? 1, textColour[1] ?? 1, textColour[2] ?? 1],
  };
  themeRgba(theme, 'title', 0xffffffff, textColour);
  titleStyle = {
    ...DEFAULT_TEXT_STYLE,
    cellSize: 3,
    color: [textColour[0] ?? 1, textColour[1] ?? 1, textColour[2] ?? 1],
  };
}
applyTheme();
// #endregion

// #region script
const script = hostScript(menuScript);
interface Menu {
  open: boolean;
  spin: boolean;
  shadows: boolean;
  light: boolean;
  restarts: number;
}
const state = exported<() => Menu>(script, 'createMenu')();
state.light = theme === LIGHT;
exported<(tree: UiNode) => void>(script, 'begin')(root);
type Update = (
  menu: Menu,
  tree: UiNode,
  width: number,
  height: number,
  x: number,
  y: number,
  down: boolean,
  key: string,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./menu.drs', (next) => {
    if (next !== undefined) patchModule(script, next as Record<string, unknown>, { Menu: [state] });
  });
}
// #endregion

// #region devices
/* The pointer in CSS pixels, the wheel, the one key pressed this frame, and a pad's buttons named
   as the keys they stand for. The script is handed all of it and routes it to the tree. */
const pointer = { x: -1, y: -1, down: false };
let pressedKey = '';
const ROUTED = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab']);
canvas.addEventListener('pointermove', (event) => {
  pointer.x = event.offsetX;
  pointer.y = event.offsetY;
});
canvas.addEventListener('pointerdown', () => {
  pointer.down = true;
});
addEventListener('pointerup', () => {
  pointer.down = false;
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    routeScrollWheel(root, event.offsetX, event.offsetY, event.deltaX, event.deltaY);
  },
  { passive: false },
);
addEventListener('keydown', (event) => {
  if (!ROUTED.has(event.key)) return;
  event.preventDefault();
  pressedKey = event.key;
});
const input = new InputSource(canvas);
function padKey(): string {
  const pad = input.pad(0);
  if (pad === null) return '';
  if (pad.pressed('dpadDown')) return 'ArrowDown';
  if (pad.pressed('dpadUp')) return 'ArrowUp';
  if (pad.pressed('faceDown')) return 'Enter';
  if (pad.pressed('faceRight') || pad.pressed('start')) return 'Escape';
  return '';
}
// #endregion

controls([
  {
    key: 'align',
    label: 'menu',
    value: flag('align', 'centre'),
    options: ['centre', 'left'].map((a) => ({ text: a, value: a })),
    change: (value) => {
      root.align = value === 'left' ? 'start' : 'center';
    },
  },
  {
    key: 'theme',
    label: 'theme',
    value: theme === LIGHT ? 'light' : 'dark',
    options: ['dark', 'light'].map((t) => ({ text: t, value: t })),
    change: (value) => {
      theme = value === 'light' ? LIGHT : DARK;
      state.light = theme === LIGHT;
      applyTheme();
    },
  },
]);
root.align = flag('align', 'centre') === 'left' ? 'start' : 'center';

/* The scene behind it: a sculpture on a plinth, which spins while the menu says so. */
const scene = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([0, 0.2, 0], 1.6, 0.2, 'y', [0.42, 0.42, 0.45], 0, 48)
    .addBox([0, -0.05, 0], [30, 0.05, 30], [0.3, 0.33, 0.38])
    .build(),
);
const sculpture = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, 1.1, 0], [0.5, 0.5, 0.5], [0.85, 0.45, 0.2])
    .addBox([0, 1.95, 0], [0.32, 0.32, 0.32], [0.25, 0.55, 0.85])
    .addSphere([0, 2.55, 0], 0.22, [0.9, 0.9, 0.92], 0, 16, 8, 0.6)
    .build(),
);
const env = createEnvironment({
  directionalDir: [0.5, 0.8, 0.3],
  directionalColor: [1.6, 1.55, 1.45],
  ambient: [0.38, 0.4, 0.48],
  ambientGround: [0.14, 0.14, 0.15],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  4,
  renderer.shadowMapSize,
  lightMatrix,
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(IDENTITY);

// #region draw
/* One sprite pass for the panels and buttons, and the pixel font over them: the tree says where
   each label goes and how much of it a clip leaves, and the page draws it. */
const pass = createSpritePass({ capacity: 256, slots: 1, label: 'interface' });
const handle = renderer.registerPass(pass);
const affine = createAffine2D();
const labels = new Map<UiNode, TextHandle>();
const queued: UiNode[] = [];
const sink = {
  content(node: UiNode, visible: UiRect): void {
    /* A label in a row a clip has cut is left out, rather than drawn over the list's edge. */
    if (visible.h < node.rect.h) return;
    queued.push(node);
  },
};
function drawLabels(width: number, height: number, time: number): void {
  for (const node of queued) {
    let label = labels.get(node);
    if (label === undefined) {
      label = renderer.createText();
      labels.set(node, label);
    }
    renderer.setText(label, node.text);
    const big = node.name === 'title' || node.name === 'optionsTitle';
    const style = big ? titleStyle : bodyStyle;
    const cell = big ? 3 : 2;
    const x = node.rect.x + (node.interactive ? 12 : 4);
    const baseline = node.rect.y + node.rect.h / 2 + (cell * 7) / 2;
    renderer.drawText(label, width, height, x, baseline, style, time);
  }
  queued.length = 0;
}
// #endregion

let time = 0;
let angle = 0;
stage.run({
  simulate(dt) {
    time += dt;
    if (state.spin) angle += dt * 0.6;
  },
  render() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // #region frame
    const key = pressedKey !== '' ? pressedKey : padKey();
    pressedKey = '';
    exported<Update>(script, 'update')(
      state,
      root,
      width,
      height,
      pointer.x,
      pointer.y,
      pointer.down,
      key,
    );
    pass.reset();
    pass.setTransform(screenToNdc(width, height, affine));
    drawUiTree(pass.batch, root, pass.white, sink);
    // #endregion

    camera.fovYDeg = 45;
    camera.position[0] = 4.5;
    camera.position[1] = 3;
    camera.position[2] = 5.5;
    /* Framed off to the right, so the sculpture shows beside the menu rather than behind it. */
    camera.lookAt(-1.6, 1.4, 0);
    env.shadowStrength = state.shadows ? 0.7 : 0;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    model.set([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((caster) => caster.mesh(sculpture, model));
    renderer.endShadowPass();
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(scene, IDENTITY);
    renderer.drawMesh(sculpture, model);
    renderer.drawPass(handle);
    drawLabels(width, height, time);
    if (!state.open) {
      const prompt = labels.get(root) ?? renderer.createText();
      labels.set(root, prompt);
      renderer.setText(prompt, 'ESCAPE OR START TO PAUSE');
      renderer.drawText(prompt, width, height, 24, height - 90, bodyStyle, time);
    }
    renderer.endFrame();
  },
});
