/**
 * A room lit by nothing but what bounces off one wall.
 *
 * **This is the page that says whether the feature does anything**, and nothing before it could.
 * Every gate the indirect light has passed so far says the same kind of thing: two copies of an
 * expression agree, or the eighteen scenes are unchanged with the flag off. None of that is a
 * picture being lit, and Wave 4A's own recorded failure is a phantom surface that passed 111,907
 * parity samples and was found by looking.
 *
 *     /bounce.html?backend=webgpu&indirect=0    the control: no bounce, so the far wall is ambient
 *     /bounce.html?backend=webgpu&indirect=1    the measurement
 *
 * **The far wall faces away from the sun**, so no direct light reaches it at any angle: `N·L` is
 * negative there and the shading drops the directional term entirely. With the ambient floor set
 * very low, what is left on that wall is whatever arrived by bouncing.
 *
 * **What it found is not what it was written expecting.** With the flag *off* the far wall is
 * already lit — because the rasterised probe bake captures the whole room from each probe and its
 * irradiance level carries the red wall's light across. The engine has bounced light for as long as
 * it has had a probe grid. What Wave 4A set out to do is bounce it *without* rasterising six faces
 * a probe, and the traced grid measures **66.0/11.7/11.5 at a red-over-blue ratio of 5.7** against
 * the rasterised **99.1/67.3/65.4 at 1.5** — two thirds of the light and nearly four times the
 * saturation, because a rasterised bake's irradiance carries the whole room's white with it.
 *
 * **It measured a thirty-fifth of that until 2026-09-18**, and the cause was here rather than in
 * the engine: `boxField` sampled each slab `n` cubed over a box that is not a cube, which gives
 * oblong voxels, and a source is read along one step on all three axes. Every slab was therefore
 * read at its own corner and the composed field held almost no room — 98.9% of every probe's rays
 * left a *closed* room, which `scripts/bake-census.mjs` is what counted. `assertCubicVoxels` now
 * refuses a source shaped that way rather than composing nothing and saying nothing.
 *
 * The comparison is the page's output; `scripts/bounce-check.mjs` asserts only the invariants a
 * bounce must obey either way, because a threshold picked to pass would be worth nothing.
 *
 * **The colour is the measurement and the brightness is not.** A feature that merely raised the
 * ambient would brighten the far wall too, and would brighten it *grey*. What only a bounce can do
 * is carry the red wall's hue onto a wall that is painted white — so this reports the far wall's
 * mean channels and the red-to-blue ratio between them, and `scripts/bounce-check.mjs` compares
 * that ratio across the two runs.
 *
 * **It also reports the frame the wall settles on**, which is the honest second half of what this
 * costs: `probeUpdateSchedule` refreshes five probes a frame, so a grid comes round in
 * `ceil(layers / 5)` frames and the direction set turns on every pass. A feature that takes two
 * seconds to converge is a different feature from one that takes four frames, and a millisecond
 * figure alone does not say which this is.
 *
 * `scripts/bounce-check.mjs` reads `__bounceCheck`. Nothing here is engine API and nothing under
 * `packages/*​/src` may import it.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { FieldSource, MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Black, so anything on the far wall came from the room rather than from the clear colour. */
const CLEAR: Vec3 = [0, 0, 0];

/** Half-extents of the room, in metres. Four by three by four is a room rather than a corridor. */
const ROOM: [number, number, number] = [2, 1.5, 2];

/** How thick a wall is. Thin enough to be a wall, thick enough for its field to resolve. */
const WALL = 0.2;

/**
 * Frames drawn before the reading is taken.
 *
 * Enough for a 64-probe grid to come round at five a frame, several times over: the first pass
 * fills every probe, and the passes after it are what the turning direction set converges with.
 */
const FRAMES = 240;

/** How much a channel may move between frames and still count as settled, out of 255. */
const SETTLE_LEVEL = 1;

/** Frames in a row that have to be within that, so one still frame is not read as convergence. */
const SETTLE_RUN = 8;

/**
 * The frame the red wall becomes blue.
 *
 * Halfway, so each half has as long to settle as the other and the two readings are comparable.
 * Nothing else about the scene changes: same geometry, same sun, same probes.
 */
const REPAINT_AT = 120;

interface Reading {
  r: number;
  g: number;
  b: number;
}

interface Result {
  /** Whether the grid was rasterised once before the trace began. `?seed=0` says it was not. */
  seeded: boolean;
  backend: string;
  /** Why that backend, which is the first thing to read when a bounce measures nothing. */
  reason: string;
  indirect: boolean;
  /** The far wall's mean channels just before the wall it faces was repainted blue. */
  wall: Reading;
  /** And at the last frame, a hundred and twenty frames after it was repainted. */
  repainted: Reading;
  /**
   * How much of the far wall's light is blue rather than red, after the repaint.
   *
   * **This is what separates a grid that follows from one that does not.** Both grids put red on
   * that wall while the wall opposite was red; only a grid that is still being computed puts blue
   * on it afterwards. A rasterised bake that nobody re-ran keeps sending red for ever.
   */
  followed: number;
  /** The bright wall's, for scale: the bounce cannot be brighter than what it bounced off. */
  source: Reading;
  /** And the same wall once it is blue, so the two halves are never compared across each other. */
  repaintedSource: Reading;
  /** The far wall's red divided by its blue. A grey wall is 1; a wall carrying red is above it. */
  ratio: number;
  /** The frame the far wall stopped moving by more than `SETTLE_LEVEL`, or -1 if it never did. */
  settledAt: number;
  /**
   * Frames after the repaint before the far wall had made nine tenths of its change to blue.
   *
   * **This is the latency a light change costs**, which is the number the feature is sold on and
   * the one `settledAt` cannot give: a stochastic estimator never stops moving by a level, so
   * "settled" reads -1 for ever while the picture has been right for two hundred frames. Measured
   * against the *final* blue rather than a threshold, so it is a fraction of whatever the answer
   * turned out to be rather than a figure chosen to pass.
   */
  followedIn: number;
  /**
   * What one refresh of the grid costs on the device, in milliseconds, or -1 where unmeasured.
   *
   * `PROBES_PER_FRAME` probes traced and convolved, which is what a frame pays — not a whole grid.
   * The mean over the run rather than the last frame, because a single refresh is a few
   * microseconds and the clock's own resolution shows through on one reading.
   */
  bakeMs: number;
  frames: number;
  error: string | null;
}

/**
 * A box's exact field on a grid, which is what the room's walls are traced against.
 *
 * **Sampled at one step with a count an axis, and the first version was not.** It took `n` cubed
 * over a box that is not a cube, which gives oblong voxels — and `sourceAt` derives one step from
 * the x axis and uses it on all three, because that is what `bakeObjectSdf` produces. So every one
 * of these slabs was read at its own corner and the composed field held almost no room at all: a
 * census of the bake counted **98.9% of every probe's rays leaving a closed room**, which is where
 * the bounce's missing light went. `assertCubicVoxels` now refuses a source shaped that way, so
 * this is the shape that gets past it as well as the shape that is right.
 */
function boxField(half: [number, number, number], pad: number, step: number): FieldSource {
  const low: [number, number, number] = [-half[0] - pad, -half[1] - pad, -half[2] - pad];
  const dims = [0, 1, 2].map((axis) => Math.round((2 * ((half[axis] as number) + pad)) / step) + 1);
  const [nx, ny, nz] = dims as [number, number, number];
  const field = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const p = [ix, iy, iz].map((whole, axis) => (low[axis] as number) + whole * step);
        const gap = [
          Math.abs(p[0] as number) - half[0],
          Math.abs(p[1] as number) - half[1],
          Math.abs(p[2] as number) - half[2],
        ];
        const outside = Math.hypot(
          Math.max(gap[0] as number, 0),
          Math.max(gap[1] as number, 0),
          Math.max(gap[2] as number, 0),
        );
        const inside = Math.min(Math.max(gap[0] as number, gap[1] as number, gap[2] as number), 0);
        field[ix + nx * (iy + ny * iz)] = outside + inside;
      }
    }
  }
  return {
    field,
    dims: [nx, ny, nz],
    /* The box the counts actually span, so the step `sourceAt` derives is the step used here. */
    bounds: new Float32Array([
      low[0],
      low[1],
      low[2],
      low[0] + (nx - 1) * step,
      low[1] + (ny - 1) * step,
      low[2] + (nz - 1) * step,
    ]),
  };
}

/** A placement with no rotation, column-major, which is all a room of slabs needs. */
function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** The mean of a rectangle of the frame, which is how a wall is read. */
function meanOf(
  pixels: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Reading {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at3 = (y * width + x) * 4;
      r += pixels[at3] as number;
      g += pixels[at3 + 1] as number;
      b += pixels[at3 + 2] as number;
      count += 1;
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0 };
  return { r: r / count, g: g / count, b: b / count };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const asked = new URLSearchParams(location.search);
  const indirect = asked.get('indirect') === '1';
  /*
   * **Whether the grid is rasterised once before the trace starts**, which is what Wave 4's
   * criterion of "no baked lighting" turns on. `?seed=0` skips it, so the probes begin at nothing
   * and every joule in the picture was computed by the trace.
   */
  const seed = asked.get('seed') !== '0';
  /*
   * **And whether there is a sun at all**, which is what tells undefined memory apart from a
   * feedback loop. A grid that reads its own output back has a fixed point; a texture nobody
   * wrote has a value. Only the first of the two goes dark when the light is switched off.
   */
  const sun = asked.get('sun') !== '0';

  /*
   * **A probe array is what the traced light is written into**, so the profile has to have one —
   * `reflectionProbeSize` is what decides that and it is construction-time. Asked for here rather
   * than left to a default so the two runs differ in one thing only.
   */
  const created = await createRenderer(
    canvas,
    { reflectionProbeSize: 64, ...askedQuality() },
    /*
     * **`preferWebGpu` explicitly, because `DEV_RENDERER` does not set it and the default is not
     * enough.** `createRenderer` only *attempts* WebGPU when the option is `true` or the query
     * string it was handed forces it, and a page's own `?backend=webgpu` never reaches it. Without
     * this the page built WebGL2, printed the refusal, and measured a room with no bounce in it
     * while appearing to work. `demo/giFieldRig.ts` asks the same way for the same reason.
     */
    { ...DEV_RENDERER, preferWebGpu: true },
  );
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /*
   * The room, as six slabs. White everywhere except the one wall that faces the sun, which is red
   * — so anything red anywhere else in the room arrived by bouncing off it.
   */
  const white: Vec3 = [0.82, 0.82, 0.82];
  const red: Vec3 = [0.9, 0.06, 0.06];
  /**
   * Two rooms, identical but for the colour of the wall the sun lands on.
   *
   * **The swap is the measurement this page ended up being about.** A rasterised probe bake is
   * already a correct one-bounce solution for a room that never changes — it convolves the real
   * room from where each probe stands, which is the answer a trace can only approximate. What a
   * rasterised bake cannot do is *follow*: six face draws a probe is 108 draws for this grid, so a
   * scene that re-bakes when the light changes pays a hitch, and one that does not keeps sending
   * the light it had. A traced grid refreshes five probes a frame for a compute dispatch.
   *
   * So after the room has settled the red wall becomes blue, and what is measured is which grid
   * notices.
   */
  const builder = new MeshBuilder();
  /* Floor and ceiling. */
  builder.addBox([0, -ROOM[1], 0], [ROOM[0], WALL, ROOM[2]], white);
  builder.addBox([0, ROOM[1], 0], [ROOM[0], WALL, ROOM[2]], white);
  /* The wall behind the camera is left out, so the room can be looked into. */
  builder.addBox([0, 0, -ROOM[2]], [ROOM[0], ROOM[1], WALL], white);
  /* The bright wall, on the left, facing the sun. */
  builder.addBox([-ROOM[0], 0, 0], [WALL, ROOM[1], ROOM[2]], red);
  /* And the far wall, on the right, whose normal points away from the sun. */
  builder.addBox([ROOM[0], 0, 0], [WALL, ROOM[1], ROOM[2]], white);
  const room: MeshHandle = renderer.createMesh(builder.build());

  const blue: Vec3 = [0.06, 0.1, 0.9];
  const after = new MeshBuilder();
  after.addBox([0, -ROOM[1], 0], [ROOM[0], WALL, ROOM[2]], white);
  after.addBox([0, ROOM[1], 0], [ROOM[0], WALL, ROOM[2]], white);
  after.addBox([0, 0, -ROOM[2]], [ROOM[0], ROOM[1], WALL], white);
  after.addBox([-ROOM[0], 0, 0], [WALL, ROOM[1], ROOM[2]], blue);
  after.addBox([ROOM[0], 0, 0], [WALL, ROOM[1], ROOM[2]], white);
  const repainted: MeshHandle = renderer.createMesh(after.build());

  /*
   * What the indirect light may be traced against: the same six slabs, declared.
   *
   * **A field a slab rather than one field for the room**, because a field is a box in its own
   * object space and the room is not a box — it is a hollow one, and the inside of a hollow box is
   * where every probe stands. Six placed slabs compose to exactly the room's surfaces.
   */
  /*
   * **Ten centimetres, so a wall forty thick is four voxels rather than one.** The world field's
   * finest cascade steps 0.167 m here, so a source finer than this buys nothing; a source coarser
   * than the wall would smear it into the room it is supposed to bound.
   */
  const slabStep = 0.1;
  const wallX = boxField([WALL, ROOM[1], ROOM[2]], 0.4, slabStep);
  const wallZ = boxField([ROOM[0], ROOM[1], WALL], 0.4, slabStep);
  const deck = boxField([ROOM[0], WALL, ROOM[2]], 0.4, slabStep);
  /*
   * **Each slab declares its own colour**, which is what the bounce carries: a ray that lands on
   * the left wall has to know it is red, because what leaves a surface is the light reaching it
   * times its albedo. The repaint below changes this list's one red entry to blue, exactly as it
   * changes the mesh.
   */
  const fields = (wall: Vec3): { source: FieldSource; model: Float32Array; albedo: Vec3 }[] => [
    { source: deck, model: at(0, -ROOM[1], 0), albedo: white },
    { source: deck, model: at(0, ROOM[1], 0), albedo: white },
    { source: wallZ, model: at(0, 0, -ROOM[2]), albedo: white },
    { source: wallX, model: at(-ROOM[0], 0, 0), albedo: wall },
    { source: wallX, model: at(ROOM[0], 0, 0), albedo: white },
  ];

  const env = createEnvironment();
  /*
   * **Almost no ambient, which is the whole point of the page.** The engine's default hemispheric
   * ambient would light the far wall grey whatever the indirect light did, and the difference this
   * page exists to show would be a few levels on top of a bright surface.
   */
  env.ambient = [0.01, 0.01, 0.012];
  env.ambientGround = [0.005, 0.005, 0.006];
  /*
   * **Four times a nominal sun, and both runs get it.** The traced bounce puts single levels on the
   * far wall, and a difference of one level out of 255 cannot be told from rounding — so the signal
   * is raised until it can be read rather than the threshold lowered until it passes. The control
   * is lit by the same sun, so nothing about the comparison moves.
   */
  env.directionalColor = sun ? [4, 3.88, 3.68] : [0, 0, 0];
  /*
   * **Toward the sun, not the way the light travels**, which is this engine's convention and which
   * the first run of this page got backwards: the sun at `[-1, …]` lit the wall the page calls far
   * and left the red one at two levels out of 255. A surface is lit when its normal faces the sun,
   * so lighting the red wall at -X — whose inward normal is +X — needs the sun at +X.
   *
   * **And it has to reach in through the opening, which took a measurement to see.** A closed room
   * with the sun outside it is dark, and the traced grid says so because it marches towards the sun
   * and finds the far wall in the way. The rasterised bake lit that room anyway — it draws the sun
   * on every face whose normal points at it, and this profile has directional shadows off — so the
   * two paths disagreed about whether the room was closed, and the traced one was right. The `z`
   * term angles the sun in through the wall this room does not have, which is the one the camera
   * looks in through.
   */
  env.directionalDir = [0.75, 0.2, 0.63];

  const camera = new Camera();
  camera.fovYDeg = 60;
  camera.near = 0.1;
  camera.far = 60;
  /*
   * **Inside the room, and the first version stood outside it.** The world field's cascades are
   * centred on the camera, so a camera five metres back put the room at the edge of the innermost
   * cascade and every probe traced against a coarse one — which reads as a bounce that is too red
   * and will not follow, because most rays escaped the good field and fell back to what the probe
   * volume last held. Standing in the room one is lighting is also what a game does.
   */
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 1.5;
  camera.lookAt(0, 0, -2);

  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const model = at(0, 0, 0);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const maybeContext = mirror.getContext('2d', { willReadFrequently: true });
  if (maybeContext === null) throw new Error('no 2d context to read the frame through');
  const context: CanvasRenderingContext2D = maybeContext;

  /* Read inside the frame that drew it: a WebGPU canvas has a current texture only until then. */
  function grab(): Uint8ClampedArray {
    context.clearRect(0, 0, mirror.width, mirror.height);
    context.drawImage(canvas, 0, 0);
    return context.getImageData(0, 0, mirror.width, mirror.height).data.slice();
  }

  const result: Result = {
    seeded: seed,
    backend: created.backend,
    reason: created.reason,
    indirect,
    wall: { r: 0, g: 0, b: 0 },
    repainted: { r: 0, g: 0, b: 0 },
    followed: 0,
    source: { r: 0, g: 0, b: 0 },
    repaintedSource: { r: 0, g: 0, b: 0 },
    ratio: 0,
    settledAt: -1,
    followedIn: -1,
    bakeMs: -1,
    frames: FRAMES,
    error: null,
  };

  /* Where the two walls are on screen, as fractions, so a resize does not move the reading. */
  const width = mirror.width;
  const height = mirror.height;
  const band = (from: number, to: number): [number, number] => [
    Math.round(width * from),
    Math.round(width * to),
  ];
  /*
   * **The outer edges, because the camera stands in the room.** The wall the camera faces fills
   * the middle of the frame and the two side walls are what is left at the edges — a reading at a
   * fifth of the way in measured the back wall, which the sun reaches through the opening, and
   * reported a bright grey that had nothing to do with any bounce.
   */
  const [farFrom, farTo] = band(0.87, 0.96);
  const [litFrom, litTo] = band(0.04, 0.13);
  const rowFrom = Math.round(height * 0.4);
  const rowTo = Math.round(height * 0.6);

  /*
   * **The grid is declared here, and rasterised once unless `?seed=0` says not to.**
   *
   * The capture used to be mandatory and is not: since the trace evaluates the sun at what it hits,
   * a grid starting at black climbs away from black on its own, and `?seed=0` measures exactly the
   * same room — 66.0/11.7/11.5, the same follow. It read 209 grey for as long as it did because a
   * flat bind group built before anything was baked holds the one-texel white `uEnvironment`
   * stand-in for ever, which was twice mistaken for a fixed point and for undefined memory.
   *
   * It is kept on by default because the control this page compares against *is* the rasterised
   * grid, and `scripts/bounce-check.mjs` runs the unseeded case beside it as the assertion that
   * Wave 4's "no baked lighting" is met literally rather than nearly.
   */
  const spacing = 1.2;
  renderer.setProbeGrid({
    origin: [-ROOM[0] + spacing, -ROOM[1] + spacing, -ROOM[2] + spacing],
    spacing: [spacing, spacing, spacing],
    counts: [3, 2, 3],
  });
  if (seed) {
    renderer.bakeProbeGrid(CLEAR, (probeCamera) => {
      renderer.bindMeshPass(probeCamera, env);
      renderer.drawMesh(room, model);
    });
  }

  const redFields = fields(red);
  const blueFields = fields(blue);

  let frame = 0;
  let steady = 0;
  let bakeTotal = 0;
  let bakeCount = 0;
  /* The far wall's blue, frame by frame after the repaint, so the latency is read backwards. */
  const blueTrack: number[] = [];
  let previous: Reading | null = null;

  function step(): void {
    if (frame >= FRAMES) {
      result.bakeMs = bakeCount > 0 ? bakeTotal / bakeCount : -1;
      /*
       * **Read backwards from what it settled on**, because nine tenths of the change is only
       * knowable once the change has finished. The first frame at or past that level, counted
       * from the repaint.
       */
      const start = blueTrack[0] ?? 0;
      const end = blueTrack[blueTrack.length - 1] ?? 0;
      const target = start + (end - start) * 0.9;
      /*
       * **A wall that never changed followed nothing, and reports -1 rather than 0.** The
       * rasterised grid keeps the light it was baked under, so its first frame after the repaint
       * already holds its last one's value and every threshold is met immediately — a latency of
       * zero, which is the opposite of what happened.
       */
      result.followedIn =
        Math.abs(end - start) < SETTLE_LEVEL
          ? -1
          : blueTrack.findIndex((blue) => (end >= start ? blue >= target : blue <= target));
      (window as unknown as { __bounceCheck: Result }).__bounceCheck = result;
      stats.textContent =
        `${created.backend} · indirect ${indirect ? 'on' : 'off'} · ` +
        `far wall ${result.wall.r.toFixed(1)}/${result.wall.g.toFixed(1)}/${result.wall.b.toFixed(1)} · ` +
        `red over blue ${result.ratio.toFixed(3)} · settled at frame ${String(result.settledAt)} · ` +
        `followed in ${String(result.followedIn)} frames · ` +
        `refresh ${result.bakeMs < 0 ? 'unmeasured' : `${result.bakeMs.toFixed(3)} ms`}`;
      return;
    }

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    /* Redeclared every frame, because the queue is emptied at every `beginFrame`. */
    if (indirect) {
      for (const field of frame < REPAINT_AT ? redFields : blueFields) {
        renderer.addDistanceField(field.source, field.model, field.albedo);
      }
    }
    renderer.drawMesh(frame < REPAINT_AT ? room : repainted, model);
    renderer.endFrame();

    /*
     * **Averaged over the run**, because one refresh is a few microseconds and a single reading
     * shows the clock's own resolution rather than the work. Read after `endFrame` submitted the
     * encoder that recorded the stamps, which is the contract `readDistanceFieldTimings` has.
     */
    renderer.readDistanceFieldTimings();
    const refresh = renderer.indirectBakeMs;
    if (refresh !== null && refresh > 0) {
      bakeTotal += refresh;
      bakeCount += 1;
    }

    const pixels = grab();
    const wall = meanOf(pixels, width, farFrom, rowFrom, farTo, rowTo);
    /* Per half, because the wall it measures is repainted and the two are not comparable. */
    const lit = meanOf(pixels, width, litFrom, rowFrom, litTo, rowTo);
    if (frame < REPAINT_AT) result.source = lit;
    else result.repaintedSource = lit;
    if (frame < REPAINT_AT) {
      /* The red half: what each grid puts on the far wall while the wall opposite is red. */
      result.wall = wall;
      result.ratio = wall.b > 0 ? wall.r / wall.b : 0;
    } else {
      /* And the blue half, where only a grid still being computed changes its answer. */
      result.repainted = wall;
      result.followed = wall.r > 0 ? wall.b / wall.r : 0;
      blueTrack.push(wall.b);
    }

    if (previous !== null) {
      /* The repaint is a step, not a drift: convergence is measured within each half. */
      if (frame === REPAINT_AT) {
        steady = 0;
        previous = wall;
        frame += 1;
        requestAnimationFrame(step);
        return;
      }
      const moved = Math.max(
        Math.abs(wall.r - previous.r),
        Math.abs(wall.g - previous.g),
        Math.abs(wall.b - previous.b),
      );
      if (moved <= SETTLE_LEVEL) {
        steady += 1;
        if (steady >= SETTLE_RUN && result.settledAt < 0) result.settledAt = frame - SETTLE_RUN;
      } else {
        steady = 0;
        /* A wall that moves again was not settled, whatever it did before. */
        result.settledAt = -1;
      }
    }
    previous = wall;

    frame += 1;
    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const target = document.getElementById('error');
  if (target !== null) target.textContent = message;
  (window as unknown as { __bounceCheck: Result }).__bounceCheck = {
    seeded: false,
    backend: '',
    reason: '',
    indirect: false,
    wall: { r: 0, g: 0, b: 0 },
    repainted: { r: 0, g: 0, b: 0 },
    followed: 0,
    source: { r: 0, g: 0, b: 0 },
    repaintedSource: { r: 0, g: 0, b: 0 },
    ratio: 0,
    settledAt: -1,
    followedIn: -1,
    bakeMs: -1,
    frames: 0,
    error: message,
  };
});
