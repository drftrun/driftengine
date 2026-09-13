/**
 * Skinning, looked at on real hardware, on either backend.
 *
 * **This page is the feature's only evidence, and that is deliberate.** No published scene has a
 * rig, so the gate on those is a zero-pixel diff — it proves the change is inert and proves
 * nothing about whether a vertex moves. Putting a character into the published set would spend
 * that gate. So the proof lives here, exactly as `normal.html` argues for its own feature.
 *
 * Two columns, identical geometry, one thing different:
 *
 *   - **Left — skinned.** A tall bar whose upper half is weighted to joint 1 and lower half to
 *     joint 0, drawn through the skinned pipeline with a palette from `Skeleton.applyPose`.
 *   - **Right — the same bar, unrigged.** The control. It takes the plain pipeline and cannot
 *     bend, so anything that moves *both* columns is the camera, the light or the harness rather
 *     than skinning.
 *
 *     /skinning.html                    the default backend
 *     /skinning.html?backend=webgl2     the other one
 *     /skinning.html?phase=0            the rest pose: both columns straight and identical
 *     /skinning.html?phase=1            fully bent
 *
 * **`?phase` and no clock.** The frame is a pure function of the query, so two captures of one
 * build differ in zero pixels and a held clock buys nothing — the same property the published
 * scenes have and the reason their floor on WebGPU is zero.
 *
 * **Exclude the readout when diffing two backends.** `#stats` prints the reason each backend was
 * chosen, and those strings differ — "WebGPU adapter and device acquired" against "forced by
 * ?backend=webgl2". Compared whole-frame the two backends read as 3,822 pixels apart at *every*
 * phase, worst pixel at the same coordinate both times, which is the tell that it is text rather
 * than geometry. With `--region=0,0,1280,650` they are **0 of 832,000**:
 *
 *     node scripts/shots.mjs capture rest --backend=webgpu \
 *       "--urls=skinning=/skinning.html?phase=0" --inject --hold=2
 *     node scripts/shots.mjs diff rest-webgpu bent-webgpu \
 *       "--urls=skinning=/skinning.html" --region=0,0,1280,650 --delta=16
 *
 * Measured 2026-08-25 on a Radeon RX 9070 XT: rest against bent moves **22,608 pixels** on both
 * backends, and the two backends agree to the pixel at either phase.
 *
 * **What a failure looks like**, so it is recognised rather than rationalised:
 *
 *   - **The left bar vanishes, or collapses to a point at the origin.** The palette reached the
 *     shader as zeroes, or the weights did. A zero matrix takes every vertex it touches to the
 *     origin; this is what the `(1, 0, 0, 0)` weight default in `vertexDefaults.ts` exists to
 *     prevent for an *unrigged* mesh, and seeing it here means the rigged path is at fault.
 *   - **The left bar is thrown out of frame.** The skin matrix was applied after `uModel` rather
 *     than before it, so the character's placement is applied twice.
 *   - **Both bars bend.** Impossible by construction — the right one has no joints — so it means
 *     the columns are not what this page says they are.
 *   - **The left bar bends the wrong way at `?phase=1`** — the joint rotation's sign, or a
 *     transposed matrix in `jointMatrix`.
 *   - **Nothing bends at any phase.** The skinned variant was not selected: `mesh.isSkinned` is
 *     false, or no palette was set, and both fall back to the plain pipeline by design.
 *   - **`?morph=1` moves nothing.** The morphed variant was not selected, or the weights were not
 *     written — the deltas belong to the mesh and the weights to the draw, so either half missing
 *     leaves the other inert.
 *   - **The bulge drifts as the bar bends.** Morph was applied after skinning rather than before
 *     it, so the target is deforming the posed vertex instead of the bind pose.
 */
import { Skeleton, createPose } from '../../packages/animation/src/index';
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.043, 0.051, 0.063];

/** Near white, so what reaches the eye is the shape rather than a tint over it. */
const BAR_COLOR: Vec3 = [0.9, 0.88, 0.85];

/** Where the second joint sits, and therefore where the bar bends. */
const ELBOW_Y = 0;

function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/**
 * A bar tall enough to show a bend, built from four stacked boxes.
 *
 * Stacked rather than one box because a bend needs vertices *along* the limb to move by different
 * amounts — a single box has vertices only at its ends, and a two-joint skin of it would rotate
 * the top face rigidly and look like a hinge rather than a limb.
 */
function bar(): MeshData {
  const builder = new MeshBuilder();
  for (let segment = 0; segment < 4; segment++) {
    const centerY = -1.5 + segment;
    builder.addBox([0, centerY, 0], [0.32, 0.5, 0.32], BAR_COLOR);
  }
  return builder.build();
}

/**
 * The same bar with a two-joint skin on it.
 *
 * Weighting is a linear ramp across one segment's height rather than a hard split, so the bend has
 * a shoulder instead of a crease — which is also what makes it a *blend* of two joints rather than
 * two rigid halves that happen to share a mesh, and therefore what actually exercises the weighted
 * sum in `skinMatrix`.
 */
/**
 * One morph target: a bulge that pushes the bar's middle out along +X.
 *
 * A delta per vertex, scaled by how near the vertex is to the middle of the bar, so the shape is a
 * smooth swell rather than a step — which is what makes a partial weight visibly partial.
 */
function bulgeTarget(positions: Float32Array): Float32Array {
  const vertices = positions.length / 3;
  const deltas = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) {
    const y = positions[v * 3 + 1] as number;
    /* One at the bar's middle, nothing at either end. */
    const near = Math.max(0, 1 - Math.abs(y) / 1.5);
    deltas[v * 3] = near * 0.55;
  }
  return deltas;
}

function riggedBar(): MeshData {
  const data = bar();
  const vertices = data.positions.length / 3;
  const joints = new Float32Array(vertices * 4);
  const weights = new Float32Array(vertices * 4);

  for (let v = 0; v < vertices; v++) {
    const y = data.positions[v * 3 + 1] as number;
    /* 0 below the elbow, 1 a segment above it, linear between. */
    const upper = Math.min(Math.max((y - ELBOW_Y) / 1, 0), 1);
    joints[v * 4] = 0;
    joints[v * 4 + 1] = 1;
    weights[v * 4] = 1 - upper;
    weights[v * 4 + 1] = upper;
  }
  return { ...data, joints, weights };
}

/**
 * A two-joint skeleton whose bind pose is the bar standing straight.
 *
 * The inverse bind of a joint at height `y` is a translation of `-y`, which is what takes a vertex
 * from model space into that joint's bind space. Written out rather than inverted at runtime,
 * because a hand-derived matrix is what makes a wrong multiplication order visible here rather
 * than plausible.
 */
function armSkeleton(): Skeleton {
  const inverseBind = new Float32Array(32);
  /* Joint 0 sits at the origin: its inverse bind is identity. */
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  /* Joint 1 sits at ELBOW_Y: translate down by that much. */
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -ELBOW_Y, 0, 1], 16);
  return new Skeleton(
    [
      { parent: -1, name: 'root' },
      { parent: 0, name: 'elbow' },
    ],
    inverseBind,
  );
}

/**
 * Bend a rig to a phase: nothing at 0, seventy degrees about Z at 1.
 *
 * Taken out of `main` when this page grew a second rig, because two rigs posed by two copies of
 * the same arithmetic is how the pair stops being a comparison.
 */
function bend(skeleton: Skeleton, phase: number): void {
  const pose = createPose(skeleton.jointCount);
  /* The bind pose the inverse binds were written for. */
  pose.translation[4] = ELBOW_Y;
  /*
   * A quaternion written by hand: (0, 0, sin(a/2), cos(a/2)). No clock and no RNG anywhere on
   * this path, which is what makes the frame a pure function of the query.
   */
  const angle = phase * 70 * (Math.PI / 180);
  pose.rotation[4] = 0;
  pose.rotation[5] = 0;
  pose.rotation[6] = Math.sin(angle / 2);
  pose.rotation[7] = Math.cos(angle / 2);
  skeleton.applyPose(pose);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const stats = document.getElementById('stats');
  if (canvas === null || stats === null) return;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment({
    /* Raking from the left, so a bend catches light on one face and shades the other. */
    directionalDir: [0.82, 0.42, 0.38],
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 60;
  camera.position[0] = 0;
  camera.position[1] = 0.2;
  camera.position[2] = 9;
  camera.lookAt(0, 0.2, 0);

  renderer.resize();
  const aspect = (): number => {
    const height = canvas.height;
    return height > 0 ? canvas.width / height : 1;
  };
  camera.updateMatrices(aspect());

  const rigged = riggedBar();
  const skinned: MeshHandle = renderer.createMesh({
    ...rigged,
    morphTargets: bulgeTarget(rigged.positions),
    morphTargetCount: 1,
  });
  const plain: MeshHandle = renderer.createMesh(bar());
  const skinnedAt = at(-1.8, 0, 0);
  const plainAt = at(1.8, 0, 0);

  const skeleton = armSkeleton();

  const query = new URLSearchParams(location.search);
  const asked = Number(query.get('phase') ?? '1');
  const phase = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 1) : 1;
  const askedMorph = Number(query.get('morph') ?? '0');
  const morph = Number.isFinite(askedMorph) ? Math.min(Math.max(askedMorph, 0), 1) : 0;
  /* One weight, for the one target. Claimed once: this is read every frame. */
  const morphWeights = new Float32Array([morph]);

  bend(skeleton, phase);

  /*
   * `?pair=1` — the right column becomes a **second rig at its own phase**, and the control goes.
   *
   * Everything above this line draws one palette per frame, which is the case a single character
   * exercises and the only case this page had. Two characters in one frame is a different claim:
   * each draw must read the palette that was set for *it*. Same mesh, same model matrix's mirror
   * image, one thing different — so a pair that comes out identical is the palette and can be
   * nothing else.
   *
   *     /skinning.html?pair=1                    left bent, right straight
   *     /skinning.html?pair=1&phase=0&phase2=1   the reverse
   *
   * **What a failure looks like: both bars take the same bend.** The backend let one palette
   * overwrite the other before either draw ran — which is what a queue-ordered upload into one
   * shared texture does to draws that are only recorded, not yet submitted.
   */
  const pair = (query.get('pair') ?? '0') === '1';
  const askedSecond = Number(query.get('phase2') ?? '0');
  const secondPhase = Number.isFinite(askedSecond) ? Math.min(Math.max(askedSecond, 0), 1) : 0;
  const second = armSkeleton();
  bend(second, secondPhase);

  function renderFrame(): void {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);

    renderer.setSkinPalette(skeleton.palette);
    renderer.setMorphWeights(morphWeights);
    renderer.drawMesh(skinned, skinnedAt);

    if (pair) {
      /* The second palette, and the second draw that must read it rather than the first's. */
      renderer.setSkinPalette(second.palette);
      renderer.drawMesh(skinned, plainAt);
      renderer.setMorphWeights(null);
      renderer.setSkinPalette(null);
    } else {
      /* Both cleared, so the control takes the plain pipeline rather than inheriting either. */
      renderer.setSkinPalette(null);
      renderer.setMorphWeights(null);
      renderer.drawMesh(plain, plainAt);
    }

    renderer.endFrame();
  }

  stats.textContent =
    `${created.backend} · ${created.reason} · 2 draws · ` +
    (pair ? `skinned | skinned at phase ${secondPhase.toFixed(2)}` : 'skinned | rigid control') +
    ` · phase ${phase.toFixed(2)} · ${(phase * 70).toFixed(0)}deg at the elbow` +
    ` · morph ${morph.toFixed(2)}`;

  /*
   * Redrawn every frame, and every frame is identical.
   *
   * Nothing here reads a clock — the pose is a function of `?phase` alone — so the loop exists for
   * the harness rather than for the picture: `shots.mjs --inject` patches `requestAnimationFrame`
   * to count held frames, and a page that draws once and stops never satisfies the readiness
   * condition. Drawing repeatedly costs nothing and keeps the two-capture floor at zero, because
   * frame N and frame N+1 are the same arithmetic.
   */
  function loop(): void {
    renderFrame();
    requestAnimationFrame(loop);
  }
  loop();

  addEventListener('resize', () => {
    renderer.resize();
    camera.updateMatrices(aspect());
  });

  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
