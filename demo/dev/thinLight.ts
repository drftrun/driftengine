/**
 * Light through a thin surface: a red banner facing the camera, lit only from behind.
 *
 *     /thinLight.html?light=sun&through=0     the control: the sun behind the banner, none through
 *     /thinLight.html?light=sun&through=0.8   the same sun through the banner, red where it passes
 *     /thinLight.html?light=lamp&through=0.8  a lamp behind it instead of the sun
 *     /thinLight.html?light=none&through=0.8  nothing behind it: the banner as with none through
 *     /thinLight.html?light=lamp&through=0.8&shadows=1   the lamp casting, the banner in its map: the
 *                                          light through must be what it is with no map, since the
 *                                          banner is the only thing between, and it is not in its own way
 *     /thinLight.html?light=sun&through=0.8&color=0,0.4,1   the light through in a colour of its own
 *                                          (`transmissionColor`): blue through the red banner, where
 *                                          the control above lets red through
 *
 * Held at frame 30. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
} from '../../packages/core/src/index';
import type {
  PointLightSource,
  RendererApi,
  ShadowCasters,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const light = ASKED.get('light') ?? 'sun';
  const through = Number(ASKED.get('through') ?? '0');
  const named = ASKED.get('color')?.split(',').map(Number);
  const color: [number, number, number] | null =
    named?.length === 3 ? [named[0] ?? 0, named[1] ?? 0, named[2] ?? 0] : null;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const banner = renderer.createMesh(
    new MeshBuilder()
      .addWallQuad([-1, 0, 0], [1, 0, 0], [1, 3, 0], [-1, 3, 0], [0, 1.5, -1], [0.8, 0.12, 0.1])
      .build(),
  );
  await renderer.ready();

  const env = createEnvironment();
  env.ambient = [0.08, 0.08, 0.09];
  env.ambientGround = [0.08, 0.08, 0.09];
  env.fogDensity = 0;
  env.shadowStrength = 0;
  /* Behind the banner: the sun low on its far side, or nothing in the sky at all. */
  env.directionalDir = [0.2, 0.35, -0.9];
  env.directionalColor = light === 'sun' ? [1, 0.97, 0.92] : [0, 0, 0];
  const lamps: PointLightSource[] =
    light === 'lamp'
      ? [
          {
            x: 0,
            y: 1.5,
            z: -0.8,
            r: 0.9,
            g: 0.85,
            b: 0.8,
            radius: 6,
            flicker: 0,
            shadowNear: 0.1,
            sourceRadius: 0.05,
          },
        ]
      : [];
  const chosen = createPointLightBuffer(renderer.shadedLights);
  const shadows = ASKED.get('shadows') === '1';
  if (shadows) renderer.prepareStaticPointShadows(lamps, []);
  const still: ShadowCasters = (sink) => sink.mesh(banner, identity);
  const nothing: ShadowCasters = () => {};

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 1.5;
  camera.position[2] = 5;
  camera.lookAt(0, 1.5, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  let frame = 0;
  const draw = (): void => {
    selectPointLights(lamps, 0, 1.5, 5, chosen, 0);
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;
    env.lightDirections = chosen.directions;
    env.lightConeCos = chosen.coneCos;
    env.lightIesProfiles = chosen.iesProfiles;
    env.lightFalloffExponents = chosen.falloffExponents;
    env.activeLightWorldIndices = chosen.sourceIndex;
    if (shadows) {
      renderer.updatePointShadows(
        lamps,
        chosen.sourceIndex,
        chosen.count,
        0,
        1.5,
        0,
        1 / 60,
        still,
        nothing,
        chosen.shadowIndex,
        chosen.shadowCount,
        [],
      );
    }
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.setMaterial({
      doubleSided: true,
      diffuseTransmission: through,
      transmissionColor: color,
    });
    renderer.drawMesh(banner, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent =
      `${created.backend} · ${light} behind · through ${through}` +
      (color === null ? '' : ` in ${color.join(',')}`) +
      (shadows ? ' · shadows' : '');
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
