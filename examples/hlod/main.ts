/**
 * A city of 144 blocks flown over from street level to the rooftops, each block drawn at the level
 * of detail its distance deserves, and each change of level crossfaded.
 *
 * A block has three levels: towers with fins and cornices, the towers alone, and one box a
 * building. Each level states its geometric error, how far its surface may stand from the finest,
 * and `HlodSet` picks the coarsest level whose error stays under a pixel and a half on screen. Paint
 * the levels to watch them change as the camera climbs, loosen the tolerance to see coarser levels
 * come closer, or switch the selection off to draw every block at its finest.
 */
import {
  HlodSet,
  MeshBuilder,
  createEnvironment,
  createHlodDraws,
  frustumFromViewProjection,
  mulberry32,
  projectionScaleOf,
  srgbColor,
} from '@driftengine/core';
import type { MeshData, MeshHandle, Vec3 } from '@driftengine/core';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

const stage = await openStage({
  occlusionCulling: 256,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// #region levels
/**
 * Sixteen buildings on a block of 100 metres, at three levels. The coarser two wear the facade's
 * average shade, so dropping the fins does not read as the city brightening.
 */
function block(ox: number, oz: number, random: () => number): MeshData[] {
  const fine = new MeshBuilder();
  const plainer = new MeshBuilder();
  const boxes = new MeshBuilder();
  for (let lot = 0; lot < 16; lot += 1) {
    const cx = ox + 20 + (lot % 4) * 20;
    const cz = oz + 20 + Math.floor(lot / 4) * 20;
    const h = 12 + random() * 60;
    const grey = 0.45 + random() * 0.35;
    const wall: Vec3 = [grey, grey * 0.96, grey * 0.9];
    const fin: Vec3 = [grey * 0.6, grey * 0.6, grey * 0.62];
    const average: Vec3 = [wall[0] * 0.9, wall[1] * 0.9, wall[2] * 0.9];
    fine.addBox([cx, h / 2, cz], [7, h / 2, 7], wall);
    fine.addBox([cx, h + 4, cz], [4.5, 4, 4.5], wall);
    for (let y = 4; y < h; y += 4) fine.addBox([cx, y, cz], [7.3, 0.15, 7.3], fin);
    for (let i = 0; i < 7; i += 1) {
      const along = -6 + i * 2;
      fine.addBox([cx + along, h / 2, cz - 7.2], [0.2, h / 2, 0.25], fin);
      fine.addBox([cx + along, h / 2, cz + 7.2], [0.2, h / 2, 0.25], fin);
      fine.addBox([cx - 7.2, h / 2, cz + along], [0.25, h / 2, 0.2], fin);
      fine.addBox([cx + 7.2, h / 2, cz + along], [0.25, h / 2, 0.2], fin);
    }
    plainer.addBox([cx, h / 2, cz], [7, h / 2, 7], average);
    plainer.addBox([cx, h + 4, cz], [4.5, 4, 4.5], average);
    boxes.addBox([cx, h / 2, cz], [7, h / 2, 7], average);
  }
  return [fine.build(), plainer.build(), boxes.build()];
}

/** What each level claims: the fins stand half a metre out, the setbacks eight metres up. */
const ERRORS = [0, 0.5, 8];
// #endregion

// #region regions
/** Twelve blocks by twelve, each a region: a box, its levels' meshes and their errors. */
const GRID = 12;
const SIZE = 100;
interface Region {
  levels: MeshHandle[];
  triangles: number[];
}
const regions: Region[] = [];
const hlod = new HlodSet({ capacity: GRID * GRID, fadeSec: 0.4 });
const draws = createHlodDraws(GRID * GRID);
const random = mulberry32(17);
for (let id = 0; id < GRID * GRID; id += 1) {
  const ox = (id % GRID) * SIZE;
  const oz = Math.floor(id / GRID) * SIZE;
  const meshes = block(ox, oz, random);
  regions.push({
    levels: meshes.map((mesh) => renderer.createMesh(mesh)),
    triangles: meshes.map((mesh) => mesh.indices.length / 3),
  });
  hlod.add(id, [ox, 0, oz, ox + SIZE, 90, oz + SIZE], ERRORS);
}
// #endregion

const ground = renderer.createMesh(
  new MeshBuilder()
    .addBox(
      [(GRID * SIZE) / 2, -0.1, (GRID * SIZE) / 2],
      [GRID * SIZE, 0.1, GRID * SIZE],
      [0.3, 0.31, 0.33],
    )
    .build(),
);

/** The switches: paint each level its own colour, how many pixels of error a level may show, and
    whether the selection runs at all. */
const LEVEL_TINTS: Vec3[] = [
  [1.3, 0.75, 0.5],
  [1.25, 1.15, 0.55],
  [0.55, 0.8, 1.35],
];
let paint = flag('paint', 'city');
let tolerance = Number(flag('tolerance', '1.5'));
let selecting = flag('hlod', 'on') === 'on';
controls([
  {
    key: 'paint',
    label: 'paint',
    value: paint,
    options: ['city', 'levels'].map((p) => ({ text: p, value: p })),
    change: (value) => {
      paint = value;
    },
  },
  {
    key: 'tolerance',
    label: 'pixels of error',
    value: String(tolerance),
    options: ['1.5', '8', '32'].map((t) => ({ text: t, value: t })),
    change: (value) => {
      tolerance = Number(value);
    },
  },
  {
    key: 'hlod',
    label: 'selection',
    value: selecting ? 'on' : 'off',
    options: [
      { text: 'on', value: 'on' },
      { text: 'off: every block finest', value: 'off' },
    ],
    change: (value) => {
      selecting = value === 'on';
    },
  },
]);

const env = createEnvironment({
  directionalDir: [0.4, 0.8, 0.3],
  directionalColor: [1.9, 1.8, 1.65],
  ambient: [0.35, 0.38, 0.45],
  ambientGround: [0.16, 0.15, 0.14],
  fogColor: [0.55, 0.62, 0.72],
  fogDensity: 0.0008,
});
const SKY = srgbColor(0.55, 0.62, 0.72);
const frustum = new Float32Array(24);
const eye = new Float32Array(3);
const shown = [0, 0, 0];
const readout = createReadout(renderer, 2);

let time = 0;
let shownAt = 0;
stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    const dt = time - shownAt;
    shownAt = time;

    /* Up and down an avenue, from head height to over the roofs and back once a minute. */
    const climb = (1 - Math.cos(time * 0.105)) / 2;
    const along = 600 - Math.cos(time * 0.04) * 480;
    camera.fovYDeg = 55;
    camera.near = 0.3;
    camera.far = 3000;
    camera.position[0] = 499;
    camera.position[1] = 1.8 + climb * 340;
    camera.position[2] = along;
    camera.lookAt(499 + Math.sin(time * 0.2) * 40, 8, along + 300 + climb * 200);
    camera.updateMatrices(renderer.cssWidth / Math.max(1, renderer.cssHeight));
    frustumFromViewProjection(camera.viewProjection, frustum);
    eye[0] = camera.position[0];
    eye[1] = camera.position[1];
    eye[2] = camera.position[2];

    renderer.beginFrame(SKY);
    renderer.bindMeshPass(camera, env);
    // #region select
    /* Each block hides what is behind it, up to its lowest roofs. */
    for (let id = 0; id < GRID * GRID; id += 1) {
      const ox = (id % GRID) * SIZE;
      const oz = Math.floor(id / GRID) * SIZE;
      renderer.addOccluder([ox + 13, 0, oz + 13], [ox + 87, 12, oz + 87], IDENTITY);
    }
    renderer.drawMesh(ground, IDENTITY);

    /* The switch distance is error · scale / tolerance, so a looser tolerance is a smaller scale. */
    const scale = (projectionScaleOf(camera.fovYDeg, stage.canvas.height) * 1.5) / tolerance;
    const count = selecting ? hlod.select(eye, scale, frustum, renderer, dt, draws) : 0;
    shown.fill(0);
    let triangles = 0;
    const drawRegion = (id: number, level: number, dither: number): void => {
      const region = regions[id];
      const mesh = region?.levels[level];
      if (region === undefined || mesh === undefined) return;
      if (dither !== 0) renderer.setDitherFade(dither);
      renderer.drawMesh(mesh, IDENTITY, undefined, paint === 'levels' ? LEVEL_TINTS[level] : null);
      if (dither !== 0) renderer.setDitherFade(0);
      triangles += region.triangles[level] ?? 0;
      if (dither >= 0) shown[level] = (shown[level] ?? 0) + 1;
    };
    if (selecting) {
      for (let i = 0; i < count; i += 1)
        drawRegion(draws.region[i] ?? 0, draws.level[i] ?? 0, draws.dither[i] ?? 0);
    } else {
      for (let id = 0; id < GRID * GRID; id += 1) drawRegion(id, 0, 0);
    }
    // #endregion

    readout.set(0, `LEVELS ${shown[0]} / ${shown[1]} / ${shown[2]} BLOCKS`);
    readout.set(1, `${(triangles / 1e6).toFixed(2)} M TRIANGLES`);
    readout.draw(time);
    renderer.endFrame();
  },
});
