/**
 * ORM maps, looked at on real hardware, on either backend.
 *
 * **This page is the feature's only evidence, and that is deliberate.** Every published scene binds
 * no ORM map, so the gate on those is a zero-pixel diff — it proves the change is inert and proves
 * nothing about whether it works. Putting a mapped surface into the published set would spend that
 * gate. So the proof lives here.
 *
 * A five by five grid of spheres. **Metallic rises left to right and roughness top to bottom**,
 * both carried by the map rather than by a uniform, so what the picture shows is the two channels
 * arriving. A sixth column carries an occlusion ramp instead, at metallic and roughness held to the
 * grid's middle, because occlusion is the one channel that darkens rather than reshapes.
 *
 *     /orm.html                    the default backend, which is WebGL2
 *     /orm.html?backend=webgpu     the other one
 *     /orm.html?channel=metal      metallic only; roughness and occlusion at their defaults
 *     /orm.html?channel=rough      roughness only
 *     /orm.html?channel=ao         occlusion only, as a texel ramp at full strength
 *     /orm.html?channel=ao0        the same map with occlusionStrength 0, which must equal ?channel=none
 *     /orm.html?channel=none       no map at all, which is the control every measurement is against
 *
 * **What a failure looks like**, so it is recognised rather than rationalised:
 *
 *   - **The bottom-right sphere black.** A rough metal has no diffuse and a reflection scaled by
 *     (1 - roughness), so it has nothing left unless the ambient it keeps survived. That is what
 *     the diffuse term's cancelled ambient half exists to prevent — see the design's 3.1.
 *   - **The top-right sphere reading as dark paint.** f0 left at 0.04. A smooth metal seen head-on
 *     should be nearly all reflection, not four percent of one.
 *   - **No highlight anywhere under the lamp.** The lamp gate is still vSpecular alone, and no
 *     sphere here carries a specular attribute — which is exactly the case it was widened for.
 *   - **The whole grid black at ?channel=ao.** Occlusion multiplied by its strength rather than
 *     mixed from 1, so strength 1 on a dark texel took everything.
 *   - **?channel=metal identical to ?channel=none.** uOrmScale's components are in the wrong order,
 *     or the B channel is not reaching metal.
 *
 * **Measured rather than looked at.** `scripts/orm-check.mjs` is what actually decides whether this
 * page passes; the eye got both answers backwards on the normal-map page, where the panel that read
 * as inverted was correct and the one that read as fine was the broken one.
 *
 * Deterministic: one fixed light, one fixed camera, a map painted from a closed form with no clock
 * and no random anywhere, so a two-capture diff of an unchanged build reads zero.
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
  MeshHandle,
  PointLightSource,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.043, 0.051, 0.063];

/** Cells across and down. Five is enough to see a trend and few enough to keep each sphere large. */
const CELLS = 5;

/** The occlusion ramp's own column, past the grid. */
const COLUMNS = CELLS + 1;

/** Metres between sphere centres, both axes. */
const SPACING = 2.0;

function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/**
 * Mid grey, so what reaches the eye is the shading rather than a colour.
 *
 * Not white, and that matters more here than on the normal-map page: a metal's highlight and its
 * reflection are both tinted by the albedo, so a white sphere would make the metal column look
 * exactly like the dielectric one and hide the single most visible thing metalness does.
 */
const SPHERE_COLOR: Vec3 = [0.72, 0.58, 0.24];

/**
 * The grid, as one image.
 *
 * Painted from a closed form rather than fetched, because this repository ships and fetches no
 * image assets — the same reason `surfaceTexture.ts` gives for its own examples.
 *
 * **Uniform within each cell.** Every sphere reads one cell, so the sweep is a property of *where a
 * sphere sits* rather than of where a texel does, and a channel arriving wrong shows up as a column
 * or a row rather than as a texture nobody can read. The occlusion column is the exception: it is a
 * vertical ramp inside its own cell, because a flat occlusion value over a whole sphere is
 * indistinguishable from that sphere simply being darker.
 */
function paintOrmGrid(channel: string): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(size, size);
  const cellW = size / COLUMNS;
  const cellH = size / CELLS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const column = Math.min(COLUMNS - 1, Math.floor(x / cellW));
      const row = Math.min(CELLS - 1, Math.floor(y / cellH));
      const occlusionColumn = column === CELLS;

      /* 0 to 1 across the grid, and the middle of the grid inside the occlusion column. */
      let metal = occlusionColumn ? 0.5 : column / (CELLS - 1);
      let rough = occlusionColumn ? 0.5 : row / (CELLS - 1);
      /* A vertical ramp within the cell, so one sphere shows the whole range of the channel. */
      let occlusion = occlusionColumn ? (y % cellH) / cellH : 1;

      /* One channel at a time, for attributing a difference to the channel that caused it. */
      if (channel === 'metal') {
        rough = 0.5;
        occlusion = 1;
      } else if (channel === 'rough') {
        /*
         * **Held metallic, because roughness is otherwise invisible here.** Roughness only reaches
         * the picture through a specular lobe or a reflection, and these spheres carry no specular
         * attribute and the pass sets no reflectivity — so at metal 0 there is nothing for it to
         * widen and the column reads as the plain lit gradient. Measuring caught that; looking did
         * not, because a smooth gradient down a column is exactly what a roughness sweep is
         * supposed to look like.
         */
        metal = 1;
        occlusion = 1;
      } else if (channel === 'ao' || channel === 'ao0') {
        metal = 0;
        rough = 0.5;
        occlusion = occlusionColumn ? occlusion : 1 - row / (CELLS - 1);
      }

      const i = (y * size + x) * 4;
      image.data[i] = Math.round(occlusion * 255);
      image.data[i + 1] = Math.round(rough * 255);
      image.data[i + 2] = Math.round(metal * 255);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * One sphere, with UVs covering exactly one cell of the grid.
 *
 * Built per cell rather than once and re-textured, because the map is one image and a sphere's own
 * UVs run 0 to 1: shifting them into the cell is what makes each sphere read its own values.
 *
 * **No specular attribute, which is the case the lamp gate was widened for.** `addSphere`'s
 * `specular` parameter defaults to 0 and it is left there deliberately: every mesh `meshBuilder`
 * builds takes that default, so a metal gated on the attribute alone would take no highlight from
 * any lamp in the scene, and this page is where that would show.
 */
function buildSphere(column: number, row: number): ReturnType<MeshBuilder['build']> {
  /*
   * `planarUvs: true`, and it is required rather than a preference. `build` emits `uvs` **only**
   * when asked: a sphere carries no texture coordinates of its own, so without this every fragment
   * reads the absent-attribute default and the whole grid samples one texel — which is exactly how
   * the first version of this page rendered, every channel identical to the control, and it took a
   * measurement rather than a look to notice.
   *
   * A box projection with seams, which does not matter here: each sphere reads one uniform cell.
   */
  const data = new MeshBuilder()
    .addSphere([0, 0, 0], 0.85, SPHERE_COLOR, 0, 28, 16)
    .build({ planarUvs: true });

  const uvs = data.uvs;
  if (uvs === undefined) throw new Error('orm: planarUvs did not produce texture coordinates');
  for (let i = 0; i < uvs.length; i += 2) {
    /* Into this sphere's cell, with a small inset so a filtered texel at the edge cannot bleed a
       neighbouring cell's values into the sphere and blur the trend the grid is showing. */
    const u = (uvs[i] ?? 0) * 0.8 + 0.1;
    const v = (uvs[i + 1] ?? 0) * 0.8 + 0.1;
    uvs[i] = (column + u) / COLUMNS;
    uvs[i + 1] = (row + v) / CELLS;
  }
  return data;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (canvas === null || stats === null) return;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment({
    /* Raking across from the left and slightly above, so a sphere catches the sun on one side. */
    directionalDir: [0.72, 0.55, 0.42],
    directionalColor: [0.9, 0.88, 0.82],
    ambient: [0.2, 0.23, 0.28],
    ambientGround: [0.07, 0.06, 0.05],
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  /*
   * One lamp, in front and to the right, because the widened highlight gate cannot be exercised by
   * the sun: that term answers to `uDirectionalColor` and the lamp term is a separate branch with
   * its own condition. Given a source radius so `sphereLobe` is the lobe running rather than the
   * point-source one.
   */
  const lights: PointLightSource[] = [
    {
      x: 3.4,
      y: 1.6,
      z: 5.2,
      r: 1,
      g: 0.86,
      b: 0.66,
      radius: 16,
      /* No flicker: this page is captured and diffed, so anything with a clock in it reads as a
         change between two runs of one build. */
      flicker: 0,
      shadowNear: 0.3,
      sourceRadius: 0.35,
    },
  ];
  const lightBuffer = createPointLightBuffer();
  selectPointLights(lights, 0, 0, 9, lightBuffer, 0);
  env.lightCount = lightBuffer.count;
  env.lightPositions = lightBuffer.positions;
  env.lightColors = lightBuffer.colors;
  env.lightRadii = lightBuffer.radii;
  env.lightSourceRadii = lightBuffer.sourceRadii;
  env.lightWeights = lightBuffer.weights;
  env.activeLightWorldIndices = lightBuffer.sourceIndex;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 60;
  /*
   * Centred on the grid and far enough back to hold all thirty with margin. The grid is
   * COLUMNS x CELLS at SPACING, so its half-height plus a sphere radius is what has to fit inside
   * half the vertical field — and the first framing of this page was computed for the columns and
   * cropped the top and bottom rows, which a screenshot showed and arithmetic would have caught.
   */
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 15.5;
  camera.lookAt(0, 0, 0);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  const spheres: { mesh: MeshHandle; model: Float32Array }[] = [];
  for (let row = 0; row < CELLS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      spheres.push({
        mesh: renderer.createMesh(buildSphere(column, row)),
        model: at((column - (COLUMNS - 1) / 2) * SPACING, ((CELLS - 1) / 2 - row) * SPACING, 0),
      });
    }
  }

  const asked = new URLSearchParams(location.search).get('channel') ?? 'all';
  /*
   * `linear`, and it is the same argument the normal-map page makes. These three numbers *are* the
   * data rather than a picture of it; decoding them as display values would bend every one of them
   * toward its floor, and a roughness map read as sRGB reads as a world made of glass.
   */
  const map: SurfaceTextureHandle = renderer.createSurfaceTexture(paintOrmGrid(asked), {
    colorSpace: 'linear',
    wrap: 'clamp',
  });

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    /*
     * Left at zero deliberately, so `max(uReflectivity, metal)` is the thing putting a reflection
     * on the metal column. A pass-level reflectivity would give every sphere one and hide whether
     * the B channel reached the term at all.
     */
    renderer.setSurfaceReflectivity(0);
    /*
     * `ao0` binds the same map and asks for no occlusion, which must land on exactly the control.
     * That is the end-to-end statement of glTF's definition: strength is a mix from 1 rather than a
     * multiply, so 0 means *unoccluded* and not black. The shader source is asserted separately;
     * this is the version that would catch the uniform arriving in the wrong component.
     */
    renderer.setMaterial(
      asked === 'none' ? null : asked === 'ao0' ? { orm: map, occlusionStrength: 0 } : { orm: map },
    );
    for (const sphere of spheres) renderer.drawMesh(sphere.mesh, sphere.model);
    renderer.endFrame();
  }

  renderFrame();
  stats.textContent =
    `${created.backend} · ${created.reason} · metallic → · roughness ↓ · last column occlusion` +
    ` · channel ${asked}`;

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    renderFrame();
  });

  /*
   * Where each sphere actually landed, in CSS pixels, published for the measurement script.
   *
   * **The page is the only thing that knows this**, and assuming it is how the first measurement
   * of this page went wrong: it sampled a six-by-five grid of screen rectangles, which is only
   * where the spheres are if the camera happens to frame them exactly, and it did not. Reading
   * `camera.project` instead makes the measurement independent of the framing, so moving the
   * camera can never silently move what is being measured.
   */
  const out = new Float32Array(2);
  (globalThis as unknown as { __cells?: unknown }).__cells = spheres.map((sphere, i) => {
    const model = sphere.model;
    camera.project(
      out,
      model[12] ?? 0,
      model[13] ?? 0,
      model[14] ?? 0,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    return { column: i % COLUMNS, row: Math.floor(i / COLUMNS), x: out[0], y: out[1] };
  });
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
