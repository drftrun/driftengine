/**
 * Rectangular lights past the fixed four, shaded through the froxel table.
 *
 *     /areaClusters.html?clustered=1            forty panels over a floor, every one lit
 *     /areaClusters.html?clustered=0            the same forty, the first four lit: the fixed arm
 *     /areaClusters.html?one=fixed&clustered=1  one panel, in the fixed arm's first slot
 *     /areaClusters.html?one=table&clustered=1  the same panel behind a dark one in that slot, so
 *                                               the table shades it: the control, which must match
 *                                               the line above but for what the fixed arm adds —
 *                                               nothing here, since the panel casts no shadow
 *     ...&barn=20&barnlength=0.3                 every panel with barn doors at 20° from its normal
 *     ...&top=1                                  looking straight down from 10 m, so a floor point's
 *                                               pixel is its x and z: the one panel's doors above
 *                                               change nothing within 1.04 m of its centre along x
 *                                               and 0.69 m along z, and leave nothing lit past
 *                                               4.94 m and 2.32 m — each the line through a door's
 *                                               tip, from 1.2 m below a 1.2 by 0.5 m panel
 *
 * Deterministic: a fixed camera, panels from a closed form, no clock.
 */
import {
  Camera,
  MeshBuilder,
  createAreaLightBuffer,
  createEnvironment,
  createRenderer,
  selectAreaLights,
} from '../../packages/core/src/index';
import type { AreaLightSource, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const BACKGROUND: Vec3 = [0, 0, 0];
const COLUMNS = 8;
const ROWS = 5;
const BARN_ANGLE = ASKED.has('barn') ? Number(ASKED.get('barn')) : undefined;
const BARN_LENGTH = ASKED.has('barnlength') ? Number(ASKED.get('barnlength')) : undefined;

function panel(x: number, z: number, hue: number, range: number): AreaLightSource {
  return {
    x,
    y: 1.2,
    z,
    r: 1.5 + hue,
    g: 1.4,
    b: 2.5 - hue,
    /* Facing down: right along x, up along +z, so right × up is -y. */
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    upX: 0,
    upY: 0,
    upZ: 1,
    halfWidth: 0.6,
    halfHeight: 0.25,
    range,
    ...(BARN_ANGLE === undefined ? {} : { barnDoorAngle: BARN_ANGLE }),
    ...(BARN_LENGTH === undefined ? {} : { barnDoorLength: BARN_LENGTH }),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const one = ASKED.get('one');
  const lights: AreaLightSource[] = [];
  if (one === 'fixed') lights.push(panel(0, 0, 0.5, 1e4));
  else if (one === 'table') {
    /* A dark rectangle in the fixed arm's first slot, so the real one is the table's. */
    lights.push({ ...panel(50, 50, 0, 1), r: 0, g: 0, b: 0 });
    for (let pad = 1; pad < renderer.shadedAreaLights; pad++) {
      lights.push({ ...panel(50, 50, 0, 1), r: 0, g: 0, b: 0 });
    }
    lights.push(panel(0, 0, 0.5, 1e4));
  } else {
    for (let n = 0; n < COLUMNS * ROWS; n++) {
      const column = n % COLUMNS;
      const row = Math.floor(n / COLUMNS);
      lights.push(panel((column - 3.5) * 3, (row - 2) * 3, (n % 3) * 0.5, 3));
    }
  }
  const areas = selectAreaLights(lights, createAreaLightBuffer(lights.length));

  const env = createEnvironment({
    directionalColor: [0, 0, 0],
    ambient: [0.02, 0.02, 0.025],
    ambientGround: [0.02, 0.02, 0.025],
    fogDensity: 0,
    areaLights: areas,
  });
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.3;
  camera.far = 200;
  const top = ASKED.get('top') === '1';
  camera.position[1] = top ? 10 : one === null ? 18 : 4;
  camera.position[2] = top ? 1e-4 : one === null ? 9 : 3;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const floor = renderer.createMesh(
    new MeshBuilder()
      .addQuad([-14, 0, 9], [14, 0, 9], [14, 0, -9], [-14, 0, -9], [0.6, 0.6, 0.62])
      .build(),
  );
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, identity);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · ${lights.length} rectangles · ${location.search}`;
}

void main();
