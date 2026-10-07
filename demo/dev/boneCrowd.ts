/**
 * A crowd played on the device from a bone animation, or the same crowd posed on the processor by
 * the arithmetic the shader states — the reporter's own path — at one held moment.
 *
 *     /boneCrowd.html                  twenty-five swaying columns, played by the vertex stage
 *     /boneCrowd.html?mode=cpu         the same moment, every instance a mesh posed by
 *                                      `animateBoneVertex` and drawn on its own
 *     /boneCrowd.html?time=2.6         another moment
 *
 * Each column is four boxes stacked, a bone each, named by the second coordinates' u a sixty-fourth
 * apart; the clip sways each bone about the column's foot, further the higher it is, over eight
 * frames, and every instance has a phase of its own. A sun casts their shadows, so the shadow pass's
 * animation is compared as well as the colour pass's. The two modes must agree to within what
 * floating point gives the device; `window.__drawn` turns true at frame thirty. Nothing under `src/`
 * may import this.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, ShadowCasters, Vec3 } from '../../packages/core/src/index';
import { animateBoneVertex, packBoneAnimation } from '../../packages/core/src/render/boneAnimation';
import type { BoneAnimationClip } from '../../packages/core/src/render/boneAnimation';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CPU = ASKED.get('mode') === 'cpu';
const TIME = Number(ASKED.get('time') ?? '1.37') || 0;
const CLEAR: Vec3 = [0.3, 0.34, 0.42];
const BONES = 4;
const FRAMES = 8;
const SIDE = 5;

const at = (x: number, y: number, z: number): Float32Array =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/** A column of four boxes, each vertex's second coordinates naming the box it belongs to. */
function column() {
  const builder = new MeshBuilder();
  for (let bone = 0; bone < BONES; bone++) {
    builder.addBox([0, 0.25 + bone * 0.5, 0], [0.18, 0.24, 0.18], [0.85 - bone * 0.12, 0.6, 0.4]);
  }
  const data = builder.build();
  const vertices = data.positions.length / 3;
  const lightmapUvs = new Float32Array(vertices * 2);
  for (let v = 0; v < vertices; v++) {
    const bone = Math.min(BONES - 1, Math.floor((data.positions[v * 3 + 1] as number) / 0.5));
    lightmapUvs[v * 2] = bone / 64;
  }
  return { ...data, lightmapUvs };
}

/** Each bone swayed about the foot, about z, further the higher it is, over the clip's frames. */
function sway(): BoneAnimationClip {
  const places = new Float32Array(FRAMES * BONES * 3);
  const turns = new Float32Array(FRAMES * BONES * 4);
  for (let frame = 0; frame < FRAMES; frame++) {
    const swing = Math.sin((frame / FRAMES) * Math.PI * 2);
    for (let bone = 0; bone < BONES; bone++) {
      const angle = swing * 0.12 * (bone + 1);
      const i = frame * BONES + bone;
      turns[i * 4 + 2] = Math.sin(angle / 2);
      turns[i * 4 + 3] = Math.cos(angle / 2);
      places[i * 3] = swing * 0.05 * bone;
    }
  }
  return { bones: BONES, frames: FRAMES, framesPerSecond: 4, places, turns, boneScale: 64 };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  const mesh = column();
  const clip = sway();
  const floor = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.05, 0], [8, 0.05, 8], [0.45, 0.46, 0.48]).build(),
  );
  const placed = createMeshInstances(SIDE * SIDE);
  const clocks = new Float32Array(SIDE * SIDE * 2);
  for (let i = 0; i < SIDE * SIDE; i++) {
    placed.models.set(at(((i % SIDE) - 2) * 1.4, 0, (Math.floor(i / SIDE) - 2) * 1.4), i * 16);
    placed.tints.set([1, 1, 1], i * 3);
    clocks[i * 2] = i * 0.17;
    clocks[i * 2 + 1] = 1 + (i % 3) * 0.25;
  }
  placed.count = SIDE * SIDE;
  const data = { ...placed, clocks };

  /* The device's crowd, or the processor's: one posed mesh an instance at the held moment. */
  let crowd: ShadowCasters;
  if (CPU) {
    const texels = packBoneAnimation(clip);
    const turnsOnly = { ...texels, places: new Float32Array(texels.places.length) };
    const posed: { mesh: MeshHandle; model: Float32Array }[] = [];
    const out = new Float32Array(3);
    for (let i = 0; i < SIDE * SIDE; i++) {
      const positions = new Float32Array(mesh.positions.length);
      const normals = new Float32Array(mesh.normals.length);
      for (let v = 0; v < positions.length / 3; v++) {
        const bone = Math.round((mesh.lightmapUvs[v * 2] as number) * 64);
        const phase = clocks[i * 2] as number;
        const rate = clocks[i * 2 + 1] as number;
        animateBoneVertex(
          texels,
          bone,
          mesh.positions.subarray(v * 3, v * 3 + 3),
          TIME,
          phase,
          rate,
          out,
        );
        positions.set(out, v * 3);
        animateBoneVertex(
          turnsOnly,
          bone,
          mesh.normals.subarray(v * 3, v * 3 + 3),
          TIME,
          phase,
          rate,
          out,
        );
        normals.set(out, v * 3);
      }
      posed.push({
        mesh: renderer.createMesh({ ...mesh, positions, normals }),
        model: placed.models.slice(i * 16, i * 16 + 16),
      });
    }
    crowd = (sink) => {
      for (const { mesh: one, model } of posed) sink.mesh(one, model, null);
    };
  } else {
    const animation = renderer.createBoneAnimation(clip);
    const batch = renderer.createInstanced(renderer.createMesh(mesh), SIDE * SIDE, { animation });
    renderer.uploadInstanced(batch, data);
    crowd = (sink) => sink.instanced?.(batch, data, null);
  }

  const env = createEnvironment({
    directionalDir: [0.45, 0.8, 0.35],
    directionalColor: [1.2, 1.12, 1.0],
    ambient: [0.3, 0.34, 0.4],
    ambientGround: [0.1, 0.09, 0.08],
    fogDensity: 0,
  });
  /* Dark enough that a shadow photographs as one: the default lifts it into the floor beside it. */
  env.shadowStrength = 0.9;
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.1;
  camera.far = 80;
  camera.position[0] = 0;
  camera.position[1] = 6;
  camera.position[2] = 10;
  camera.lookAt(0, 1, 0);
  camera.updateMatrices(aspect);
  const lightMatrix = new Float32Array(16);
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    0,
    1,
    0,
    9,
    renderer.shadowMapSize,
    lightMatrix,
  );
  env.lightViewProj = lightMatrix;

  let frames = 0;
  const draw = (): void => {
    /* The clock first, before the shadows, which read it as the colour pass does. */
    renderer.setAnimationTime(TIME);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(crowd);
    renderer.endShadowPass();
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(floor, at(0, 0, 0));
    renderer.drawSceneCasters(crowd);
    renderer.endFrame();
    frames += 1;
    if (frames === 30) {
      (window as unknown as { __drawn: boolean }).__drawn = true;
      stats.textContent = `${created.backend} · ${CPU ? 'posed on the processor' : 'played by the vertex stage'} · t=${TIME}`;
    }
    requestAnimationFrame(draw);
  };
  draw();
}

void main();
