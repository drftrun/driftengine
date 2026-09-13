/**
 * Forty lamps over a floor, with clustering the only thing that changes.
 *
 * **This is the positive control, and the feature has no evidence without it.** Every published
 * scene is gated at zero pixels with clustering off, which proves the arm is inert and proves
 * nothing whatever about it working — and `AGENTS.md` is emphatic that a negative needs a positive
 * control, and that the control has to separate the two states being tested and nothing else.
 *
 *     /clustered.html?clustered=1   the froxel table lights all forty
 *     /clustered.html?clustered=0   the uniform slots light the first sixteen
 *
 * The two differ in one construction-time flag. Same lamps, same floor, same camera, same clock.
 *
 * **Why forty and why apart.** The fixed path shades against the first `MAX_POINT_LIGHTS` entries
 * of the array, in order, so lamps 16 to 39 are simply absent from it; clustering bins all of them
 * and a fragment reads only the froxel it is in. Spacing them so their pools do not overlap makes
 * the difference countable rather than a matter of brightness: `scripts/cluster-lights-check.mjs`
 * samples the floor under each lamp and counts how many are lit.
 *
 * **What a failure looks like**, so it is recognised rather than explained away:
 *
 *   - **Sixteen lit with `?clustered=1`** — the table was never filled, or `uClustered` never
 *     reached the shader. Read the device console before touching the binner.
 *   - **Forty lit but the wrong forty, or lamps lighting the floor beside them** — the fragment
 *     and the binner disagree about which froxel is which. `scripts/cluster-check.mjs` compares
 *     the two binners and would still pass, because both would be filling the same wrong table.
 *   - **Bands of unlit floor between lit lamps** — a froxel boundary. The tile arithmetic in the
 *     shader is not the tile arithmetic in `clusteredLights.ts`.
 *
 * Deterministic: one fixed camera, lamps from a closed form, and nothing reads a clock.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0, 0, 0];

/** Well past `MAX_POINT_LIGHTS`, so the difference is two dozen lamps rather than a shade. */
const LAMPS = 40;
const COLUMNS = 8;
const ROWS = 5;
/** Metres between lamps, and a radius under half of it so no two pools touch. */
const SPACING = 6;
const RADIUS = 2.6;

/** Where lamp `n` stands, on the floor plane. */
function lampAt(n: number): [number, number, number] {
  const column = n % COLUMNS;
  const row = Math.floor(n / COLUMNS);
  return [(column - (COLUMNS - 1) / 2) * SPACING, 1.6, (row - (ROWS - 1) / 2) * SPACING];
}

function floor(): ReturnType<MeshBuilder['build']> {
  const half = 30;
  return (
    new MeshBuilder()
      /*
       * Wound so the face normal points **up**. `addQuad` derives one from the winding, and the
       * other order gives -Y — under which every lamp above the floor has a negative `ndl` and the
       * frame is black in both states, which reads exactly like a froxel table nobody filled.
       */
      .addQuad(
        [-half, 0, half],
        [half, 0, half],
        [half, 0, -half],
        [-half, 0, -half],
        [0.55, 0.55, 0.58],
      )
      .build()
  );
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  /*
   * Arrays sized for forty rather than for the fixed budget.
   *
   * `createEnvironment` allocates `MAX_POINT_LIGHTS` by default and takes overrides, and the
   * guards in `resolvePointLights` are `>=` rather than `===` — so a longer array is already
   * legal and the fixed path simply reads the first sixteen of it. That is what makes this one
   * scene able to show both states.
   */
  const positions = new Float32Array(LAMPS * 3);
  const colors = new Float32Array(LAMPS * 3);
  const radii = new Float32Array(LAMPS);
  const sourceRadii = new Float32Array(LAMPS);
  const weights = new Float32Array(LAMPS);
  for (let n = 0; n < LAMPS; n++) {
    const [x, y, z] = lampAt(n);
    positions[n * 3] = x;
    positions[n * 3 + 1] = y;
    positions[n * 3 + 2] = z;
    /* Warm and cool by column, so a misplaced lamp is visible as a colour and not only a level. */
    colors[n * 3] = 1;
    colors[n * 3 + 1] = 0.85;
    colors[n * 3 + 2] = 0.6 + 0.4 * ((n % COLUMNS) / COLUMNS);
    radii[n] = RADIUS;
    sourceRadii[n] = 0.12;
    weights[n] = 1;
  }

  const env = createEnvironment({
    /* No sun at all: every lit pixel here comes from a lamp, which is what makes counting work. */
    directionalColor: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    fogColor: BACKGROUND,
    fogDensity: 0,
    lightCount: LAMPS,
    lightPositions: positions,
    lightColors: colors,
    lightRadii: radii,
    lightSourceRadii: sourceRadii,
    lightWeights: weights,
  });

  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.5;
  camera.far = 200;
  camera.position[0] = 0;
  camera.position[1] = 34;
  camera.position[2] = 0.001;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);
  camera.updateMatrices(aspect());

  const plane: MeshHandle = renderer.createMesh(floor());
  const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /* Where each lamp lands on screen, for the checker to sample. Written once, after the camera. */
  const projected = new Float32Array(2);
  const cells = Array.from({ length: LAMPS }, (_, n) => {
    const [x, , z] = lampAt(n);
    const onScreen = camera.project(projected, x, 0, z, canvas.clientWidth, canvas.clientHeight);
    return {
      lamp: n,
      x: onScreen ? (projected[0] ?? -1) : -1,
      y: onScreen ? (projected[1] ?? -1) : -1,
    };
  });

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(null);
    renderer.drawMesh(plane, model);
    renderer.endFrame();
  }

  renderFrame();
  const clustered = new URLSearchParams(location.search).get('clustered') === '1';
  stats.textContent = `${created.backend} · ${LAMPS} lamps · clustered ${clustered ? 'on' : 'off'}`;
  (globalThis as unknown as { __cells: unknown }).__cells = cells;
  (globalThis as unknown as { __drawn: boolean }).__drawn = true;
}

void main();
