/**
 * A headset, seen from across the room: where its head is, its two controllers, and the joints of
 * a tracked left hand, read every frame from a WebXR session.
 *
 * The session is a simulated one, the runtime `@driftengine/xr` runs its own tests against,
 * because almost nobody reading this has a headset on. What the browser in front of you answers
 * is written under the readout, asked for real. `headset.drs` turns the lamp up with the right trigger and
 * notices when a fingertip stops being tracked; the strip pulls the trigger, hides the fingertip,
 * takes the headset off, or asks this browser for a real session.
 *
 * The engine does not draw into a headset yet: the renderer draws to its canvas and to nothing
 * else, so a real session can be entered and read but shows nothing inside the headset.
 */
import {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createPointLightBuffer,
  selectPointLights,
} from '@driftengine/core';
import type { PointLightSource } from '@driftengine/core';
import type { XrRuntime } from '@driftengine/script';
import { patchModule } from 'driftscript';
import {
  HandSkeleton,
  JOINT_COUNT,
  controllerFor,
  enterXr,
  probeXrSupport,
  readControllers,
  readHand,
} from '@driftengine/xr';
import type { ControllerState, XrFrame, XrSession, XrSupport } from '@driftengine/xr';
import { syntheticXr } from '@driftengine/xr/src/testing/synthetic.ts';
import type { SyntheticSession } from '@driftengine/xr/src/testing/synthetic.ts';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as headsetScript from './headset.drs';

const stage = await openStage({ outputTransform: 'aces', sceneSamples: 4 });
const { renderer, camera } = stage;
const readout = createReadout(renderer, 3);
const answer = document.querySelector<HTMLElement>('#answer');

// #region probe
/* Asked by doing: a context of its own is offered to be made XR compatible, which is the step
   that fails on a machine with no headset attached even where every mode reports supported. */
const here = await probeXrSupport(document.createElement('canvas').getContext('webgl2'));

function said(support: XrSupport): string {
  if (!support.present) return 'this browser has no WebXR';
  const modes = [
    support.immersiveVr ? 'immersive-vr' : '',
    support.immersiveAr ? 'immersive-ar' : '',
    support.inline ? 'inline' : '',
  ].filter((mode) => mode !== '');
  const reason = support.reason.charAt(0).toUpperCase() + support.reason.slice(1);
  return `${modes.length === 0 ? 'no session mode' : modes.join(', ')}. ${reason}`;
}
// #endregion

// #region simulated
/* A runtime that answers: two controllers, the left one with a hand, and a frame only when asked
   for one. `probeXrSupport` takes it in place of the browser's. */
const system = syntheticXr({
  controllers: [{ handedness: 'left', hand: true }, { handedness: 'right' }],
});
const simulated = await probeXrSupport(null, system);
// #endregion

// #region session
let session: SyntheticSession | null = null;
let space: unknown = null;

/* The steps `enterXr` takes, without the layer: a simulated session has nothing to draw into. */
async function putOn(): Promise<void> {
  const started = (await system.requestSession('immersive-vr', {
    optionalFeatures: ['hand-tracking'],
  })) as SyntheticSession;
  space = await started.requestReferenceSpace('local-floor');
  leftHand.clear();
  started.addEventListener('end', () => {
    if (session === started) session = null;
  });
  session = started;
  session.requestAnimationFrame(onFrame);
}
// #endregion

// #region read
/* What the frame said, kept where the script and the drawing both read it. */
const head = new Float32Array(3);
let presenting = false;
const states: ControllerState[] = [];
const leftHand = new HandSkeleton();

function onFrame(_time: number, frame: XrFrame): void {
  const current = frame.session as XrSession;
  /* A session that has ended asks for no more frames. */
  if (current !== session) return;
  const pose = frame.getViewerPose(space) ?? null;
  presenting = pose !== null;
  if (pose !== null) head.set(pose.transform.matrix.subarray(12, 15));
  readControllers(current, frame, space, states);
  let sawLeft = false;
  for (const source of current.inputSources) {
    if (source.handedness !== 'left' || source.hand === undefined) continue;
    readHand(source, frame, space, leftHand);
    sawLeft = true;
  }
  /* A hand that is not there at all is forgotten; one merely out of view keeps its last poses. */
  if (!sawLeft) leftHand.clear();
  current.requestAnimationFrame(onFrame);
}
// #endregion

// #region host
/* What `drift/xr` reads, from the state the frame left. Nothing here is deterministic, so the
   script reads it in the frame and never in the fixed step. */
const xr: XrRuntime = {
  get support() {
    return simulated;
  },
  get headPosition() {
    return session !== null && presenting ? head : null;
  },
  controller: (hand) => (session === null ? null : controllerFor(states, hand)),
  hand: (hand) => (session !== null && hand === 'left' && leftHand.visible ? leftHand : null),
};
const script = hostScript(headsetScript, { xr });
interface Lamp {
  level: number;
  ease: number;
}
const lamp = exported<() => Lamp>(script, 'createLamp')();
if (import.meta.hot) {
  import.meta.hot.accept('./headset.drs', (next) => {
    if (next !== undefined) patchModule(script, next as Record<string, unknown>, { Lamp: [lamp] });
  });
}
const light = (dt: number): void =>
  exported<(l: Lamp, dt: number) => void>(script, 'light')(lamp, dt);
const tipSeen = (): boolean => exported<() => boolean>(script, 'tipSeen')();
// #endregion

// #region enter
/* A real session, from a click: `requestSession` needs a user gesture. The answer is a whole
   sentence either way, and a session that does start is ended, since nothing can be drawn into it. */
let real = '';
async function tryReal(): Promise<void> {
  real = 'asking…';
  tell();
  const entered = await enterXr({
    sources: { gl: document.createElement('canvas').getContext('webgl2', { xrCompatible: true }) },
  });
  if (!entered.ok) {
    real = entered.reason;
  } else {
    real = `entered on ${entered.run.referenceSpaceType} through ${entered.run.backend}, and ended, since nothing draws into it yet.`;
    await entered.run.end();
  }
  tell();
}

/* What this browser answered, and what a real session said when one was asked for. */
function tell(): void {
  if (answer === null) return;
  answer.textContent =
    `This browser: ${said(here)}` + (real === '' ? '' : ` A real session: ${real}`);
}
tell();
// #endregion

const TRIGGER = { released: 0, half: 0.5, pulled: 1 } as const;
let trigger = flag('trigger', 'half') as keyof typeof TRIGGER;
let fingertip = flag('fingertip', 'tracked');

/* The strip's state is laid on whatever session is running, and again on every new one. */
function arrange(): void {
  session?.setButton('right', 0, TRIGGER[trigger] ?? 0);
  session?.setJointTracked('left', 'index-finger-tip', fingertip === 'tracked');
}

async function wear(value: string): Promise<void> {
  if (value === 'simulated') {
    if (session === null) await putOn();
    arrange();
    return;
  }
  /* Taken off, or handed to the browser: the simulated session ends the way a runtime ends one. */
  system.endLatest();
  presenting = false;
  if (value === 'browser') await tryReal();
}

controls([
  {
    key: 'headset',
    label: 'Headset',
    value: 'simulated',
    options: [
      { text: 'simulated', value: 'simulated' },
      { text: 'taken off', value: 'off' },
      { text: "this browser's", value: 'browser' },
    ],
    change: wear,
  },
  {
    key: 'trigger',
    label: 'Right trigger',
    value: trigger,
    options: [
      { text: 'released', value: 'released' },
      { text: 'half', value: 'half' },
      { text: 'pulled', value: 'pulled' },
    ],
    change: (value) => {
      trigger = value as keyof typeof TRIGGER;
      arrange();
    },
  },
  {
    key: 'fingertip',
    label: 'Fingertip',
    value: fingertip,
    options: [
      { text: 'tracked', value: 'tracked' },
      { text: 'lost', value: 'lost' },
    ],
    change: (value) => {
      fingertip = value;
      arrange();
    },
  },
]);

await putOn();
arrange();

/* The room: a floor, a table, and a lamp hanging over it. */
const room = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, -0.05, 0], [3, 0.05, 3], [0.32, 0.3, 0.28])
    .addBox([0, 0.72, -0.75], [0.7, 0.03, 0.4], [0.45, 0.32, 0.22], 0, 0.3)
    .addBox([-0.6, 0.35, -1.05], [0.03, 0.35, 0.03], [0.3, 0.22, 0.16])
    .addBox([0.6, 0.35, -1.05], [0.03, 0.35, 0.03], [0.3, 0.22, 0.16])
    .addBox([-0.6, 0.35, -0.45], [0.03, 0.35, 0.03], [0.3, 0.22, 0.16])
    .addBox([0.6, 0.35, -0.45], [0.03, 0.35, 0.03], [0.3, 0.22, 0.16])
    .build(),
);
const LAMP_AT = [0, 1.75, -0.8] as const;
const globeLit = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.09, [1, 0.85, 0.6], 1).build(),
);
const globeDark = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.09, [0.5, 0.46, 0.4], 0, 12, 6, 0.3).build(),
);
/* The markers: the head, a controller idle and pulled, a joint tracked this frame and one whose
   pose is the last it had. Each is drawn where the frame put it. */
const headMark = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.09, 0.06, 0.1], [0.42, 0.45, 0.52], 0, 0.4).build(),
);
const idle = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.03, 0.03, 0.07], [0.55, 0.58, 0.64], 0, 0.4).build(),
);
const pulled = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.03, 0.03, 0.07], [0.95, 0.62, 0.3], 0.5, 0.4).build(),
);
const joint = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.004, 0.004, 0.004], [0.4, 0.8, 0.95], 0.8).build(),
);
const jointStale = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.004, 0.004, 0.004], [0.95, 0.45, 0.3], 0.8).build(),
);

const lamps: PointLightSource[] = [
  {
    x: LAMP_AT[0],
    y: LAMP_AT[1],
    z: LAMP_AT[2],
    r: 0,
    g: 0,
    b: 0,
    radius: 5,
    flicker: 0,
    shadowNear: 0.2,
    sourceRadius: 0.09,
  },
];
const env = createEnvironment({
  directionalColor: [0.16, 0.18, 0.24],
  ambient: [0.05, 0.055, 0.07],
  ambientGround: [0.02, 0.02, 0.02],
  emissiveGain: 1.2,
  nightFactor: 1,
});
const chosen = createPointLightBuffer(renderer.shadedLights);
const still = new SceneNode();
still.updateWorld();
const at = new Float32Array(16);

/* A translation into `at`, for a marker that is not turned. */
function place(x: number, y: number, z: number): Float32Array {
  at.fill(0);
  at[0] = at[5] = at[10] = at[15] = 1;
  at[12] = x;
  at[13] = y;
  at[14] = z;
  return at;
}

camera.fovYDeg = 50;
camera.near = 0.05;
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    /* One simulated frame for each of the page's. A real session's frames come from the headset. */
    system.advance(16);
    light(1 / 60);

    const orbit = time * 0.15;
    camera.position[0] = Math.sin(orbit) * 1.7;
    camera.position[1] = 1.85;
    camera.position[2] = Math.cos(orbit) * 1.7 - 0.35;
    /* Aimed left of the headset and above it, so it stands clear of the text in the top left. */
    camera.lookAt(-Math.cos(orbit) * 0.25, 1.4, -0.35 + Math.sin(orbit) * 0.25);

    const glow = lamp.level * 3;
    const [first] = lamps;
    if (first !== undefined) {
      first.r = glow;
      first.g = glow * 0.8;
      first.b = glow * 0.55;
    }
    const [x, y, z] = camera.position;
    selectPointLights(lamps, x, y, z, chosen, time, DEFAULT_POINT_LIGHT_VIEW_RANGE);
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;

    renderer.beginFrame([0.05, 0.055, 0.07]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(room, still.worldMatrix);
    renderer.drawMesh(
      lamp.level > 0.05 ? globeLit : globeDark,
      place(LAMP_AT[0], LAMP_AT[1], LAMP_AT[2]),
    );
    const wearing = session !== null && presenting;
    if (wearing) {
      renderer.drawMesh(headMark, place(head[0] ?? 0, head[1] ?? 0, head[2] ?? 0));
      for (const state of states) {
        const grip = state.gripMatrix;
        if (!state.tracked || grip === null) continue;
        const mesh = (state.pressed[0] ?? false) ? pulled : idle;
        renderer.drawMesh(mesh, place(grip[12] ?? 0, grip[13] ?? 0, grip[14] ?? 0));
      }
      const m = leftHand.matrices;
      for (let i = 0; i < JOINT_COUNT; i += 1) {
        /* A joint never seen since the hand arrived has no pose to draw. */
        if (m[i * 16 + 15] !== 1) continue;
        /* One the runtime stopped reporting keeps its last pose, and the flag says it is stale. */
        renderer.drawMesh(
          leftHand.tracked[i] === 1 ? joint : jointStale,
          place(m[i * 16 + 12] ?? 0, m[i * 16 + 13] ?? 0, m[i * 16 + 14] ?? 0),
        );
      }
    }

    const tracked = wearing ? leftHand.tracked.reduce((sum, value) => sum + value, 0) : 0;
    readout.set(
      0,
      wearing ? `HEADSET ON, HEAD AT ${(head[1] ?? 0).toFixed(2)} M` : 'HEADSET OFF, SESSION ENDED',
    );
    readout.set(
      1,
      `TRIGGER ${(controllerFor(states, 'right')?.buttons[0] ?? 0).toFixed(2)}, LAMP ${lamp.level.toFixed(2)}`,
    );
    readout.set(
      2,
      `HAND ${tracked} OF ${JOINT_COUNT} JOINTS, TIP ${wearing && tipSeen() ? 'SEEN' : 'LOST'}`,
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
