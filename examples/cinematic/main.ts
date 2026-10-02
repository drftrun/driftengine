/**
 * A buggy lapping a track with a jump, filmed three ways.
 *
 * Directed: `director.drs` watches the buggy and picks a shot, a low wide one as it takes off, an
 * orbit round the landing, the tower framed as it passes, and the page cuts a `CinematicCamera` to
 * it. A cut is instant and the motion inside a shot is smoothed. Timeline: a cinematic written as
 * data, shots and the lines shown under them, played by a `CinematicPlayer`. Path: a camera keyed
 * in world space and flown through on a curve. The time switch re-times the jump with a curve that
 * slows it in the air and pays the time back after, so a lap still takes as long.
 */
import {
  CinematicCamera,
  CinematicPlayer,
  ColliderSet,
  MeshBuilder,
  boxCollider,
  computeLightMatrix,
  createCameraPath,
  createCameraPathSample,
  createEnvironment,
  curveOffsetSec,
  defineCinematic,
  sampleCameraPath,
  timeCurve,
} from '@driftengine/core';
import type { ShotParams, Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as directorScript from './director.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

/* The track: an oval, a jump on its left side, and a tower in the middle. A lap is sixteen seconds,
   quicker on the straights. */
const LAP = 16;
const JUMP: readonly [number, number] = [Math.PI - 0.35, Math.PI + 0.35];
const RAMP = 0.15;
const TOWER: Vec3 = [0, 5, 0];
const angleAt = (lapSec: number): number =>
  ((Math.PI * 2 * lapSec) / LAP + 0.12 * Math.sin((Math.PI * 4 * lapSec) / LAP)) % (Math.PI * 2);
const pointAt = (angle: number, out: Vec3): Vec3 => {
  out[0] = 15 * Math.cos(angle);
  out[2] = 9 * Math.sin(angle);
  out[1] = heightAt(angle);
  return out;
};
function heightAt(angle: number): number {
  const [from, to] = JUMP;
  if (angle > from - RAMP && angle < from) return (0.9 * (angle - (from - RAMP))) / RAMP;
  if (angle >= from && angle <= to) {
    const u = (angle - from) / (to - from);
    return 0.9 + 2.6 * 4 * u * (1 - u);
  }
  if (angle > to && angle < to + RAMP) return 0.9 * (1 - (angle - to) / RAMP);
  return 0;
}

// #region time
/* The stretch of a lap the buggy spends over the jump, found once, and a curve that re-times it:
   slower in the air, quicker after, the same length in all. */
function lapSecAt(angle: number): number {
  let low = 0;
  let high = LAP / 2 + 2;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (angleAt(mid) < angle) low = mid;
    else high = mid;
  }
  return low;
}
const flightStart = lapSecAt(JUMP[0] - RAMP);
const flightEnd = lapSecAt(JUMP[1] + RAMP);
const slowMotion = timeCurve('ramp', flightEnd - flightStart, { amount: 0.75 });
let retimed = flag('time', 'real') === 'slow';
/** Where in its lap the buggy is, from the lap's clock, through the curve where it applies. */
function sourceSec(lapClock: number): number {
  if (!retimed || lapClock < flightStart || lapClock > flightEnd) return lapClock;
  return flightStart + curveOffsetSec(slowMotion, lapClock - flightStart);
}
// #endregion

// #region shots
/* The shots, as records the page owns. The director script answers with a place in this list. */
const SHOTS: readonly ShotParams[] = [
  { kind: 'chase', distance: 7, height: 2.2, fovDeg: 62 },
  { kind: 'lowWide', distance: 9, height: 0.7, fovDeg: 48 },
  { kind: 'orbit', distance: 8, height: 3, fovDeg: 55, orbitRate: 0.7 },
  { kind: 'flyby', distance: 10, height: 1.6, fovDeg: 45 },
  { kind: 'overhead', distance: 14, height: 16, fovDeg: 50 },
  { kind: 'lookAt', distance: 11, height: 3, fovDeg: 42, anchor: TOWER },
];
/* The rig keeps its boom out of the rocks, so it is given them. */
const ROCKS: Vec3[] = [
  [6, 0.8, 3],
  [-5, 0.8, -4],
  [9, 0.8, -12],
];
const rocks = new ColliderSet(ROCKS.map(([x, y, z]) => boxCollider(x, y, z, 1, 0.8, 1)));
const rig = new CinematicCamera(rocks);
/* The rig's own clock, which a cut is stamped with: a shot's age, and an orbit's angle, count
   from it. */
let rigClock = 0;
// #endregion

// #region director
const script = hostScript(directorScript);
interface Director {
  shot: number;
  cuts: number;
}
const director = exported<() => Director>(script, 'createDirector')();
type Direct = (
  director: Director,
  camera: CinematicCamera,
  airborne: boolean,
  nearTower: boolean,
) => number;
if (import.meta.hot) {
  import.meta.hot.accept('./director.drs', (next) => {
    if (next !== undefined) {
      patchModule(script, next as Record<string, unknown>, { Director: [director] });
    }
  });
}
// #endregion

// #region timeline
/* A cinematic written as data: when the camera cuts, a shot that moves while it holds, and the
   lines shown under the picture. Checked when it is defined, so a malformed one fails on load. */
const TRAILER = defineCinematic('trailer', {
  durationSec: 16,
  shots: [
    { atSec: 0, camera: { kind: 'overhead', distance: 16, height: 18, fovDeg: 48 } },
    { atSec: 3.5, camera: { kind: 'chase', distance: 6, height: 1.8, fovDeg: 64 } },
    {
      atSec: 7,
      camera: [
        {
          atSec: 0,
          camera: { kind: 'lookAt', distance: 14, height: 2, fovDeg: 40, anchor: TOWER },
        },
        { atSec: 4, camera: { kind: 'lookAt', distance: 8, height: 5, fovDeg: 50, anchor: TOWER } },
      ],
    },
    { atSec: 11.5, camera: { kind: 'flyby', distance: 9, height: 1.2, fovDeg: 44 } },
  ],
  lines: [
    { atSec: 0.5, holdSec: 2.5, text: 'ONE TRACK', look: 'title' },
    { atSec: 4, holdSec: 2.5, text: 'ONE JUMP', look: 'title' },
    { atSec: 8, holdSec: 3, text: 'EVERY LAP THE SAME LENGTH', look: 'title' },
    { atSec: 12, holdSec: 3, text: 'CUT ON THE MOMENT', look: 'title' },
  ],
});
const player = new CinematicPlayer(TRAILER, 'trailer');
// #endregion

// #region path
/* A move through the world with no subject: an eye and a point it looks at, keyed in time and
   passed through smoothly, looping round the track. */
const flight = createCameraPath(
  [
    { atSec: 0, eye: [22, 6, 16], target: [0, 1, 0], fovDeg: 50 },
    { atSec: 5, eye: [-8, 3, 14], target: [-15, 1, 0], fovDeg: 45 },
    { atSec: 10, eye: [-24, 9, -6], target: [-14, 1, 2], fovDeg: 40 },
    { atSec: 15, eye: [0, 20, -22], target: [0, 0, 0], fovDeg: 55 },
  ],
  { loop: true, periodSec: 20 },
);
const along = createCameraPathSample();
// #endregion

let mode = flag('camera', 'director');
controls([
  {
    key: 'camera',
    label: 'camera',
    value: mode,
    options: ['director', 'timeline', 'path'].map((m) => ({ text: m, value: m })),
    change: (value) => {
      mode = value;
      player.reset();
      rig.cut(SHOTS[director.shot] as ShotParams, rigClock);
    },
  },
  {
    key: 'time',
    label: 'jump',
    value: retimed ? 'slow' : 'real',
    options: ['real', 'slow'].map((t) => ({ text: t, value: t })),
    change: (value) => {
      retimed = value === 'slow';
    },
  },
]);

/* The scene: ground, the track as a ribbon, the ramps, rocks, the tower, and the buggy. */
const ground = new MeshBuilder().addBox([0, -0.1, 0], [40, 0.1, 40], [0.33, 0.4, 0.27]);
const at: Vec3 = [0, 0, 0];
const ahead: Vec3 = [0, 0, 0];
for (let k = 0; k < 120; k += 1) {
  const angle = (k / 120) * Math.PI * 2;
  if (angle > JUMP[0] - RAMP && angle < JUMP[1] + RAMP) continue;
  pointAt(angle, at);
  pointAt(angle + 0.06, ahead);
  ground.addOrientedBox(
    [at[0], 0.01, at[2]],
    [1.6, 0.01, 0.42],
    [ahead[0] - at[0], 0, ahead[2] - at[2]],
    [0.2, 0.19, 0.18],
  );
}
for (const [x, y, z] of ROCKS) ground.addBox([x, y, z], [1, 0.8, 1], [0.45, 0.43, 0.4]);
ground.addBox([TOWER[0], 2.5, TOWER[2]], [0.9, 2.5, 0.9], [0.55, 0.5, 0.45]);
ground.addBox([TOWER[0], 5.3, TOWER[2]], [1.2, 0.3, 1.2], [0.6, 0.25, 0.18]);
/* The take-off ramp and the landing, each a wedge across the track. */
for (const [edge, rising] of [
  [JUMP[0], true],
  [JUMP[1], false],
] as const) {
  const low = pointAt(rising ? edge - RAMP : edge + RAMP, [0, 0, 0]);
  const high = pointAt(edge, [0, 0, 0]);
  const half = 1.6;
  /* Each face both ways, since a wedge is seen from every side as the cameras move round it. */
  const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, colour: Vec3): void => {
    ground.addQuad(a, b, c, d, colour);
    ground.addQuad(d, c, b, a, colour);
  };
  face(
    [low[0] - half, 0.01, low[2]],
    [low[0] + half, 0.01, low[2]],
    [high[0] + half, 0.9, high[2]],
    [high[0] - half, 0.9, high[2]],
    [0.62, 0.45, 0.28],
  );
  face(
    [high[0] - half, 0.9, high[2]],
    [high[0] + half, 0.9, high[2]],
    [high[0] + half, 0, high[2]],
    [high[0] - half, 0, high[2]],
    [0.5, 0.36, 0.22],
  );
  for (const side of [-half, half]) {
    /* A triangle, as a quad whose fourth corner is halfway along its bottom edge. */
    face(
      [low[0] + side, 0.01, low[2]],
      [high[0] + side, 0.9, high[2]],
      [high[0] + side, 0, high[2]],
      [(low[0] + high[0]) / 2 + side, 0.005, (low[2] + high[2]) / 2],
      [0.5, 0.36, 0.22],
    );
  }
}
const groundMesh = renderer.createMesh(ground.build());
const buggy = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, 0.55, 0], [0.55, 0.25, 0.95], [0.85, 0.3, 0.12])
    .addBox([0, 0.9, 0.15], [0.45, 0.15, 0.45], [0.15, 0.17, 0.2])
    .addCylinder([0.6, 0.35, -0.6], 0.35, 0.12, 'x', [0.1, 0.1, 0.1], 0, 14)
    .addCylinder([-0.6, 0.35, -0.6], 0.35, 0.12, 'x', [0.1, 0.1, 0.1], 0, 14)
    .addCylinder([0.6, 0.35, 0.6], 0.35, 0.12, 'x', [0.1, 0.1, 0.1], 0, 14)
    .addCylinder([-0.6, 0.35, 0.6], 0.35, 0.12, 'x', [0.1, 0.1, 0.1], 0, 14)
    .build(),
);

const env = createEnvironment({
  directionalDir: [0.45, 0.75, 0.35],
  directionalColor: [1.7, 1.6, 1.45],
  ambient: [0.42, 0.46, 0.55],
  ambientGround: [0.16, 0.15, 0.12],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.65;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  26,
  renderer.shadowMapSize,
  lightMatrix,
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(16);
const readout = createReadout(renderer, 3);
const position: Vec3 = [0, 0, 0];
const next: Vec3 = [0, 0, 0];
let lapClock = 0;
let time = 0;
let yaw = 0;
let pathSec = 0;
let caption = '';

stage.run({
  simulate(dt) {
    time += dt;
    lapClock = (lapClock + dt) % LAP;
    const angle = angleAt(sourceSec(lapClock));
    pointAt(angle, position);
    pointAt(angle + 0.02, next);
    yaw = Math.atan2(next[0] - position[0], -(next[2] - position[2]));
    const airborne = position[1] > 1;
    const nearTower =
      Math.abs(angle - Math.PI / 2) < 0.35 || Math.abs(angle - 1.5 * Math.PI) < 0.35;

    // #region frame
    caption = '';
    if (mode === 'director') {
      const shot = exported<Direct>(script, 'direct')(director, rig, airborne, nearTower);
      if (shot >= 0) rig.cut(SHOTS[shot] as ShotParams, rigClock);
    } else if (mode === 'timeline') {
      player.update(dt);
      if (player.shotChanged && player.shot !== null) rig.cut(player.shot, rigClock);
      caption = player.line?.text ?? '';
      if (player.finished) player.reset();
    }
    if (mode === 'path') {
      pathSec += dt;
      sampleCameraPath(flight, pathSec, along);
      camera.position[0] = along.eye[0];
      camera.position[1] = along.eye[1];
      camera.position[2] = along.eye[2];
      camera.lookAt(along.target[0], along.target[1], along.target[2]);
      camera.fovYDeg = along.fovDeg;
    } else {
      rigClock += dt;
      rig.update(dt, position[0], position[1], position[2], yaw);
      camera.position[0] = rig.camera.position[0] ?? 0;
      camera.position[1] = rig.camera.position[1] ?? 0;
      camera.position[2] = rig.camera.position[2] ?? 0;
      camera.yaw = rig.camera.yaw;
      camera.pitch = rig.camera.pitch;
      camera.fovYDeg = rig.camera.fovYDeg;
    }
    // #endregion
  },
  render() {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    model.set([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, position[0], position[1], position[2], 1]);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(groundMesh, IDENTITY);
      sink.mesh(buggy, model);
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.55, 0.66, 0.8]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(groundMesh, IDENTITY);
    renderer.drawMesh(buggy, model);
    const shotName = mode === 'path' ? 'A KEYED PATH' : shotLabel().toUpperCase();
    readout.set(0, `${mode.toUpperCase()}  ${shotName}  CUTS ${director.cuts}`);
    readout.set(
      1,
      mode === 'timeline'
        ? `TRAILER ${player.timeSec.toFixed(1)} / ${TRAILER.durationSec} S`
        : `LAP ${lapClock.toFixed(1)} S  JUMP ${retimed ? 'SLOWED, PAID BACK AFTER' : 'IN REAL TIME'}`,
    );
    readout.set(2, caption);
    readout.draw(time);
    renderer.endFrame();
  },
});

/** The shot the rig is in, by its kind. */
function shotLabel(): string {
  const shot = mode === 'timeline' ? player.shot : SHOTS[director.shot];
  return shot === null || shot === undefined ? '' : `${shot.kind} ${rig.shotAgeSec.toFixed(1)} S`;
}
