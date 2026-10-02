/**
 * A campfire, and everything in it doing real chemistry: oak and kindling over a bed of embers, a
 * kettle, a block of ice, an iron nail and a copper coin, each heating at the rate its own
 * substance decides.
 *
 * The camp is a DriftScript module through `drift/chemistry`: the rain, a keeper who lays a new log
 * on the fire, seasoned or green, and a notebook read from the chemistry's event buffer. Lay a green
 * log and it steams and does not catch; let it rain and the smoke turns white; let the wind blow and
 * the embers brighten. The fire runs fifteen times faster than the clock, a quarter second a tick.
 */
import {
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createPointLightBuffer,
  selectPointLights,
} from '@driftengine/core';
import type { MeshHandle, PointLightSource, Vec3 } from '@driftengine/core';
import { ORGANIC } from '@driftengine/chemistry/library/organic';
import { FOOD } from '@driftengine/chemistry/library/food';
import { METAL } from '@driftengine/chemistry/library/metal';
import {
  emitSmoke,
  installChemistry,
  parcelFromBounds,
  writeSurface,
} from '@driftengine/chemistry/present';
import type { SmokeTarget, SurfaceTarget } from '@driftengine/chemistry/present';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as campScript from './camp.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region install
/** Three families of substance, and a world with air over it: one metre cells, 8³ to a chunk. */
const chem = installChemistry({ libraries: [ORGANIC, FOOD, METAL], maxChunks: 8 });
/** The fire's own fixed step: a quarter second of chemistry each tick of the page. */
const DT = 0.25;
/** The hearth sits at (4, 4, 4) in the air's cells, and the scene is drawn in those same metres. */
const HEARTH: Vec3 = [4, 4, 4];
// #endregion

// #region things
/** What is on the hearth: a substance, where it sits, and the box it fills. */
interface Thing {
  readonly label: string;
  readonly at: Vec3;
  readonly size: Vec3;
  parcel: number;
  meshes: MeshHandle[];
}
function spawn(label: string, substance: string, at: Vec3, size: Vec3): Thing {
  const index = chem.substances.indexOf(substance);
  const bounds = parcelFromBounds(size[0], size[1], size[2], chem.substances.densityOf(index));
  const parcel = chem.parcels.spawn({
    substance: index,
    mass: bounds.mass,
    temperature: 288.15,
    area: bounds.area,
    x: at[0],
    y: at[1],
    z: at[2],
  });
  return { label, at, size, parcel, meshes: charSteps(parcel, size) };
}
// #endregion

/** One box a char step, darkening from the substance's own colour toward its char colour. */
const CHAR_STEPS = 8;
function charSteps(parcel: number, size: Vec3): MeshHandle[] {
  const look = chem.parcels.appearanceOf(parcel);
  const base = look === null ? [0.5, 0.5, 0.5] : Array.from(look.albedo);
  const char = look === null ? [0.1, 0.1, 0.1] : Array.from(look.charAlbedo);
  return Array.from({ length: CHAR_STEPS }, (_, step) => {
    const t = step / (CHAR_STEPS - 1);
    const colour = [0, 1, 2].map((k) => (base[k] ?? 0) * (1 - t) + (char[k] ?? 0) * t) as Vec3;
    /* Emissive everywhere and white, so the glow a draw asks for is the colour the chemistry gave,
       and none at all while the scale it is drawn with is zero. Texture coordinates, because the
       scale reaches the surface through a map. */
    const builder = new MeshBuilder().setEmissiveColor([1, 1, 1]);
    return renderer.createMesh(shape(builder, size, colour, 1).build({ planarUvs: true }));
  });
}

/** A box, or a round log along its longest side when one side is much longer than the others. */
function shape(builder: MeshBuilder, size: Vec3, colour: Vec3, emissive = 0): MeshBuilder {
  const long = Math.max(...size);
  const axis = size[0] === long ? 'x' : size[2] === long ? 'z' : 'y';
  const across = Math.min(...size.filter((_, k) => 'xyz'[k] !== axis));
  if (long > across * 3)
    return builder.addCylinder([0, 0, 0], across / 2, long / 2, axis, colour, emissive, 12);
  return builder.addBox([0, 0, 0], [size[0] / 2, size[1] / 2, size[2] / 2], colour, emissive);
}

const [hx, hy, hz] = HEARTH;
const things: Thing[] = [
  spawn('oak', 'oak', [hx + 0.42, hy + 0.06, hz], [0.08, 0.08, 0.5]),
  spawn('kindling', 'pine', [hx + 0.2, hy + 0.04, hz - 0.28], [0.3, 0.015, 0.015]),
  spawn('kettle', 'water', [hx - 0.55, hy + 0.12, hz + 0.1], [0.14, 0.14, 0.14]),
  spawn('ice', 'ice', [hx - 0.55, hy + 0.06, hz - 0.3], [0.08, 0.08, 0.08]),
  spawn('nail', 'iron', [hx + 0.3, hy + 0.04, hz + 0.5], [0.004, 0.004, 0.08]),
  spawn('coin', 'copper', [hx + 0.36, hy + 0.04, hz + 0.5], [0.02, 0.002, 0.02]),
];
const named = (label: string): Thing => things.find((thing) => thing.label === label) as Thing;

// #region script
/** The camp, hosted with the chemistry it reads and writes. */
const camp = hostScript(campScript, { chemistry: chem });
interface Camp {
  rain: number;
  caught: number;
  putOut: number;
  boiled: boolean;
  melting: boolean;
  lastCaught: number;
}
const notes = exported<() => Camp>(camp, 'createCamp')();
type Weather = (camp: Camp, chem: unknown, dt: number) => void;
type Stoke = (chem: unknown, green: boolean, x: number, y: number, z: number) => number;
type Notice = (camp: Camp, chem: unknown, kettle: number, ice: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./camp.drs', (next) => {
    if (next !== undefined) patchModule(camp, next as Record<string, unknown>, { Camp: [notes] });
  });
}
// #endregion

/** A new log goes beside the embers, at the next of four places round them. */
const PLACES: [number, number][] = [
  [-0.35, 0.35],
  [0.35, -0.45],
  [-0.4, -0.05],
  [0.1, 0.45],
];
let logs = 0;
function layLog(green: boolean): void {
  const [dx, dz] = PLACES[logs % PLACES.length] as [number, number];
  logs += 1;
  const size: Vec3 = [0.4, 0.07, 0.07];
  const at: Vec3 = [hx + dx, hy + 0.1, hz + dz];
  const parcel = exported<Stoke>(camp, 'stoke')(chem, green, at[0], at[1], at[2]);
  things.push({
    label: green ? 'green oak' : 'oak',
    at,
    size,
    parcel,
    meshes: charSteps(parcel, size),
  });
}

let wind = flag('wind', 'still') === 'breeze' ? 1.5 : 0;
notes.rain = flag('rain', 'none') === 'shower' ? 0.002 : 0;
controls([
  {
    key: 'log',
    label: 'lay a log',
    value: 'none',
    options: ['none', 'seasoned', 'green'].map((l) => ({ text: l, value: l })),
    change: (value) => {
      if (value !== 'none') layLog(value === 'green');
    },
  },
  {
    key: 'rain',
    label: 'rain',
    value: notes.rain > 0 ? 'shower' : 'none',
    options: ['none', 'shower'].map((r) => ({ text: r, value: r })),
    change: (value) => {
      notes.rain = value === 'shower' ? 0.002 : 0;
    },
  },
  {
    key: 'wind',
    label: 'wind',
    value: wind > 0 ? 'breeze' : 'still',
    options: ['still', 'breeze'].map((w) => ({ text: w, value: w })),
    change: (value) => {
      wind = value === 'breeze' ? 1.5 : 0;
    },
  },
]);

/* Drawing: the stones and the embers, every thing at its char step and glow, and the smoke. */
const stones = new MeshBuilder()
  .addBox([hx, hy - 0.2, hz], [20, 0.2, 20], [0.16, 0.13, 0.1])
  .addCylinder([hx, hy + 0.005, hz], 0.85, 0.005, 'y', [0.2, 0.19, 0.18], 0, 32);
for (let k = 0; k < 18; k += 1) {
  const angle = (k / 18) * Math.PI * 2;
  const size = 0.07 + (k % 3) * 0.015;
  stones.addSphere(
    [hx + Math.cos(angle) * 0.92, hy + size * 0.6, hz + Math.sin(angle) * 0.92],
    size,
    [0.34, 0.32, 0.3],
  );
}
/* The kettle is a pot on three stones; the water in it is the parcel, and is not drawn. */
const kettle = named('kettle').at;
stones
  .addCylinder(
    [kettle[0], kettle[1] + 0.01, kettle[2]],
    0.1,
    0.09,
    'y',
    [0.18, 0.18, 0.2],
    0,
    20,
    0.6,
  )
  .addCylinder(
    [kettle[0], kettle[1] + 0.105, kettle[2]],
    0.06,
    0.01,
    'y',
    [0.12, 0.12, 0.13],
    0,
    16,
  );
const stoneMesh = renderer.createMesh(stones.build());
const emberMesh = renderer.createMesh(
  new MeshBuilder().addBox([hx, hy + 0.03, hz], [0.25, 0.03, 0.2], [0.5, 0.16, 0.03], 1).build(),
);
const SMOKE = 768;
const smoke: SmokeTarget & { spins: Float32Array } = {
  spins: new Float32Array(SMOKE),
  positions: new Float32Array(SMOKE * 3),
  velocities: new Float32Array(SMOKE * 3),
  colors: new Float32Array(SMOKE * 3),
  alphas: new Float32Array(SMOKE),
  sizes: new Float32Array(SMOKE),
  ages: new Float32Array(SMOKE),
  seeds: new Float32Array(SMOKE),
  count: 0,
  capacity: SMOKE,
};
const smokeBatch = renderer.createParticles(SMOKE, {
  material: 'smoke',
  blend: 'alpha',
  erosion: 0.5,
});
const surface: SurfaceTarget = {
  albedos: new Float32Array(32 * 3),
  emissives: new Float32Array(32 * 3),
  roughness: new Float32Array(32),
  scales: new Float32Array(32),
  count: 0,
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(16);
const env = createEnvironment({
  directionalDir: [-0.3, 0.8, 0.5],
  directionalColor: [0.22, 0.26, 0.4],
  ambient: [0.05, 0.06, 0.09],
  ambientGround: [0.02, 0.02, 0.02],
  nightFactor: 1,
  emissiveGain: 1,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.6;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  hx,
  hy,
  hz,
  2,
  renderer.shadowMapSize,
  lightMatrix,
);
/* The embers light the hearth: a warm point light just above them, flickering as a fire does. */
const fireLight: PointLightSource[] = [
  {
    x: hx,
    y: hy + 0.35,
    z: hz,
    r: 3,
    g: 1.4,
    b: 0.45,
    radius: 5,
    flicker: 0.3,
    shadowNear: 0.1,
    sourceRadius: 0.2,
    castsShadow: false,
  },
];
const glowMap = renderer.createSurfaceTexture(
  new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1),
);
const chosen = createPointLightBuffer(renderer.shadedLights);
const readout = createReadout(renderer, 3);
let ticks = 0;

stage.run({
  simulate() {
    ticks += 1;
    // #region tick
    /* The embers radiate; every parcel is offered a flame, which is one of the five conditions. */
    chem.world.sources.clear();
    chem.world.sources.add(hx, hy + 0.05, hz, 1150, 0.2, 90000);
    chem.world.contacts.clear();
    for (const thing of things) chem.parcels.ignite(thing.parcel);
    exported<Weather>(camp, 'weather')(notes, chem, DT);
    chem.world.simulate(DT, wind, 0);
    /* The events are cleared at the top of the next step, so they are read now. */
    exported<Notice>(camp, 'notice')(notes, chem, named('kettle').parcel, named('ice').parcel);
    // #endregion
  },
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = hx + 1.25;
    camera.position[1] = hy + 1.05;
    camera.position[2] = hz + 1.55;
    camera.lookAt(hx - 0.05, hy + 0.08, hz);

    // #region surface
    /* Every reading a picture needs: char colour, Planck glow, wetness, and what is left of it. */
    writeSurface(
      chem.parcels,
      things.map((thing) => thing.parcel),
      surface,
    );
    emitSmoke(chem.air, hx - 4, hy, hz - 4, 8, smoke, {
      threshold: 2e-6,
      size: 0.3,
      wind: wind * 0.3,
    });
    /* The air's cells are a metre across, so a puff in the cell the camera is in fills the view. */
    for (let i = 0; i < smoke.count; i += 1) {
      const dx = (smoke.positions[i * 3] ?? 0) - camera.position[0];
      const dy = (smoke.positions[i * 3 + 1] ?? 0) - camera.position[1];
      const dz = (smoke.positions[i * 3 + 2] ?? 0) - camera.position[2];
      if (dx * dx + dy * dy + dz * dz < 1.5) smoke.alphas[i] = 0;
    }
    // #endregion

    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => sink.mesh(stoneMesh, IDENTITY));
    renderer.endShadowPass();
    selectPointLights(
      fireLight,
      camera.position[0],
      camera.position[1],
      camera.position[2],
      chosen,
      ticks / 60,
    );
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;
    renderer.beginFrame([0.02, 0.025, 0.04]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(stoneMesh, IDENTITY);
    renderer.drawMesh(emberMesh, IDENTITY);
    things.forEach((thing, at) => {
      if (!chem.parcels.alive(thing.parcel) || thing.label === 'kettle') return;
      const char = chem.parcels.charFractionOf(thing.parcel);
      const step = Math.min(CHAR_STEPS - 1, Math.round(char * (CHAR_STEPS - 1)));
      const scale = surface.scales[at] ?? 1;
      /* The glow is an emissive map one texel wide and white, scaled to the colour the chemistry
         says this thing radiates: `emissiveScale` scales a map, and without one it does nothing. */
      renderer.setMaterial({
        emissive: glowMap,
        emissiveScale: [
          surface.emissives[at * 3] ?? 0,
          surface.emissives[at * 3 + 1] ?? 0,
          surface.emissives[at * 3 + 2] ?? 0,
        ],
      });
      model.set([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, ...thing.at, 1]);
      renderer.drawMesh(thing.meshes[step] as MeshHandle, model);
    });
    renderer.setMaterial(null);
    renderer.drawParticles(smokeBatch, smoke, camera, env, ticks * DT);

    const celsius = (label: string): string =>
      `${(chem.parcels.surfaceTemperatureOf(named(label).parcel) - 273.15).toFixed(0)}`;
    const seconds = Math.floor(ticks * DT);
    const oak = named('oak').parcel;
    readout.set(
      0,
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}  OAK ${celsius('oak')}C, CORE ${(chem.parcels.coreTemperatureOf(oak) - 273.15).toFixed(0)}C, ${(chem.parcels.charFractionOf(oak) * 100).toFixed(0)}% CHAR`,
    );
    readout.set(
      1,
      `KETTLE ${celsius('kettle')}C  ICE ${celsius('ice')}C  NAIL ${celsius('nail')}C  COIN ${celsius('coin')}C`,
    );
    readout.set(
      2,
      `${notes.caught} CAUGHT  ${notes.putOut} PUT OUT${notes.boiled ? '  KETTLE BOILED' : ''}${notes.melting ? '  ICE MELTING' : ''}`,
    );
    readout.draw(ticks / 60);
    renderer.endFrame();
  },
});
