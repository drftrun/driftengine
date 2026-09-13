/**
 * Gaussian splat captures, drawn through `registerPass`, with engine geometry standing in them.
 *
 * **The captures are synthesised here rather than fetched**, and that is the point of the page. A
 * downloaded `.ply` is tens of megabytes, is nobody's to redistribute, and is unknown — so a
 * wrong picture from one cannot be told from a wrong file. Everything drawn below is built from
 * numbers written in this file, so every feature of the frame is predictable and a departure from
 * it is the renderer.
 *
 * What each part is for, because a page that shows everything at once shows nothing:
 *
 *   - **The wall**, a plane of small round splats coloured by position. Says that positions,
 *     colours and the draw order are right. A scrambled order shows here as speckle.
 *   - **The ladder**, seven large splats along X with increasing anisotropy, each rotated 30
 *     degrees more than the last. Says the covariance and the rotation survive packing: a
 *     transposed covariance draws ellipses tilted the wrong way, and a dropped rotation draws
 *     seven circles.
 *   - **The post**, an opaque engine box standing through the wall. Says the depth test works —
 *     splats behind it are hidden and splats in front of it are not, which is the whole claim
 *     that these compose *into* a scene rather than being drawn instead of one.
 *
 *   - **The stack**, eight half-transparent splats at one screen position but spread in depth,
 *     interleaved so index order is nothing like depth order. Says the *sort* is happening: far to
 *     near the warm near colour wins, and in index order it does not.
 *
 *   - **The arch**, a **second capture** in its own batch, turned and moved by a model matrix.
 *     Says two captures compose in one scene, that a batch's transform reaches both the picture
 *     and its own sort, and — under `?seam=1` — shows the limit that costs: two batches are two
 *     orders, so where they interpenetrate one wins every blend along a visible plane.
 *
 *     /splats.html                 the five above
 *     ?wall=0 ?ladder=0 ?post=0 ?stack=0 ?arch=0
 *                                  each off, for attributing a fault to one of them
 *     ?sort=0                      draw unsorted, which is what a missing sort looks like
 *     ?budget=N                    cap each batch at N splats, kept by screen-space size
 *     ?budget=auto                 the same, at whatever `defaultSplatBudget` says this part can hold
 *     ?seam=1                      drive the arch through the wall, so the two-order seam shows
 *     ?aside=1                     move the arch out of frame, so the cull can be read off `drawn`
 *     ?spin=1                      orbit rather than hold, for looking rather than measuring
 *     ?bulk=N                      replace everything with a cube of N splats, and report a mean
 *                                  frame time. The instrument for §3.5's vertex-stage question
 *     ?flat=1                      the same cube with every splat sub-pixel, so the fill is gone
 *                                  and what is left is the vertex stage. Meaningless without ?bulk
 *
 * Deterministic: every position is a closed form of an index, nothing reads a clock, and the
 * camera holds after `HOLD_AT` — so two runs of one build differ in zero pixels.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, PassHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import {
  SplatSorter,
  createSplatPass,
  createSplatViewLocal,
  defaultSplatBudget,
  packSplats,
  resolveSplatView,
} from '../../packages/splats/src/index';
import type { SplatData, SplatPass, SplatViewLocal } from '../../packages/splats/src/index';

import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.02, 0.024, 0.03];
/** Where the page stops moving, so a capture and its published numbers are from one frame. */
const HOLD_AT = 40;
/**
 * How long the page will wait past `HOLD_AT` for the sorters to settle before giving up.
 *
 * **A ceiling, so the page always stops.** A sorter whose worker never answers would otherwise
 * hold this loop for ever, and a page that never says it is ready is a capture that times out
 * with no explanation. Four seconds at sixty frames; the readout says so when it is reached.
 */
const SETTLE_LIMIT = HOLD_AT + 240;

/** How many splats a side the wall is. 64 is 4,096 splats: enough to read, cheap to sort. */
const WALL = 64;
const LADDER = 7;
/** Splats in the depth stack. Eight is enough for the near colour to win outright. */
const STACK = 8;
/** Splats along the arch, times three rings of it. */
const ARCH = 44;

/** How many inter-frame gaps the mean is taken over. A quarter of a second at 120 Hz is thirty. */
const FRAME_SAMPLES = 120;

/**
 * A cube of `count` splats, for measuring rather than for looking at.
 *
 * **The instrument for §3.5's open question**, which is whether the vertex stage is what limits a
 * splat pass. Six vertices a splat come off the vertex id where an indexed quad would issue four,
 * and the alternative costs 24 MB per million splats — so the trade is only worth taking if the
 * vertex stage is a large share of the pass, and nothing had measured that.
 *
 * `tiny` is the other half of the control: the same count, the same vertex work, and splats small
 * enough that almost no fragments are shaded. The difference between the two runs is the fill, and
 * what is left is the vertex stage plus the draw.
 */
function buildBulk(count: number, tiny: boolean): SplatData {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacities = new Float32Array(count);
  /* A closed form of the index, like everything else on this page, so two runs are one picture. */
  const side = Math.ceil(Math.cbrt(count));
  const size = tiny ? 0.0006 : 0.03;
  for (let index = 0; index < count; index++) {
    const x = index % side;
    const y = Math.floor(index / side) % side;
    const z = Math.floor(index / (side * side));
    positions[index * 3] = ((x + 0.5) / side - 0.5) * 5;
    positions[index * 3 + 1] = ((y + 0.5) / side - 0.5) * 5 + 1;
    positions[index * 3 + 2] = ((z + 0.5) / side - 0.5) * 5;
    scales[index * 3] = size;
    scales[index * 3 + 1] = size;
    scales[index * 3 + 2] = size;
    rotations[index * 4 + 3] = 1;
    colors[index * 3] = (x + 1) / side;
    colors[index * 3 + 1] = (y + 1) / side;
    colors[index * 3 + 2] = (z + 1) / side;
    opacities[index] = 0.6;
  }
  return packSplats({ count, positions, scales, rotations, colors, opacities });
}

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * A model matrix: a uniform scale, a turn about y, then a move. Column-major, as the engine's are.
 *
 * Written out rather than composed from three matrices, because a page proving that a model matrix
 * reaches the picture should not be proving it through a matrix library the pass does not use.
 */
function placed(scale: number, turnRad: number, x: number, y: number, z: number): Float32Array {
  const c = Math.cos(turnRad) * scale;
  const s = Math.sin(turnRad) * scale;
  const m = new Float32Array(16);
  m[0] = c;
  m[2] = -s;
  m[5] = scale;
  m[8] = s;
  m[10] = c;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  m[15] = 1;
  return m;
}

/**
 * The first capture: a wall of round splats, a ladder of anisotropic ones, a stack in depth.
 *
 * Colours are a function of position, so a splat drawn in the wrong place is visible as a colour
 * out of its gradient rather than as a shape nobody can locate.
 */
function buildCapture(
  wantsWall: boolean,
  wantsLadder: boolean,
  wantsStack: boolean,
  sh: boolean,
): SplatData {
  const positions: number[] = [];
  const scales: number[] = [];
  const rotations: number[] = [];
  const colors: number[] = [];
  const opacities: number[] = [];

  if (wantsWall) {
    for (let row = 0; row < WALL; row++) {
      for (let column = 0; column < WALL; column++) {
        const u = column / (WALL - 1);
        const v = row / (WALL - 1);
        positions.push((u - 0.5) * 6, (v - 0.5) * 4 + 1.2, 0);
        /* Round and small, so the wall reads as a surface rather than as overlapping blobs. */
        scales.push(0.035, 0.035, 0.035);
        rotations.push(0, 0, 0, 1);
        colors.push(u, 0.35 + 0.4 * v, 1 - u);
        opacities.push(0.95);
      }
    }
  }

  if (wantsLadder) {
    for (let rung = 0; rung < LADDER; rung++) {
      const t = rung / (LADDER - 1);
      /* A half-angle, because a quaternion's angle is half the rotation it performs. */
      const half = (rung * (Math.PI / 6)) / 2;
      positions.push((rung - (LADDER - 1) / 2) * 0.85, -1.6, 0.4);
      /* Increasingly long in x and always thin in y: a circle at the left, a needle at the right. */
      scales.push(0.06 + 0.28 * t, 0.06, 0.06);
      /* About z, so the tilt is in the plane the camera faces. xyzw. */
      rotations.push(0, 0, Math.sin(half), Math.cos(half));
      colors.push(1, 0.82, 0.35);
      opacities.push(1);
    }
  }

  if (wantsStack) {
    /*
     * **The element that makes the sort visible, and the page could not tell before it existed.**
     *
     * The wall is a plane and the ladder is a row: both are coplanar, so there is no ordering to
     * get wrong in either, and `?sort=0` moved the frame by a mean of 0.10 of a level — a control
     * that cannot separate the two states it is testing.
     *
     * This is eight large half-transparent splats stacked *in depth* at one screen position, in two
     * colours, **interleaved so that index order is nothing like depth order**: index 0 is nearest,
     * index 1 is farthest, and so on inward. Composited far to near the near colour dominates;
     * composited in index order it does not, because `over` is not commutative. A missing or
     * reversed sort is then a different colour rather than a subtle edge.
     */
    for (let layer = 0; layer < STACK; layer++) {
      const fromFront = layer % 2 === 0;
      const step = Math.floor(layer / 2);
      const z = fromFront ? 1.6 - step * 0.4 : -1.6 + step * 0.4;
      positions.push(-2.4, -1.6, z);
      scales.push(0.34, 0.34, 0.34);
      rotations.push(0, 0, 0, 1);
      /* Near is warm and far is cold, so which one wins is legible without a colour picker. */
      if (z > 0) colors.push(1, 0.3, 0.2);
      else colors.push(0.2, 0.6, 1);
      opacities.push(0.5);
    }
  }

  return pack(positions, scales, rotations, colors, opacities, sh);
}

/**
 * The second capture: three concentric rings of splats, authored around its own origin.
 *
 * **Authored at the origin on purpose.** A capture placed by its own coordinates would prove
 * nothing about a model matrix; this one is only ever seen where the matrix puts it, so a matrix
 * that is ignored, transposed or applied to the picture but not to the sort each fails visibly.
 */
function buildArch(sh: boolean): SplatData {
  const positions: number[] = [];
  const scales: number[] = [];
  const rotations: number[] = [];
  const colors: number[] = [];
  const opacities: number[] = [];

  for (let ring = 0; ring < 3; ring++) {
    const radius = 0.9 + ring * 0.22;
    for (let step = 0; step < ARCH; step++) {
      const t = step / (ARCH - 1);
      const angle = Math.PI * t;
      positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, (ring - 1) * 0.3);
      /* Elongated along the ring, and turned to follow it, so the whole batch is anisotropic —
         which is what makes a wrong model rotation read as ellipses lying across the arc. */
      const half = (angle + Math.PI / 2) / 2;
      scales.push(0.14, 0.05, 0.05);
      rotations.push(0, 0, Math.sin(half), Math.cos(half));
      colors.push(0.35 + 0.4 * t, 0.95, 0.45);
      opacities.push(0.9);
    }
  }

  return pack(positions, scales, rotations, colors, opacities, sh);
}

/**
 * The synthetic l=1 band `?sh=1` gives every splat: `Y(1,0)` and nothing else.
 *
 * **One basis function, and it is chosen so the answer flips sign rather than merely changes.**
 * The l=1 evaluation is `−C1·y·c0 + C1·z·c1 − C1·x·c2`, so a band with only `c1` set makes the
 * shift proportional to the **z component of the direction from the camera to the splat**. A
 * camera at +z sees a negative z there and a camera at −z a positive one, so the red channel goes
 * down at one angle and up at the other, by the same amount. A coefficient on `c0` or `c2` would
 * do the same about a different axis; a constant offset — which is what a *view-independent* bug
 * would produce — cannot flip at all, which is what makes this the control rather than a picture.
 *
 * Red up and green and blue down, so the shift is a hue swing rather than a brightness one and
 * cannot be confused with an exposure change.
 */
const SH_PROBE = [0.9, -0.45, -0.45] as const;

function pack(
  positions: number[],
  scales: number[],
  rotations: number[],
  colors: number[],
  opacities: number[],
  sh = false,
): SplatData {
  const count = opacities.length;
  let sh1: Float32Array | undefined;
  if (sh) {
    sh1 = new Float32Array(count * 9);
    for (let index = 0; index < count; index++) {
      /* Coefficients 3, 4 and 5 are Y(1,0)'s three channels. See `SplatSource.sh1`. */
      sh1[index * 9 + 3] = SH_PROBE[0];
      sh1[index * 9 + 4] = SH_PROBE[1];
      sh1[index * 9 + 5] = SH_PROBE[2];
    }
  }
  return packSplats({
    count,
    positions: new Float32Array(positions),
    scales: new Float32Array(scales),
    rotations: new Float32Array(rotations),
    colors: new Float32Array(colors),
    opacities: new Float32Array(opacities),
    ...(sh1 === undefined ? {} : { sh1 }),
  });
}

/**
 * One capture, its pass, its sorter and the scratch the two share.
 *
 * The order of a frame is what this exists to keep straight: `setView` first, because it is what
 * decides visibility; then the cull; then the sort, which is skipped entirely for a batch out of
 * frame — see `SplatPass.visible` for why that ordering is the whole saving.
 */
interface Batch {
  readonly data: SplatData;
  readonly pass: SplatPass;
  readonly handle: PassHandle;
  readonly sorter: SplatSorter;
  readonly local: SplatViewLocal;
  readonly model: Float32Array;
  readonly unsorted: Uint32Array;
  uploaded: number;
  drawn: number;
}

function makeBatch(
  renderer: RendererApi,
  data: SplatData,
  label: string,
  model: Float32Array,
  budget: number,
): Batch {
  const pass = createSplatPass(data, label);
  const unsorted = new Uint32Array(Math.max(1, data.count));
  for (let index = 0; index < unsorted.length; index++) unsorted[index] = index;
  pass.setModel(model);
  return {
    data,
    pass,
    handle: renderer.registerPass(pass),
    sorter: new SplatSorter({ splats: data, budget }),
    local: createSplatViewLocal(),
    model,
    unsorted,
    uploaded: -1,
    drawn: 0,
  };
}

async function main(): Promise<void> {
  const canvasEl = document.getElementById('canvas') as HTMLCanvasElement | null;
  const statsEl = document.getElementById('stats');
  const errorOut = document.getElementById('error');
  if (canvasEl === null || statsEl === null) return;
  const canvas = canvasEl;
  const stats = statsEl;

  const params = new URLSearchParams(location.search);
  const wantsWall = params.get('wall') !== '0';
  const wantsLadder = params.get('ladder') !== '0';
  const wantsPost = params.get('post') !== '0';
  const wantsStack = params.get('stack') !== '0';
  const wantsArch = params.get('arch') !== '0';
  const wantsSort = params.get('sort') !== '0';
  const wantsSpin = params.get('spin') === '1';
  /*
   * `?sh=1` gives every batch a synthetic l=1 band, and `?turn=` fixes the held camera angle.
   *
   * **The pair is the instrument and neither half is one alone.** A capture with harmonics drawn
   * once proves only that the extra texel reached the shader; what makes the colour *view*
   * dependent is that the same splats change as the camera moves, and that needs two angles with
   * everything else held. `SH_PROBE` below picks a coefficient whose sign flips between them.
   */
  const wantsSh = params.get('sh') === '1';
  /* `Number('')` is 0 and `Number(null)` is 0, so the absence has to be tested rather than the
     value: without this, every page with no `?turn=` would pin its camera at angle zero. */
  const askedTurn = params.has('turn') ? Number(params.get('turn')) : Number.NaN;
  /* A cube for measuring, rather than the elements for looking at. See `buildBulk`. */
  const bulk = Math.max(0, Number(params.get('bulk') ?? '0') || 0);
  const wantsFlat = params.get('flat') === '1';
  const wantsSeam = params.get('seam') === '1';
  const wantsAside = params.get('aside') === '1';
  const askedBudget = params.get('budget') ?? '0';

  let renderer: RendererApi;
  let created: { backend: string; reason: string };
  try {
    const made = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
    renderer = made.renderer;
    created = { backend: made.backend, reason: made.reason };
  } catch (error) {
    if (errorOut !== null) errorOut.textContent = String(error);
    return;
  }

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.1;
  camera.far = 60;

  const env = createEnvironment({
    directionalDir: [0.4, 0.8, 0.45],
    directionalColor: [0.9, 0.9, 0.95],
    ambient: [0.16, 0.17, 0.2],
    ambientGround: [0.06, 0.06, 0.07],
    emissiveGain: 1,
    nightFactor: 0,
    fogColor: BACKGROUND,
    fogDensity: 0,
  });

  /*
   * **`?budget=auto` is what turns `defaultSplatBudget` on**, and a default nothing exercises is
   * written rather than ported. It reads the renderer's own name, which is the only thing that
   * decides between the two numbers, so this page is where a weak part would show its lower one.
   */
  const budget =
    askedBudget === 'auto' ? defaultSplatBudget(renderer.rendererName) : Number(askedBudget) || 0;

  const batches: Batch[] = [];
  const capture =
    bulk > 0
      ? buildBulk(bulk, wantsFlat)
      : buildCapture(wantsWall, wantsLadder, wantsStack, wantsSh);
  if (capture.count > 0) {
    batches.push(makeBatch(renderer, capture, 'demo.splats', identity(), budget));
  }
  if (wantsArch && bulk === 0) {
    /*
     * Three placements, and each answers one question. In frame and clear of the wall is the
     * composition claim; `?seam=1` drives it into the wall so the two-order seam is visible rather
     * than described; `?aside=1` puts it well outside the frustum so `drawn` falls to zero without
     * the sorter ever being asked.
     */
    const model = wantsAside
      ? placed(0.9, 0.6, 26, 0.4, 0)
      : wantsSeam
        ? /* Big, turned most of a right angle, and centred on the wall, so a good half of the arc
             is genuinely *behind* the wall's splats and is drawn over them anyway. */
          placed(1.5, 1.25, 0, 1.2, 0)
        : /* Clear of the wall and clearly **in front** of it, so the default frame is a control
             for composition rather than an instance of the seam: batch order and depth agree, and
             `?seam=1` is the only view that shows them disagreeing. */
          placed(0.85, 0.6, 3.2, 0.5, 0.9);
    batches.push(makeBatch(renderer, buildArch(wantsSh), 'demo.splats.arch', model, budget));
  }

  /* Standing through the wall: half in front of z = 0 and half behind, so one box proves both
     that a splat behind it is hidden and that a splat in front of it is not. */
  const post: MeshHandle | null = wantsPost
    ? renderer.createMesh(
        new MeshBuilder().addBox([1.1, 0.9, 0], [0.22, 1.4, 0.6], [0.75, 0.72, 0.66], 0).build(),
      )
    : null;
  const postModel = identity();

  renderer.resize();
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);

  let frame = 0;
  /* A ring of inter-frame gaps, so the readout is a mean rather than whichever frame was last. */
  const frameSamplesMs = new Float64Array(FRAME_SAMPLES);
  let frameSampleAt = 0;
  let frameSamplesFilled = 0;
  let lastFrameStamp = 0;
  let meanFrameMs = 0;

  function renderFrame(): void {
    /*
     * **A bulk run keeps turning, because a held camera measures a driver's idea of a repeated
     * frame rather than the work.** Everything else on this page holds, which is what makes it a
     * control; `?bulk=` is the one mode that is a measurement rather than a picture.
     */
    const held = Math.min(frame, HOLD_AT);
    /* `?turn=` fixes the angle outright, which is what lets two captures differ in the camera and
       in nothing else. Without it the angle is a function of the frame, as it always was. */
    const turn = Number.isFinite(askedTurn)
      ? askedTurn
      : wantsSpin || bulk > 0
        ? frame * 0.006
        : held * 0.004;
    camera.position[0] = Math.sin(turn) * 7.5;
    camera.position[1] = 1.6;
    camera.position[2] = Math.cos(turn) * 7.5;
    camera.lookAt(0, 0.6, 0);
    camera.updateMatrices(aspect());

    for (const batch of batches) {
      if (batch.data.count === 0) continue;
      /* First, because it is what decides visibility for everything below it. */
      batch.pass.setView({
        view: camera.view,
        projection: camera.projection,
        widthPx: canvas.width,
        heightPx: canvas.height,
      });

      if (!wantsSort) {
        batch.pass.setOrder(batch.unsorted, batch.data.count);
        batch.drawn = batch.data.count;
        continue;
      }

      /* **The cull is read before the sort is asked for**, which is where the saving is: a batch
         out of frame costs a linear pass over every splat it has, in a worker, for nothing. */
      if (!batch.pass.visible) {
        batch.drawn = 0;
        continue;
      }

      /* The camera in this batch's own space, so one sorter serves one batch. */
      resolveSplatView(camera.view, batch.model, batch.local);
      batch.sorter.frame(batch.local);
      const order = batch.sorter.order;
      /* Uploaded when a new one lands and not every frame: four bytes a splat is 4 MB at a
         million, and paying that per frame is the cost the scheduler exists to avoid. */
      if (order !== null && batch.sorter.version !== batch.uploaded) {
        batch.pass.setOrder(order, batch.sorter.drawCount);
        batch.uploaded = batch.sorter.version;
      }
      batch.drawn = order === null ? 0 : batch.sorter.drawCount;
    }

    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    if (post !== null) renderer.drawMesh(post, postModel);
    /* The documented slot: after the meshes, before anything additive. */
    for (const batch of batches) renderer.drawPass(batch.handle);
    renderer.endFrame();
  }

  function loop(): void {
    frame++;
    /* `performance.now` rather than a clock this page owns: the gap between frames is the thing
       being measured, and it is the browser's to report. Only read in the measuring mode. */
    if (bulk > 0) {
      const now = performance.now();
      if (lastFrameStamp > 0) {
        frameSamplesMs[frameSampleAt] = now - lastFrameStamp;
        frameSampleAt = (frameSampleAt + 1) % FRAME_SAMPLES;
        if (frameSamplesFilled < FRAME_SAMPLES) frameSamplesFilled++;
      }
      lastFrameStamp = now;
      let total = 0;
      for (let at = 0; at < frameSamplesFilled; at++) total += frameSamplesMs[at] ?? 0;
      meanFrameMs = frameSamplesFilled > 0 ? total / frameSamplesFilled : 0;
    }
    renderFrame();
    const total = batches.reduce((sum, batch) => sum + batch.data.count, 0);
    const drawn = batches.reduce((sum, batch) => sum + batch.drawn, 0);
    const culled = batches.filter((batch) => !batch.pass.visible).length;
    stats.textContent =
      `${created.backend} · ${created.reason} · ${batches.length} batch(es) · ` +
      `${drawn} of ${total} splats${budget > 0 ? ` · budget ${budget}/batch` : ''}` +
      `${culled > 0 ? ` · ${culled} culled` : ''}` +
      `${wantsSort ? '' : ' · UNSORTED'}${wantsPost ? ' · post' : ''}` +
      `${wantsSh ? ' · sh1' : ''}${Number.isFinite(askedTurn) ? ` · turn ${askedTurn}` : ''}` +
      `${bulk > 0 ? ` · ${wantsFlat ? 'FLAT' : 'sized'} · ${meanFrameMs.toFixed(3)} ms mean of ${frameSamplesFilled}` : ''}` +
      ` · frame ${Math.min(frame, HOLD_AT)}`;
    /*
     * **Settled means the order this frame drew is the order the held camera wants**, which is
     * stricter than "a sort has landed" and the difference is measurable. With a budget the sort
     * chooses *which* splats are drawn, not merely their order, so a page that stopped at the
     * first landed sort photographed whichever sort the worker happened to finish first — and two
     * runs of one build differed by tens of thousands of pixels. The camera is fixed from
     * `HOLD_AT`, so at most one more sort is wanted after that; once it has landed and been
     * uploaded, `frame` asks for nothing further and this converges.
     */
    const settled = (batch: Batch): boolean =>
      batch.data.count === 0 ||
      !batch.pass.visible ||
      (!batch.sorter.sorting &&
        batch.sorter.order !== null &&
        batch.uploaded === batch.sorter.version);
    /*
     * A bulk run reports once the ring of samples is full, which is the point at which the mean
     * means anything; every other mode reports the frame it holds on. Returned before the settle
     * check because that check does not apply here — a measuring run never stops turning, so its
     * frame counter passes `SETTLE_LIMIT` as a matter of course and the marker would say
     * "unsettled" about a run that is doing exactly what it was asked to.
     */
    if (bulk > 0) {
      if (frameSamplesFilled >= FRAME_SAMPLES) {
        (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
      }
      requestAnimationFrame(loop);
      return;
    }

    const gaveUp = frame >= SETTLE_LIMIT;
    const ready = !wantsSort || gaveUp || batches.every(settled);
    if (gaveUp) stats.textContent += ' · UNSETTLED';
    if (frame >= HOLD_AT && ready && !wantsSpin) {
      /*
       * **The page holds, and says so once.** The camera's angle is a function of the frame, so a
       * measuring script that photographs one frame and reads numbers from another gets two
       * different views — which is the confusion `pointshadow.html` paid for.
       */
      (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
      return;
    }
    requestAnimationFrame(loop);
  }

  loop();
}

void main();
