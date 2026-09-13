/**
 * A long wall lit almost edge-on, which is where directional shadows are hardest.
 *
 * **This page exists to reproduce a difference between the two backends that no scene here
 * shows.** The parity ledger records it against a consumer's world: a quarter of the frame at a
 * mean delta of 30, visible as a kind rather than a number — WebGPU's directional shadows on an
 * arcade wall hard and stair-stepped in large blocks where WebGL2's are smooth. Every published
 * scene in this repository agrees between the backends, so the ledger's own conclusion is that
 * eight scenes agreeing covers eight scenes.
 *
 * What those scenes do not have is a **large surface the light grazes**. `directionalShadow.ts`
 * says in as many words that this is the geometry the receiver-plane compensation exists for:
 * "on a grazing face that becomes the repeating light/dark ribs seen as the receiver crosses
 * shadow texels". So this page is that face, and nothing else.
 *
 *     /grazing.html?backend=webgpu   the backend the report is about
 *     /grazing.html?backend=webgl2   the one it is compared against
 *     /grazing.html?elevation=8      how far above the horizon the sun sits, in degrees
 *
 * The wall runs away from the camera so that one surface spans the whole depth range, and the
 * light comes along it rather than across it, so its shadow stretches over many shadow texels per
 * screen pixel. A caster stands on the floor in front of it.
 *
 * **What a failure looks like**, so it is recognised rather than explained away:
 *
 *   - **Stair-stepped blocks along the shadow's edge on one backend only** — the thing being
 *     hunted. The blocks are shadow texels, so their size on screen says how far the receiver has
 *     travelled per texel.
 *   - **Ribs of light and dark across the whole wall** — the receiver-plane compensation is not
 *     working at all, on whichever backend shows them.
 *   - **The two backends agreeing** — this page does not reproduce it, and the conditions are
 *     wrong rather than the report.
 *
 * Deterministic: one fixed light, one fixed camera, no clock read anywhere.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  ShadowCasterSink,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';
import { holdFrames } from './heldFrame';

const BACKGROUND: Vec3 = [0.05, 0.06, 0.08];
const STONE: Vec3 = [0.62, 0.6, 0.56];
const FLOOR: Vec3 = [0.45, 0.44, 0.42];

/** Frames held before the picture stops, matching what `shots.mjs` waits for. */
const FRAMES = 2;

function wall(): ReturnType<MeshBuilder['build']> {
  const b = new MeshBuilder();
  /*
   * 90 m long, 12 m high, facing **+x** so the light grazes along its length.
   *
   * `addQuad` derives the face normal from the winding, and the other order gives -x — under
   * which the wall faces away from both the camera and the sun and the whole page is black. That
   * is what the first capture showed, and it reads exactly like a shadow bug.
   */
  b.addQuad([0, 0, -45], [0, 12, -45], [0, 12, 45], [0, 0, 45], STONE);
  return b.build();
}

function floor(): ReturnType<MeshBuilder['build']> {
  /* Wound so the normal points up, for the reason the wall's comment gives. */
  return new MeshBuilder()
    .addQuad([-2, 0, 45], [40, 0, 45], [40, 0, -45], [-2, 0, -45], FLOOR)
    .build();
}

/** Three pillars in front of the wall, so the shadows they throw run along it. */
function pillars(): ReturnType<MeshBuilder['build']> {
  const b = new MeshBuilder();
  for (const z of [-18, 0, 18]) {
    b.addBox([6, 0, z - 1.1], [8, 9, z + 1.1], STONE);
  }
  return b.build();
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const query = new URLSearchParams(location.search);
  holdFrames(FRAMES);

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  /*
   * The sun a few degrees above the horizon and running along the wall.
   *
   * `uDirectionalDir` points from the surface toward the source, so a small y is a low sun. The
   * shader fades a directional shadow out by source elevation — see `lowElevationFade` — so this
   * has to stay above that fade or the page measures the fade rather than the filter.
   */
  const elevationDeg = Number(query.get('elevation') ?? '14');
  const elevation = (Number.isFinite(elevationDeg) ? elevationDeg : 14) * (Math.PI / 180);
  const env = createEnvironment({
    directionalDir: [Math.cos(elevation) * 0.28, Math.sin(elevation), Math.cos(elevation) * 0.96],
    directionalColor: [1.35, 1.25, 1.05],
    ambient: [0.06, 0.07, 0.09],
    ambientGround: [0.04, 0.04, 0.05],
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  const camera = new Camera();
  camera.fovYDeg = 52;
  camera.near = 0.4;
  camera.far = 240;
  camera.position[0] = 26;
  camera.position[1] = 7.5;
  camera.position[2] = -34;
  camera.lookAt(1, 4.5, 12);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const wallMesh: MeshHandle = renderer.createMesh(wall());
  const floorMesh: MeshHandle = renderer.createMesh(floor());
  const pillarMesh: MeshHandle = renderer.createMesh(pillars());
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /*
   * The light's own matrix, centred on the wall and wide enough to hold it.
   *
   * A 90 m wall in a 2048 map is 44 mm a texel at best, and the whole point of this page is that
   * the receiver crosses many texels per screen pixel — so the extent is the wall's rather than a
   * comfortable one.
   */
  const lightMatrix = new Float32Array(16);
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    0,
    4,
    0,
    52,
    renderer.shadowMapSize,
    lightMatrix,
  );
  env.lightViewProj = lightMatrix;

  const casters = (sink: ShadowCasterSink): void => {
    sink.mesh(pillarMesh, identity);
    sink.mesh(wallMesh, identity);
  };

  function frame(): void {
    /* The casters, into the static layer, which is the one every scene uses. */
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(null);
    renderer.drawMesh(floorMesh, identity);
    renderer.drawMesh(wallMesh, identity);
    renderer.drawMesh(pillarMesh, identity);
    renderer.endFrame();
  }

  frame();
  /* The shape `shots.mjs` waits for: a held frame count and a draw count in the readout. */
  stats.textContent = `${created.backend} · grazing · 3 draws · sun ${elevationDeg}°`;
  (window as unknown as { __heldFrame?: number }).__heldFrame = FRAMES;
}

void main();
