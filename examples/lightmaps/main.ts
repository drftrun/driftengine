/**
 * A room lit by a lightmap: light baked once, here on the CPU from a warm lamp the scene does not
 * otherwise have, with the shadow of a box on the floor that no shadow map draws.
 *
 * A bake from another tool arrives as the same two images a page holds: the irradiance at each
 * texel, and the direction it arrives from as a first-order spherical harmonic. Every surface reads
 * its own region of the page at its second set of coordinates. The switch turns the page off, which
 * leaves the room to its faint ambient: what is left is what the bake was carrying.
 */
import { MeshBuilder, createEnvironment, lightmapModel, srgbColor } from '@driftengine/core';
import type {
  LightmapPage,
  LightmapRegion,
  MeshData,
  SurfaceMaterial,
  SurfaceTextureHandle,
  Vec3,
} from '@driftengine/core';
import { controls, flag, openStage } from '../common/stage';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.02, 0.022, 0.026);

const stage = await openStage({ outputTransform: 'aces' });
const { renderer, camera } = stage;

/** Texels a side of each of the page's three regions: the floor, the back wall, the left wall. */
const SIDE = 64;
/** The lamp the bake was made from, and its intensity: warm, with nothing in the scene at it. */
const LAMP: Vec3 = [1.6, 3.6, -0.8];
const POWER: Vec3 = [7, 5, 3.2];
/** The box on the floor, whose shadow is in the bake. */
const BOX: Vec3 = [-0.6, 0.6, -1.2];
const HALF = 0.6;

/** Where each region's texel is in the world, from its own coordinates. */
const SURFACES: readonly ((u: number, v: number) => Vec3)[] = [
  (u, v) => [-4 + 8 * u, 0, -4 + 8 * v],
  (u, v) => [-4 + 8 * u, 5 * v, -4],
  (u, v) => [-4, 5 * v, -4 + 8 * u],
];

/** Whether the segment from `p` to the lamp passes through the box: a slab test. */
function blocked(p: Vec3): boolean {
  let near = 0;
  let far = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const from = p[axis] as number;
    const along = (LAMP[axis] as number) - from;
    const lo = (BOX[axis] as number) - HALF;
    const hi = (BOX[axis] as number) + HALF;
    if (Math.abs(along) < 1e-9) {
      if (from < lo || from > hi) return false;
      continue;
    }
    const t0 = (lo - from) / along;
    const t1 = (hi - from) / along;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    if (near > far) return false;
  }
  return true;
}

// #region bake
/** One byte of a direction component, stored as `v * 0.5 + 0.5`. */
const byte = (v: number): number => Math.round((v * 0.5 + 0.5) * 255);

/**
 * The page: the lamp's light at each texel with the direction it comes from, and a faint bounce
 * from every side, carried by the harmonic's constant, so a shadow is not black.
 */
function bake(): LightmapPage {
  const width = SIDE * 3;
  const irradiance = new Float32Array(width * SIDE * 3);
  const direction = new Uint8Array(width * SIDE * 4);
  for (let region = 0; region < 3; region += 1) {
    const surface = SURFACES[region] as (u: number, v: number) => Vec3;
    for (let y = 0; y < SIDE; y += 1) {
      for (let x = 0; x < SIDE; x += 1) {
        const p = surface((x + 0.5) / SIDE, (y + 0.5) / SIDE);
        const dx = LAMP[0] - p[0];
        const dy = LAMP[1] - p[1];
        const dz = LAMP[2] - p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2);
        const lit = blocked(p) ? 0 : 1;
        const t = y * width + region * SIDE + x;
        for (let c = 0; c < 3; c += 1)
          irradiance[t * 3 + c] = ((POWER[c] as number) * lit) / d2 + 0.04;
        const share = lit === 0 ? 0 : 1 - 0.04 / (irradiance[t * 3] as number);
        direction.set(
          [byte((dx / d) * share), byte((dy / d) * share), byte((dz / d) * share), byte(1 - share)],
          t * 4,
        );
      }
    }
  }
  return { width, height: SIDE, irradiance, direction };
}
// #endregion

/** A surface's mesh, its second coordinates read back off its positions. */
function surface(
  build: (b: MeshBuilder) => MeshBuilder,
  uv: (p: Vec3) => [number, number],
): MeshData {
  const data = build(new MeshBuilder()).build();
  const lightmapUvs = new Float32Array((data.positions.length / 3) * 2);
  for (let i = 0; i < lightmapUvs.length / 2; i += 1) {
    const p: Vec3 = [
      data.positions[i * 3] as number,
      data.positions[i * 3 + 1] as number,
      data.positions[i * 3 + 2] as number,
    ];
    lightmapUvs.set(uv(p), i * 2);
  }
  return { ...data, lightmapUvs };
}

const PALE: Vec3 = [0.78, 0.76, 0.72];
const floor = renderer.createMesh(
  surface(
    (b) => b.addGroundQuad([-4, 0, -4], [4, 0, -4], [4, 0, 4], [-4, 0, 4], PALE),
    (p) => [(p[0] + 4) / 8, (p[2] + 4) / 8],
  ),
);
const back = renderer.createMesh(
  surface(
    (b) => b.addWallQuad([-4, 0, -4], [4, 0, -4], [4, 5, -4], [-4, 5, -4], [0, 2, -10], PALE),
    (p) => [(p[0] + 4) / 8, p[1] / 5],
  ),
);
const left = renderer.createMesh(
  surface(
    (b) =>
      b.addWallQuad(
        [-4, 0, -4],
        [-4, 0, 4],
        [-4, 5, 4],
        [-4, 5, -4],
        [-10, 2, 0],
        [0.6, 0.66, 0.74],
      ),
    (p) => [(p[2] + 4) / 8, p[1] / 5],
  ),
);
const box = renderer.createMesh(
  new MeshBuilder().addBox(BOX, [HALF, HALF, HALF], [0.5, 0.35, 0.25]).build(),
);

// #region material
const page = renderer.createLightmap(bake());
/** Region `k` of the page's three, as `[scaleU, scaleV, biasU, biasV]`. */
const third = (k: number): LightmapRegion => [1 / 3, 1, k / 3, 0];
const baked = (k: number): SurfaceMaterial<SurfaceTextureHandle> => ({
  model: lightmapModel({ region: third(k) }),
  modelMap: page,
});
// #endregion
const materials = [baked(0), baked(1), baked(2)];

const env = createEnvironment({
  directionalDir: [0.3, 1, 0.4],
  directionalColor: [0.05, 0.05, 0.06],
  ambient: [0.15, 0.15, 0.15],
  ambientGround: [0.15, 0.15, 0.15],
  fogDensity: 0,
});
camera.fovYDeg = 50;
camera.position[0] = 1.2;
camera.position[1] = 3.4;
camera.position[2] = 8;
camera.lookAt(-0.6, 1.4, -1.5);

let lit = flag('page', 'on') === 'on';
controls([
  {
    key: 'page',
    label: 'baked light',
    value: lit ? 'on' : 'off',
    options: [
      { text: 'on', value: 'on' },
      { text: 'off', value: 'off' },
    ],
    change: (value) => {
      lit = value === 'on';
    },
  },
]);

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const walls = [floor, back, left];
stage.run({
  render() {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    for (let k = 0; k < walls.length; k += 1) {
      renderer.setMaterial(lit ? (materials[k] ?? null) : null);
      renderer.drawMesh(walls[k] as (typeof walls)[number], IDENTITY);
    }
    renderer.setMaterial(null);
    renderer.drawMesh(box, IDENTITY);
    renderer.endFrame();
  },
});
