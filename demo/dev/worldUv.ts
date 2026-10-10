/**
 * A material's maps placed by the world: ground, a sphere and a block whose mesh coordinates are all
 * zero, wearing a checker.
 *
 *     /worldUv.html?projection=none        the control: every point reads the checker's one texel
 *     /worldUv.html?projection=planar      the ground tiled a metre a repeat, eight squares to it;
 *                                          the sphere and the block streaked down their sides
 *     /worldUv.html?projection=triplanar   every face tiled, the sphere's blended where planes meet
 *     /worldUv.html?normals=1              and a ridged normal map on all of it
 *     /worldUv.html?normals=tilt           a normal map leaning every texel half way along +u, so
 *                                          which way a projection turns u is read off the light
 *     /worldUv.html?projection=mesh        the reference: the ground's own coordinates set to what
 *                                          planar computes, drawn by the mesh's own frame
 *     /worldUv.html?projection=tangents    the same with tangents generated, so the frame is the
 *                                          attribute's, which carries its handedness, not derived;
 *                                          and the block's faces given triplanar's own plane each
 *     /worldUv.html?scale=0.25&albedo=0    a tile every four metres, white, so the normal map's
 *                                          shading alone is what a comparison sees
 *     /worldUv.html?camx=6                 the camera moved along x, so the block's +x side shows
 *
 * Held at frame 90, by when a switch's rebuilt pipelines have landed on a desktop part, so a capture
 * is a function of the query. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  generateTangents,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, SurfaceProjection, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 90;
const SIZE = 256;

/** Eight squares a side, white and a dark red; as normals, ridges along u, or one lean along +u. */
function paint(normals: boolean, lean = false): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('worldUv: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const at = (y * SIZE + x) * 4;
      if (normals) {
        const tilt = lean ? 0.5 : 0.6 * Math.sin((x / SIZE) * Math.PI * 16);
        const z = Math.sqrt(1 - tilt * tilt);
        image.data[at] = Math.round((tilt * 0.5 + 0.5) * 255);
        image.data[at + 1] = 128;
        image.data[at + 2] = Math.round((z * 0.5 + 0.5) * 255);
      } else {
        const odd = (Math.floor(x / (SIZE / 8)) + Math.floor(y / (SIZE / 8))) % 2 === 1;
        image.data[at] = odd ? 140 : 235;
        image.data[at + 1] = odd ? 30 : 230;
        image.data[at + 2] = odd ? 30 : 220;
      }
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** The mesh with every texture coordinate at zero: what an import with no useful ones carries. */
function flatCoordinates(data: MeshData): MeshData {
  return { ...data, uvs: new Float32Array((data.positions.length / 3) * 2) };
}

/** The mesh with tangents generated from its coordinates, as an import with tangents carries. */
function withTangents(data: MeshData): MeshData {
  const uvs = data.uvs ?? new Float32Array((data.positions.length / 3) * 2);
  return { ...data, tangents: generateTangents(data.positions, data.normals, uvs, data.indices) };
}

/** Each vertex the plane its normal faces most, as triplanar reads it: (z, y), (x, z) or (x, y). */
function faceCoordinates(data: MeshData, scale: number): MeshData {
  const count = data.positions.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [0, 1, 2].map((k) => (data.positions[i * 3 + k] as number) * scale) as [
      number,
      number,
      number,
    ];
    const [nx, ny, nz] = [0, 1, 2].map((k) => Math.abs(data.normals[i * 3 + k] as number));
    const plane =
      (nx as number) >= (ny as number) && (nx as number) >= (nz as number)
        ? 0
        : (ny as number) >= (nz as number)
          ? 1
          : 2;
    uvs[i * 2] = plane === 0 ? z : x;
    uvs[i * 2 + 1] = plane === 1 ? z : y;
  }
  return { ...data, uvs };
}

/** The mesh with the coordinates planar would compute, `x` and `z` times the scale. */
function planarCoordinates(data: MeshData, scale: number): MeshData {
  const count = data.positions.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = (data.positions[i * 3] as number) * scale;
    uvs[i * 2 + 1] = (data.positions[i * 3 + 2] as number) * scale;
  }
  return { ...data, uvs };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const kind = ASKED.get('projection') ?? 'none';
  const scale = Number(ASKED.get('scale') ?? '1');
  const projection: SurfaceProjection | null =
    kind === 'planar' || kind === 'triplanar' ? { kind, scale } : null;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const checker =
    ASKED.get('albedo') === '0'
      ? null
      : renderer.createSurfaceTexture(paint(false), { colorSpace: 'srgb' });
  const asked = ASKED.get('normals');
  const ridges =
    asked === '1' || asked === 'tilt'
      ? renderer.createSurfaceTexture(paint(true, asked === 'tilt'), { colorSpace: 'linear' })
      : null;
  /* White under a checker; a mid grey alone, so a normal map's light is not clipped at white. */
  const grey: Vec3 = checker === null ? [0.35, 0.35, 0.35] : [1, 1, 1];
  const groundData = new MeshBuilder()
    .addGroundQuad([-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5], grey)
    .build();
  const ground = renderer.createMesh(
    kind === 'tangents'
      ? withTangents(planarCoordinates(groundData, scale))
      : kind === 'mesh'
        ? planarCoordinates(groundData, scale)
        : flatCoordinates(groundData),
  );
  const sphere = renderer.createMesh(
    flatCoordinates(new MeshBuilder().addSphere([-1.2, 1, 0], 1, grey).build()),
  );
  const blockData = new MeshBuilder().addBox([1.6, 0.8, 0], [0.8, 0.8, 0.8], grey).build();
  const block = renderer.createMesh(
    kind === 'tangents'
      ? withTangents(faceCoordinates(blockData, scale))
      : flatCoordinates(blockData),
  );
  await renderer.ready();

  const env = createEnvironment();
  env.directionalDir = [0.4, 0.8, 0.45];
  env.ambient = [0.35, 0.37, 0.4];
  env.fogDensity = 0;
  const camera = new Camera();
  camera.fovYDeg = 45;
  /* Moved along x to see the block's side that faces it: ?camx=6. */
  camera.position[0] = Number(ASKED.get('camx') ?? '1.5');
  camera.position[1] = 4;
  camera.position[2] = 7;
  camera.lookAt(0, 0.6, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.setMaterial({ albedo: checker, normal: ridges, projection });
    renderer.drawMesh(ground, identity);
    renderer.drawMesh(sphere, identity);
    renderer.drawMesh(block, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · projection ${kind}${ridges === null ? '' : ' · normals'}`;
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
