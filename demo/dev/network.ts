/**
 * Two peers, one world, and a correction that converges — drawn, so it can be measured.
 *
 * Four unrelated claims, so this draws one pair per load and publishes what the canvas holds:
 *
 *     /network.html?variant=lockstep     two peers over an impaired link, which must agree
 *     /network.html?variant=nolockstep   the same link with one input per packet, which must not
 *     /network.html?variant=predict      a client predicting its own player under latency
 *     /network.html?variant=nopredict    the same client waiting for the authority, the control
 *     /network.html?variant=smooth       a remote body interpolated between two authoritative states
 *     /network.html?variant=nosmooth     the same body drawn at the newest state, which steps
 *     /network.html?variant=fixture      both arms of the conformance fixture, in a browser
 *
 * **Two cubes, at two heights, in two colours.** Peer A is cyan and above; peer B is magenta and
 * below. Every measurement is a centroid of one colour, so nothing has to know where a region ends
 * — the same reason `editor.ts` separates its three subjects by colour rather than by rectangle.
 *
 * **The link is impaired from a seed and the clock is driven by hand**, so two loads of one URL
 * produce the same frame. A page that read `performance.now()` would produce a different delivery
 * schedule every run and no assertion here would mean anything.
 *
 * **`fixture` is why this page exists as well as the unit tests.** `SimNumber`'s digests are
 * committed in `packages/network/src/fixture.test.ts`, measured under Node; this runs the same two
 * arms in a browser, on the same machine's other JavaScript engine path, and publishes them for the
 * check to compare against those. That is a second engine for free.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `gizmo.ts`, `editor.ts` and `ui.ts`.
 */

import {
  Camera,
  createEnvironment,
  createRenderer,
  exactCos,
  exactSin,
  savableMulberry32,
} from '../../packages/core/src/index';
import { SceneNode } from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { World, defineComponent } from '../../packages/entities/src/index';
import {
  AuthorityHost,
  InputLog,
  LockstepSession,
  LoopbackNetwork,
  PredictingClient,
  RewindLoop,
  StateInterpolator,
  combineSnapshotters,
  createFixture,
  randomSnapshotter,
  worldSnapshotter,
} from '../../packages/network/src/index';
import type { Impairment, Replicator } from '../../packages/network/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0.02, 0.03, 0.08];
const PEER_A: Vec3 = [0.25, 0.85, 0.95];
const PEER_B: Vec3 = [0.95, 0.35, 0.85];

const FIXED_DT = 1 / 60;
const PARTICIPANTS = 2;
const Body = defineComponent('NetBody', { x: 'f64', vx: 'f64' });

type Variant =
  'lockstep' | 'nolockstep' | 'predict' | 'nopredict' | 'smooth' | 'nosmooth' | 'fixture';

/** A cube, emissive, so its brightness is a constant of the scene rather than of the lighting. */
function cube(size: number, colour: Vec3): MeshData {
  const h = size / 2;
  const corners = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const faces = [
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [4, 0, 3, 7],
    [1, 5, 6, 2],
    [3, 2, 6, 7],
    [4, 5, 1, 0],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const at of face) {
      const corner = corners[at] as number[];
      positions.push(corner[0] as number, corner[1] as number, corner[2] as number);
      normals.push(0, 0, 1);
      colors.push(colour[0], colour[1], colour[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    emissive: new Float32Array(count).fill(1),
    indices: new Uint32Array(indices),
  };
}

/** One peer: a world with two bodies, a rewind loop over it, and the input log they share. */
function makePeer(seedOffset: number) {
  const world = new World();
  const rng = savableMulberry32(9001 + seedOffset * 0);
  const entities = [world.create(), world.create()];
  for (const e of entities) world.add(e, Body, { x: 0, vx: 0 });

  const inputs = new InputLog({ participants: PARTICIPANTS, depth: 64, inputBytes: 1 });
  const scratch = new Uint8Array(1);

  const step = (dt: number, tick: number): void => {
    for (let p = 0; p < PARTICIPANTS; p++) {
      inputs.into(p, tick, scratch);
      const e = entities[p] as number;
      const push = ((scratch[0] as number) & 1) === 1 ? 5 : -1.2;
      const vx = (world.read(e, Body, 'vx') as number) + push * dt;
      world.write(e, Body, 'vx', vx);
      world.write(e, Body, 'x', (world.read(e, Body, 'x') as number) + vx * dt);
    }
  };

  const loop = new RewindLoop({
    step,
    snapshotter: combineSnapshotters([worldSnapshotter(world), randomSnapshotter(rng)] as never[]),
    inputs,
    fixedDt: FIXED_DT,
    depth: 24,
  });

  const at = (participant: number): number =>
    world.read(entities[participant] as number, Body, 'x') as number;

  return { world, entities, inputs, loop, at };
}

/** Participant 0 taps; participant 1 holds from tick 30. Neither is predictable by repeating. */
const input = (participant: number, tick: number): Uint8Array =>
  new Uint8Array([
    participant === 0
      ? (tick >= 12 && tick <= 15) || (tick >= 40 && tick <= 43)
        ? 1
        : 0
      : tick >= 30
        ? 1
        : 0,
  ]);

const IMPAIRED: Impairment = {
  latencyMs: 60,
  jitterMs: 25,
  loss: 0.15,
  reorder: 0.25,
  reorderMs: 50,
  duplicate: 0.05,
};

/** A lockstep pair, run to completion. `redundancy` of one is the control. */
function runLockstep(redundancy: number): { a: number; b: number; replays: number } {
  const net = new LoopbackNetwork();
  const a = makePeer(0);
  const b = makePeer(1);
  const sessionA = new LockstepSession({
    transport: net.open({ self: 0, seed: 11, impairment: IMPAIRED }),
    loop: a.loop,
    inputs: a.inputs,
    self: 0,
    participants: PARTICIPANTS,
    inputDelay: 2,
    redundancy,
  });
  const sessionB = new LockstepSession({
    transport: net.open({ self: 1, seed: 22, impairment: IMPAIRED }),
    loop: b.loop,
    inputs: b.inputs,
    self: 1,
    participants: PARTICIPANTS,
    inputDelay: 2,
    redundancy,
  });

  for (let tick = 0; tick < 120; tick++) {
    sessionA.poll();
    sessionB.poll();
    sessionA.submit(tick, input(0, tick));
    sessionB.submit(tick, input(1, tick));
    if (sessionA.status === 'running') sessionA.advance(FIXED_DT, tick);
    if (sessionB.status === 'running') sessionB.advance(FIXED_DT, tick);
    net.advance(1000 / 60);
  }
  return { a: a.at(1), b: b.at(1), replays: a.loop.stats.replays + b.loop.stats.replays };
}

/** An authority and a client. `predict` off is the control. */
function runAuthority(predict: boolean): { client: number; host: number; corrections: number } {
  const net = new LoopbackNetwork();
  const hostSide = makePeer(0);
  const clientSide = makePeer(1);

  const replicatorFor = (side: ReturnType<typeof makePeer>): Replicator => {
    const view = new DataView(new ArrayBuffer(16));
    return {
      encode: (into) => {
        if (into.length < 16) return -1;
        view.setFloat64(0, side.at(0));
        view.setFloat64(8, side.at(1));
        into.set(new Uint8Array(view.buffer));
        return 16;
      },
      apply: (from) => {
        if (from.length < 16) return;
        const copy = new Uint8Array(16);
        copy.set(from.subarray(0, 16));
        const incoming = new DataView(copy.buffer);
        side.world.write(side.entities[0] as number, Body, 'x', incoming.getFloat64(0));
        side.world.write(side.entities[1] as number, Body, 'x', incoming.getFloat64(8));
      },
    };
  };

  const host = new AuthorityHost({
    transport: net.open({ self: 0, impairment: { latencyMs: 60 } }),
    loop: hostSide.loop,
    inputs: hostSide.inputs,
    replicator: replicatorFor(hostSide),
    stateEvery: 3,
  });
  const client = new PredictingClient({
    transport: net.open({ self: 1, impairment: { latencyMs: 60 } }),
    loop: clientSide.loop,
    inputs: clientSide.inputs,
    replicator: replicatorFor(clientSide),
    self: 1,
    predict,
  });

  const held = new Uint8Array([1]);
  for (let tick = 0; tick < 120; tick++) {
    host.poll();
    client.poll();
    client.submit(tick, held);
    host.advance(FIXED_DT, tick);
    client.advance(FIXED_DT, tick);
    net.advance(1000 / 60);
  }
  return { client: clientSide.at(1), host: hostSide.at(1), corrections: client.corrections };
}

/**
 * A remote body's drawn position over time, interpolated or not.
 *
 * **The measurement is the largest step between two consecutive drawn positions.** A body drawn at
 * the newest authoritative state holds still for two ticks and then jumps three ticks' worth, so its
 * largest step is about three times an interpolated one's. That is the whole visible difference and
 * it is a number rather than an impression.
 */
function runInterpolation(smooth: boolean): { positions: number[]; maxStep: number } {
  const buffer = new StateInterpolator(16, 16, 4);
  const view = new DataView(new ArrayBuffer(8));
  const positions: number[] = [];

  /* An authority publishing every third tick, from a body moving at a constant rate. */
  for (let tick = 0; tick < 60; tick++) {
    if (tick % 3 === 0) {
      view.setFloat64(0, tick * 0.05);
      buffer.push(tick, new Uint8Array(view.buffer.slice(0)));
    }
    const sample = buffer.sample(tick);
    if (sample === null) {
      positions.push(0);
      continue;
    }
    const from = new DataView(
      sample.from.buffer.slice(sample.from.byteOffset, sample.from.byteOffset + 8),
    );
    const to = new DataView(sample.to.buffer.slice(sample.to.byteOffset, sample.to.byteOffset + 8));
    positions.push(
      smooth
        ? from.getFloat64(0) + (to.getFloat64(0) - from.getFloat64(0)) * sample.alpha
        : to.getFloat64(0),
    );
  }

  let maxStep = 0;
  for (let i = 1; i < positions.length; i++) {
    maxStep = Math.max(maxStep, Math.abs((positions[i] as number) - (positions[i - 1] as number)));
  }
  return { positions, maxStep };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const variant = (asked.get('variant') ?? 'lockstep') as Variant;
  const frames = Number(asked.get('frames') ?? '3');

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  /* Or the drawing buffer stays at the canvas element's default 300x150 and every measurement
     comes back zero, which has now cost a debugging cycle on five rows running. */
  renderer.resize();

  const cssWidth = canvas.width;
  const cssHeight = canvas.height;

  let leftValue = 0;
  let rightValue = 0;
  let replays = 0;
  let corrections = 0;
  let maxStep = 0;
  let floatDigest = '';
  let fixedDigest = '';

  if (variant === 'lockstep' || variant === 'nolockstep') {
    const run = runLockstep(variant === 'lockstep' ? 4 : 1);
    leftValue = run.a;
    rightValue = run.b;
    replays = run.replays;
  } else if (variant === 'predict' || variant === 'nopredict') {
    const run = runAuthority(variant === 'predict');
    leftValue = run.client;
    rightValue = run.host;
    corrections = run.corrections;
  } else if (variant === 'smooth' || variant === 'nosmooth') {
    const run = runInterpolation(variant === 'smooth');
    maxStep = run.maxStep;
    leftValue = run.positions[run.positions.length - 1] ?? 0;
    rightValue = leftValue;
  } else {
    const fixture = createFixture({ sin: exactSin, cos: exactCos });
    floatDigest = fixture.runFloat(600).digest;
    fixedDigest = fixture.runFixed(600).digest;
    leftValue = fixture.runFloat(600).x;
    rightValue = fixture.runFixed(600).x;
  }

  /* Two cubes, at two heights, in two colours. Their x is what the simulation produced. */
  const meshA = renderer.createMesh(cube(0.7, PEER_A));
  const meshB = renderer.createMesh(cube(0.7, PEER_B));
  const nodeA = new SceneNode();
  const nodeB = new SceneNode();
  nodeA.setPosition(leftValue, 1.3, 0);
  nodeB.setPosition(rightValue, -1.3, 0);

  const env = createEnvironment();
  env.ambient = [0.3, 0.3, 0.3];
  env.ambientGround = [0.3, 0.3, 0.3];
  env.directionalColor = [0.5, 0.5, 0.5];
  env.directionalDir = [0, 0, 1];

  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.near = 0.5;
  camera.far = 200;
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 14;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(cssHeight > 0 ? cssWidth / cssHeight : 1);

  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let leftCentroid = -1;
  let rightCentroid = -1;
  let subjectPixels = 0;
  let digest = '';

  /**
   * Each cube's centroid, counted from the canvas rather than from a screenshot — for the reason
   * `oit.ts` records, where a screenshot comparison found 120 differing pixels that turned out to be
   * the page's own caption.
   *
   * **Cyan and magenta are separated by whether green beats red**, which is the one comparison that
   * cannot confuse them at any brightness. A threshold on absolute channel values would call a dim
   * cyan cube magenta at the edges.
   */
  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;

    let leftSum = 0;
    let leftCount = 0;
    let rightSum = 0;
    let rightCount = 0;
    for (let y = 0; y < mirror.height; y++) {
      for (let x = 0; x < mirror.width; x++) {
        const i = (y * mirror.width + x) * 4;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        if (b < 90) continue;
        if (g > r + 40) {
          leftSum += x;
          leftCount += 1;
        } else if (r > g + 40) {
          rightSum += x;
          rightCount += 1;
        }
      }
    }
    leftCentroid = leftCount === 0 ? -1 : leftSum / leftCount;
    rightCentroid = rightCount === 0 ? -1 : rightSum / rightCount;
    subjectPixels = leftCount + rightCount;

    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    for (const [node, mesh] of [
      [nodeA, meshA],
      [nodeB, meshB],
    ] as const) {
      node.updateWorld();
      renderer.drawMesh(mesh, node.worldMatrix);
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
    `${created.backend} · ${created.reason} · ${variant} · left ${leftValue.toFixed(4)} ` +
    `right ${rightValue.toFixed(4)} · centroids ${leftCentroid.toFixed(1)}/${rightCentroid.toFixed(1)} ` +
    `· px ${subjectPixels} · replays ${replays} · corrections ${corrections} · ${digest}`;

  const out = globalThis as unknown as Record<string, unknown>;
  out['__leftValue'] = leftValue;
  out['__rightValue'] = rightValue;
  out['__leftCentroid'] = leftCentroid;
  out['__rightCentroid'] = rightCentroid;
  out['__subjectPixels'] = subjectPixels;
  out['__replays'] = replays;
  out['__corrections'] = corrections;
  out['__maxStep'] = maxStep;
  out['__floatDigest'] = floatDigest;
  out['__fixedDigest'] = fixedDigest;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
