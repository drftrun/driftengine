/**
 * A scene captured from a second camera into a texture, shown on a quad: `captureScene`.
 *
 *     /sceneCapture.html?mode=direct&hdr=1    the second camera's view drawn to the frame itself
 *     /sceneCapture.html?mode=screen&hdr=1    the same view captured, shown on a quad filling the
 *                                             frame, unlit: the control's picture to within a level,
 *                                             at a 256 by 192 window, the capture's own size
 *     /sceneCapture.html?mode=empty&hdr=1     a capture whose callback draws nothing: the clear alone
 *     /sceneCapture.html?mode=room&capture=1  the room from the frame's camera with a small screen
 *                                             on the wall showing the second camera's view
 *     /sceneCapture.html?mode=room&capture=0  the same room with the capture never drawn: outside
 *                                             the screen the two frames must be the same pixels, so
 *                                             a capture leaves the frame it is drawn in alone
 *
 * **Why the control is exact.** A capture holds radiance and the quad draws it unlit, so the frame
 * grades the screen's pixels once, as it grades the direct view's; with half floats both are the
 * same light. The quad fills the view edge to edge, so each pixel samples its texel's centre.
 *
 * Deterministic: fixed cameras, closed forms, no clock. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const mode = ASKED.get('mode') ?? 'screen';
const CLEAR: Vec3 = [0.05, 0.06, 0.09];
const CAPTURE_W = 256;
const CAPTURE_H = 192;
const FOV = 50;

/** Five boxes of five colours on a floor: something whose every part is somewhere particular. */
function boxes(): MeshData {
  const b = new MeshBuilder().addBox([0, -0.05, 0], [4, 0.05, 4], [0.5, 0.5, 0.52]);
  const colours: Vec3[] = [
    [0.9, 0.2, 0.15],
    [0.2, 0.8, 0.3],
    [0.2, 0.35, 0.9],
    [0.9, 0.8, 0.2],
    [0.8, 0.3, 0.8],
  ];
  colours.forEach((colour, i) => {
    const x = (i - 2) * 1.3;
    b.addBox([x, 0.3 + 0.2 * i, -0.5 * (i % 2)], [0.4, 0.3 + 0.2 * i, 0.4], colour);
  });
  return b.build();
}

/** A quad at z = -1 that fills a camera at the origin looking down -z, square to it. */
function fillingQuad(aspect: number): MeshData {
  const h = Math.tan((FOV * Math.PI) / 360);
  const w = h * aspect;
  return {
    positions: new Float32Array([-w, -h, -1, w, -h, -1, w, h, -1, -w, h, -1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12).fill(1),
    emissive: new Float32Array(4),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function aim(camera: Camera, from: Vec3, at: Vec3): void {
  camera.fovYDeg = FOV;
  camera.near = 0.1;
  camera.far = 60;
  camera.position[0] = from[0];
  camera.position[1] = from[1];
  camera.position[2] = from[2];
  camera.lookAt(at[0], at[1], at[2]);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const env = createEnvironment({
    directionalDir: [0.4, 0.8, 0.45],
    directionalColor: [0.9, 0.85, 0.8],
    ambient: [0.25, 0.27, 0.3],
    fogDensity: 0,
  });
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  const world = renderer.createMesh(boxes());
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const second = new Camera();
  aim(second, [3.5, 2.6, 4.5], [0, 0.6, 0]);
  const viewer = new Camera();
  if (mode === 'room') aim(viewer, [-4, 3, 6], [0.5, 0.5, 0]);
  else viewer.fovYDeg = FOV;
  viewer.updateMatrices(aspect);

  const capture = renderer.createSceneCapture(CAPTURE_W, CAPTURE_H);
  const screen = renderer.createMesh(fillingQuad(CAPTURE_W / CAPTURE_H));
  /* In the room, a small screen on a post: the filling quad scaled and stood up beside the boxes. */
  const onWall = new Float32Array([0.6, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0.6, 0, -2.6, 1.6, -1.2, 1]);
  const showing = { albedo: capture };
  const drawWorld = (camera: Camera): void => {
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(world, identity);
  };

  const frame = (): void => {
    renderer.beginFrame(CLEAR);
    if (mode === 'direct') {
      second.updateMatrices(aspect);
      drawWorld(second);
    } else {
      if (mode !== 'room' || ASKED.get('capture') !== '0') {
        renderer.captureScene(capture, second, CLEAR, mode === 'empty' ? () => {} : drawWorld);
      }
      if (mode === 'room') drawWorld(viewer);
      else renderer.bindMeshPass(viewer, env);
      renderer.setMaterial(showing);
      renderer.drawTranslucentMesh(screen, mode === 'room' ? onWall : identity, 1, {
        lit: false,
        fog: false,
      });
      renderer.setMaterial(null);
    }
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · scene capture · ${location.search}`;
}

void main();
