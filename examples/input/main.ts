/**
 * A puck in an arena, driven by any device, and a controls screen that rebinds it.
 *
 * The keyboard, a gamepad and a touch screen all drive the same puck, because the script asks an
 * action map what the player means and never which device said it. `puck.drs` steers, boosts,
 * brakes and bounces, and rumbles the pad on a hit where the pad has motors. The panel on the right
 * rebinds boost and brake to the next key or button pressed and saves only what was changed. The
 * prompts name what the player last used: a key, the label printed on their pad, or a tap.
 */
import {
  ActionMap,
  InputSource,
  MeshBuilder,
  TouchControls,
  computeLightMatrix,
  createEnvironment,
  defaultStore,
} from '@driftengine/core';
import type { Binding, GamepadButton, Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as puckScript from './puck.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera, canvas } = stage;

// #region devices
/* Every device at once. The keys listed are kept from the page, so Space does not scroll it. */
const input = new InputSource(canvas, [
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
]);
const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  boost: { keys: ['Space'], buttons: ['faceDown'] },
  brake: { keys: ['ShiftLeft'], buttons: ['faceRight', 'l2'] },
});
/* A stick where the left thumb lands, and taps and holds on the right of the screen. */
const touch = new TouchControls(input, {
  stickBase: document.querySelector<HTMLElement>('#stick-base') ?? undefined,
  stickNub: document.querySelector<HTMLElement>('#stick-nub') ?? undefined,
});
// #endregion

// #region store
/* What the player changed survives a reload. Only the changes are written, so a default the game
   alters later still reaches a player who never touched it. */
const store = defaultStore();
const SAVED = 'driftengine.examples.input';
actions.load(store, SAVED);
// #endregion

// #region script
const script = hostScript(puckScript);
interface Puck {
  x: number;
  z: number;
  vx: number;
  vz: number;
  boost: number;
  braking: boolean;
  bumps: number;
  hit: number;
  raw: boolean;
  shake: boolean;
}
const puck = exported<() => Puck>(script, 'createPuck')();
type Drive = (puck: Puck, actions: ActionMap, touch: TouchControls, dt: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./puck.drs', (next) => {
    if (next !== undefined) patchModule(script, next as Record<string, unknown>, { Puck: [puck] });
  });
}
// #endregion

/* The controls screen. A row per action the player may change; pressing its button waits for the
   next key or pad button, binds it, and says which action lost it, if one did. */
const REBINDABLE = ['boost', 'brake'];
const BUTTONS: readonly GamepadButton[] = [
  'faceDown',
  'faceRight',
  'faceLeft',
  'faceUp',
  'l1',
  'r1',
  'l2',
  'r2',
  'select',
  'start',
  'l3',
  'r3',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
];
/* Where a button is, for naming it before any pad has said what it prints on the plastic. */
const POSITION: Record<GamepadButton, string> = {
  faceDown: 'bottom',
  faceRight: 'right',
  faceLeft: 'left',
  faceUp: 'top',
  l1: 'left bumper',
  r1: 'right bumper',
  l2: 'left trigger',
  r2: 'right trigger',
  select: 'select',
  start: 'start',
  l3: 'left stick',
  r3: 'right stick',
  dpadUp: 'd-pad up',
  dpadDown: 'd-pad down',
  dpadLeft: 'd-pad left',
  dpadRight: 'd-pad right',
  guide: 'home',
};
let waiting: string | null = null;
const note = document.querySelector<HTMLElement>('#note');
const rows = document.querySelector<HTMLElement>('#rows');

function bindingNames(action: string): string {
  const pad = input.pad(0);
  return actions
    .bindingsFor(action)
    .map((binding) =>
      binding.device === 'keyboard'
        ? keyName(binding.code)
        : (pad?.identity.label(binding.button) ?? `pad ${POSITION[binding.button]}`),
    )
    .join(', ');
}

// #region rebind
function bind(binding: Binding, said: string): void {
  if (waiting === null) return;
  const displaced = actions.rebind(waiting, binding);
  actions.save(store, SAVED);
  if (note !== null) {
    note.textContent =
      displaced.length > 0 ? `${said} was taken from ${displaced.join(' and ')}` : '';
  }
  waiting = null;
  drawRows();
}

addEventListener('keydown', (event) => {
  if (waiting === null) return;
  event.preventDefault();
  bind({ device: 'keyboard', code: event.code }, keyName(event.code));
});

/** Called each frame while a row is waiting: the first button any pad pressed. */
function listenToPads(): void {
  if (waiting === null) return;
  for (const pad of input.pads) {
    for (const button of BUTTONS) {
      if (pad.pressed(button)) {
        bind({ device: 'gamepad', button }, pad.identity.label(button));
        return;
      }
    }
  }
}
// #endregion

function drawRows(): void {
  if (rows === null) return;
  rows.replaceChildren(
    ...REBINDABLE.map((action) => {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = action;
      const keys = document.createElement('span');
      keys.className = 'keys';
      keys.textContent = bindingNames(action);
      const change = document.createElement('button');
      change.type = 'button';
      change.textContent = waiting === action ? 'press…' : 'add';
      if (waiting === action) change.className = 'waiting';
      change.addEventListener('click', () => {
        waiting = waiting === action ? null : action;
        drawRows();
      });
      row.append(name, keys, change);
      return row;
    }),
  );
}
document.querySelector('#reset')?.addEventListener('click', () => {
  actions.resetToDefaults();
  actions.save(store, SAVED);
  waiting = null;
  if (note !== null) note.textContent = '';
  drawRows();
});
drawRows();
/* A pad plugged in changes how its buttons are named, so the rows are drawn again. */
input.onDeviceChange(() => drawRows());

/** A key's code as a player reads it: `KeyW` is W, `ShiftLeft` is left shift. */
function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5).toLowerCase()} arrow`;
  if (code.endsWith('Left')) return `left ${code.slice(0, -4).toLowerCase()}`;
  if (code.endsWith('Right')) return `right ${code.slice(0, -5).toLowerCase()}`;
  return code.toLowerCase();
}

puck.raw = flag('stick', 'rim') === 'raw';
puck.shake = flag('rumble', 'on') === 'on';
const padsOn = flag('pad', 'on') === 'on';
input.setSourceEnabled('gamepad', padsOn);
controls([
  {
    key: 'stick',
    label: 'stick',
    value: puck.raw ? 'raw' : 'rim',
    options: ['rim', 'raw'].map((s) => ({ text: s, value: s })),
    change: (value) => {
      puck.raw = value === 'raw';
    },
  },
  {
    key: 'rumble',
    label: 'rumble',
    value: puck.shake ? 'on' : 'off',
    options: ['on', 'off'].map((r) => ({ text: r, value: r })),
    change: (value) => {
      puck.shake = value === 'on';
    },
  },
  {
    key: 'pad',
    label: 'gamepad',
    value: padsOn ? 'on' : 'off',
    options: ['on', 'off'].map((p) => ({ text: p, value: p })),
    change: (value) => input.setSourceEnabled('gamepad', value === 'on'),
  },
]);

/* The arena: a floor with a low wall round it, four pillars, and the puck. */
const PILLARS: Vec3[] = [
  [-5, 1.25, -4],
  [5, 1.25, -4],
  [-5, 1.25, 4],
  [5, 1.25, 4],
];
const arena = new MeshBuilder()
  .addBox([0, -0.1, 0], [11, 0.1, 11], [0.24, 0.25, 0.28])
  .addBox([0, 0.25, -10.65], [11, 0.25, 0.15], [0.4, 0.38, 0.36])
  .addBox([0, 0.25, 10.65], [11, 0.25, 0.15], [0.4, 0.38, 0.36])
  .addBox([-10.65, 0.25, 0], [0.15, 0.25, 11], [0.4, 0.38, 0.36])
  .addBox([10.65, 0.25, 0], [0.15, 0.25, 11], [0.4, 0.38, 0.36]);
for (let line = -10; line <= 10; line += 2) {
  arena.addBox([line, 0.002, 0], [0.02, 0.002, 10.5], [0.3, 0.31, 0.35]);
  arena.addBox([0, 0.002, line], [10.5, 0.002, 0.02], [0.3, 0.31, 0.35]);
}
for (const at of PILLARS) arena.addCylinder(at, 0.7, 1.25, 'y', [0.55, 0.5, 0.45], 0, 24);
const arenaMesh = renderer.createMesh(arena.build());
const puckMesh = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([0, 0, 0], 0.6, 0.14, 'y', [0.2, 0.22, 0.26], 0, 32, 0.5)
    .addCylinder([0, 0.16, 0], 0.32, 0.04, 'y', [0.85, 0.88, 0.92], 0, 24)
    .build(),
);
const rim: number[] = [];
for (let k = 0; k <= 48; k += 1) {
  const angle = (k / 48) * Math.PI * 2;
  rim.push(Math.cos(angle) * 0.62, 0, Math.sin(angle) * 0.62);
}
const rimMesh = renderer.createMesh(
  new MeshBuilder().addTube(rim, new Array<number>(49).fill(0.05), [1, 1, 1], 1).build(),
);

const env = createEnvironment({
  directionalDir: [0.4, 0.85, 0.35],
  directionalColor: [1.5, 1.45, 1.35],
  ambient: [0.35, 0.37, 0.44],
  ambientGround: [0.12, 0.12, 0.13],
  /* Emission is gated on how much of night there is, so the rim needs some of it to glow. */
  nightFactor: 0.6,
  emissiveGain: 2,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.6;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  15,
  renderer.shadowMapSize,
  lightMatrix,
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const RESTING: Vec3 = [0.15, 0.45, 1.2];
const BOOSTING: Vec3 = [1.6, 0.7, 0.15];
const BRAKING: Vec3 = [1.4, 0.12, 0.08];
const rimTint: Vec3 = [0, 0, 0];
const model = new Float32Array(IDENTITY);
/* Clear of the bindings panel, which shares the top of the frame with these lines. */
const bindings = document.querySelector<HTMLElement>('#bindings');
const readout = createReadout(renderer, 3, { clearRight: () => (bindings?.offsetWidth ?? 0) + 24 });
let time = 0;

/** What to press, said for the device the player last used. */
function prompt(): string {
  if (input.lastDevice === 'touch') return 'LEFT THUMB STEERS, TAP TO BOOST, HOLD TO BRAKE';
  const pad = input.lastDevice === 'gamepad' ? input.pad(0) : null;
  const first = (action: string): string => {
    for (const binding of actions.bindingsFor(action)) {
      if (pad !== null && binding.device === 'gamepad') return pad.identity.label(binding.button);
      if (pad === null && binding.device === 'keyboard') return keyName(binding.code);
    }
    return 'NOTHING';
  };
  const steer = pad === null ? 'WASD' : 'LEFT STICK';
  return `${steer} TO STEER, ${first('boost')} TO BOOST, ${first('brake')} TO BRAKE`.toUpperCase();
}

stage.run({
  simulate(dt) {
    time += dt;
    // #region tick
    listenToPads();
    touch.tick(performance.now());
    exported<Drive>(script, 'drive')(puck, actions, touch, dt);
    // #endregion
  },
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = 0;
    camera.position[1] = 18;
    camera.position[2] = 15.5;
    camera.lookAt(0, 0, 2.4);

    model.set(IDENTITY);
    model[12] = puck.x;
    model[13] = 0.35;
    model[14] = puck.z;
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(arenaMesh, IDENTITY);
      sink.mesh(puckMesh, model);
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.13, 0.14, 0.18]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(arenaMesh, IDENTITY);
    renderer.drawMesh(puckMesh, model);
    /* The rim: orange while boosting, red while braking, and flashing white on a hit. Its glow is
       a per-draw tint over a white emissive ring, so changing it allocates and rebuilds nothing. */
    const glow = puck.hit * 2;
    const base = puck.boost > 0 ? BOOSTING : puck.braking ? BRAKING : RESTING;
    rimTint[0] = base[0] + glow;
    rimTint[1] = base[1] + glow;
    rimTint[2] = base[2] + glow;
    renderer.drawMesh(rimMesh, model, undefined, rimTint);

    const pad = input.pad(0);
    const motors =
      pad === null ? 'NO PAD' : pad.canRumble ? 'PAD HAS MOTORS' : 'PAD HAS NO MOTORS HERE';
    readout.set(
      0,
      `LAST USED: ${input.lastDevice.toUpperCase()}${pad !== null && input.lastDevice === 'gamepad' ? ` (${pad.identity.family.toUpperCase()})` : ''}`,
    );
    readout.set(1, prompt());
    readout.set(
      2,
      `SPEED ${Math.hypot(puck.vx, puck.vz).toFixed(1)} M/S  BUMPS ${puck.bumps}  ${motors}`,
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
