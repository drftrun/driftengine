/**
 * One quad, one lane at a time, and a control beside every claim.
 *
 * The per-vertex channel carries three unrelated things in one `vec4` — sway in the vertex stage,
 * a sky factor the directional term alone consumes, and an alpha the draw's opacity multiplies —
 * so this page draws one subject per load and publishes what the canvas holds.
 *
 *     /vertexChannel.html?variant=nochannel   a mesh with no channel array at all
 *     /vertexChannel.html?variant=neutral     the same mesh carrying (0, 1, 1, 0) a vertex
 *     /vertexChannel.html?variant=sway        sway ramped 0 at the base to 1 at the top
 *     /vertexChannel.html?variant=swayoff     the same geometry with sway 0, the control
 *     /vertexChannel.html?variant=sky1        skyDirect 1: full sun
 *     /vertexChannel.html?variant=sky0        skyDirect 0: no sun, and the ambient it keeps
 *     /vertexChannel.html?variant=skycolor    the old way — the sky factor folded into vColor
 *     /vertexChannel.html?variant=alpha       alpha ramped across the quad
 *     /vertexChannel.html?variant=opaque      the same draw at alpha 1, the control
 *
 * `?t=` is the wind's own clock in seconds and `?wx=`/`?wz=` its direction, both passed straight
 * to `setWind`. Nothing here reads a real clock, so two loads of one URL draw the same frame and
 * a difference between two loads is a difference in what was asked for.
 *
 * **`nochannel` against `neutral` is the assertion the rest of the page rests on.** A mesh that
 * omits the attribute reads the constant `(0, 1, 1, 0)`, so the two must be identical to the
 * digest — planted, fully sunlit, opaque. If that fails, every other number here is measuring a
 * changed world rather than a new capability.
 *
 * **`skycolor` puts the defect in the scene rather than in a comment.** It is what a consumer has
 * to do without this lane: fold the sky factor into the vertex colour, where it multiplies the
 * albedo and therefore scales ambient and sun together. It must go darker than `sky0`, which is
 * the whole difference the lane buys.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `decals.ts` and `oit.ts`.
 */

import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Dark, and nothing in the scene is near it, so a subject pixel is unambiguous. */
const CLEAR: Vec3 = [0.02, 0.03, 0.08];

/** How many quads across the subject is cut into, so a ramp is smooth and sway bends. */
const CELLS = 24;

/** Mid grey, so the sky lane has room to darken and the alpha lane has room to fade. */
const ALBEDO: Vec3 = [0.6, 0.6, 0.6];

type Variant =
  'nochannel' | 'neutral' | 'sway' | 'swayoff' | 'sky0' | 'sky1' | 'skycolor' | 'alpha' | 'opaque';

/**
 * A subdivided quad facing the camera, and the lanes that variant wants.
 *
 * One builder for every variant so the geometry is bit-identical between them: the only thing that
 * differs is the channel array, which is what makes `nochannel` against `neutral` a statement
 * about the attribute rather than about two meshes.
 */
function quad(variant: Variant): MeshData {
  const verts = (CELLS + 1) * (CELLS + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const emissive = new Float32Array(verts);
  const channel = new Float32Array(verts * 4);

  for (let iy = 0; iy <= CELLS; iy++) {
    for (let ix = 0; ix <= CELLS; ix++) {
      const i = iy * (CELLS + 1) + ix;
      /* u and v run 0..1 across and up, and every lane below is written from them. */
      const u = ix / CELLS;
      const v = iy / CELLS;
      positions[i * 3] = (u - 0.5) * 2;
      positions[i * 3 + 1] = (v - 0.5) * 2;
      positions[i * 3 + 2] = 0;
      /* Facing the camera, so the directional term is a straight dot product and nothing about
         the shading depends on where on the quad a fragment is. */
      normals[i * 3 + 2] = 1;

      let albedoScale = 1;
      if (variant === 'skycolor') albedoScale = 0;
      colors[i * 3] = ALBEDO[0] * albedoScale;
      colors[i * 3 + 1] = ALBEDO[1] * albedoScale;
      colors[i * 3 + 2] = ALBEDO[2] * albedoScale;

      /* Absent means (0, 1, 1, 0); every variant that carries an array writes the same. */
      let sway = 0;
      let skyDirect = 1;
      let alpha = 1;
      if (variant === 'sway') sway = v;
      if (variant === 'sky0') skyDirect = 0;
      if (variant === 'alpha') alpha = u;
      channel[i * 4] = sway;
      channel[i * 4 + 1] = skyDirect;
      channel[i * 4 + 2] = alpha;
      channel[i * 4 + 3] = 0;
    }
  }

  const indices = new Uint32Array(CELLS * CELLS * 6);
  let w = 0;
  for (let iy = 0; iy < CELLS; iy++) {
    for (let ix = 0; ix < CELLS; ix++) {
      const a = iy * (CELLS + 1) + ix;
      const b = a + 1;
      const c = a + (CELLS + 1);
      const d = c + 1;
      /* Counter-clockwise seen from +Z, which is where the camera is and which way the normals
         point. Wound the other way every triangle is back-facing and the engine culls the whole
         quad -- a blank frame that agrees with every control, which is why this page counts the
         subject's pixels before it compares anything. */
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = d;
      indices[w++] = c;
    }
  }

  const data: MeshData = { positions, normals, colors, emissive, indices };
  /* The one variant that carries nothing, which is the control for every default in
     `ABSENT_ATTRIBUTE`. */
  if (variant !== 'nochannel') data.channel = channel;
  return data;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const variant = (asked.get('variant') ?? 'neutral') as Variant;
  const frames = Number(asked.get('frames') ?? '3');
  const windTime = Number(asked.get('t') ?? '0');
  const windX = Number(asked.get('wx') ?? '1');
  const windZ = Number(asked.get('wz') ?? '0');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const mesh = renderer.createMesh(quad(variant));

  /*
   * **Both terms non-zero, and that is the point of the scene.** The sky lane removes the
   * directional half and must leave the ambient half standing; with ambient at zero a face at
   * skyDirect 0 would be black either way and the assertion that separates this lane from folding
   * the factor into the vertex colour could not be made at all.
   */
  const env = createEnvironment();
  env.ambient = [0.25, 0.25, 0.25];
  env.ambientGround = [0.25, 0.25, 0.25];
  env.directionalColor = [0.9, 0.9, 0.9];
  /* Straight at the quad, so the directional term is at full strength and a change in it is the
     largest signal the scene can produce. */
  env.directionalDir = [0, 0, 1];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.5;
  camera.far = 100;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 4;
  camera.lookAt(0, 0, 0);

  /*
   * A large, constant gust rather than a realistic one: this measures whether the lane reaches the
   * vertex stage at all, and a displacement smaller than a pixel proves nothing about that.
   */
  renderer.setWind(windX * 12, windZ * 12, 0, windTime);

  /*
   * **The drawing buffer is sized here or it stays at the canvas element's default 300x150.**
   * Found by this page's own check reporting a blank frame: nothing errors, the scene draws, and
   * every measurement comes back zero, which is exactly the failure the subject-present assertion
   * exists to catch.
   */
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let pixels = 0;
  let centroidX = 0;
  let lum = 0;
  let leftLum = 0;
  let rightLum = 0;
  let digest = '';

  /**
   * What the frame contains, counted from the canvas rather than from a screenshot.
   *
   * From the canvas for the reason `oit.ts` records: a screenshot comparison there found 120
   * differing pixels that turned out to be the page's own caption.
   *
   * The background is read from the first pixel rather than assumed, because the clear colour goes
   * through the composite and a page that knew the answer would be measuring its own assumption.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    const bgR = data[0] ?? 0;
    const bgG = data[1] ?? 0;
    const bgB = data[2] ?? 0;
    let count = 0;
    let sumX = 0;
    let sumLum = 0;
    let leftSum = 0;
    let leftCount = 0;
    let rightSum = 0;
    let rightCount = 0;
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      /* Anything that is not the clear colour is the subject: the scene holds one quad. A tolerance
         of 2 covers the composite's own rounding without reaching the darkest shading the sky lane
         produces, which is ambient times albedo and far above it. */
      const isBg = Math.abs(r - bgR) <= 2 && Math.abs(g - bgG) <= 2 && Math.abs(b - bgB) <= 2;
      if (!isBg) {
        const pixel = i / 4;
        const x = pixel % mirror.width;
        const l = (r + g + b) / 3;
        count += 1;
        sumX += x;
        sumLum += l;
        if (x < mirror.width / 2) {
          leftSum += l;
          leftCount += 1;
        } else {
          rightSum += l;
          rightCount += 1;
        }
      }
      hash = Math.imul(hash ^ r, 0x01000193);
      hash = Math.imul(hash ^ g, 0x01000193);
      hash = Math.imul(hash ^ b, 0x01000193);
    }
    pixels = count;
    centroidX = count === 0 ? 0 : sumX / count;
    lum = count === 0 ? 0 : sumLum / count;
    leftLum = leftCount === 0 ? 0 : leftSum / leftCount;
    rightLum = rightCount === 0 ? 0 : rightSum / rightCount;
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    /* The alpha lane only means anything where the blend stage reads alpha, so those two variants
       take the translucent path. Everything else is an ordinary opaque draw. */
    if (variant === 'alpha' || variant === 'opaque') {
      renderer.drawTranslucentMesh(mesh, IDENTITY, 1);
    } else {
      renderer.drawMesh(mesh, IDENTITY);
    }
    renderer.endFrame();
    measure();
  }

  let drawn = 0;
  await new Promise<void>((done) => {
    const tick = (): void => {
      frame();
      drawn += 1;
      if (drawn >= frames) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  stats.textContent =
    `${created.backend} · ${created.reason} · ${variant} · t=${windTime} · ` +
    `${pixels} px at x=${centroidX.toFixed(2)} · lum ${lum.toFixed(2)} ` +
    `(L ${leftLum.toFixed(2)} R ${rightLum.toFixed(2)}) · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__pixels'] = pixels;
  out['__centroidX'] = centroidX;
  out['__lum'] = lum;
  out['__leftLum'] = leftLum;
  out['__rightLum'] = rightLum;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
