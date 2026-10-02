/**
 * A courtyard at dusk, heard from wherever the camera stands.
 *
 * The camera is the listener. A bell in the tower strikes on a clock `courtyard.drs` keeps, heard
 * the cheap way, louder the nearer you are and on its own side, and the music ducks under it. A
 * cart rolls along the far road through an HRTF panner with doppler, muffled while the house is
 * between it and you, and the fire is placed the same way. In the crypt its reverb takes over and
 * the script crossfades the mix to a snapshot; the wind is a bus the script fades; the lanterns
 * keep time with the kick the music is making. Every sound is synthesised, so the page loads none.
 */
import {
  AudioGraph,
  addReverbZone,
  createListener,
  createSpatialSource,
  fireLoopBuffer,
  metalBuffer,
  noiseBuffer,
  windLoopBuffer,
} from '@driftengine/audio';
import type { OcclusionProbe } from '@driftengine/audio';
import {
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createPointLightBuffer,
  selectPointLights,
} from '@driftengine/core';
import type { PointLightSource, Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import { beatBuffer } from './beat';
import * as courtyardScript from './courtyard.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region graph
/* The graph: one music stem into a mix of buses. A browser that will give no audio at all still
   gets a graph, on a context that never plays, so the page and its script run the same. */
const graph =
  (await AudioGraph.create({ stemCount: 1 })) ??
  (await AudioGraph.create({ stemCount: 1, context: new OfflineAudioContext(2, 1, 48000) }));
if (graph === null) throw new Error('no audio graph, even offline');
const mix = graph.console;

/* Every sound is a named slot: its files are tried first and its synth stands in when none loads.
   This page lists no files, so all five are made here. */
const sounds = graph.registry;
sounds.register('bell', { urls: [], synth: (context) => metalBuffer(context, 5, 155, 0.9) });
sounds.register('wheels', { urls: [], synth: (context) => noiseBuffer(context, 3, 0, () => 0.05) });
sounds.register('fire', { urls: [], synth: (context) => fireLoopBuffer(context) });
sounds.register('wind', { urls: [], synth: (context) => windLoopBuffer(context) });
sounds.register('beat', { urls: [], synth: beatBuffer });
await sounds.load(graph.context);
const slot = (name: string): AudioBuffer => {
  const buffer = sounds.get(name);
  if (buffer === undefined) throw new Error(`the ${name} slot did not build`);
  return buffer;
};
graph.loadStem(0, slot('beat'));
graph.setStemGain(0, 0.8);
// #endregion

// #region mix
/* The yard's own sounds on a bus of their own, under the effects, so the crypt can turn them down. */
const yard = mix.bus('yard', { parent: graph.layout.effects });
/* Two mixes the script recalls by name: the yard as it is, and the crypt, where the music and the
   yard are far away. */
mix.snapshot('yard');
graph.layout.music.setLevel(0.35);
yard.setLevel(0.4);
mix.snapshot('crypt');
graph.layout.music.setLevel(1);
yard.setLevel(1);
/* The wind, on a bus made after both snapshots: a recall leaves alone a bus it never saw, so the
   weather belongs to the script's `fade` and to nothing else. */
const wind = mix.bus('wind', { parent: graph.layout.effects, level: 0 });
const gusts = graph.context.createBufferSource();
gusts.buffer = slot('wind');
gusts.loop = true;
gusts.connect(wind.input);
// #endregion

// #region place
/* The ears, and the things heard from a place: a room the listener can stand in, the fire, and a
   cart that passes. A placed source is the expensive path, for when the direction is information. */
const listener = createListener(mix);
const crypt = addReverbZone(
  listener,
  'crypt',
  { x: 9.5, y: 1.5, z: -7.5, radius: 2.2, blend: 1.5 },
  { seconds: 3.4, decay: 2.2, wet: 0.85 },
);
const fire = createSpatialSource(listener, slot('fire'), { loop: true, bus: yard, refDistance: 2 });
const cart = createSpatialSource(listener, slot('wheels'), {
  loop: true,
  bus: yard,
  doppler: true,
  refDistance: 4,
});
fire.place(1.5, 0.4, -3, 0);

/* What a line from a sound to the ears can be blocked by: the house, the tower and the crypt's
   walls, as boxes. The listener asks, spread over the sources, and the answer is smoothed. */
const SOLIDS: readonly (readonly number[])[] = [
  [-5, 0, -12.2, 5, 4.4, -9.8],
  [-10.4, 0, -8.4, -7.6, 8, -5.6],
  [7, 0, -10, 12, 3, -9.65],
  [7, 0, -10, 7.35, 3, -5],
  [11.65, 0, -10, 12, 3, -5],
  [7, 0, -5.35, 8.8, 3, -5],
  [10.2, 0, -5.35, 12, 3, -5],
];
const walls: OcclusionProbe = (ax, ay, az, bx, by, bz) => {
  for (const box of SOLIDS) if (crosses(box, ax, ay, az, bx, by, bz)) return 0.85;
  return 0;
};
listener.probe = walls;
// #endregion

/** Whether the segment from a to b passes through a box, by the slab test. */
function crosses(
  box: readonly number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  let enter = 0;
  let leave = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const from = axis === 0 ? ax : axis === 1 ? ay : az;
    const span = (axis === 0 ? bx : axis === 1 ? by : bz) - from;
    const low = box[axis] ?? 0;
    const high = box[axis + 3] ?? 0;
    if (Math.abs(span) < 1e-9) {
      if (from < low || from > high) return false;
      continue;
    }
    const a = (low - from) / span;
    const b = (high - from) / span;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return false;
  }
  return true;
}

// #region script
/* The script, bound to the mix and the sounds, and to the kick detector listening to the music. */
const kick = graph.createKickDetector();
const script = hostScript(courtyardScript, {
  audio: { graph, registry: sounds, ...(kick === null ? {} : { kick }) },
});
interface Courtyard {
  every: number;
  next: number;
  since: number;
  strikes: number;
  clock: number;
  windy: boolean;
  glow: number;
}
interface Ears {
  x: number;
  z: number;
  yaw: number;
  indoors: boolean;
}
const court = exported<() => Courtyard>(script, 'createCourtyard')();
const ears = exported<() => Ears>(script, 'createEars')();
type Tick = (yard: Courtyard, ears: Ears, dt: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./courtyard.drs', (next) => {
    if (next !== undefined) {
      patchModule(script, next as Record<string, unknown>, { Courtyard: [court], Ears: [ears] });
    }
  });
}
// #endregion

// #region gesture
/* A context only plays after a gesture on the page, so the first click or key wakes it and starts
   the music and the loops. Started before one, each would only add a warning to the console. */
let started = false;
const listen = (): void => {
  graph.wake();
  if (started) return;
  started = true;
  graph.start();
  gusts.start();
  fire.start();
  cart.start();
};
addEventListener('pointerdown', listen);
addEventListener('keydown', listen);
// #endregion

/** Where the listener can stand, and what it looks at from there. */
const SPOTS: Record<string, { label: string; at: Vec3; look: Vec3 }> = {
  fire: { label: 'BY THE FIRE', at: [2.5, 1.7, 5], look: [0, 3, -8] },
  tower: { label: 'BY THE TOWER', at: [-4.5, 1.7, 3.5], look: [-9, 7, -7] },
  crypt: { label: 'IN THE CRYPT', at: [9.5, 1.6, -9.2], look: [9.5, 1.8, 0] },
  walk: { label: 'WALKING ROUND', at: [9, 1.7, -3], look: [1.5, 1.5, -3] },
};
let spot = flag('listen', 'fire');
court.every = flag('bell', 'slow') === 'quick' ? 4 : 10;
court.windy = flag('weather', 'calm') === 'windy';
const muffle = (on: boolean): void => {
  listener.probe = on ? walls : null;
  /* Without a probe a source keeps the last answer, so say plainly that nothing is in the way. */
  if (!on) {
    fire.setOcclusion(0);
    cart.setOcclusion(0);
  }
};
muffle(flag('walls', 'muffle') === 'muffle');
controls([
  {
    key: 'listen',
    label: 'listen',
    value: spot,
    options: Object.keys(SPOTS).map((s) => ({ text: s, value: s })),
    change: (value) => {
      spot = value;
    },
  },
  {
    key: 'bell',
    label: 'bell',
    value: court.every === 4 ? 'quick' : 'slow',
    options: ['slow', 'quick'].map((b) => ({ text: b, value: b })),
    change: (value) => {
      court.every = value === 'quick' ? 4 : 10;
    },
  },
  {
    key: 'weather',
    label: 'weather',
    value: court.windy ? 'windy' : 'calm',
    options: ['calm', 'windy'].map((w) => ({ text: w, value: w })),
    change: (value) => {
      court.windy = value === 'windy';
    },
  },
  {
    key: 'walls',
    label: 'walls',
    value: listener.probe === null ? 'ignore' : 'muffle',
    options: ['muffle', 'ignore'].map((w) => ({ text: w, value: w })),
    change: (value) => muffle(value === 'muffle'),
  },
]);

/* The yard, built once: ground and road, the house, the tower and its bell, the crypt, the fire's
   stones and the lantern posts. */
const BELL: Vec3 = [-9, 9.3, -7];
const FIRE: Vec3 = [1.5, 0, -3];
const LANTERNS: Vec3[] = [0, 1, 2, 3, 4].map((k) => {
  const angle = (k / 5) * Math.PI * 2 + 1;
  return [FIRE[0] + Math.cos(angle) * 4.6, 2.75, FIRE[2] + Math.sin(angle) * 4.6];
});
/* And one outside the crypt's door, which is what can be seen from inside it. */
LANTERNS.push([9.5, 2.75, 2.5]);
const stone: Vec3 = [0.46, 0.43, 0.4];
const built = new MeshBuilder()
  .addBox([0, -0.1, -4], [26, 0.1, 18], [0.2, 0.19, 0.18])
  .addBox([0, 0.005, -16], [30, 0.005, 1.6], [0.12, 0.11, 0.1])
  .addBox([0, 2.2, -11], [5, 2.2, 1.2], [0.42, 0.36, 0.3])
  .addBox([0, 4.55, -11], [5.4, 0.25, 1.6], [0.3, 0.18, 0.14])
  .addBox([-9, 4, -7], [1.4, 4, 1.4], stone)
  .addBox([-9, 10.6, -7], [1.6, 0.25, 1.6], [0.3, 0.18, 0.14])
  .addCylinder([BELL[0], BELL[1], BELL[2]], 0.5, 0.45, 'y', [0.55, 0.38, 0.16], 0, 24, 0.6)
  .addBox([9.5, 1.5, -9.825], [2.5, 1.5, 0.175], stone)
  .addBox([7.175, 1.5, -7.5], [0.175, 1.5, 2.5], stone)
  .addBox([11.825, 1.5, -7.5], [0.175, 1.5, 2.5], stone)
  .addBox([7.9, 1.5, -5.175], [0.9, 1.5, 0.175], stone)
  .addBox([11.1, 1.5, -5.175], [0.9, 1.5, 0.175], stone)
  .addBox([9.5, 2.6, -5.175], [0.7, 0.4, 0.175], stone)
  .addBox([9.5, 3.15, -7.5], [2.7, 0.15, 2.7], [0.3, 0.29, 0.28]);
for (const [dx, dz] of [
  [-1.25, -1.25],
  [1.25, -1.25],
  [-1.25, 1.25],
  [1.25, 1.25],
]) {
  built.addBox([-9 + (dx ?? 0), 9.2, -7 + (dz ?? 0)], [0.15, 1.2, 0.15], stone);
}
for (let k = 0; k < 12; k += 1) {
  const angle = (k / 12) * Math.PI * 2;
  built.addSphere(
    [FIRE[0] + Math.cos(angle) * 0.7, 0.1, FIRE[2] + Math.sin(angle) * 0.7],
    0.14,
    [0.3, 0.29, 0.28],
  );
}
for (const at of LANTERNS) built.addBox([at[0], 1.3, at[2]], [0.06, 1.3, 0.06], [0.1, 0.1, 0.1]);
const yardMesh = renderer.createMesh(built.build());
const flame = renderer.createMesh(
  new MeshBuilder()
    .addCapsule([0, 0.3, 0], 0.22, 0.12, [1, 0.38, 0.08], 1)
    .addCapsule([0.05, 0.55, -0.03], 0.13, 0.1, [1, 0.62, 0.2], 1)
    .addSphere([-0.03, 0.78, 0.02], 0.07, [1, 0.85, 0.45], 1)
    .build(),
);
const heads = new MeshBuilder();
for (const at of LANTERNS) {
  heads.addBox(at, [0.12, 0.16, 0.12], [1, 0.7, 0.35], 1);
  heads.addBox([at[0], at[1] + 0.2, at[2]], [0.16, 0.04, 0.16], [0.08, 0.08, 0.08]);
}
const headMesh = renderer.createMesh(heads.build());
const cartMesh = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, 0.85, 0], [1.3, 0.35, 0.7], [0.36, 0.22, 0.12])
    .addCylinder([-0.8, 0.42, 0.75], 0.42, 0.06, 'z', [0.16, 0.12, 0.09], 0, 16)
    .addCylinder([0.8, 0.42, 0.75], 0.42, 0.06, 'z', [0.16, 0.12, 0.09], 0, 16)
    .addCylinder([-0.8, 0.42, -0.75], 0.42, 0.06, 'z', [0.16, 0.12, 0.09], 0, 16)
    .addCylinder([0.8, 0.42, -0.75], 0.42, 0.06, 'z', [0.16, 0.12, 0.09], 0, 16)
    .build(),
);
/* The ring drawn round the bell as it strikes, a circle one metre across scaled out as it fades. */
const circle: number[] = [];
for (let k = 0; k <= 48; k += 1) {
  const angle = (k / 48) * Math.PI * 2;
  circle.push(Math.cos(angle), 0, Math.sin(angle));
}
const ringMesh = renderer.createMesh(
  new MeshBuilder()
    .addTube(circle, new Array<number>(circle.length / 3).fill(0.025), [1, 0.85, 0.5], 1)
    .build(),
);

const env = createEnvironment({
  directionalDir: [0.35, 0.55, 0.6],
  directionalColor: [0.55, 0.5, 0.62],
  ambient: [0.13, 0.14, 0.22],
  ambientGround: [0.05, 0.05, 0.06],
  nightFactor: 0.8,
  emissiveGain: 1.4,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.6;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  2,
  -6,
  20,
  renderer.shadowMapSize,
  lightMatrix,
);
const lights: PointLightSource[] = [
  {
    x: FIRE[0],
    y: 0.6,
    z: FIRE[2],
    r: 3,
    g: 1.4,
    b: 0.45,
    radius: 7,
    flicker: 0.3,
    shadowNear: 0.1,
    sourceRadius: 0.25,
    castsShadow: false,
  },
  ...LANTERNS.map((at) => ({
    x: at[0],
    y: at[1],
    z: at[2],
    r: 0,
    g: 0,
    b: 0,
    radius: 5,
    flicker: 0,
    shadowNear: 0.1,
    sourceRadius: 0.15,
    castsShadow: false,
  })),
];
const chosen = createPointLightBuffer(renderer.shadedLights);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(IDENTITY);
const readout = createReadout(renderer, 3);
const eye: Vec3 = [...(SPOTS[spot] ?? (SPOTS.fire as { at: Vec3 })).at];
const gaze: Vec3 = [...(SPOTS[spot] ?? (SPOTS.fire as { look: Vec3 })).look];
const cartAt: Vec3 = [-30, 0, -16];
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    // #region frame
    /* The camera glides to where it was asked to stand, and the ears go with it. */
    const target = SPOTS[spot] ?? (SPOTS.fire as { at: Vec3; look: Vec3 });
    if (spot === 'walk') {
      const angle = time * ((Math.PI * 2) / 50);
      target.at[0] = 0.5 + Math.cos(angle) * 6.2;
      target.at[2] = -2.5 + Math.sin(angle) * 6.2;
    }
    const ease = 1 - Math.exp(-dt * 1.6);
    for (let axis = 0; axis < 3; axis += 1) {
      eye[axis] = (eye[axis] ?? 0) + ((target.at[axis] ?? 0) - (eye[axis] ?? 0)) * ease;
      gaze[axis] = (gaze[axis] ?? 0) + ((target.look[axis] ?? 0) - (gaze[axis] ?? 0)) * ease;
    }
    camera.position[0] = eye[0];
    camera.position[1] = eye[1];
    camera.position[2] = eye[2];
    camera.lookAt(gaze[0], gaze[1], gaze[2]);
    listener.set(eye[0], eye[1], eye[2], camera.yaw, camera.pitch, dt);

    /* The cart goes round: along the road, and back to the start without having travelled. */
    cartAt[0] += dt * 7;
    if (cartAt[0] > 30) {
      cartAt[0] = -30;
      cart.warp(cartAt[0], 0.6, cartAt[2]);
    }
    cart.place(cartAt[0], 0.6, cartAt[2], dt);
    fire.place(FIRE[0], 0.4, FIRE[2], dt);
    kick?.update(performance.now());

    /* What the script needs to know, and then the script. */
    ears.x = eye[0];
    ears.z = eye[2];
    ears.yaw = camera.yaw;
    ears.indoors = eye[0] > 7.35 && eye[0] < 11.65 && eye[2] > -9.65 && eye[2] < -5.35;
    exported<Tick>(script, 'tick')(court, ears, dt);
    // #endregion
  },
  render() {
    camera.fovYDeg = 62;
    for (let k = 0; k < LANTERNS.length; k += 1) {
      const light = lights[k + 1] as PointLightSource;
      light.r = 2.4 * court.glow;
      light.g = 1.5 * court.glow;
      light.b = 0.6 * court.glow;
    }
    selectPointLights(
      lights,
      camera.position[0],
      camera.position[1],
      camera.position[2],
      chosen,
      time,
    );
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;
    model.set(IDENTITY);
    model[12] = cartAt[0];
    model[14] = cartAt[2];

    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(yardMesh, IDENTITY);
      sink.mesh(cartMesh, model);
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.1, 0.11, 0.18]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(yardMesh, IDENTITY);
    renderer.drawMesh(cartMesh, model);
    const flicker = 1 + Math.sin(time * 13) * 0.06 + Math.sin(time * 29) * 0.04;
    model.set([1, 0, 0, 0, 0, flicker, 0, 0, 0, 0, 1, 0, FIRE[0], 0, FIRE[2], 1]);
    renderer.drawMesh(flame, model);
    /* The heads glow with the kick, through the pass's emissive gain and back. */
    renderer.setEmissiveGain(env.emissiveGain * court.glow);
    renderer.drawMesh(headMesh, IDENTITY);
    renderer.setEmissiveGain(env.emissiveGain);
    if (court.since >= 0 && court.since < 2) {
      const scale = 0.8 + court.since * 2;
      model.set([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, BELL[0], BELL[1], BELL[2], 1]);
      renderer.drawTranslucentMesh(ringMesh, model, (1 - court.since / 2) * 0.7);
    }

    const ducked = graph.layout.music.duckedTo;
    readout.set(
      0,
      `${graph.audible ? 'LISTENING' : 'CLICK ANYWHERE TO HEAR IT'}  ${SPOTS[spot]?.label ?? ''}  MUSIC x${ducked.toFixed(2)}`,
    );
    readout.set(
      1,
      `CART ${(cart.occlusion * 100).toFixed(0)}% MUFFLED  ${cart.detuneCents >= 0 ? '+' : ''}${cart.detuneCents.toFixed(0)} CENTS  CRYPT ${(listener.zoneSend(crypt) * 100).toFixed(0)}%`,
    );
    readout.set(
      2,
      `BELL ${court.strikes}, NEXT IN ${Math.max(0, court.next - court.clock).toFixed(1)} S  KICK ${(kick?.pulse ?? 0).toFixed(2)}`,
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
