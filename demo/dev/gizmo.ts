/**
 * A gizmo drawn beside a control that does not stay the same size, and dragged by a real camera.
 *
 * Three unrelated claims, so this draws one subject per load and publishes what the canvas holds:
 *
 *     /gizmo.html?variant=near        translate, camera at six metres
 *     /gizmo.html?variant=far         the same gizmo with the camera four times further out
 *     /gizmo.html?variant=hover       the pointer parked on the x arm
 *     /gizmo.html?variant=nohover     the pointer parked on the background, the highlight's control
 *     /gizmo.html?variant=rotate      three rings
 *     /gizmo.html?variant=scale       three arms and a centre
 *     /gizmo.html?variant=dragx       a scripted drag along the x arm, through the camera
 *     /gizmo.html?variant=dragnone    the same drag begun where there is no handle
 *     /gizmo.html?variant=dragturn    three quarters of a turn about a ring, crossing the seam
 *     /gizmo.html?variant=dragscale   an arm dragged one gizmo length outward
 *
 * **The white quad is the control and it is the point of the size claim.** A gizmo asked for a
 * hundred and twenty pixels has to occupy a hundred and twenty pixels at any distance, and a test
 * that only measures the gizmo passes a build that ignores distance entirely. The quad is one metre
 * of world at the same distance, so between `near` and `far` it must shrink by the factor the gizmo
 * must not.
 *
 * **The gizmo is classified by saturation and the control by being magenta.** The background is the
 * clear colour and nothing else is drawn, so a pixel whose channels differ is a gizmo line and a
 * pixel that is magenta is the control.
 *
 * **`minWidthPerMetre` is zero here, and the first version of this page set it to 1.5.** That is a
 * floor in pixels per metre of distance, so at six metres it made every stroke nine pixels of
 * half-width — and because it scales with distance, a line pointing away from the camera came out as
 * a wedge that widened toward its far end. The frame was a starburst of coloured wedges reaching
 * every edge, the bounding box was the whole canvas, and *"the gizmo is the same size at both
 * distances"* passed perfectly, because a canvas is. Only looking at the picture found it.
 *
 * **The drags run through `camera.rayThrough` rather than against hand-built rays.** The unit tests
 * already cover the arithmetic against bare rays; what these add is the half no unit test reaches —
 * that a screen pixel becomes the ray the gizmo wanted.
 *
 * Nothing here reads a real clock, so two loads of one URL draw the same frame.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `refraction.ts` and `vertexChannel.ts`.
 */

import {
  Camera,
  GIZMO_GROUP_COLORS,
  GIZMO_GROUP_COUNT,
  Gizmo,
  createEnvironment,
  createRenderer,
  gizmoScaleFor,
} from '../../packages/core/src/index';
import type { LineHandle, MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Dark, and nothing in the scene is near it, so a subject pixel is unambiguous. */
const CLEAR: Vec3 = [0.02, 0.03, 0.08];

/** How many screen pixels the gizmo is asked to span. The whole size claim is about this number. */
const GIZMO_PIXELS = 120;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type Variant =
  | 'near'
  | 'far'
  | 'hover'
  | 'nohover'
  | 'rotate'
  | 'scale'
  | 'dragx'
  | 'dragnone'
  | 'dragturn'
  | 'dragscale';

/**
 * The control: a one-metre emissive magenta quad, off to the left of the gizmo.
 *
 * Emissive so its brightness is a constant of the scene rather than of the lighting, and magenta
 * because nothing else in the frame is — not the sky, not the ground, and not one of the five
 * colours the gizmo draws with.
 */
function control(): MeshData {
  return {
    positions: new Float32Array([-3, -0.5, 0, -2, -0.5, 0, -2, 0.5, 0, -3, 0.5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1]),
    emissive: new Float32Array([1, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const variant = (asked.get('variant') ?? 'near') as Variant;
  const frames = Number(asked.get('frames') ?? '3');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const quad = renderer.createMesh(control());
  const batches: LineHandle[] = [];
  /* One handle per group, and not one reused: on WebGPU a buffer written twice in a frame reads
     whichever write landed last, while WebGL2 draws each call as it comes. `createLines` says so. */
  for (let group = 0; group < GIZMO_GROUP_COUNT; group++)
    batches.push(renderer.createLines(96, `gizmo${group}`));

  const env = createEnvironment();
  env.ambient = [0.3, 0.3, 0.3];
  env.ambientGround = [0.3, 0.3, 0.3];
  env.directionalColor = [0.5, 0.5, 0.5];
  env.directionalDir = [0, 0, 1];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.5;
  camera.far = 400;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = variant === 'far' ? 24 : 6;
  camera.lookAt(0, 0, 0);

  /*
   * The drawing buffer is sized here or it stays at the canvas element's default 300x150, and every
   * measurement comes back zero — the failure the subject-present assertion exists for, and which
   * has now cost a debugging cycle on three rows running.
   */
  renderer.resize();
  const cssWidth = canvas.width;
  const cssHeight = canvas.height;
  camera.updateMatrices(cssHeight > 0 ? cssWidth / cssHeight : 1);

  const gizmo = new Gizmo();
  gizmo.mode =
    variant === 'rotate' || variant === 'dragturn'
      ? 'rotate'
      : variant === 'scale' || variant === 'dragscale'
        ? 'scale'
        : 'translate';
  gizmo.size = gizmoScaleFor(camera, gizmo.position, cssHeight, GIZMO_PIXELS);

  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  const projected = new Float32Array(2);

  /** The ray through a canvas pixel, which is the half of this that no unit test reaches. */
  function rayAtPixel(x: number, y: number): void {
    camera.rayThrough(origin, direction, x, y, cssWidth, cssHeight);
  }

  /** Where a world point lands on the canvas, so a scripted pointer can aim at a handle. */
  function pixelOf(x: number, y: number, z: number): [number, number] {
    camera.project(projected, x, y, z, cssWidth, cssHeight);
    return [projected[0] ?? 0, projected[1] ?? 0];
  }

  /** A pointer parked on the middle of the x arm. */
  function onArmX(): [number, number] {
    return pixelOf(gizmo.size * 0.6, 0, 0);
  }

  let dragStarted = false;
  if (variant === 'hover') {
    rayAtPixel(...onArmX());
    gizmo.hover(origin, direction);
  } else if (variant === 'nohover') {
    rayAtPixel(cssWidth * 0.06, cssHeight * 0.06);
    gizmo.hover(origin, direction);
  } else if (variant === 'dragx' || variant === 'dragnone') {
    if (variant === 'dragnone') rayAtPixel(cssWidth * 0.06, cssHeight * 0.06);
    else rayAtPixel(...onArmX());
    dragStarted = gizmo.beginDrag(origin, direction);
    /* One gizmo length further along x, in world, asked for as the pixel it lands on. */
    rayAtPixel(...pixelOf(gizmo.size * 1.6, 0, 0));
    gizmo.updateDrag(origin, direction);
  } else if (variant === 'dragturn') {
    rayAtPixel(...pixelOf(gizmo.size, 0, 0));
    dragStarted = gizmo.beginDrag(origin, direction);
    for (let step = 1; step <= 36; step++) {
      const angle = (step / 36) * (Math.PI * 1.5);
      rayAtPixel(...pixelOf(Math.cos(angle) * gizmo.size, Math.sin(angle) * gizmo.size, 0));
      gizmo.updateDrag(origin, direction);
    }
  } else if (variant === 'dragscale') {
    rayAtPixel(...onArmX());
    dragStarted = gizmo.beginDrag(origin, direction);
    rayAtPixel(...pixelOf(gizmo.size * 1.6, 0, 0));
    gizmo.updateDrag(origin, direction);
  }
  gizmo.build();

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let gizmoPixels = 0;
  let gizmoWidth = 0;
  let gizmoHeight = 0;
  let controlWidth = 0;
  let litPixels = 0;
  let digest = '';

  /** What the canvas holds right now, read back rather than screenshotted. */
  function grab(): Uint8ClampedArray | null {
    if (mirrorCtx === null) return null;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    return mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
  }

  /**
   * What the frame holds, counted from the canvas rather than from a screenshot — for the reason
   * `oit.ts` records, where a screenshot comparison found 120 differing pixels that turned out to be
   * the page's own caption.
   *
   * **Called in the tick that drew, which is not a style choice.** A WebGL drawing buffer is
   * discarded once the browser composites it, so reading the canvas at the start of the next tick
   * returns a cleared buffer and every number here comes back zero.
   */
  function measure(): void {
    const data = grab();
    if (data === null) return;

    let count = 0;
    let lit = 0;
    let minX = mirror.width;
    let maxX = -1;
    let minY = mirror.height;
    let maxY = -1;
    let controlMinX = mirror.width;
    let controlMaxX = -1;

    for (let y = 0; y < mirror.height; y++) {
      for (let x = 0; x < mirror.width; x++) {
        const i = (y * mirror.width + x) * 4;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;

        /* Magenta is the control and nothing else in this frame is near it. */
        if (r > 140 && b > 140 && g < 90) {
          if (x < controlMinX) controlMinX = x;
          if (x > controlMaxX) controlMaxX = x;
          continue;
        }

        const high = Math.max(r, g, b);
        const low = Math.min(r, g, b);
        if (high < 60 || high - low <= 55) continue;

        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        /* The highlight is the one group with red and green up together and blue down. */
        if (r > 150 && g > 120 && b < 110) lit += 1;
      }
    }

    gizmoPixels = count;
    gizmoWidth = maxX < 0 ? 0 : maxX - minX + 1;
    gizmoHeight = maxY < 0 ? 0 : maxY - minY + 1;
    controlWidth = controlMaxX < 0 ? 0 : controlMaxX - controlMinX + 1;
    litPixels = lit;

    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(withGizmo: boolean): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(quad, IDENTITY);
    for (let group = 0; withGizmo && group < GIZMO_GROUP_COUNT; group++) {
      const segments = gizmo.segments(group);
      if (segments.count === 0) continue;
      renderer.drawLines(
        batches[group] as LineHandle,
        segments,
        IDENTITY,
        camera,
        env,
        GIZMO_GROUP_COLORS[group] as Vec3,
        gizmo.size * 0.008,
        1,
        0,
        0,
      );
    }
    renderer.endFrame();
  }

  let drawn = 0;
  await new Promise<void>((done) => {
    const step = (): void => {
      frame(true);
      measure();
      drawn += 1;
      if (drawn >= frames) {
        done();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  stats.textContent =
    `${created.backend} · ${created.reason} · ${variant} · ${gizmoPixels} px · ` +
    `box ${gizmoWidth}x${gizmoHeight} · control ${controlWidth} · lit ${litPixels} · ` +
    `pos ${(gizmo.position[0] ?? 0).toFixed(3)} · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__pixels'] = gizmoPixels;
  out['__boxW'] = gizmoWidth;
  out['__boxH'] = gizmoHeight;
  out['__controlW'] = controlWidth;
  out['__lit'] = litPixels;
  out['__started'] = dragStarted;
  out['__posX'] = gizmo.position[0] ?? 0;
  out['__posY'] = gizmo.position[1] ?? 0;
  out['__posZ'] = gizmo.position[2] ?? 0;
  out['__sclX'] = gizmo.scale[0] ?? 0;
  out['__sclY'] = gizmo.scale[1] ?? 0;
  out['__angle'] = gizmo.dragAngle;
  out['__size'] = gizmo.size;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
