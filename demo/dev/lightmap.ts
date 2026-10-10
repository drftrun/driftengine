/**
 * A room lit by a lightmap baked here, on the CPU, from a warm lamp the scene does not have — with
 * the shadow of a box on the floor that no shadow map draws.
 *
 *     /lightmap.html                 the room: floor and two walls, three regions of one page
 *     /lightmap.html?mode=off        the same room with no lightmap: what the bake adds
 *     /lightmap.html?mode=tiles      the floor as sixteen tiles in one instanced batch, each tile's
 *                                    region its own instance's, composed with the floor's
 *     /lightmap.html?mode=each       the same sixteen tiles drawn one at a time, each with its
 *                                    region in its material: the control for `tiles`
 *     /lightmap.html?mode=tiles&fade=0.5   every other tile at opacity 0.5 through
 *                                    `setDitherOpacity`: about half its pixels kept, each lit as in
 *                                    `tiles`, and the opaque tiles exactly as in `tiles`
 *     /lightmap.html?mode=flat       the floor alone under a page of one value, 0.25 arriving
 *                                    straight down, which adds exactly half the albedo
 *     /lightmap.html?mode=flatref    the floor alone with no page and its own ambient 0.5 higher,
 *                                    through `setAmbientSH`: the control for `flat`
 *
 * **The two controls are the claims.** `tiles` against `each` is the instance's region against the
 * material's, and `flat` against `flatref` is the page's units against the ambient's: a page whose
 * irradiance is 0.25 and whose direction is straight up with a constant of one adds twice that to a
 * floor, which is the ambient raised by 0.5. Both pairs are the same frame or the feature is wrong.
 * The reference raises the *draw's* ambient and not the frame's, because the frame's also colours
 * the reflection the floor blends toward — a control that moved two things at once.
 *
 * Deterministic: a fixed camera, a closed form, and no clock. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createMeshInstances,
  createRenderer,
  lightmapModel,
} from '../../packages/core/src/index';
import type {
  LightmapPage,
  LightmapRegion,
  MeshData,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.02, 0.022, 0.026];
const mode = new URLSearchParams(location.search).get('mode') ?? 'room';
const fade = Number(new URLSearchParams(location.search).get('fade') ?? '1');
/** Texels a side of each of the page's three regions. */
const SIDE = 64;
/** The lamp the bake was made from, and its intensity: warm, with nothing in the scene at it. */
const LAMP: Vec3 = [1.6, 3.6, -0.8];
const LAMP_POWER: Vec3 = [7, 5, 3.2];
/** The box on the floor, whose shadow is in the bake: centre and half extents. */
const BOX_CENTRE: Vec3 = [-0.6, 0.6, -1.2];
const BOX_HALF: Vec3 = [0.6, 0.6, 0.6];
const TILES = 4;

/** Each surface's place in the world, from its own lightmap coordinates. */
type Surface = (u: number, v: number) => { position: Vec3; normal: Vec3 };
const FLOOR: Surface = (u, v) => ({ position: [-4 + 8 * u, 0, -4 + 8 * v], normal: [0, 1, 0] });
const BACK: Surface = (u, v) => ({ position: [-4 + 8 * u, 5 * v, -4], normal: [0, 0, 1] });
const LEFT: Surface = (u, v) => ({ position: [-4, 5 * v, -4 + 8 * u], normal: [1, 0, 0] });

/** Whether the segment from `p` to the lamp passes through the box: a slab test. */
function blocked(p: Vec3): boolean {
  let near = 0;
  let far = 1;
  for (let axis = 0; axis < 3; axis++) {
    const from = p[axis] as number;
    const along = (LAMP[axis] as number) - from;
    const lo = (BOX_CENTRE[axis] as number) - (BOX_HALF[axis] as number);
    const hi = (BOX_CENTRE[axis] as number) + (BOX_HALF[axis] as number);
    if (Math.abs(along) < 1e-9) {
      if (from < lo || from > hi) return false;
      continue;
    }
    let t0 = (lo - from) / along;
    let t1 = (hi - from) / along;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return false;
  }
  return true;
}

/** One byte of a direction component: `v * 0.5 + 0.5`, as `LightmapPage.direction` stores it. */
const byte = (v: number): number => Math.round((v * 0.5 + 0.5) * 255);

/**
 * The page: three regions side by side — floor, back wall, left wall — each the lamp's light at
 * that texel, with its direction, and a faint cool bounce from everywhere so a shadow is not black.
 */
function bake(): LightmapPage {
  const width = SIDE * 3;
  const height = SIDE;
  const irradiance = new Float32Array(width * height * 3);
  const direction = new Uint8Array(width * height * 4);
  const surfaces = [FLOOR, BACK, LEFT];
  for (let region = 0; region < 3; region++) {
    const surface = surfaces[region] as Surface;
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        const { position } = surface((x + 0.5) / SIDE, (y + 0.5) / SIDE);
        const dx = LAMP[0] - position[0];
        const dy = LAMP[1] - position[1];
        const dz = LAMP[2] - position[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2);
        const lit = blocked(position) ? 0 : 1;
        const t = y * width + region * SIDE + x;
        /* The lamp, carried with its direction, plus a bounce carried by the constant alone. */
        for (let c = 0; c < 3; c++) {
          irradiance[t * 3 + c] = ((LAMP_POWER[c] as number) * lit) / d2 + 0.04;
        }
        const share = lit === 0 ? 0 : 1 - 0.04 / (irradiance[t * 3] as number);
        direction[t * 4] = byte((dx / d) * share);
        direction[t * 4 + 1] = byte((dy / d) * share);
        direction[t * 4 + 2] = byte((dz / d) * share);
        direction[t * 4 + 3] = byte(1 - share);
      }
    }
  }
  return { width, height, irradiance, direction };
}

/** One value everywhere, arriving straight down: the `flat` control's page. */
function flatPage(): LightmapPage {
  const texels = 4 * 4;
  const irradiance = new Float32Array(texels * 3).fill(0.25);
  const direction = new Uint8Array(texels * 4);
  for (let t = 0; t < texels; t++) direction.set([128, 255, 128, 255], t * 4);
  return { width: 4, height: 4, irradiance, direction };
}

/** A mesh's lightmap coordinates, read back off its positions by the surface's own inverse. */
function withUvs(data: MeshData, uv: (p: Vec3) => [number, number]): MeshData {
  const count = data.positions.length / 3;
  const lightmapUvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [
      data.positions[i * 3] as number,
      data.positions[i * 3 + 1] as number,
      data.positions[i * 3 + 2] as number,
    ];
    const [u, v] = uv(p);
    lightmapUvs[i * 2] = u;
    lightmapUvs[i * 2 + 1] = v;
  }
  return { ...data, lightmapUvs };
}

const PALE: Vec3 = [0.78, 0.76, 0.72];

function floorMesh(): MeshData {
  const built = new MeshBuilder()
    .addGroundQuad([-4, 0, -4], [4, 0, -4], [4, 0, 4], [-4, 0, 4], PALE)
    .build();
  return withUvs(built, (p) => [(p[0] + 4) / 8, (p[2] + 4) / 8]);
}

/** One tile of the floor, its own coordinates across it: an instance's region places it. */
function tileMesh(): MeshData {
  const s = 8 / TILES;
  const built = new MeshBuilder()
    .addGroundQuad([0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s], PALE)
    .build();
  return withUvs(built, (p) => [p[0] / s, p[2] / s]);
}

function backMesh(): MeshData {
  const built = new MeshBuilder()
    .addWallQuad([-4, 0, -4], [4, 0, -4], [4, 5, -4], [-4, 5, -4], [0, 2, -10], PALE)
    .build();
  return withUvs(built, (p) => [(p[0] + 4) / 8, p[1] / 5]);
}

function leftMesh(): MeshData {
  const built = new MeshBuilder()
    .addWallQuad([-4, 0, -4], [-4, 0, 4], [-4, 5, 4], [-4, 5, -4], [-10, 2, 0], [0.6, 0.66, 0.74])
    .build();
  return withUvs(built, (p) => [(p[2] + 4) / 8, p[1] / 5]);
}

/** Region `k` of the page's three. */
const third = (k: number): LightmapRegion => [1 / 3, 1, k / 3, 0];

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const flat = mode === 'flat' || mode === 'flatref';
  const ambient = 0.15;
  /* 0.65 from every direction, as nine coefficients: a constant radiance r is c00 = r / Y00. */
  const raised = new Array<number>(27).fill(0);
  for (let c = 0; c < 3; c++) raised[c] = 0.65 / 0.282095;
  const env = createEnvironment({
    directionalDir: [0.3, 1, 0.4],
    directionalColor: flat ? [0, 0, 0] : [0.05, 0.05, 0.06],
    ambient: [ambient, ambient, ambient],
    ambientGround: [ambient, ambient, ambient],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.position[0] = 1.2;
  camera.position[1] = 3.4;
  camera.position[2] = 8;
  camera.lookAt(-0.6, 1.4, -1.5);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const page = renderer.createLightmap(flat ? flatPage() : bake());
  const floor = renderer.createMesh(floorMesh());
  const back = renderer.createMesh(backMesh());
  const left = renderer.createMesh(leftMesh());
  const box = renderer.createMesh(
    new MeshBuilder().addBox(BOX_CENTRE, BOX_HALF, [0.5, 0.35, 0.25]).build(),
  );
  const tile = renderer.createMesh(tileMesh());
  const batch = renderer.createInstanced(tile, TILES * TILES);
  const instances = {
    ...createMeshInstances(TILES * TILES),
    lightmapRegions: new Float32Array(TILES * TILES * 4),
  };
  const tileModels: Float32Array[] = [];
  const tileRegions: LightmapRegion[] = [];
  const s = 8 / TILES;
  for (let j = 0; j < TILES; j++) {
    for (let i = 0; i < TILES; i++) {
      const k = j * TILES + i;
      const model = new Float32Array([
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        -4 + i * s,
        0,
        -4 + j * s,
        1,
      ]);
      tileModels.push(model);
      instances.models.set(model, k * 16);
      instances.lightmapRegions.set([1 / TILES, 1 / TILES, i / TILES, j / TILES], k * 4);
      /* Every other tile faded, where the page asks: the rest stay opaque, the control. */
      if (instances.alphas !== undefined) instances.alphas[k] = (i + j) % 2 === 1 ? fade : 1;
      /* The instance's region composed with the floor's, by hand: what `each` hands a material. */
      tileRegions.push([1 / (3 * TILES), 1 / TILES, i / (3 * TILES), j / TILES]);
    }
  }
  instances.count = TILES * TILES;
  renderer.uploadInstanced(batch, instances);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const baked = mode !== 'off' && mode !== 'flatref';
  const regionMaterial = (region: LightmapRegion): Parameters<RendererApi['setMaterial']>[0] =>
    baked ? { model: lightmapModel({ region }), modelMap: page } : null;
  const floorMaterial = regionMaterial(flat ? [1, 1, 0, 0] : third(0));
  const backMaterial = regionMaterial(third(1));
  const leftMaterial = regionMaterial(third(2));
  const eachMaterials = tileRegions.map(regionMaterial);

  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    if (mode === 'tiles') {
      renderer.setMaterial(floorMaterial);
      if (fade < 1) renderer.setDitherOpacity(true);
      renderer.drawInstanced(batch, instances);
      renderer.setDitherOpacity(false);
    } else if (mode === 'each') {
      for (let k = 0; k < tileModels.length; k++) {
        renderer.setMaterial(eachMaterials[k] ?? null);
        renderer.drawMesh(tile, tileModels[k] as Float32Array);
      }
    } else {
      renderer.setMaterial(floorMaterial);
      if (mode === 'flatref') renderer.setAmbientSH(raised);
      renderer.drawMesh(floor, identity);
      renderer.setAmbientSH(null);
    }
    if (!flat) {
      renderer.setMaterial(backMaterial);
      renderer.drawMesh(back, identity);
      renderer.setMaterial(leftMaterial);
      renderer.drawMesh(left, identity);
      renderer.setMaterial(null);
      renderer.drawMesh(box, identity);
    }
    renderer.endFrame();
    drawn += 1;
    if (drawn === 3) (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
    requestAnimationFrame(frame);
  };
  let drawn = 0;
  frame();
  stats.textContent =
    `${created.backend} · lightmap · ${mode}` + (fade < 1 ? ` · every other tile at ${fade}` : '');
}

void main();
