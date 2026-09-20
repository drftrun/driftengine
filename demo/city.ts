/**
 * A city at dusk, on the second pipeline: towers past a million triangles, lit windows, glass and
 * a low sun, streamed a block at a time as the camera moves.
 *
 * **Why a city, and why dusk** (`specs/2026-09-18-gpu-driven-demos-design.md` §4). Occlusion
 * culling is this pipeline's signature and a city is where it pays — every street a corridor with
 * the district hidden behind its first building. Dusk puts the two capabilities the second pipeline
 * gained for it on screen: the lit windows are an image read through an emissive map, and the glass
 * is its blended half.
 *
 * **Nothing here is an asset.** Every block, window and pane is generated from `CITY_SEED`, so the
 * demo runs from a clone and a held frame is the same picture on every run.
 *
 * The forward path draws the sky and nothing else; the pass draws the city.
 */
import {
  Camera,
  GpuDrivenPass,
  atmosphereFog,
  createEnvironment,
  createFogTarget,
  createRenderer,
} from '../packages/core/src/index';

import type { GpuDrivenView, RenderQualityOptions, SkyColors } from '../packages/core/src/index';
import { CITY_SEED, CityStream } from './city/cityStream';
import { FLIGHT_SPEED, flightAt, flightLook } from './city/flight';
import { cityPalette } from './city/palette';
import type { DemoBudget, DemoHandle, DemoScene, DemoStats } from './types';

/**
 * Toward the sun: three degrees above the west-north-west horizon, the last of it.
 *
 * **Blue hour rather than golden hour**, because that is the light a skyline is photographed in:
 * the sky still blue, the streets already dark, the city's own lights on — and a sun so low that it
 * reaches only the tops of the tallest towers, every storey below them in the shadow of the city to
 * its west. Across the camera's view from the left and a little ahead, so those tops are rim-lit
 * against the sky rather than lit flat. Three degrees is a slope of nineteen metres along the ground
 * for each one of height, far past the forward path's default of three, so the pass is told a
 * steeper limit and a longer reach below.
 */
const SUN: readonly [number, number, number] = (() => {
  const up = (3 * Math.PI) / 180;
  const round = (200 * Math.PI) / 180;
  return [Math.cos(up) * Math.cos(round), Math.sin(up), Math.cos(up) * Math.sin(round)];
})();

const SUN_COLOUR: readonly [number, number, number] = [1.9, 0.55, 0.3];
const SKY_FILL: readonly [number, number, number] = [0.05, 0.13, 0.22];
const GROUND_FILL: readonly [number, number, number] = [0.04, 0.012, 0.04];

const SKY: SkyColors = {
  top: [0.005, 0.03, 0.13],
  horizon: [0.42, 0.1, 0.24],
  deep: [0.003, 0.006, 0.02],
  sunDir: [SUN[0], SUN[1], SUN[2]],
  sunColor: [1, 0.5, 0.25],
  sunAngularRadius: 0.02,
  moonDir: [0.45, 0.4, 0.5],
  moonColor: [0.55, 0.6, 0.75],
  moonAngularRadius: 0.015,
  moonPhase: 0.3,
  nightFactor: 0.6,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

/**
 * The frame's light and its haze, for the forward sky and, through `atmosphereFog`, for the pass:
 * a blue-violet haze that lies low, so distance reads as depth.
 *
 * **`nightFactor` one**, because both pipelines scale every glow by it and a window lit at dusk has
 * to be lit; the sky reads its own.
 */
const ENV = createEnvironment({
  directionalDir: [SUN[0], SUN[1], SUN[2]],
  directionalColor: [SUN_COLOUR[0], SUN_COLOUR[1], SUN_COLOUR[2]],
  ambient: [SKY_FILL[0], SKY_FILL[1], SKY_FILL[2]],
  ambientGround: [GROUND_FILL[0], GROUND_FILL[1], GROUND_FILL[2]],
  emissiveGain: 1,
  nightFactor: 1,
  fogColor: [0.12, 0.05, 0.17],
  fogDensity: 0.0007,
  fogHeightFalloff: 0.004,
  fogBaseY: 0,
});

/**
 * Metres to each side of the eye that the city is built. `?reach=` changes it.
 *
 * Nine hundred holds most of the grid from the opening view, past a million triangles.
 */
const REACH = 900;
/** Blocks built a frame at most, and the milliseconds a frame may spend building them. */
const BLOCKS_A_FRAME = 4;
const BUILD_MS = 8;

/**
 * The frame's settings, over whatever the page asked for: a scene target that holds light brighter
 * than white, bloom on what is — the windows, the crowns, the street lights and the neon — and a
 * filmic curve.
 *
 * **Graded like a night film, in the light rather than after it**: a teal fill from the sky, a
 * hot-pink horizon, a violet haze, and warm windows and sodium lamps against them — the colour
 * contrast the look is known by, made by the scene because the renderer has no grade to make it.
 */
const CINEMA: RenderQualityOptions = {
  hdrScene: true,
  screenEffects: true,
  bloom: 0.35,
  bloomThreshold: 1.1,
  /* Filmic: the shoulder keeps the neon and the windows from clipping, the toe crushes the dark. */
  outputTransform: 'aces',
  outputExposure: 1,
};

/** What the frame is cleared to under the sky, which covers all of it. */
const CLEAR: [number, number, number] = [0.05, 0.05, 0.1];

/**
 * Where a still camera looks when `?eye=` asks for one and `?target=` does not: over the middle of
 * an avenue in the low valley between downtown and midtown, up it to midtown's towers.
 */
const TARGET: readonly [number, number, number] = [0, 130, -700];

/** `?eye=x,y,z` or `?target=x,y,z`, three numbers, or null. */
function pointAsked(search: string, name: string): readonly [number, number, number] | null {
  const parts = (new URLSearchParams(search).get(name) ?? '').split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite)
    ? [parts[0] as number, parts[1] as number, parts[2] as number]
    : null;
}

/**
 * `?at=seconds`: where on the flight the camera starts, so a held frame can be any place on it —
 * `shots.mjs` holds four hundred and twenty frames, seven seconds, past this.
 */
function startAsked(search: string): number {
  const asked = Number(new URLSearchParams(search).get('at') ?? '');
  return Number.isFinite(asked) ? asked : 0;
}

/** `?reach=`, in metres from 100 to 2000, or the default. */
function reachAsked(search: string): number {
  const asked = Number(new URLSearchParams(search).get('reach') ?? '');
  return Number.isFinite(asked) && asked >= 100 && asked <= 2000 ? asked : REACH;
}

async function mountCity(
  canvas: HTMLCanvasElement,
  overrides: RenderQualityOptions,
): Promise<DemoHandle> {
  const { renderer, backend } = await createRenderer(
    canvas,
    { ...CINEMA, ...overrides },
    {
      splash: false,
      pipeline: 'gpu-driven',
    },
  );
  await renderer.ready();

  const stream = new CityStream(CITY_SEED, reachAsked(location.search));
  /*
   * **The flight unless a still camera is asked for.** `?eye=` holds the camera where it says and
   * looks at `?target=`; without it the camera flies `flight.ts`'s loop from `?at=` seconds,
   * looking along the loop a little ahead, so it turns its head into a corner before it
   * turns.
   */
  const still = pointAsked(location.search, 'eye');
  const aimed = pointAsked(location.search, 'target') ?? TARGET;
  let flown = startAsked(location.search);
  const eye: [number, number, number] = [0, 0, 0];
  const target: [number, number, number] = [aimed[0], aimed[1], aimed[2]];
  const materials = cityPalette(CITY_SEED);
  /*
   * **A shadow for a city rather than a rig.** The map follows the eye three hundred metres to each
   * side, keeps a shadow however far a tower throws it, and casts under a sun lower than the forward
   * default allows — which is the whole of a blue hour's light.
   */
  const pass = new GpuDrivenPass(stream.scene, materials, {
    followRadius: 300,
    maxDistance: 5000,
    maxSlope: 25,
  });
  /*
   * The occlusion cull's own figure, in the readout: what a street hides against the roofs. And
   * `?occlusion=0` switches the cull off, so the same frame's count without it can be read.
   */
  pass.countDrawn = true;
  pass.occlusion = new URLSearchParams(location.search).get('occlusion') !== '0';
  const handle = renderer.registerPass(pass);
  renderer.resize();

  const camera = new Camera();
  /*
   * **A long lens**, as a skyline is shot: it stacks the towers down the avenue into one wall of
   * light and keeps the buildings beside the camera from filling the frame's edges.
   */
  camera.fovYDeg = 36;
  camera.near = 0.5;
  camera.far = 2600;

  /* Filled each frame from the environment, so the pass's haze is the sky's. */
  const fog = createFogTarget();
  const view: GpuDrivenView = {
    viewProj: camera.viewProjection,
    eye,
    lightDir: SUN,
    lightColour: SUN_COLOUR,
    ambient: SKY_FILL,
    ambientGround: GROUND_FILL,
    /* A block is one level of detail, so the threshold chooses nothing; the rigs' own number. */
    lodThreshold: 1.5,
    fovY: (camera.fovYDeg * Math.PI) / 180,
    shadowStrength: 1,
    emissiveGain: ENV.emissiveGain,
    nightFactor: ENV.nightFactor,
    fog,
  };

  const stats = { draws: 2, gpuMs: 0, extra: '' } as DemoStats;
  let disposed = false;

  return {
    backend,
    frame(dtSec: number): DemoStats {
      if (disposed || renderer.contextLost) return stats;
      if (still === null) {
        flown += dtSec;
        flightAt(flown * FLIGHT_SPEED, eye);
        flightLook(flown * FLIGHT_SPEED, eye, target);
      } else {
        eye[0] = still[0];
        eye[1] = still[1];
        eye[2] = still[2];
      }
      stream.update(eye[0], eye[2], BLOCKS_A_FRAME, BUILD_MS);

      camera.position[0] = eye[0];
      camera.position[1] = eye[1];
      camera.position[2] = eye[2];
      camera.lookAt(target[0], target[1], target[2]);
      camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
      atmosphereFog(ENV, eye[1], false, fog);

      pass.resize(renderer.sceneWidth, renderer.sceneHeight);
      pass.setView(view);
      renderer.beginFrame(CLEAR);
      renderer.bindMeshPass(camera, ENV);
      renderer.drawSky(camera, SKY, ENV);
      renderer.drawPass(handle);
      renderer.endFrame();

      stats.gpuMs = pass.totalMs ?? 0;
      /* Phase one's clusters and phase two's are the frame's opaque draw; the glass is its own. */
      const one = pass.drawnClusters('phaseOne');
      const shadowMs = pass.stageTime('shadow');
      const drawn =
        one === null
          ? ''
          : ` · ${(one + (pass.drawnClusters('phaseTwo') ?? 0)).toLocaleString('en')} drawn, ` +
            `${(pass.drawnClusters('blend') ?? 0).toLocaleString('en')} glass, ` +
            `${(pass.drawnClusters('shadow') ?? 0).toLocaleString('en')} in the sun's map` +
            /* Where the device is timed, what the map costs of the frame's milliseconds. */
            (shadowMs === null ? '' : ` (${shadowMs.toFixed(2)} ms)`);
      stats.extra =
        `${stream.triangles.toLocaleString('en')} triangles in ` +
        `${stream.scene.liveClusters.toLocaleString('en')} clusters, ${stream.count} blocks` +
        (stream.refused > 0 ? `, ${stream.refused} refused` : '') +
        drawn;
      return stats;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      renderer.unregisterPass(handle);
      renderer.dispose();
    },
  };
}

export const city: DemoScene = {
  id: 'city',
  title: 'A city at dusk',
  /* The second pipeline alone: the city is what it makes possible, and there is no forward city. */
  pipelines: ['gpu-driven'],
  note:
    'Manhattan at blue hour, generated from one seed: the 1811 grid, a street wall of walk-ups and ' +
    'prewar blocks, setback towers with floodlit crowns, and glass boxes lit a floor at a time. ' +
    'Close to two million triangles, streamed a block at a time as the camera flies the avenues, ' +
    'drawn by the GPU-driven pipeline, whose occlusion cull leaves most of the city undrawn from ' +
    'the street and whose sun culls what the city hides from it.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    return mountCity(canvas, overrides);
  },
};
