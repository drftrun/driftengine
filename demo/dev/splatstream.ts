/**
 * A Gaussian splat capture arriving through the `.drft` container, block by block.
 *
 * **This is the page the whole container chunk exists for.** Everything in `splats.html` is a
 * splat viewer; what this shows is a capture that opens on a *recognisable place* after the first
 * block and densifies as the rest land — because the writer lays the blocks out interleaved across
 * the whole capture rather than in the order the splats were authored in. A file written in
 * authored order would open on one corner at full density, which reads as a broken load.
 *
 * **The file is written here rather than fetched**, for the same reason `splats.html` synthesises
 * its capture: a downloaded `.ply` is unknown, so a wrong picture from one cannot be told from a
 * wrong file. This bakes a capture with `writeDrft`, feeds the bytes to `DrftStream` a slice at a
 * time, and draws whatever has arrived. Every byte in the picture came from a number in this file.
 *
 *   /splatstream.html            the whole load, running
 *   ?upto=N                      feed only the first N blocks and hold — the still frames a
 *                                recording is made of, and what makes a capture deterministic
 *   ?blocks=N                    how many blocks the file is written in. 16 by default
 *   ?authored=1                  write the file in authored order instead of coarse-first, which
 *                                is the control: the same prefix, opening on one corner
 *   ?slice=N                     bytes fed per frame, for watching it arrive at a chosen rate
 *
 * Deterministic at a given `?upto=`: the camera holds, the file is the same bytes every run, and
 * the blocks are fed synchronously rather than over a network.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { PassHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DrftStream, writeDrft } from '../../packages/drft/src/index';
import type { DrftSplatBlock } from '../../packages/drft/src/index';
import {
  SPLAT_WORDS,
  SplatCapture,
  SplatSorter,
  createSplatPass,
  createSplatViewLocal,
  packSplats,
  resolveSplatView,
} from '../../packages/splats/src/index';
import type { SplatPass } from '../../packages/splats/src/index';

import { DEV_RENDERER, askedQuality } from './askedQuality';

const BACKGROUND: Vec3 = [0.02, 0.024, 0.03];
/** Where the camera stops moving, so a still of a given block count is one frame. */
const HOLD_AT = 30;
/** Splats a side of the hollow box that stands in for a captured room. */
const SIDE = 46;

/**
 * A hollow box of splats, coloured by position: a room, in the shape a capture of one has.
 *
 * **Hollow rather than solid**, because a solid cube's surface hides everything behind it and a
 * partial load would look identical to a complete one. The walls are what a capture of a place
 * actually is, and a sparse version of them is visibly sparse.
 *
 * Written out in **authored order** — one face at a time, each face row by row — which is exactly
 * the order that makes a naive prefix look broken, and is what the container's coarse-first layout
 * has to survive. `?authored=1` writes it that way on purpose so the two can be compared.
 */
function buildRoom(): ReturnType<typeof packSplats> {
  const positions: number[] = [];
  const scales: number[] = [];
  const rotations: number[] = [];
  const colors: number[] = [];
  const opacities: number[] = [];

  const push = (x: number, y: number, z: number, u: number, v: number): void => {
    positions.push(x, y, z);
    /* A spread of sizes, so a budget and a coarse level have something to choose between. */
    const size = 0.03 + 0.02 * ((u * 7 + v * 3) % 1);
    scales.push(size, size, size);
    rotations.push(0, 0, 0, 1);
    colors.push(0.25 + 0.7 * u, 0.3 + 0.5 * v, 0.85 - 0.5 * u);
    opacities.push(0.95);
  };

  for (let face = 0; face < 5; face++) {
    for (let row = 0; row < SIDE; row++) {
      for (let column = 0; column < SIDE; column++) {
        const u = column / (SIDE - 1);
        const v = row / (SIDE - 1);
        const a = (u - 0.5) * 6;
        const b = (v - 0.5) * 6;
        if (face === 0) push(a, b + 3, -3, u, v);
        else if (face === 1) push(-3, b + 3, a, u, v);
        else if (face === 2) push(3, b + 3, a, u, v);
        else if (face === 3) push(a, 0, b, u, v);
        else push(a, 6, b, u, v);
      }
    }
  }

  return packSplats({
    count: opacities.length,
    positions: new Float32Array(positions),
    scales: new Float32Array(scales),
    rotations: new Float32Array(rotations),
    colors: new Float32Array(colors),
    opacities: new Float32Array(opacities),
  });
}

async function main(): Promise<void> {
  const canvasEl = document.getElementById('canvas') as HTMLCanvasElement | null;
  const statsEl = document.getElementById('stats');
  const errorOut = document.getElementById('error');
  if (canvasEl === null || statsEl === null) return;
  const canvas = canvasEl;
  const stats = statsEl;

  const params = new URLSearchParams(location.search);
  const blocks = Number(params.get('blocks') ?? '16') || 16;
  const upto = params.get('upto') === null ? Infinity : Number(params.get('upto'));
  const slice = Number(params.get('slice') ?? '4096') || 4096;
  const authored = params.get('authored') === '1';

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

  const room = buildRoom();
  /*
   * **The control, and it is one line.** `?authored=1` hands the writer positions it cannot tell
   * apart — every splat at the origin — so the Morton sort has nothing to order by and the
   * coarse-first walk decimates the authored order instead of the spatial one. That is precisely
   * the file a naive baker writes, and the difference between the two pictures at `?upto=1` is
   * what the whole layout is for.
   */
  const layoutPositions = authored ? new Float32Array(room.count * 3) : room.positions;
  const file = writeDrft({
    head: { name: 'room', generator: 'splatstream' },
    meshes: [],
    splats: {
      count: room.count,
      positions: layoutPositions,
      records: room.packed,
      wordsPerSplat: SPLAT_WORDS,
      boundsMin: room.boundsMin,
      boundsMax: room.boundsMax,
      sphericalHarmonics: room.sphericalHarmonics,
      blocks,
    },
  });

  const camera = new Camera();
  camera.fovYDeg = 55;
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

  let capture: SplatCapture | null = null;
  let pass: SplatPass | null = null;
  let handle: PassHandle | null = null;
  let sorter: SplatSorter | null = null;
  let uploaded = -1;
  let landed = 0;
  let totalBlocks = 0;
  const local = createSplatViewLocal();
  const model = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /*
   * The whole integration, in one handler. The capture is allocated the moment the first block
   * names the final count, the pass is registered against it at full size, and every block after
   * that is a sub-upload into storage that already exists — no reallocation, and no re-sort of
   * what has not arrived.
   */
  const onSplats = (block: DrftSplatBlock): void => {
    if (landed >= upto) return;
    if (capture === null) {
      capture = new SplatCapture({
        total: block.totalCount,
        boundsMin: block.boundsMin,
        boundsMax: block.boundsMax,
        sphericalHarmonics: block.sphericalHarmonics,
        /* From the block rather than assumed: a capture with view-dependent colour writes twelve
           words a splat and one without writes eight. See `SplatCaptureOptions.wordsPerSplat`. */
        wordsPerSplat: block.wordsPerSplat,
      });
      pass = createSplatPass(capture.data, 'demo.splatstream');
      handle = renderer.registerPass(pass);
      pass.setModel(model);
      sorter = new SplatSorter({
        splats: capture.data,
        /* Follows the load: the sorter orders what has arrived and nothing else. */
        ready: () => capture?.ready ?? 0,
      });
    }
    const where = capture.append(block.records, block.count);
    pass?.uploadSplats(where.from, where.count);
    landed++;
  };

  const stream = new DrftStream({
    onManifest: (manifest) => {
      totalBlocks = manifest.splatBlockCount;
    },
    onSplats,
  });

  const bytes = new Uint8Array(file);
  let fed = 0;
  renderer.resize();
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);

  let frame = 0;

  function renderFrame(): void {
    /* Fed on the frame, so the load is watchable and a still at `?upto=N` is reproducible. */
    if (fed < bytes.length && landed < upto) {
      const piece = bytes.subarray(fed, Math.min(bytes.length, fed + slice));
      fed += piece.length;
      stream.push(piece);
      if (fed >= bytes.length) stream.end();
    }

    const held = Math.min(frame, HOLD_AT);
    const turn = held * 0.01;
    camera.position[0] = Math.sin(turn) * 5.5;
    camera.position[1] = 2.6;
    camera.position[2] = Math.cos(turn) * 5.5;
    camera.lookAt(0, 2.4, 0);
    camera.updateMatrices(aspect());

    if (pass !== null && sorter !== null && capture !== null) {
      pass.setView({
        view: camera.view,
        projection: camera.projection,
        widthPx: canvas.width,
        heightPx: canvas.height,
      });
      if (pass.visible) {
        resolveSplatView(camera.view, model, local);
        sorter.frame(local);
        const order = sorter.order;
        if (order !== null && sorter.version !== uploaded) {
          pass.setOrder(order, sorter.drawCount);
          uploaded = sorter.version;
        }
      }
    }

    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    if (handle !== null) renderer.drawPass(handle);
    renderer.endFrame();
  }

  function loop(): void {
    frame++;
    renderFrame();
    const ready = capture?.ready ?? 0;
    const total = capture?.data.count ?? 0;
    stats.textContent =
      `${created.backend} · ${created.reason} · ${authored ? 'AUTHORED ORDER' : 'coarse first'}` +
      ` · block ${landed} of ${totalBlocks} · ${ready} of ${total} splats` +
      ` · ${(fed / 1024).toFixed(0)} of ${(bytes.length / 1024).toFixed(0)} KB · frame ${Math.min(frame, HOLD_AT)}`;
    /*
     * Held once the camera has stopped, the asked-for blocks have landed, and the sorter has
     * settled at that view — the same three conditions `splats.ts` waits on, and for the same
     * reason: a page photographed at whichever sort happened to finish is not a control.
     */
    const settledSort =
      sorter === null || (!sorter.sorting && sorter.order !== null && sorter.version === uploaded);
    const done = landed >= Math.min(upto, totalBlocks || 1) || fed >= bytes.length;
    if (frame >= HOLD_AT && done && settledSort) {
      (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
      return;
    }
    requestAnimationFrame(loop);
  }

  loop();
}

void main();
