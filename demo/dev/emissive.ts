/**
 * Four glowing panels, with the emissive map the only thing that differs.
 *
 * **The positive control, and the feature has no evidence without it.** No published scene binds an
 * emissive map, so the gate on those is a zero-pixel diff: it proves the term is inert and says
 * nothing about it working. `AGENTS.md` is explicit that a negative needs a positive control, and
 * that the control has to separate the two states under test and nothing else.
 *
 *     /emissive.html                  the four panels
 *     /emissive.html?emissivemap=0    every panel unmapped, which is the control
 *     /emissive.html?backend=webgpu   the other backend
 *
 *   - **Panel 1 — no map.** A uniform glow at the mesh's own `emissive`. Whatever the other three
 *     do, this is what they are doing it against.
 *   - **Panel 2 — mapped.** The same glow, shaped by an image. Its brightness varies across the
 *     panel where panel 1's does not, which is the whole claim and is what the checker measures.
 *   - **Panel 3 — mapped, with `emissiveScale` at 2.** The factor that multiplies the image, so
 *     this is panel 2 twice as bright and nothing else.
 *   - **Panel 4 — mapped, on a mesh whose `emissive` attribute is zero.** **Dark, on purpose.**
 *     glTF's rule is that emitted colour is the factor times the texture, so a surface that emits
 *     nothing emits nothing however bright the image. This panel is here because that is the one
 *     thing about this map that surprises people, and a page that omitted it would leave the
 *     surprise to be discovered against a bought model.
 *
 * **What a failure looks like**, so it is recognised rather than explained away:
 *
 *   - **Panel 2 uniform like panel 1** — the map is not reaching the shader, or `uEmissiveScale`
 *     came through as zero. An unwritten uniform is zero and this one multiplies.
 *   - **Panel 2 dark and muddy rather than saturated** — decoded linear. It is a colour.
 *   - **Panel 4 glowing** — the map is creating emission rather than modulating it, which is the
 *     one thing this term must not do.
 *
 * Painted from a closed form, so nothing is fetched and two runs differ in zero pixels.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.02, 0.025, 0.032];
/**
 * Bright, and that is a measurement decision rather than a look.
 *
 * With no emissive *colour* named, the term falls back to the surface's own albedo — see
 * `emissiveTint` — so the panel's colour is what glows. At 0.05 the whole page came back at a mean
 * luminance of 13 of 255, which is exactly 0.05 written into eight bits and is correct, and it left
 * every figure the checker takes crowded against the floor. A bright panel separates them.
 */
const PANEL_COLOR: Vec3 = [0.85, 0.85, 0.88];
const MAP_SIZE = 128;

/** A panel in the XY plane, facing +Z, carrying the emissive amount it was given. */
function panel(emissive: number): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addQuad([-1.1, -1.1, 0], [1.1, -1.1, 0], [1.1, 1.1, 0], [-1.1, 1.1, 0], PANEL_COLOR, emissive)
    .build({ planarUvs: true });
}

/**
 * Concentric rings, painted rather than fetched.
 *
 * **Rings and not a checker**, because the measurement is spatial variance and a checker at the
 * wrong scale aliases into a flat grey at exactly the sampling radius a checker script would use.
 * A radial ramp varies at every scale.
 */
function paintRings(): ImageData {
  const data = new Uint8ClampedArray(MAP_SIZE * MAP_SIZE * 4);
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const u = (x / (MAP_SIZE - 1)) * 2 - 1;
      const v = (y / (MAP_SIZE - 1)) * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const ring = 0.5 + 0.5 * Math.cos(r * Math.PI * 5);
      const at = (y * MAP_SIZE + x) * 4;
      /* Warm, so a decode mistake shows as a hue shift as well as a level one. */
      data[at] = Math.round(255 * ring);
      data[at + 1] = Math.round(255 * ring * 0.55);
      data[at + 2] = Math.round(255 * ring * 0.2);
      data[at + 3] = 255;
    }
  }
  return new ImageData(data, MAP_SIZE, MAP_SIZE);
}

function at(x: number): Float32Array {
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  m[12] = x;
  return m;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const query = new URLSearchParams(location.search);
  const useMap = query.get('emissivemap') !== '0';

  /* No sun and no ambient: every lit pixel here is emission, which is what makes it measurable. */
  const env = createEnvironment({
    directionalColor: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    fogColor: BACKGROUND,
    fogDensity: 0,
    emissiveGain: 1,
    nightFactor: 1,
  });

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 9.4;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const glowing: MeshHandle = renderer.createMesh(panel(1));
  const dark: MeshHandle = renderer.createMesh(panel(0));
  const models = [at(-4.2), at(-1.4), at(1.4), at(4.2)];

  /* sRGB, which is the default for a colour and is passed explicitly because this is where
     somebody would come to find out why a glow came back muddy. */
  const map: SurfaceTextureHandle = renderer.createSurfaceTexture(paintRings(), {
    colorSpace: 'srgb',
  });

  const projected = new Float32Array(2);
  const cells = models.map((m, n) => {
    const onScreen = camera.project(
      projected,
      m[12] ?? 0,
      0,
      0,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    return {
      panel: n,
      x: onScreen ? (projected[0] ?? -1) : -1,
      y: onScreen ? (projected[1] ?? -1) : -1,
    };
  });

  renderer.beginFrame(BACKGROUND);
  renderer.bindMeshPass(camera, env);

  renderer.setMaterial(null);
  renderer.drawMesh(glowing, models[0] as Float32Array);

  const bound = useMap ? map : null;
  renderer.setMaterial({ emissive: bound });
  renderer.drawMesh(glowing, models[1] as Float32Array);

  renderer.setMaterial({ emissive: bound, emissiveScale: [2, 2, 2] });
  renderer.drawMesh(glowing, models[2] as Float32Array);

  /* The mesh emits nothing, so the map has nothing to scale. See the header. */
  renderer.setMaterial({ emissive: bound });
  renderer.drawMesh(dark, models[3] as Float32Array);

  renderer.setMaterial(null);
  renderer.endFrame();

  stats.textContent = `${created.backend} · emissiveMap ${useMap ? 'on' : 'off'}`;
  (globalThis as unknown as { __cells: unknown }).__cells = cells;
  (globalThis as unknown as { __drawn: boolean }).__drawn = true;
}

void main();
