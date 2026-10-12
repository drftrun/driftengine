/**
 * A material's tiled detail: regions chosen by a map in the ORM array, each with its own detail.
 *
 *     /detail.html             three regions: domes on the left half, ridges with an occlusion on
 *                              the right, diagonal ridges twice as steep on the right's top quarter
 *     /detail.html?detail=0    the control: the same material with no detail, a flat grey wall
 *     /detail.html?detail=one  one region and no region map, the domes everywhere
 *
 * **What it proves.** The wall is lit from low on one side, so a detail's slopes show as light and
 * shade. Where the full material reads region 0, the left half, it must draw what one region with
 * no map draws, to the pixel; where it reads the others it must differ; and with no detail at all
 * the wall is flat. The two backends must agree. Held at frame 60. Nothing under `src/` may import
 * this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  RendererApi,
  SurfaceDetail,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 60;
const SIZE = 64;

/** A canvas of `size` painted by `colour(x, y)`, 0 to 255 a channel, opaque. */
function paint(colour: (x: number, y: number) => [number, number, number]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('detail: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) image.data.set([...colour(x, y), 255], (y * SIZE + x) * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A tangent-space normal map from a height field over the tile, wrapping at its edges. */
function normals(height: (u: number, v: number) => number, steep: number): HTMLCanvasElement {
  const e = 1 / SIZE;
  return paint((x, y) => {
    const u = (x + 0.5) / SIZE;
    const v = (y + 0.5) / SIZE;
    const dx = ((height(u + e, v) - height(u - e, v)) / (2 * e)) * steep;
    const dy = ((height(u, v + e) - height(u, v - e)) / (2 * e)) * steep;
    const l = Math.hypot(dx, dy, 1);
    return [
      Math.round((-dx / l) * 127.5 + 127.5),
      Math.round((-dy / l) * 127.5 + 127.5),
      Math.round((1 / l) * 127.5 + 127.5),
    ];
  });
}

const dome = (u: number, v: number): number => {
  const d = Math.hypot(u - 0.5, v - 0.5);
  return d < 0.4 ? Math.sqrt(0.16 - d * d) : 0;
};
const ridges = (u: number): number => Math.sin(u * Math.PI * 4) * 0.05;
const diagonal = (u: number, v: number): number => Math.sin((u + v) * Math.PI * 2) * 0.05;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const mode = ASKED.get('detail') ?? 'regions';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const albedo = renderer.createSurfaceTexture(
    paint(() => [150, 150, 150]),
    { colorSpace: 'srgb' },
  );
  /* The ORM proper, then the region map: 0 on the left, 1 on the right, 2 on the right's top half
     of the image's rows, each stored as index / 255. */
  const orm = renderer.createSurfaceTextureArray(
    [paint(() => [255, 140, 0]), paint((x, y) => [x < SIZE / 2 ? 0 : y < SIZE / 2 ? 2 : 1, 0, 0])],
    { colorSpace: 'linear' },
  );
  const maps = renderer.createSurfaceTextureArray(
    [
      normals(dome, 1),
      normals(ridges, 1),
      /* An occlusion: dark lines between the ridges. */
      paint((x) => {
        const o = Math.round(
          255 * (0.35 + 0.65 * Math.abs(Math.sin(((x + 0.5) / SIZE) * Math.PI * 4))),
        );
        return [o, o, o];
      }),
      normals(diagonal, 1),
    ],
    { colorSpace: 'linear' },
  );
  const regions: SurfaceDetail<SurfaceTextureHandle> = {
    maps,
    regionLayer: 1,
    regions: [
      { normalLayer: 0, repeat: 8 },
      { normalLayer: 1, occlusionLayer: 2, repeat: [12, 12] },
      { normalLayer: 3, repeat: 6, normalStrength: 2 },
    ],
  };
  const one: SurfaceDetail<SurfaceTextureHandle> = {
    maps,
    regions: [{ normalLayer: 0, repeat: 8 }],
  };
  const detail = mode === '0' ? null : mode === 'one' ? one : regions;
  const quad = renderer.createMesh(
    new MeshBuilder()
      .addWallQuad([-2, 0, 0], [2, 0, 0], [2, 4, 0], [-2, 4, 0], [0, 2, -1], [1, 1, 1])
      .build({ planarUvs: true }),
  );
  await renderer.ready();

  const env = createEnvironment();
  /* Low from the left, so a slope facing it lights and one facing away shades. */
  env.directionalDir = [-0.85, 0.25, 0.45];
  env.directionalColor = [1.4, 1.35, 1.25];
  env.ambient = [0.18, 0.19, 0.21];
  env.ambientGround = [0.18, 0.19, 0.21];
  env.shadowStrength = 0;
  env.fogDensity = 0;
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 2;
  camera.position[2] = 6;
  camera.lookAt(0, 2, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    /* The quad runs -2 to 2 metres; a quarter, moved by a half, lays the maps across it once. */
    renderer.setMaterial({
      albedo,
      orm,
      uScale: 0.25,
      vScale: 0.25,
      uOffset: 0.5,
      vOffset: 0.5,
      detail,
    });
    renderer.drawMesh(quad, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · detail ${mode}`;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
