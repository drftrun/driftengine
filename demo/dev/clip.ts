/**
 * A real clip through every capture stage, timed, and the `.drft` it becomes.
 *
 * **`capture.html` builds its room analytically; this one is handed a video.** That difference is
 * the whole of Wave 6's Task 21: every stage was written, tested and measured on synthetic scenes
 * with known answers, and nothing had ever fed the chain a recording. A stage that is correct on a
 * ray-cast box and useless on a phone's footage is a stage that passes its own tests.
 *
 * **Nothing here is committed.** `demo/dev/public/` is gitignored, and a clip is the maintainer's
 * own footage — the arrangement `plans/notes/2026-09-17-wave6-weights-proposal.md` settled on:
 * the repository records a hash and never the bytes. Symlink a clip and the converted models in:
 *
 * ```sh
 * mkdir -p demo/dev/public/capture
 * ln -s "$PWD/models/capture/depth-anything-3-small.drft" demo/dev/public/capture/
 * ln -s /path/to/your.mp4 demo/dev/public/capture/clip-a.mp4
 * npm run demo                 # then /clip.html?clip=clip-a
 * ```
 *
 * **The timings are the point, not the picture.** The plan says this capability's honest
 * description is how long each stage took and on what, so every stage is timed separately and the
 * table is written into `#stats` where `shots.mjs` and a person both read it. A reconstruction that
 * looks right and takes four minutes a clip is a different capability from one that takes four
 * seconds, and only one of them is worth a row.
 *
 * **Poses come from the depth model rather than from `estimatePoses`.** Depth Anything 3 answers
 * extrinsics, intrinsics, depth and a confidence together for a whole clip at once, which is why
 * the weights proposal chose it: one Apache-2.0 model covers what would otherwise be a
 * structure-from-motion stage and a monocular prior that have to agree with each other. The
 * classical path is still there and is what a clip with no usable model would take.
 *
 * `?clip=` names the file, `?frames=` the budget, `?size=` the model's working size, `?nav=0`
 * skips the navigation bake, and `?hold=` freezes the drawing the way every other page here does.
 */
import { DrftLoader } from '../../packages/assets/src/index';
import {
  DEPTH_ANYTHING_3,
  browserFrameSource,
  captureFile,
  collisionMesh,
  areaResize,
  createDelightOut,
  createDepthEstimator,
  createVolume,
  decimate,
  delight,
  fuseDepth,
  marchVolume,
  proposeEntities,
  segmentGeometry,
  selectFrames,
  type DelightView,
  type DepthEstimate,
  type RawFrame,
  type SurfaceView,
  type Volume,
} from '../../packages/capture/src/index';
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';
import { createGraphRunner } from '../../packages/core/src/render/inference/runner';
import { readDrft } from '../../packages/drft/src/index';
import {
  buildContours,
  buildPolyMesh,
  buildRegions,
  voxeliseWalkable,
} from '../../packages/nav/src/index';
import {
  graphForDevice,
  graphFromStored,
  type GraphTensor,
  type NetworkGraph,
  type WeightSource,
} from '../../packages/texture/src/index';
import {
  BODY_STATIC,
  CharacterController,
  PhysicsWorld,
  meshShape,
} from '../../packages/physics/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** The middle of a bounding box along one axis. */
function middleOf(box: { low: Vec3; high: Vec3 }, axis: number): number {
  return ((box.low[axis] as number) + (box.high[axis] as number)) / 2;
}

const BACKGROUND: Vec3 = [0.05, 0.055, 0.065];
const asked = new URLSearchParams(location.search);
const clipName = asked.get('clip') ?? 'clip-a';
const frameBudget = Number(asked.get('frames') ?? '8');
/**
 * The model's working size, and it is not free to choose.
 *
 * A frame is cut into whole patches of 14, in both axes, and `prepare.ts` refuses a size that does
 * not divide — it will not invent the cubic resize that would be needed to stretch to one. For a
 * 16:9 clip that means `size × 9/16` must also be a multiple of 14: **448 × 252** is 32 × 18
 * patches and is the closest such size to the 518 these weights were trained at. 336 is not — it
 * gives 336 × 189, and 189 is not a multiple of 14.
 */
const modelSize = Number(asked.get('size') ?? '448');
/**
 * Every Nth frame instead of choosing by motion, and by default that is what happens.
 *
 * **Choosing by motion costs a decode of the whole clip.** `selectFrames` compares each frame with
 * the one before it, so it walks all of them — and on the browser path a frame is reached by
 * setting `currentTime` and awaiting `seeked`, which measured **445 seconds for 1401 frames** here:
 * seven and a half minutes to pick six. That is a property of seeking a video element, not of the
 * rule, and it is the single largest cost in the browser path by two orders of magnitude.
 * `?every=0` asks for motion anyway and is worth the wait on a short clip.
 */
const everyAsked = asked.get('every');
const wantNav = asked.get('nav') !== '0';

const stats = document.getElementById('stats') as HTMLElement;
const error = document.getElementById('error') as HTMLElement;
const canvas = document.getElementById('scene') as HTMLCanvasElement;

/** Every stage's wall clock, in the order it ran. The capability row is written from this. */
const timings: { stage: string; ms: number; note: string }[] = [];

async function timed<T>(stage: string, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  const value = await run();
  timings.push({ stage, ms: performance.now() - started, note: '' });
  return value;
}

function note(text: string): void {
  const last = timings.at(-1);
  if (last !== undefined) timings[timings.length - 1] = { ...last, note: text };
}

function report(): void {
  const total = timings.reduce((sum, one) => sum + one.ms, 0);
  stats.textContent = [
    ...timings.map(
      ({ stage, ms, note: said }) =>
        `${stage.padEnd(14)} ${(ms / 1000).toFixed(2).padStart(7)} s   ${said}`,
    ),
    `${'total'.padEnd(14)} ${(total / 1000).toFixed(2).padStart(7)} s`,
  ].join('\n');
}

/**
 * The device, as a `GraphRun` the capture package takes.
 *
 * One runner per graph, kept: building one compiles every kernel the graph needs, and a clip runs
 * the same graph once. The map is what makes a second clip in the same page free.
 */
function deviceRun(device: GPUDevice, half: boolean) {
  const runners = new Map<NetworkGraph, Awaited<ReturnType<typeof createGraphRunner>>>();
  return async (
    graph: NetworkGraph,
    inputs: ReadonlyMap<string, Float32Array>,
  ): Promise<ReadonlyMap<string, Float32Array>> => {
    let runner = runners.get(graph);
    if (runner === undefined) {
      runner = await createGraphRunner({ device, half }, graphForDevice(graph));
      runners.set(graph, runner);
    }
    return runner.run(inputs);
  };
}

/** The weights of a converted model's first graph, as the architecture reads them. */
function weightsOf(file: ArrayBuffer): WeightSource {
  const { graphs } = readDrft(file);
  const stored = graphs[0];
  if (stored === undefined) throw new Error('the model file holds no graph');
  const tensors: ReadonlyMap<string, GraphTensor> = graphFromStored(stored).tensors;
  return { get: (name) => tensors.get(name), names: () => tensors.keys() };
}

/**
 * A depth estimate as the fusion stage's views.
 *
 * `DepthView` carries a 3 × 3 intrinsic matrix and a confidence; `SurfaceView` wants the four
 * numbers a pinhole actually uses and a coverage. **The conversion is here rather than in either
 * package** because it is this harness's choice to treat the model's confidence as coverage —
 * which is a judgement about one model, not a fact about the format.
 */
function surfaceViews(estimate: DepthEstimate): SurfaceView[] {
  return estimate.views.map((view) => ({
    depth: view.depth,
    coverage: view.confidence,
    camera: {
      width: estimate.width,
      height: estimate.height,
      intrinsics: [
        view.intrinsics[0] as number,
        view.intrinsics[4] as number,
        view.intrinsics[2] as number,
        view.intrinsics[5] as number,
      ] as const,
      worldToCamera: Float64Array.from(view.worldToCamera),
    },
  }));
}

/**
 * A volume that covers what the views actually saw.
 *
 * **Sized from the reconstruction rather than chosen**, because a monocular clip has no scale of
 * its own and a box guessed in metres is either mostly empty or clips the room. Every believed
 * pixel is back-projected, the cloud's bounds are taken, and the grid is `resolution` samples along
 * its longest side — so the cost is fixed whatever the clip's scale turns out to be.
 */
function volumeFor(views: readonly SurfaceView[], resolution: number): Volume {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let seen = 0;
  const point = new Float64Array(3);

  for (const view of views) {
    const { width, height, intrinsics, worldToCamera } = view.camera;
    const [fx, fy, cx, cy] = intrinsics;
    for (let pixel = 0; pixel < view.depth.length; pixel += 1) {
      const z = view.depth[pixel] as number;
      if (!(z > 0) || (view.coverage[pixel] as number) < 0.5) continue;
      const px = pixel % width;
      const py = Math.floor(pixel / width);
      if (py >= height) break;
      /* Camera space, then the inverse of a rigid world-to-camera: Rᵀ(p − t). */
      const cxz = ((px + 0.5 - cx) / fx) * z;
      const cyz = ((py + 0.5 - cy) / fy) * z;
      for (let axis = 0; axis < 3; axis += 1) {
        point[axis] =
          (worldToCamera[axis] as number) * (cxz - (worldToCamera[3] as number)) +
          (worldToCamera[4 + axis] as number) * (cyz - (worldToCamera[7] as number)) +
          (worldToCamera[8 + axis] as number) * (z - (worldToCamera[11] as number));
      }
      const [x, y, zz] = point as unknown as [number, number, number];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zz)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z > 0 ? zz : zz);
      maxZ = Math.max(maxZ, zz);
      seen += 1;
    }
  }

  if (seen === 0) throw new Error('no view produced a pixel the fusion would believe');
  /* A tenth of the span of padding, so a surface at the very edge still has samples either side. */
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const pad = Math.max(spanX, spanY, spanZ) * 0.1;
  const spacing = (Math.max(spanX, spanY, spanZ) + pad * 2) / resolution;
  const dims: [number, number, number] = [
    Math.max(2, Math.ceil((spanX + pad * 2) / spacing) + 1),
    Math.max(2, Math.ceil((spanY + pad * 2) / spacing) + 1),
    Math.max(2, Math.ceil((spanZ + pad * 2) / spacing) + 1),
  ];
  note(
    `${seen.toLocaleString()} points, ` +
      `${spanX.toFixed(2)}×${spanY.toFixed(2)}×${spanZ.toFixed(2)} m, ` +
      `grid ${dims.join('×')} at ${spacing.toFixed(3)} m`,
  );
  return createVolume(dims, [minX - pad, minY - pad, minZ - pad], spacing);
}

/** A mesh's extent. A reconstruction that came back scattered says so here before anywhere else. */
function boundsOf(positions: Float32Array): { low: Vec3; high: Vec3; said: string } {
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at + 2 < positions.length; at += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[at + axis] as number;
      low[axis] = Math.min(low[axis] as number, value);
      high[axis] = Math.max(high[axis] as number, value);
    }
  }
  const span = low.map((one, axis) => (high[axis] as number) - one);
  const middle = low.map((one, axis) => one + (span[axis] as number) / 2);
  return {
    low,
    high,
    said:
      `${span.map((one) => one.toFixed(2)).join('×')} m ` +
      `about (${middle.map((one) => one.toFixed(2)).join(', ')})`,
  };
}

async function run(): Promise<void> {
  const clip = await timed('fetch', async () => {
    const response = await fetch(`/capture/${clipName}.mp4`);
    if (!response.ok) throw new Error(`no clip at /capture/${clipName}.mp4`);
    return response.blob();
  });
  note(`${(clip.size / 1e6).toFixed(1)} MB`);

  const source = await timed('open', () => browserFrameSource(clip));
  const every =
    everyAsked === '0'
      ? undefined
      : Number(everyAsked ?? Math.max(1, Math.floor(source.frameCount() / frameBudget)));
  const kept = await timed('choose', () =>
    selectFrames(source, { budget: frameBudget, ...(every === undefined ? {} : { every }) }),
  );
  note(
    `${kept.length} of ${source.frameCount()} frames, ` +
      (every === undefined ? 'by motion' : `every ${every}`),
  );

  const frames = await timed('decode', async () => {
    const out: RawFrame[] = [];
    const probe = await source.frameAt(kept[0] as number, new Uint8Array(0));
    for (const index of kept) {
      const pixels = new Uint8Array(probe.width * probe.height * 4);
      const size = await source.frameAt(index, pixels);
      out.push({ pixels, width: size.width, height: size.height });
    }
    return out;
  });
  note(`${frames[0]?.width ?? 0}×${frames[0]?.height ?? 0}`);

  const { device, half } = await timed('device', async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) throw new Error('this browser has no WebGPU adapter');
    const supportsHalf = adapter.features.has('shader-f16');
    const got = await adapter.requestDevice({
      requiredFeatures: supportsHalf ? (['shader-f16'] as const) : [],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    return { device: got, half: supportsHalf };
  });
  note(half ? 'half precision available' : 'single precision only');

  const weights = await timed('weights', async () => {
    const file = await (await fetch('/capture/depth-anything-3-small.drft')).arrayBuffer();
    return weightsOf(file);
  });

  const estimate = await timed('depth + poses', async () => {
    const estimator = createDepthEstimator(
      DEPTH_ANYTHING_3.small,
      weights,
      deviceRun(device, half),
      { size: modelSize },
    );
    return estimator.estimate(frames);
  });
  note(`${estimate.views.length} views at ${estimate.width}×${estimate.height}`);

  const views = surfaceViews(estimate);
  const volume = await timed('volume', () => volumeFor(views, 96));
  await timed('fuse', () => {
    fuseDepth(views, volume);
  });

  const mesh = await timed('march', () => marchVolume(volume));
  note(`${mesh.indices.length / 3} triangles`);

  /* Half the triangles marching produced, which is what the showroom's own bake asks for. */
  const cleaned = await timed('decimate', () =>
    decimate(mesh, Math.max(512, Math.floor(mesh.indices.length / 6))),
  );
  const bounds = boundsOf(cleaned.positions);
  note(`${cleaned.indices.length / 3} triangles, ${bounds.said}`);

  /*
   * **Do the normals face the cameras that saw the surface?** A depth fusion from one side makes a
   * sheet, and the one thing that is certainly true of it is that its front is the side the footage
   * was shot from. A mean below zero means the surface is lit from behind wherever the clip was
   * filmed, which reads as a reconstruction that came out black — and that is the "mesh that faces
   * outwards" case this stage's plan names as its hardest.
   */
  const facing = await timed('facing', () => {
    const first = (estimate.views[0] as { worldToCamera: Float32Array }).worldToCamera;
    const eyeAt: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      eyeAt[axis] = -(
        (first[axis] as number) * (first[3] as number) +
        (first[4 + axis] as number) * (first[7] as number) +
        (first[8 + axis] as number) * (first[11] as number)
      );
    }
    let total = 0;
    let counted = 0;
    for (let at = 0; at + 2 < cleaned.positions.length; at += 3) {
      const toEye = [
        (eyeAt[0] as number) - (cleaned.positions[at] as number),
        (eyeAt[1] as number) - (cleaned.positions[at + 1] as number),
        (eyeAt[2] as number) - (cleaned.positions[at + 2] as number),
      ];
      const length = Math.hypot(toEye[0] as number, toEye[1] as number, toEye[2] as number);
      if (!(length > 0)) continue;
      total +=
        ((cleaned.normals[at] as number) * (toEye[0] as number) +
          (cleaned.normals[at + 1] as number) * (toEye[1] as number) +
          (cleaned.normals[at + 2] as number) * (toEye[2] as number)) /
        length;
      counted += 1;
    }
    return counted === 0 ? 0 : total / counted;
  });
  note(`mean normal · toward the first camera = ${facing.toFixed(3)}`);

  /*
   * **The colour, and the light taken back off it.**
   *
   * Marching fills every vertex white, so a capture with no material stage is a grey cast of the
   * room — geometrically right and unreadable, which is exactly what this page drew until now.
   * `delight` is what fixes that, and it does more than project pixels: a point seen from several
   * cameras gives several observations, whose median rejects a highlight seen from a minority of
   * them, and whose chromaticity tells a cast shadow from a dark patch of paint.
   *
   * **What it cannot do is remove a cast shadow**, which its own header says plainly: a shadowed
   * point is shadowed from every camera, and agreement is not evidence of albedo. So the
   * confidence it returns is part of the answer rather than a diagnostic, and stage 3's maturity
   * statement is written from it.
   *
   * The frames are resized to the size the depth ran at, because that is the size its cameras and
   * intrinsics are in, and de-gamma'd: the separation is multiplicative in linear light and means
   * nothing on sRGB bytes.
   */
  if (asked.get('delight') !== '0') {
    await timed('delight', () => {
      const wide = estimate.width;
      const tall = estimate.height;
      const small = new Uint8Array(wide * tall * 4);
      const delightViews: DelightView[] = frames.map((frame, at) => {
        areaResize(frame.pixels, frame.width, frame.height, 4, small, wide, tall);
        const linear = new Float32Array(wide * tall * 4);
        for (let one = 0; one < linear.length; one += 1) {
          const value = (small[one] as number) / 255;
          linear[one] =
            one % 4 === 3
              ? value
              : value <= 0.04045
                ? value / 12.92
                : Math.pow((value + 0.055) / 1.055, 2.4);
        }
        return { frame: linear, camera: (views[at] as SurfaceView).camera };
      });
      const material = createDelightOut(cleaned.positions.length / 3);
      delight(delightViews, cleaned, {}, material);
      /* Back to the colours the container carries, which the shader reads as vertex colour. */
      cleaned.colors.set(material.albedo.subarray(0, cleaned.colors.length));
      let believed = 0;
      for (const one of material.confidence) believed += one;
      return material.confidence.length === 0 ? 0 : believed / material.confidence.length;
    }).then((mean) => {
      note(`mean confidence ${mean.toFixed(3)}`);
    });
  }

  const collision = await timed('colliders', () => collisionMesh(cleaned));

  const navigation = wantNav
    ? await timed('navmesh', () => {
        const cell = Math.max(0.05, volume.spacing);
        const field = voxeliseWalkable(
          { positions: cleaned.positions, indices: cleaned.indices },
          {
            cellSize: cell,
            cellHeight: cell * 0.7,
            maxSlope: 45,
            agentHeight: 1.2,
            agentRadius: 0.2,
          },
        );
        const regions = buildRegions(field, { minRegionSpans: 4, maxStep: 1 });
        return buildPolyMesh(buildContours(field, regions, 0.5), 6, field);
      })
    : undefined;
  if (navigation !== undefined) note(`${navigation.polyCount} polygons`);

  const regions = await timed('segment', () => segmentGeometry(cleaned));
  const proposals = await timed('propose', () => proposeEntities(regions));
  note(`${proposals.length} entities proposed`);

  const bytes = new Uint8Array(
    await timed('write', () => captureFile({ mesh: cleaned, navigation, proposals })),
  );
  note(`${(bytes.byteLength / 1e6).toFixed(2)} MB`);

  /*
   * **Read back through the loader, so what is drawn is the file rather than the arrays.** Those
   * arrays are what the stages produced; what a consumer opens is the container, and the gap
   * between the two is the one thing this page can check that no unit test does.
   */
  const created = await createRenderer(
    canvas,
    { maxDrawingBufferPixels: 0, ...askedQuality() },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const loader = new DrftLoader(renderer, {
    fetchImpl: () => Promise.resolve(new Response(bytes)),
  });
  /*
   * **`fit: 'none'` because a capture is already in metres.** The loader's other mode scales the
   * model into a box a caller names, which is what an imported asset of unknown units wants; a
   * reconstruction arrives in the world its own depth was measured in, and scaling it would throw
   * that away. Asking for a fit and then aiming the camera at the volume's coordinates is how this
   * page first drew three specks: the mesh was moved and the camera was not.
   */
  await timed('read back', () => loader.load('clip.drft', { fit: 'none' }));
  /*
   * **The loader queues what arrives and `update` uploads it at a budget**, so a page that loads
   * and draws in the same breath draws nothing — which is what this one did: a 0.56 MB file, no
   * error, and `parts` empty. The budget is per frame and exists so a stream never stalls one;
   * here there is nothing to stall, so it is drained until it says it is done.
   */
  await timed('upload', () => {
    for (let guard = 0; guard < 10_000 && loader.update(1 / 60); guard += 1);
  });
  note(`${loader.parts.length} parts`);

  /*
   * **Lit from where you are looking, which for a capture is the only light that always works.**
   *
   * A fused sheet's normals face the cameras that saw it — measured at +0.61 against the first
   * pose on this clip, which is what killed the inverted-mesh theory — so a sun fixed in the world
   * lights it only if the clip happened to be shot from the sun's side. It was not, and the first
   * pictures came back near-black from the very viewpoint the footage was taken at. **What this
   * gives up** is any sense of where the real light was; that is stage 3's subject, and until
   * delighting runs this is a lamp on the viewer's head, not a claim about the room.
   */
  const environment = createEnvironment({
    directionalDir: [0, 1, 0],
    /*
     * **Bright, because albedo is not white.** Marching fills every vertex with 1.0 and delighting
     * replaces it with what the surface actually reflects — around a quarter for wood — so a light
     * levelled for the untextured cast leaves the delit one three times too dark. The exposure a
     * capture is looked at under is a property of the harness, not of the capture.
     */
    directionalColor: [2.1, 2.05, 1.98],
    ambient: [0.72, 0.74, 0.82],
    ambientGround: [0.4, 0.4, 0.46],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 50;
  const span = Math.max(
    (bounds.high[0] as number) - (bounds.low[0] as number),
    (bounds.high[1] as number) - (bounds.low[1] as number),
    (bounds.high[2] as number) - (bounds.low[2] as number),
  );
  const middle: Vec3 = [
    ((bounds.low[0] as number) + (bounds.high[0] as number)) / 2,
    ((bounds.low[1] as number) + (bounds.high[1] as number)) / 2,
    ((bounds.low[2] as number) + (bounds.high[2] as number)) / 2,
  ];
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /*
   * **The file itself, for a harness to take away.** `shots.mjs` can photograph a page and cannot
   * reach into it; Task 21 wants this capture opened in the *editor*, which means the bytes have
   * to leave the browser. Base64 on the window is the seam every other page here would use for the
   * same thing, and it costs nothing until something reads it.
   */
  /*
   * **A character standing on the captured colliders, which is the claim the stage makes.**
   *
   * `collisionMesh` says a capture can be walked on; a controller that sinks through it or skates
   * over it says otherwise, and no unit test over synthetic geometry can tell — a marched surface
   * from a real clip is bumpy in ways a ray-cast box never is. The walker is dropped above the
   * highest point of the reconstruction and given a fixed step a frame, so two runs of one build
   * photograph the same thing.
   */
  const physics = new PhysicsWorld();
  physics.addBody({
    type: BODY_STATIC,
    shape: meshShape(collision.positions, collision.indices),
  });
  /*
   * **Nine drops across the capture, because one says nothing.**
   *
   * A single walker dropped in the middle of the bounds fell straight past the surface and settled
   * below the lowest triangle — which is what a hole in the reconstruction looks like and equally
   * what colliders that do not work look like. Dropping over a grid separates them: a patchy
   * capture catches some and not others, and a broken collider catches none.
   */
  const caught = await timed('stand', () => {
    const probe = new CharacterController();
    const floor = bounds.low[1] as number;
    let held = 0;
    let tried = 0;
    for (let gx = 0; gx < 3; gx += 1) {
      for (let gz = 0; gz < 3; gz += 1) {
        const x =
          (bounds.low[0] as number) +
          (((bounds.high[0] as number) - (bounds.low[0] as number)) * (gx + 1)) / 4;
        const z =
          (bounds.low[2] as number) +
          (((bounds.high[2] as number) - (bounds.low[2] as number)) * (gz + 1)) / 4;
        probe.teleport(x, (bounds.high[1] as number) + 1, z);
        for (let step = 0; step < 180; step += 1) {
          probe.move(physics, 1 / 60, { moveX: 0, moveZ: 0, jump: false });
        }
        tried += 1;
        /* Above the lowest triangle by more than a centimetre means something stopped it. */
        if (probe.y > floor + 0.01) held += 1;
      }
    }
    return { held, tried };
  });
  note(`${caught.held} of ${caught.tried} drops landed on the capture rather than through it`);

  const walker = new CharacterController();
  /*
   * **Dropped from a height, because settling where it started proves nothing.** The first run put
   * the walker 0.3 m above the top and it reported settling at exactly its drop height — which is
   * what a controller that found ground looks like and equally what one that never fell looks
   * like. `?drop=` is the control: from two metres up, a capture whose colliders hold arrives at
   * the surface and one whose colliders are missing keeps going.
   */
  const dropFrom = Number(asked.get('drop') ?? '0.3');
  walker.teleport(middleOf(bounds, 0), (bounds.high[1] as number) + dropFrom, middleOf(bounds, 2));
  const startedAt = (bounds.high[1] as number) + dropFrom;
  const walkerMesh = renderer.createMesh(
    new MeshBuilder().addCapsule([0, 0, 0], 0.12, 0.5, [0.42, 0.84, 0.62], 0.2).build(),
  );
  const walkerAt = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const walking = asked.get('walk') === '1';
  /** Where the walker settled, which is what says whether the colliders held it. */
  const landedAt = { y: walker.y, steps: 0 };

  (window as unknown as { clipFile?: string }).clipFile = btoa(
    Array.from(bytes, (one) => String.fromCharCode(one)).join(''),
  );

  report();
  /*
   * **The camera stands where the clip's own camera stood**, which is the only viewpoint a capture
   * is guaranteed to look right from.
   *
   * A reconstruction fused from one side is a *sheet*, not a solid: a tabletop has a front and a
   * back, and from behind it is culled. Framed on the bounding box's corner this page drew a
   * handful of stray triangles and looked exactly like a stage that had produced nothing — the
   * mesh was 1.81 × 1.38 × 1.36 m and perfectly real, and the camera was underneath it. Standing
   * on an estimated pose is also a check on the poses: if they are wrong, nothing is in frame.
   *
   * **`−Rᵀt`, not `−t`** — a view matrix is `R · T(−p)`, so its translation column is in view
   * space. `?view=` picks which pose, `?inside=1` stands in the middle and looks out, which is what
   * separates an inverted mesh from an absent one.
   */
  const inside = asked.get('inside') === '1';
  const viewAt = Math.min(estimate.views.length - 1, Math.max(0, Number(asked.get('view') ?? '0')));
  const pose = (estimate.views[viewAt] as { worldToCamera: Float32Array }).worldToCamera;
  /* The camera's own place in the world, and the point one span in front of it. */
  const eye: Vec3 = [0, 0, 0];
  const ahead: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    eye[axis] = -(
      (pose[axis] as number) * (pose[3] as number) +
      (pose[4 + axis] as number) * (pose[7] as number) +
      (pose[8 + axis] as number) * (pose[11] as number)
    );
    /* Rᵀ applied to +z, the direction a pinhole looks. */
    ahead[axis] = pose[8 + axis] as number;
  }

  const draw = (): void => {
    const aspect = canvas.width / Math.max(1, canvas.height);
    if (inside) {
      camera.position[0] = middle[0];
      camera.position[1] = middle[1];
      camera.position[2] = middle[2];
      camera.lookAt(middle[0] + span, middle[1], middle[2] + span);
    } else {
      /* A little behind the pose, so the surface it saw is comfortably in frame. */
      camera.position[0] = eye[0] - ahead[0] * span * 0.25;
      camera.position[1] = eye[1] - ahead[1] * span * 0.25;
      camera.position[2] = eye[2] - ahead[2] * span * 0.25;
      camera.lookAt(middle[0], middle[1], middle[2]);
    }
    camera.updateMatrices(aspect);
    /* The headlight: from the camera toward what it is looking at, renewed as the camera moves. */
    const toEye = [
      camera.position[0] - middle[0],
      camera.position[1] - middle[1],
      camera.position[2] - middle[2],
    ];
    const reach = Math.hypot(toEye[0] as number, toEye[1] as number, toEye[2] as number) || 1;
    environment.directionalDir[0] = (toEye[0] as number) / reach;
    environment.directionalDir[1] = (toEye[1] as number) / reach;
    environment.directionalDir[2] = (toEye[2] as number) / reach;
    /* One fixed step a frame: the clock is the harness's, so the motion is counted, not timed. */
    walker.move(physics, 1 / 60, {
      moveX: walking ? 1 : 0,
      moveZ: walking ? 0.4 : 0,
      jump: false,
    });
    landedAt.y = walker.y;
    landedAt.steps += 1;
    walkerAt[12] = walker.x;
    walkerAt[13] = walker.y + 0.5;
    walkerAt[14] = walker.z;

    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, environment);
    for (const part of loader.parts) renderer.drawMesh(part.mesh, identity);
    renderer.drawMesh(walkerMesh, walkerAt);
    renderer.endFrame();
  };
  /*
   * A hundred and twenty steps before the shutter, so the walker has had time to fall onto the
   * surface and, where `?walk=1`, to have crossed some of it.
   */
  for (let step = 0; step < 120; step += 1) draw();
  timings.push({
    stage: 'walk',
    ms: 0,
    note:
      `dropped from ${startedAt.toFixed(2)}, settled at ${landedAt.y.toFixed(2)} ` +
      `after ${landedAt.steps} steps; the capture spans y ` +
      `${(bounds.low[1] as number).toFixed(2)} to ${(bounds.high[1] as number).toFixed(2)}`,
  });
  report();
  (window as unknown as { clipReady?: boolean }).clipReady = true;
}

run().catch((thrown: unknown) => {
  const said = thrown instanceof Error ? thrown.message : String(thrown);
  error.textContent = `failed to mount: ${said}`;
  report();
  (window as unknown as { clipReady?: boolean }).clipReady = true;
});
