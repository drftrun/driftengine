/**
 * Three ways to keep what is on screen: a still, a clip recorded as it plays, and a clip rendered
 * frame by frame.
 *
 * Seven pillars rise and chime round a turning plinth while the camera circles them; `show.drs`
 * says where everything is at every instant. The panel saves a still, records four seconds in real
 * time with the mix underneath, or renders four seconds offline, each frame stamped with where it
 * belongs. The strip picks the clip's shape, its rate and whether it carries a mark.
 */
import { AudioGraph, toneBuffer } from '@driftengine/audio';
import {
  FrameRecorder,
  MeshBuilder,
  clipBitrate,
  computeLightMatrix,
  createEnvironment,
  describeClipMime,
  srgbColor,
  stillFrame,
} from '@driftengine/core';
import type { FrameOverlay, MeshHandle, Vec3 } from '@driftengine/core';
import { ClipEncoder, clipEncodingSupported, framesReachEncoder } from '@driftengine/media';
import { patchModule } from 'driftscript';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as showScript from './show.drs';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.05, 0.06, 0.09);

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera, canvas } = stage;

// #region script
/* The show's clock lives in a record the page owns; the rules are read through the module on every
   call, so a save changes the next frame. */
const show = hostScript(showScript);
interface Show {
  time: number;
}
interface Rules {
  step(show: Show, dt: number): void;
  height(time: number, slot: number): number;
  glow(time: number, slot: number): number;
  lit(from: number, to: number, slot: number): boolean;
  turn(time: number): number;
  orbitX(time: number): number;
  orbitZ(time: number): number;
}
const rules = (): Rules => show.exports as unknown as Rules;
const live = exported<() => Show>(show, 'createShow')();
if (import.meta.hot) {
  import.meta.hot.accept('./show.drs', (next) => {
    if (next !== undefined) patchModule(show, next as Record<string, unknown>, { Show: [live] });
  });
}
// #endregion

// #region switches
const FORMATS = {
  landscape: { width: 1280, height: 720 },
  square: { width: 1080, height: 1080 },
  portrait: { width: 720, height: 1280 },
} as const;
type Format = keyof typeof FORMATS;
let format: Format =
  flag('format', 'landscape') in FORMATS ? (flag('format', 'landscape') as Format) : 'landscape';
let rate = Number(flag('rate', '30')) === 60 ? 60 : 30;
let marked = flag('mark', 'on') === 'on';
const SECONDS = 4;

controls([
  {
    key: 'format',
    label: 'clip',
    value: format,
    options: Object.keys(FORMATS).map((f) => ({ text: f, value: f })),
    change: (value) => {
      format = value as Format;
    },
  },
  {
    key: 'rate',
    label: 'rate',
    value: String(rate),
    options: ['30', '60'].map((r) => ({ text: `${r} fps`, value: r })),
    change: (value) => {
      rate = Number(value);
    },
  },
  {
    key: 'mark',
    label: 'mark',
    value: marked ? 'on' : 'off',
    options: ['on', 'off'].map((m) => ({ text: m, value: m })),
    change: (value) => {
      marked = value === 'on';
    },
  },
]);
// #endregion

// #region mark
/* Baked once per frame size: the engine's name in the corner. The clock is drawn live into every
   frame, after the scene and the mark, because it changes. */
const MARK: FrameOverlay = {
  texts: [{ text: 'DRIFTENGINE', x: 0.04, y: 0.05, cell: 0.006, color: '#e9edf5', alpha: 0.85 }],
};

function clock(time: () => number) {
  return (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
    const size = Math.round(Math.min(width, height) * 0.035);
    ctx.font = `${size}px ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(233, 237, 245, 0.85)';
    ctx.fillText(`${time().toFixed(1)} s`, width * 0.96, height * 0.94);
  };
}
// #endregion

/* The stage: a dark floor, a plinth and seven pillars with glowing caps. */
const SLOTS = 7;
const CAP_COLORS: Vec3[] = [
  [1, 0.45, 0.2],
  [1, 0.75, 0.25],
  [0.6, 1, 0.35],
  [0.25, 0.95, 0.85],
  [0.3, 0.6, 1],
  [0.7, 0.4, 1],
  [1, 0.35, 0.7],
];
const floorMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, -0.1, 0], [12, 0.1, 12], [0.05, 0.055, 0.07]).build(),
);
const plinthMesh = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([0, 0.25, 0], 1.6, 0.25, 'y', [0.3, 0.31, 0.36], 0, 48, 0.3)
    .addBox([0, 0.62, 0], [0.5, 0.12, 0.5], [0.8, 0.78, 0.72], 0)
    .build(),
);
const pillarMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0.5, 0], [0.22, 0.5, 0.22], [0.42, 0.43, 0.48]).build(),
);
const capMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.26, 0.05, 0.26], [1, 1, 1], 1).build(),
);
const env = createEnvironment({
  directionalDir: [0.4, 0.8, 0.45],
  directionalColor: [0.45, 0.42, 0.4],
  ambient: [0.08, 0.09, 0.13],
  ambientGround: [0.06, 0.06, 0.08],
  nightFactor: 0.8,
  emissiveGain: 2.5,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.6;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  9,
  renderer.shadowMapSize,
  lightMatrix,
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const models = Array.from({ length: SLOTS * 2 + 1 }, () => new Float32Array(IDENTITY));
const tint: Vec3 = [0, 0, 0];

// #region draw
/* One frame of the show at `time`, whoever is asking: the live loop and the offline render both
   draw through here, so a rendered clip is the picture the page shows. */
function draw(time: number, aspect: number): void {
  const r = rules();
  camera.fovYDeg = 42;
  camera.position[0] = r.orbitX(time);
  camera.position[1] = 5.2;
  camera.position[2] = r.orbitZ(time);
  camera.lookAt(0, 1, 0);
  camera.updateMatrices(aspect);

  const turn = r.turn(time);
  const plinth = models[0] as Float32Array;
  plinth.set([
    Math.cos(turn),
    0,
    -Math.sin(turn),
    0,
    0,
    1,
    0,
    0,
    Math.sin(turn),
    0,
    Math.cos(turn),
    0,
    0,
    0,
    0,
    1,
  ]);
  const placed: { mesh: MeshHandle; model: Float32Array; slot: number }[] = [];
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const angle = (slot / SLOTS) * Math.PI * 2;
    const x = Math.cos(angle) * 3.2;
    const z = Math.sin(angle) * 3.2;
    const height = r.height(time, slot);
    const pillar = models[1 + slot * 2] as Float32Array;
    pillar.set(IDENTITY);
    pillar[5] = height;
    pillar[12] = x;
    pillar[14] = z;
    const cap = models[2 + slot * 2] as Float32Array;
    cap.set(IDENTITY);
    cap[12] = x;
    cap[13] = height + 0.05;
    cap[14] = z;
    placed.push({ mesh: pillarMesh, model: pillar, slot: -1 }, { mesh: capMesh, model: cap, slot });
  }

  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters((sink) => {
    sink.mesh(plinthMesh, plinth);
    for (const { mesh, model } of placed) sink.mesh(mesh, model);
  });
  renderer.endShadowPass();
  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floorMesh, IDENTITY);
  renderer.drawMesh(plinthMesh, plinth);
  for (const { mesh, model, slot } of placed) {
    if (slot < 0) {
      renderer.drawMesh(mesh, model);
      continue;
    }
    const color = CAP_COLORS[slot] as Vec3;
    const glow = 0.2 + r.glow(time, slot) * 5;
    tint[0] = color[0] * glow;
    tint[1] = color[1] * glow;
    tint[2] = color[2] * glow;
    renderer.drawMesh(mesh, model, undefined, tint);
  }
}
// #endregion

// #region sound
/* A chime per pillar, a fifth apart up the ring. The same slots on a live graph and on an offline
   one, so a rendered clip's score and a recorded clip's mix are the same sounds. */
function registerChimes(graph: AudioGraph): void {
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const hz = 330 * 1.5 ** (slot / 2);
    graph.registry.register(`chime${slot}`, {
      urls: [],
      synth: (ctx) => toneBuffer(ctx, 0.7, hz, hz * 1.01, 5),
    });
  }
}

/* The live graph, made on the first press: a browser lets a page make sound only after one. */
let sound: AudioGraph | null = null;
let soundAsked: Promise<AudioGraph | null> | null = null;
function startSound(): Promise<AudioGraph | null> {
  soundAsked ??= (async () => {
    const graph = await AudioGraph.create({ stemCount: 0 });
    if (graph === null) return null;
    registerChimes(graph);
    await graph.registry.load(graph.context);
    sound = graph;
    return graph;
  })();
  return soundAsked;
}
addEventListener('pointerdown', () => void startSound());
addEventListener('keydown', () => void startSound());

/* Every chime the show rang between two instants, on whichever graph is listening. */
function chime(graph: AudioGraph, from: number, to: number): void {
  for (let slot = 0; slot < SLOTS; slot += 1) {
    if (rules().lit(from, to, slot)) graph.play(graph.registry.get(`chime${slot}`), 0.35);
  }
}
// #endregion

/* The panel: three buttons, a sentence about what happened, and the result. */
const note = document.querySelector<HTMLElement>('#note');
const result = document.querySelector<HTMLElement>('#result');
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#panel button')];
function say(text: string): void {
  if (note !== null) note.textContent = text;
}
function busy(on: boolean): void {
  for (const button of buttons) button.disabled = on;
}
function present(file: Blob, name: string, kind: 'image' | 'video'): void {
  if (result === null) return;
  const url = URL.createObjectURL(file);
  const media = document.createElement(kind === 'image' ? 'img' : 'video');
  media.src = url;
  if (media instanceof HTMLVideoElement) {
    media.controls = true;
    media.loop = true;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = `Save ${name} (${Math.round(file.size / 1024)} KB)`;
  result.replaceChildren(media, link);
}

// #region still
/* Asked for here, taken inside the next frame: a WebGL drawing buffer is only readable before the
   page composites it. */
let stillWanted = false;
function takeStill(): void {
  const frame = stillFrame(
    canvas,
    marked ? MARK : undefined,
    clock(() => live.time),
  );
  if (frame === null) return say('This browser cannot copy the frame.');
  frame.toBlob((png) => {
    if (png !== null) present(png, 'still.png', 'image');
    say(`A still at ${frame.width} by ${frame.height}, the size of the canvas.`);
  }, 'image/png');
}
// #endregion

// #region record
/* Real time: the frame is locked to the clip's shape, the mark is composited into every frame, and
   the recorder keeps every n-th animation frame at the rate asked for, with the live mix. */
let recorder: FrameRecorder | null = null;
let recordedFor = 0;

async function record(): Promise<void> {
  const graph = await startSound();
  const { width, height } = FORMATS[format];
  recorder = new FrameRecorder({
    fps: rate,
    /* Only a mix that is playing. A suspended context's stream is a live track that never carries
       a sample, and a recorder waiting on it keeps about half a second of picture. */
    audio: graph !== null && graph.audible ? graph.captureStream() : null,
    target: {
      source: canvas,
      surface: renderer,
      width,
      height,
      ...(marked ? { overlay: MARK } : {}),
      drawFrame: clock(() => live.time),
      presentedFrames: () => renderer.presentedFrames,
    },
  });
  const size = recorder.prepare();
  recorder.start();
  recordedFor = 0;
  busy(true);
  say(`Recording ${size?.width ?? width} by ${size?.height ?? height} for ${SECONDS} seconds.`);
}

async function stopRecording(): Promise<void> {
  const ending = recorder;
  if (ending === null) return;
  recorder = null;
  /* Read before stopping: `stop` gives the surface back, and the pacing goes with it. */
  const pacing = ending.pacing;
  const mime = describeClipMime(ending.mimeType);
  const file = await ending.stop();
  busy(false);
  if (file === null) return say('The recording came back empty.');
  present(file, `recorded.${mime.container === 'unknown' ? 'webm' : mime.container}`, 'video');
  say(
    `Recorded ${mime.container === 'unknown' ? 'a clip' : `an ${mime.container.toUpperCase()}`}${mime.audio === 'unspecified' ? '' : ` with ${mime.audio === 'aac' ? 'AAC' : 'Opus'} audio`}${mime.shareable ? '' : ', which some share targets will not take'}. ${pacing === null ? '' : `It kept ${pacing.captured} frames, ${pacing.capturedFps.toFixed(1)} a second against ${pacing.targetFps} asked, the worst gap ${pacing.worstGapMs.toFixed(0)} ms.`}`,
  );
}
// #endregion

// #region render
/* Offline: no clock at all. Each frame is drawn at the instant it belongs to and stamped with it,
   and the score is rendered on an offline audio context from the same rules, so the file is exact
   however long it took to make. */
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
let rendering = false;

async function renderClip(): Promise<void> {
  busy(true);
  try {
    /* The round trip first: on some configurations every frame reaches the encoder empty while
       every call reports success, and the file comes out solid green. */
    if ((await framesReachEncoder()) === 'empty') {
      return say('This browser hands its encoder empty frames, so a rendered clip would be blank.');
    }
    const { width, height } = FORMATS[format];
    const fps = rate;
    const bitrate = clipBitrate(width, height, fps);
    if (!(await clipEncodingSupported({ width, height, fps, bitrate }))) {
      return say(`This browser cannot encode ${width} by ${height} at ${fps} fps.`);
    }
    const frames = SECONDS * fps;

    /* The score, scheduled at the instant of each frame on an offline context. */
    const offline = new OfflineAudioContext(2, SECONDS * 48000, 48000);
    const score = await AudioGraph.create({ stemCount: 0, context: offline });
    if (score === null) return say('No audio graph on an offline context.');
    registerChimes(score);
    await score.registry.load(offline);
    for (let i = 1; i < frames; i += 1) {
      score.at(i / fps);
      chime(score, (i - 1) / fps, i / fps);
    }
    const audio = await offline.startRendering();

    const encoder = await ClipEncoder.open({ width, height, fps, bitrate, sampleRate: 48000 });
    rendering = true;
    renderer.lockDrawingBuffer(width, height);
    const clip = exported<() => Show>(show, 'createShow')();
    for (let i = 0; i < frames; i += 1) {
      await nextFrame();
      draw(clip.time, width / height);
      renderer.endFrame();
      const frame = stillFrame(
        canvas,
        marked ? MARK : undefined,
        clock(() => clip.time),
      );
      if (frame !== null) await encoder.addFrame(frame, i);
      rules().step(clip, 1 / fps);
      say(`Rendering frame ${i + 1} of ${frames}.`);
    }
    await encoder.addAudio(audio);
    const file = await encoder.finish();
    if (file === null) return say(`The encoder gave up: ${encoder.error ?? 'no reason given'}.`);
    present(file, 'rendered.mp4', 'video');
    say(
      `Rendered ${frames} frames at ${width} by ${height}, H.264 with ${encoder.audioCodec === 'aac' ? 'AAC' : 'Opus'} audio, each frame stamped at its own instant.`,
    );
  } finally {
    if (rendering) renderer.unlockDrawingBuffer();
    rendering = false;
    busy(false);
  }
}
// #endregion

document.querySelector('#still')?.addEventListener('click', () => {
  stillWanted = true;
});
document.querySelector('#record')?.addEventListener('click', () => void record());
document.querySelector('#render')?.addEventListener('click', () => void renderClip());
say('Save a still, record four seconds as they play, or render four seconds frame by frame.');

// #region loop
stage.run({
  simulate(dt) {
    if (rendering) return;
    const before = live.time;
    rules().step(live, dt);
    if (sound !== null) chime(sound, before, live.time);
    if (recorder !== null) {
      recordedFor += dt;
      if (recordedFor >= SECONDS) void stopRecording();
    }
  },
  render() {
    /* The offline render owns the canvas while it runs. */
    if (rendering) return;
    recorder?.captureDue(performance.now());
    draw(live.time, canvas.height > 0 ? canvas.width / canvas.height : 1);
    renderer.endFrame();
    if (stillWanted) {
      stillWanted = false;
      takeStill();
    }
    recorder?.frameRendered();
  },
});
// #endregion
