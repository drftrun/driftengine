/**
 * Three things a consumer could not do until 4.8.3, each turned on and photographed.
 *
 *     /surfaceDials.html?show=fog                         an opaque surface out of the fog
 *     /surfaceDials.html?show=flipbook                    a strip's cells picked by UV offset
 *     /surfaceDials.html?show=shoulder&transform=shoulder the hue-keeping highlight shoulder
 *     /surfaceDials.html?show=shoulder&transform=srgb     the control: sRGB clips per channel
 *     ...&backend=webgpu, ...&hdr=1                       the other backend, and the resolve's grade
 *
 * **fog**: two identical red pillars far down a fogged floor. The left is drawn as every surface
 * is; the right with `setSurfaceFog(false)`, so it keeps its full colour where the left greys into
 * the medium. Between them a small unlit pane drawn while the dial is off but asking for fog, so it
 * must come out fogged like the left pillar: a translucent draw is measured against the dial and
 * puts it back. **A failure** is the right pillar as grey as the left, or the pane as clear as the
 * right pillar.
 *
 * **flipbook**: four cards from one mesh, each choosing one cell of a four-cell strip by
 * `uOffset` — red with one hole, green with two, blue with three, yellow with four — the last
 * through an instanced batch, whose vertex block is a second layout. Each card's shadow must carry
 * its own cell's holes, which is the offset reaching the depth pass. **A failure** is four red
 * cards, or a shadow whose holes are another cell's.
 *
 * **shoulder**: three unlit quads coloured past one: `(1.6, 0.4, 0.2)`, `(0.3, 1.4, 0.5)` and
 * `(2.4, 2.1, 0.6)`. Under `shoulder` the first reads about `(250, 137, 97)`; under `srgb` it clips
 * to `(255, 170, 124)`, pinker. With `hdr=1` the resolve grades rather than the forward pass, which
 * is the other copy of the curve.
 *
 * Deterministic: one fixed light, one fixed camera, one frame, textures painted from closed forms.
 * Nothing under `src/` may import this.
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
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const SUN: Vec3 = [0.18, 0.86, -0.48];
const CELLS = 4;
const CELL_COLOURS: readonly (readonly [number, number, number])[] = [
  [200, 60, 50],
  [60, 170, 70],
  [60, 90, 200],
  [220, 190, 50],
];

function at(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Four cells across, each its own colour, with one more round hole than the cell before. */
function paintStrip(): HTMLCanvasElement {
  const cell = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cell * CELLS;
  canvas.height = cell;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const which = Math.floor(x / cell);
      const holes = which + 1;
      const u = (x % cell) / cell;
      const v = y / cell;
      let inside = false;
      for (let h = 0; h < holes; h++) {
        const cx = (h + 0.5) / holes;
        const dx = (u - cx) * holes;
        const dy = (v - 0.5) * 2.2;
        if (dx * dx + dy * dy < 0.3) inside = true;
      }
      const colour = CELL_COLOURS[which] ?? [255, 255, 255];
      const i = (y * canvas.width + x) * 4;
      image.data[i] = colour[0];
      image.data[i + 1] = colour[1];
      image.data[i + 2] = colour[2];
      image.data[i + 3] = inside ? 0 : 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A flat card two metres square, both faces, UVs across it once. */
function card(): Parameters<RendererApi['createMesh']>[0] {
  const corners = [
    [-1, 0, -1, 0, 0],
    [1, 0, -1, 1, 0],
    [1, 0, 1, 1, 1],
    [-1, 0, 1, 0, 1],
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

/** An upright quad facing +z, one metre square, in one colour that may be past one. */
function swatch(
  colour: readonly [number, number, number],
): Parameters<RendererApi['createMesh']>[0] {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const colors = new Float32Array(12);
  for (let v = 0; v < 4; v++) colors.set(colour, v * 3);
  return {
    positions,
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors,
    emissive: new Float32Array(4),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const show = new URLSearchParams(location.search).get('show') ?? 'fog';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment();
  env.directionalDir = SUN;
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.2, 0.22, 0.26];
  env.shadowStrength = 0.9;
  env.fogColor = CLEAR;
  env.fogDensity = show === 'fog' ? 0.06 : 0;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 300;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  if (show === 'fog') {
    const floor = renderer.createMesh(
      new MeshBuilder().addBox([0, -0.1, -20], [8, 0.1, 30], [0.42, 0.44, 0.48]).build(),
    );
    const pillar = renderer.createMesh(
      new MeshBuilder().addBox([0, 2, 0], [1, 2, 1], [0.8, 0.12, 0.1]).build(),
    );
    const pane = renderer.createMesh(swatch([0.9, 0.9, 0.9]));
    camera.position[1] = 2.2;
    camera.position[2] = 8;
    camera.lookAt(0, 1.8, -20);
    camera.updateMatrices(aspect);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, IDENTITY);
    renderer.drawMesh(pillar, at(-3, 0, -24));
    renderer.setSurfaceFog(false);
    renderer.drawMesh(pillar, at(3, 0, -24));
    /* Under the dial, and asking for fog: it must come out as grey as the left pillar. */
    renderer.drawTranslucentMesh(pane, at(0, 2, -24, 1.4, 1.4, 1), 1, { lit: false });
    renderer.setSurfaceFog(true);
    renderer.endFrame();
  } else if (show === 'flipbook') {
    const floor = renderer.createMesh(
      new MeshBuilder().addBox([0, -0.1, 0], [12, 0.1, 9], [0.42, 0.44, 0.48]).build(),
    );
    const leaf: MeshHandle = renderer.createMesh(card());
    const albedo = renderer.createSurfaceTexture(paintStrip());
    const cellOf = (which: number): SceneCasterMaterial => ({
      albedo,
      cutout: 0.5,
      uScale: 1 / CELLS,
      uOffset: which / CELLS,
    });
    const placed = [at(-6, 1.3, 0), at(-2, 1.3, 0), at(2, 1.3, 0)];
    const batch = renderer.createInstanced(leaf, 1);
    const last = createMeshInstances(1);
    last.models.set(at(6, 1.3, 0));
    last.tints.set([1, 1, 1]);
    last.count = 1;
    renderer.uploadInstanced(batch, last);

    const casters = (sink: ShadowCasterSink): void => {
      placed.forEach((model, which) => sink.mesh(leaf, model, cellOf(which)));
      sink.instanced?.(batch, last, cellOf(3));
    };
    camera.position[1] = 9;
    camera.position[2] = 10;
    camera.lookAt(0, 0, 1.2);
    camera.updateMatrices(aspect);
    const lightMatrix = new Float32Array(16);
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      1,
      0,
      12,
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
    placed.forEach((model, which) => {
      renderer.setMaterial(cellOf(which));
      renderer.drawMesh(leaf, model);
    });
    renderer.setMaterial(cellOf(3));
    renderer.drawInstanced(batch, last);
    renderer.setMaterial(null);
    renderer.endFrame();
  } else {
    const colours: readonly (readonly [number, number, number])[] = [
      [1.6, 0.4, 0.2],
      [0.3, 1.4, 0.5],
      [2.4, 2.1, 0.6],
    ];
    const swatches = colours.map((colour) => renderer.createMesh(swatch(colour)));
    camera.position[2] = 4;
    camera.lookAt(0, 0, 0);
    camera.updateMatrices(aspect);
    renderer.beginFrame([0.05, 0.06, 0.08]);
    renderer.bindMeshPass(camera, env);
    swatches.forEach((mesh, at3) => {
      renderer.drawTranslucentMesh(mesh, at((at3 - 1) * 1.3, 0, 0), 1, { lit: false, fog: false });
    });
    renderer.endFrame();
  }

  stats.textContent = `${created.backend} · ${created.reason} · ${show}`;
  (window as unknown as { __surfaceDialsReady?: boolean }).__surfaceDialsReady = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(error);
});
