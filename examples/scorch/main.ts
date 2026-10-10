/**
 * A wall a turret scorches, three times a second, and a clock that can run backwards.
 *
 * The scorch marks are written into a sparse overlay on the wall's texture, and every write is
 * recorded in a journal beside the tick it happened on. Run the clock backwards and the wall is
 * rebuilt from the journal as it was at each earlier tick, so the marks vanish newest first; run it
 * forwards again and the journal is cut at the present, and the turret, whose aim is a function of
 * the tick, burns exactly the same marks again.
 *
 * When the turret fires and where it aims are rules in `turret.drs`.
 */
import {
  MeshBuilder,
  createEnvironment,
  hashToUnit,
  solidQuad,
  solidToMesh,
  transformSolid,
  srgbColor,
} from '@driftengine/core';
import {
  OVERLAY_CHANNELS,
  createOverlay,
  createOverlayJournal,
  journalLength,
  overlayTileCount,
  recordOverlayWrite,
  rewindOverlay,
  sampleOverlay,
  truncateJournalFrom,
  writeOverlay,
  writtenMaskAt,
} from '@driftengine/texture';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as turretScript from './turret.drs';

const stage = await openStage({ outputTransform: 'aces', sceneSamples: 4 });
const { renderer, camera } = stage;

// #region overlay
/** The wall's texture, 256 texels square, as eight by eight tiles of 32 the overlay allocates. */
const RESOLUTION = 256;
const overlay = createOverlay(32, { tilesAcross: 8 });
const journal = createOverlayJournal();

/** One shot: a soot halo and a darker core, each written into the three colour channels. */
function scorch(tick: number, u: number, v: number, radius: number): void {
  const marks: [number, number][] = [
    [radius, 0.22],
    [radius * 0.5, 0.06],
  ];
  for (const [r, shade] of marks) {
    for (let channel = 0; channel < 3; channel += 1) {
      writeOverlay(overlay, u, v, r, channel, shade);
      recordOverlayWrite(journal, tick, u, v, r, channel, shade);
    }
  }
}
// #endregion

/** The stone the marks land on: courses of blocks, as linear RGB. */
const base = new Float32Array(RESOLUTION * RESOLUTION * OVERLAY_CHANNELS);
for (let y = 0; y < RESOLUTION; y += 1) {
  for (let x = 0; x < RESOLUTION; x += 1) {
    const row = Math.floor(y / 32);
    const joint = y % 32 < 2 || (x + (row % 2) * 32) % 64 < 2;
    const tone = joint
      ? 0.42
      : 0.62 + hashToUnit(Math.floor((x + (row % 2) * 32) / 64) * 31 + row) * 0.1;
    const at = (y * RESOLUTION + x) * OVERLAY_CHANNELS;
    base.set([tone, tone * 0.92, tone * 0.8, 1], at);
  }
}

// #region composite
/** The wall as the base with every written channel of every written texel laid over it. */
const pixels = new ImageData(RESOLUTION, RESOLUTION);
const sampled = new Float32Array(OVERLAY_CHANNELS);
function paint(): ImageData {
  for (let y = 0; y < RESOLUTION; y += 1) {
    for (let x = 0; x < RESOLUTION; x += 1) {
      const u = (x + 0.5) / RESOLUTION;
      const v = (y + 0.5) / RESOLUTION;
      const at = (y * RESOLUTION + x) * OVERLAY_CHANNELS;
      const mask = writtenMaskAt(overlay, u, v);
      if (mask !== 0) sampleOverlay(overlay, u, v, sampled);
      for (let c = 0; c < OVERLAY_CHANNELS; c += 1) {
        const value = (mask & (1 << c)) !== 0 ? (sampled[c] ?? 0) : (base[at + c] ?? 0);
        /* sRGB for the canvas, from the linear values the wall is authored in. */
        pixels.data[at + c] = c === 3 ? 255 : Math.round(Math.pow(value, 1 / 2.2) * 255);
      }
    }
  }
  return pixels;
}
// #endregion

const texture = renderer.createSurfaceTexture(paint(), { colorSpace: 'srgb' });
/** A wall eight metres square, its texture coordinates running 0 to 1 across it. */
const wall = renderer.createMesh(
  solidToMesh(
    transformSolid(solidQuad(8, 8), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 4, 0, 1]),
    [1, 1, 1],
  ),
);
const ground = renderer.createMesh(
  new MeshBuilder().addBox([0, -0.1, 4], [12, 0.1, 10], [0.3, 0.33, 0.28]).build(),
);

// #region script
/** The turret's rules, hosted. They read nothing but the tick. */
const turret = hostScript(turretScript);
type ByTick<T> = (tick: number) => T;
if (import.meta.hot) {
  import.meta.hot.accept('./turret.drs', (next) => {
    if (next !== undefined) patchModule(turret, next as Record<string, unknown>, {});
  });
}
// #endregion

// #region clock
/** The simulation's tick, which the switch runs forwards or backwards. */
let tick = 0;
let backwards = flag('clock', 'forwards') === 'backwards';
let dirty = true;
controls([
  {
    key: 'clock',
    label: 'clock',
    value: backwards ? 'backwards' : 'forwards',
    options: ['forwards', 'backwards'].map((c) => ({ text: c, value: c })),
    change: (value) => {
      backwards = value === 'backwards';
      /* Going forwards from here: what the journal holds past now never happened. */
      if (!backwards) truncateJournalFrom(journal, tick + 1);
    },
  },
]);

function step(): void {
  if (backwards) {
    if (tick === 0) return;
    tick -= 1;
    /* A write cannot be undone, so the wall is rebuilt from the journal up to the earlier tick. */
    rewindOverlay(overlay, journal, tick);
    dirty = true;
    return;
  }
  tick += 1;
  if (!exported<ByTick<boolean>>(turret, 'fires')(tick)) return;
  scorch(
    tick,
    exported<ByTick<number>>(turret, 'aimU')(tick),
    exported<ByTick<number>>(turret, 'aimV')(tick),
    exported<ByTick<number>>(turret, 'size')(tick),
  );
  dirty = true;
}
// #endregion

const env = createEnvironment({
  directionalDir: [-0.3, 0.6, 0.75],
  directionalColor: [1.6, 1.5, 1.35],
  ambient: [0.34, 0.37, 0.44],
  ambientGround: [0.15, 0.14, 0.13],
});
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const SKY = srgbColor(0.6, 0.66, 0.74);
const readout = createReadout(renderer, 2);
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    step();
  },
  render() {
    if (dirty) {
      renderer.updateSurfaceTexture(texture, paint());
      dirty = false;
    }
    camera.fovYDeg = 50;
    camera.position[0] = Math.sin(time * 0.1) * 3;
    camera.position[1] = 4;
    camera.position[2] = 11;
    camera.lookAt(0, 4, 0);
    renderer.beginFrame(SKY);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);
    renderer.setSurfaceTexture(texture);
    renderer.drawMesh(wall, IDENTITY);
    renderer.setSurfaceTexture(null);
    readout.set(0, `TICK ${tick}  JOURNAL ${journalLength(journal)} WRITES`);
    readout.set(1, `${overlayTileCount(overlay)} OF 64 TILES ALLOCATED`);
    readout.draw(time);
    renderer.endFrame();
  },
});
