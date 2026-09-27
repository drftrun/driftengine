/**
 * A cutout casts the shape in its texture, not its quad, on either backend.
 *
 * **No published scene has a cutout caster**, so the published-scene gate cannot show this either
 * direction: a zero-pixel diff there only proves the change moved nothing. The proof lives here.
 *
 *     /cutoutShadows.html                 the default backend
 *     /cutoutShadows.html?backend=webgpu  the other one
 *     /cutoutShadows.html?cutout=0        no caster offers a material: three solid shadows
 *
 * Three identical cards, a lattice of round holes cut out of each by its alpha, held flat above a
 * floor with the sun behind them. Each card's *picture* has the holes in all three cases, because
 * the colour pass has always discarded below the cutoff:
 *
 *   - **left**, a mesh whose caster offers its material. Its shadow must have the holes.
 *   - **centre**, the same card as an instanced batch of one, offering its material. Also holes. It
 *     goes through a second pipeline on each backend, which is why it has a card of its own.
 *   - **right**, a mesh whose caster offers **no** material. A solid shadow: this is how every
 *     alpha-cut surface cast before 4.4.0, and it stays in the frame as the control.
 *
 * **What a failure looks like**: the left or centre shadow solid (the sink ignored the material, or
 * the cutoff never reached the shader); the holes in the shadow shifted from those in the card (the
 * UV scale did not reach the depth pass); every shadow gone (the cutout program discards everything,
 * which is a cutoff read from the wrong offset); or the page matching `?cutout=0` exactly.
 *
 * Deterministic: one fixed light, one fixed camera, one frame, and a texture painted from a closed
 * form. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  SceneCasterMaterial,
  ShadowCasterSink,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];

/** Pointing at the sun: high and behind the cards, so each shadow lands on open floor toward the camera. */
const SUN: Vec3 = [0.18, 0.86, -0.48];

/** Holes across and down the card's texture. Few, so each one is many pixels in the shadow. */
const HOLES = 4;

function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Green where the card is and transparent in a disc at the centre of each cell. */
function paintLattice(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(size, size);
  const cell = size / HOLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x % cell) / cell - 0.5;
      const dy = (y % cell) / cell - 0.5;
      const inside = dx * dx + dy * dy < 0.3 * 0.3;
      const i = (y * size + x) * 4;
      image.data[i] = 70;
      image.data[i + 1] = 150;
      image.data[i + 2] = 60;
      image.data[i + 3] = inside ? 0 : 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * A flat card two metres square, both faces, UVs across it once.
 *
 * Both faces because which one a depth pass culls is not this page's question, and a card culled
 * from the light casts nothing, which would read as the cutout having removed everything.
 */
function card(): Parameters<RendererApi['createMesh']>[0] {
  const half = 1;
  const corners = [
    [-half, 0, -half, 0, 0],
    [half, 0, -half, 1, 0],
    [half, 0, half, 1, 1],
    [-half, 0, half, 0, 1],
  ] as const;
  const positions = new Float32Array(24);
  const normals = new Float32Array(24);
  const uvs = new Float32Array(16);
  for (let face = 0; face < 2; face++) {
    for (let c = 0; c < 4; c++) {
      const corner = corners[c] as readonly number[];
      const v = face * 4 + c;
      positions.set([corner[0] ?? 0, corner[1] ?? 0, corner[2] ?? 0], v * 3);
      normals.set([0, face === 0 ? 1 : -1, 0], v * 3);
      uvs.set([corner[3] ?? 0, corner[4] ?? 0], v * 2);
    }
  }
  return {
    positions,
    normals,
    colors: new Float32Array(24).fill(1),
    emissive: new Float32Array(8),
    uvs,
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const offered = new URLSearchParams(location.search).get('cutout') !== '0';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.1, 0], [9, 0.1, 9], [0.42, 0.44, 0.48]).build(),
  );
  const leaf: MeshHandle = renderer.createMesh(card());
  const albedo = renderer.createSurfaceTexture(paintLattice());
  const material: SceneCasterMaterial = { albedo, cutout: 0.5 };
  const asCaster: SceneCasterMaterial = offered ? material : null;

  const LEFT = at(-2.6, 1.3, 0);
  const RIGHT = at(2.6, 1.3, 0);
  const batch = renderer.createInstanced(leaf, 1);
  const centre = createMeshInstances(1);
  centre.models.set(at(0, 1.3, 0));
  centre.tints.set([1, 1, 1]);
  centre.count = 1;
  renderer.uploadInstanced(batch, centre);

  const casters = (sink: ShadowCasterSink): void => {
    sink.mesh(leaf, LEFT, asCaster);
    sink.instanced?.(batch, centre, asCaster);
    sink.mesh(leaf, RIGHT, null);
  };

  const env = createEnvironment();
  env.directionalDir = SUN;
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.16, 0.18, 0.23];
  env.shadowStrength = 0.9;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 200;
  camera.position[1] = 7.2;
  camera.position[2] = 8.5;
  camera.lookAt(0, 0, 1.2);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const lightMatrix = new Float32Array(16);
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    0,
    1,
    0,
    9,
    renderer.shadowMapSize,
    lightMatrix,
  );
  env.lightViewProj = lightMatrix;

  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters(casters);
  renderer.endShadowPass();

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floor, IDENTITY);
  renderer.setMaterial(material);
  renderer.drawMesh(leaf, LEFT);
  renderer.drawInstanced(batch, centre);
  renderer.drawMesh(leaf, RIGHT);
  renderer.setMaterial(null);
  renderer.endFrame();

  stats.textContent =
    `${created.backend} · ${created.reason} · casters ${offered ? 'offer' : 'withhold'} ` +
    `their material · left mesh · centre instanced · right no material`;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
