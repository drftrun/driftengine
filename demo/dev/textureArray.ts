/**
 * One merged mesh wearing six images is one draw, on either backend.
 *
 *     /textureArray.html                 the default backend
 *     /textureArray.html?backend=webgl2  the other one
 *
 * **Left to right along the back**: six panels merged into one mesh, each naming a different layer
 * of one six-layer albedo array, drawn by **one** `drawMesh` under one material. Each panel is its
 * own colour with its own count of white bars (one to six), so a panel showing another's picture is
 * readable at a glance. An emissive array built in the same order puts a glowing frame on the odd
 * panels only, which proves every map of a material is read at the vertex's layer.
 *
 * **Front left**: a plain one-image texture — a checker — as the regression: every surface texture
 * is an array now, and a plain image is an array of one.
 *
 * **Front right**: a card on layer 1 of a two-layer cutout array. Layer 0 is solid and layer 1 is a
 * lattice of holes, so the card's shadow has holes only if the depth pass reads the layer too.
 *
 * **What a failure looks like**: every panel the same picture (the layer never reached the shader, or
 * was truncated to 0); panels shifted one along (the layer rounded the wrong way); the glow on the
 * even panels (emissive read at another layer); a solid card shadow (the depth pass read layer 0);
 * the checker missing (a one-layer array bound wrongly). Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  concatMeshes,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshData,
  MeshHandle,
  RendererApi,
  SceneCasterMaterial,
  ShadowCasterSink,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const SUN: Vec3 = [0.25, 0.8, 0.55];
const PANELS = 6;
const SIZE = 128;

const COLOURS: readonly (readonly [number, number, number])[] = [
  [200, 60, 50],
  [220, 150, 40],
  [70, 160, 70],
  [50, 140, 200],
  [120, 80, 200],
  [200, 70, 160],
];

function canvas2d(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('textureArray: no 2D context');
  return [canvas, ctx];
}

/** Panel `k`: its colour, and k + 1 white bars across it. */
function panelImage(k: number): HTMLCanvasElement {
  const [canvas, ctx] = canvas2d();
  const [r, g, b] = COLOURS[k] ?? [128, 128, 128];
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#fff';
  const bars = k + 1;
  for (let i = 0; i < bars; i++) ctx.fillRect(16 + i * 16, 24, 10, SIZE - 48);
  return canvas;
}

/** A glowing frame on the odd panels, black on the even ones. */
function glowImage(k: number): HTMLCanvasElement {
  const [canvas, ctx] = canvas2d();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  if (k % 2 === 1) {
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, SIZE - 16, SIZE - 16);
  }
  return canvas;
}

function checkerImage(): HTMLCanvasElement {
  const [canvas, ctx] = canvas2d();
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#e8e8e8' : '#303030';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  return canvas;
}

/** Layer 0 solid, layer 1 a lattice of round holes. */
function cardImage(holes: boolean): HTMLCanvasElement {
  const [canvas, ctx] = canvas2d();
  const image = ctx.createImageData(SIZE, SIZE);
  const cell = SIZE / 4;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x % cell) / cell - 0.5;
      const dy = (y % cell) / cell - 0.5;
      const i = (y * SIZE + x) * 4;
      image.data[i] = 70;
      image.data[i + 1] = 150;
      image.data[i + 2] = 60;
      image.data[i + 3] = holes && dx * dx + dy * dy < 0.09 ? 0 : 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** An upright quad `w` by `h` centred at (x, y, z) facing +Z, both faces, on `layer`. */
function quad(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  layer: number | null,
): MeshData {
  const corners = [
    [-1, -1, 0, 1],
    [1, -1, 1, 1],
    [1, 1, 1, 0],
    [-1, 1, 0, 0],
  ] as const;
  const positions = new Float32Array(24);
  const normals = new Float32Array(24);
  const uvs = new Float32Array(16);
  for (let face = 0; face < 2; face++) {
    for (let c = 0; c < 4; c++) {
      const [sx, sy, u, v] = corners[c] ?? [0, 0, 0, 0];
      const at = face * 4 + c;
      positions.set([x + (sx * w) / 2, y + (sy * h) / 2, z], at * 3);
      normals.set([0, 0, face === 0 ? 1 : -1], at * 3);
      uvs.set([u, v], at * 2);
    }
  }
  return {
    positions,
    normals,
    colors: new Float32Array(24).fill(1),
    emissive: new Float32Array(8).fill(layer === null ? 0 : 1),
    uvs,
    ...(layer === null ? {} : { layers: new Float32Array(8).fill(layer) }),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const panels: MeshData[] = [];
  for (let k = 0; k < PANELS; k++) panels.push(quad(-5 + k * 2, 2.2, -2, 1.8, 1.8, k));
  const wall: MeshHandle = renderer.createMesh(concatMeshes(panels));
  const wallMaterial = {
    albedo: renderer.createSurfaceTextureArray(
      Array.from({ length: PANELS }, (_, k) => panelImage(k)),
      { colorSpace: 'srgb' },
    ),
    emissive: renderer.createSurfaceTextureArray(
      Array.from({ length: PANELS }, (_, k) => glowImage(k)),
      { colorSpace: 'srgb' },
    ),
  };

  const plain: MeshHandle = renderer.createMesh(quad(-3, 1, 1.5, 1.8, 1.8, null));
  const checker = { albedo: renderer.createSurfaceTexture(checkerImage(), { colorSpace: 'srgb' }) };

  const card: MeshHandle = renderer.createMesh(quad(0, 0, 0, 1.8, 1.8, 1));
  const cardMaterial: SceneCasterMaterial = {
    albedo: renderer.createSurfaceTextureArray([cardImage(false), cardImage(true)]),
    cutout: 0.5,
  };
  const CARD = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 3, 1.4, 1.5, 1]);

  const floor: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.1, 0], [9, 0.1, 6], [0.42, 0.44, 0.48]).build(),
  );

  const env = createEnvironment();
  env.directionalDir = SUN;
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.2, 0.22, 0.26];
  env.shadowStrength = 0.9;
  env.nightFactor = 1;

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.3;
  camera.far = 200;
  camera.position[1] = 4.5;
  camera.position[2] = 9.5;
  camera.lookAt(0, 1.2, 0);
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
  renderer.drawShadowCasters((sink: ShadowCasterSink) => sink.mesh(card, CARD, cardMaterial));
  renderer.endShadowPass();

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floor, IDENTITY);
  renderer.setMaterial(wallMaterial);
  renderer.drawMesh(wall, IDENTITY);
  renderer.setMaterial(checker);
  renderer.drawMesh(plain, IDENTITY);
  renderer.setMaterial(cardMaterial);
  renderer.drawMesh(card, CARD);
  renderer.setMaterial(null);
  renderer.endFrame();

  stats.textContent = `${created.backend} · ${created.reason} · six panels, one draw`;
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
