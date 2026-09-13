/**
 * Normal maps, looked at on real hardware, on either backend.
 *
 * **This page is the feature's only evidence, and that is deliberate.** Every published scene binds
 * no normal map, so the gate on those is a zero-pixel diff — it proves the change is inert and
 * proves nothing about whether it works. Putting a mapped surface into the published set would
 * spend that gate. So the proof lives here.
 *
 * Four panels, identical but for the one thing each is about:
 *
 *   - **Panel 1 — no map.** The plain lit plate. Whatever the other three do, this is what they
 *     are doing it against.
 *   - **Panel 2 — mapped, with the tangent frame the generator produced.** `generateTangents`
 *     derives it, `ATTR_TANGENT` carries it and location 10 uploads it; this is the first thing
 *     in the engine that reads it.
 *   - **Panel 3 — mapped, with no tangent attribute at all.** The frame comes from screen-space
 *     derivatives instead. **This is the only place that path is exercised**, because every
 *     imported mesh has tangents and every published scene is built from primitives. Expect it to
 *     agree with panel 2 on flat geometry, which both of these are.
 *   - **Panel 4 — mapped, with its UVs mirrored in u.** `tangent.w` exists so a mirrored island
 *     does not light inside out, and there is nothing in this repository that mirrors: every
 *     primitive `meshBuilder` makes is unmirrored, so without this panel the sign ships untested
 *     and a wrong one looks fine everywhere else.
 *
 *     /normal.html                  the default backend, which is WebGL2
 *     /normal.html?backend=webgpu   the other one
 *     /normal.html?strength=0       every panel unmapped, which is the control
 *
 * **What a failure looks like**, so it is recognised rather than rationalised:
 *
 *   - **A green tint over everything** — the map was decoded as sRGB. These bytes are a direction,
 *     not a colour; `y` reads high and the whole surface tilts one way. The default is `linear`,
 *     so this means somebody passed `colorSpace: 'srgb'`.
 *   - **Panel 4 lit opposite to panels 2 and 3** — `tangent.w` is dropped or inverted.
 *   - **Relief that moves with the camera rather than with the light** — the frame is wrong, most
 *     likely a transposed `mat3(t, b, n)`.
 *   - **Panel 3 flat while panel 2 is not** — the derived path is not being taken, or
 *     `uHasTangents` is stuck at 1.
 *
 * Deterministic: one fixed light, one fixed camera, a map painted from a closed form with no clock
 * and no random anywhere, so a two-capture diff of an unchanged build reads zero.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  generateTangents,
} from '../../packages/core/src/index';
import type {
  MeshHandle,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.043, 0.051, 0.063];

function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** Near white, so what reaches the eye is the lighting rather than a tint over it. */
const PANEL_COLOR: Vec3 = [0.92, 0.9, 0.88];

/**
 * One panel, with the frame it should carry.
 *
 * `mirrorU` flips the texture coordinates in u without moving a vertex, which is what an artist
 * does when they map the left and right of a model onto one patch. The tangent generator then
 * produces a frame with the opposite handedness for it, and `w` is the only thing that records
 * that — which is the whole of what panel 4 is for.
 */
function buildPanel(mirrorU: boolean, withTangents: boolean): ReturnType<MeshBuilder['build']> {
  const data = new MeshBuilder()
    .addQuad([-1.2, -1.2, 0], [1.2, -1.2, 0], [1.2, 1.2, 0], [-1.2, 1.2, 0], PANEL_COLOR)
    .build({ planarUvs: true });

  const uvs = data.uvs;
  if (uvs === undefined) return data;
  if (mirrorU) {
    for (let i = 0; i < uvs.length; i += 2) uvs[i] = 1 - (uvs[i] ?? 0);
  }
  /*
   * Left off entirely for panel 3. `vertexDefaults.ts` then supplies (1, 0, 0, 1) — a usable
   * frame rather than a sentinel — and `uHasTangents` is what tells the shader to derive one
   * instead, because that constant is indistinguishable from a real tangent along +X.
   */
  if (!withTangents) return data;
  return {
    ...data,
    tangents: generateTangents(data.positions, data.normals, uvs, data.indices),
  };
}

/**
 * A grid of domes, as surface-space directions.
 *
 * Painted from a closed form rather than fetched, because this repository ships and fetches no
 * image assets — the same reason `surfaceTexture.ts` gives for its own examples. Each cell is a
 * hemisphere: the normal at a point leans away from the cell's centre by how far out it is, and
 * flat blue (0.5, 0.5, 1) everywhere the domes do not reach.
 *
 * The grid is mirror symmetric in both axes, so which way round the canvas arrives cannot change
 * what it draws — panel 4's mirroring has to show up as *lighting*, not as a different picture.
 */
function paintDomeNormals(): HTMLCanvasElement {
  const size = 512;
  const cells = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(size, size);
  const cell = size / cells;
  const radius = cell * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (Math.floor(x / cell) + 0.5) * cell;
      const cy = (Math.floor(y / cell) + 0.5) * cell;
      const dx = (x + 0.5 - cx) / radius;
      const dy = (y + 0.5 - cy) / radius;
      const r2 = dx * dx + dy * dy;

      /* Outside the dome the surface is flat, which in this encoding is straight up. */
      let nx = 0;
      let ny = 0;
      let nz = 1;
      if (r2 < 1) {
        nx = dx;
        ny = dy;
        nz = Math.sqrt(Math.max(1 - r2, 0));
      }
      const inv = 1 / Math.hypot(nx, ny, nz);
      const at4 = (y * size + x) * 4;
      /* [-1,1] to [0,1], which is what the shader undoes. See `uNormalMap`. */
      image.data[at4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      image.data[at4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      image.data[at4 + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      image.data[at4 + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (canvas === null || stats === null) return;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment({
    /* Raking across from the left, so a dome catches light on one side and shades on the other. */
    directionalDir: [0.94, 0.12, 0.32],
    fogColor: BACKGROUND,
    fogDensity: 0,
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
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  const panels: MeshHandle[] = [
    renderer.createMesh(buildPanel(false, true)),
    renderer.createMesh(buildPanel(false, true)),
    renderer.createMesh(buildPanel(false, false)),
    renderer.createMesh(buildPanel(true, true)),
  ];
  const models = [at(-4.2, 0, 0), at(-1.4, 0, 0), at(1.4, 0, 0), at(4.2, 0, 0)];

  /*
   * `linear`, and it is the whole of §6 of the design in one argument. These bytes are a
   * direction, not a colour: decoding them as display values bends every normal toward the
   * surface and reads as a green tint over everything. `linear` is already the default; it is
   * passed explicitly here because this page is where somebody would come to find out why.
   */
  const map: SurfaceTextureHandle = renderer.createSurfaceTexture(paintDomeNormals(), {
    colorSpace: 'linear',
    wrap: 'repeat',
  });

  const strength = Number(new URLSearchParams(location.search).get('strength') ?? '1');
  const mapped = Number.isFinite(strength) ? strength : 1;

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);

    /* Half a tile to the metre, so a dome lands about twenty pixels across at this camera. */
    renderer.setMaterial(null);
    renderer.drawMesh(panels[0] as MeshHandle, models[0] as Float32Array);

    renderer.setMaterial({ normal: map, uScale: 0.5, vScale: 0.5, normalStrength: mapped });
    renderer.drawMesh(panels[1] as MeshHandle, models[1] as Float32Array);
    renderer.drawMesh(panels[2] as MeshHandle, models[2] as Float32Array);
    renderer.drawMesh(panels[3] as MeshHandle, models[3] as Float32Array);

    renderer.endFrame();
  }

  renderFrame();
  stats.textContent =
    `${created.backend} · ${created.reason} · none | tangents | derived | mirrored u` +
    ` · strength ${mapped}`;

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
    renderFrame();
  });

  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
