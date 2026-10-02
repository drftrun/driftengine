/**
 * A rock garden made of Gaussian splats, with a lantern post of ordinary geometry standing in it.
 *
 * A splat capture is usually a photographed place, read from the file a capture tool writes. This
 * one is synthesised here instead, so the page needs no download: about a hundred thousand flat
 * ellipsoids laid on the surfaces of a few rocks, a mossy ground and a pool. The pool's splats carry
 * the first band of view-dependent colour, so its sheen moves as the camera goes round.
 *
 * Splats are transparent and draw back to front, so they are sorted off the frame, in a worker,
 * and drawn in whatever order last arrived. Switch the sort off to see what drawing them in file
 * order looks like, and switch the pool's view-dependent colour off to see it flatten.
 */
import { MeshBuilder, createEnvironment, hashToUnit } from '@driftengine/core';
import type { PassHandle, Vec3 } from '@driftengine/core';
import {
  SplatSorter,
  createSplatPass,
  createSplatViewLocal,
  packSplats,
  resolveSplatView,
} from '@driftengine/splats';
import type { SplatData, SplatPass } from '@driftengine/splats';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

const stage = await openStage({ outputTransform: 'aces', outputExposure: 1.2 });
const { renderer, camera } = stage;

// #region capture
/** Splats gathered for one capture: where, how big along each axis, which way, what colour. */
const positions: number[] = [];
const scales: number[] = [];
const rotations: number[] = [];
const colors: number[] = [];
const opacities: number[] = [];
const shine: number[] = [];

/** The quaternion, xyzw, that turns +z onto a unit normal: a flat splat lies along the surface. */
function facing(nx: number, ny: number, nz: number): [number, number, number, number] {
  const w = 1 + nz;
  if (w < 1e-6) return [1, 0, 0, 0];
  const length = Math.hypot(-ny, nx, 0, w);
  return [-ny / length, nx / length, 0, w / length];
}

/** One flat splat on a surface: wide along it, thin across it. */
function lay(at: Vec3, normal: Vec3, size: number, colour: Vec3, opacity: number, sheen = 0): void {
  positions.push(...at);
  scales.push(size, size, size * 0.12);
  rotations.push(...facing(normal[0], normal[1], normal[2]));
  colors.push(...colour);
  opacities.push(opacity);
  shine.push(sheen);
}

/** A rock: points spread evenly over a lumpy ellipsoid, stone below and moss where it faces up. */
function rock(cx: number, cz: number, rx: number, ry: number, rz: number, seed: number): void {
  const count = Math.round(6000 * rx * rz);
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    const nx = Math.cos(a) * ring;
    const nz = Math.sin(a) * ring;
    const lump = 1 + (hashToUnit(seed + Math.floor(a * 3) * 17 + Math.floor(y * 6)) - 0.5) * 0.18;
    if (y < -0.2) continue;
    const grey = 0.36 + hashToUnit(seed * 7 + i) * 0.14;
    const moss = Math.max(0, y - 0.55) * 2.2 * hashToUnit(seed * 13 + i);
    const colour: Vec3 = [grey - moss * 0.2, grey + moss * 0.18, grey - moss * 0.22];
    lay([cx + nx * rx * lump, y * ry * lump, cz + nz * rz * lump], [nx, y, nz], 0.07, colour, 0.9);
  }
}

/** The ground: a disc of soil and grass, and a pool in it whose colour changes with the view. */
for (let i = 0; i < 52000; i += 1) {
  const r = Math.sqrt((i + 0.5) / 52000) * 9;
  const a = i * 2.399963;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  const pool = Math.hypot(x - 2.2, z + 1.2) < 1.8;
  const tone = hashToUnit(i * 3);
  const colour: Vec3 = pool
    ? [0.05, 0.12 + tone * 0.03, 0.16]
    : [0.16 + tone * 0.08, 0.2 + tone * 0.16, 0.08 + tone * 0.04];
  lay(
    [x, pool ? -0.05 : tone * 0.04, z],
    [0, 1, 0],
    0.075,
    colour,
    pool ? 0.85 : 0.95,
    pool ? 1 : 0,
  );
}
rock(-2.2, -1.5, 1.4, 1.1, 1.2, 11);
rock(-0.4, 1.6, 0.9, 0.7, 0.8, 23);
rock(-3.6, 1.8, 0.7, 1.3, 0.6, 37);
rock(3.4, 2.4, 1, 0.6, 1.1, 41);
// #endregion

// #region pack
/**
 * The same splats packed twice: once with flat colour, and once with the first band of
 * view-dependent colour on the pool, nine coefficients a splat, interleaved by basis function.
 */
const count = opacities.length;
const source = {
  count,
  positions: new Float32Array(positions),
  scales: new Float32Array(scales),
  rotations: new Float32Array(rotations),
  colors: new Float32Array(colors),
  opacities: new Float32Array(opacities),
};
const sh1 = new Float32Array(count * 9);
for (let i = 0; i < count; i += 1) {
  const sheen = shine[i] ?? 0;
  /* Brighter and bluer seen from one side of the pool, darker from the other. */
  sh1[i * 9 + 6] = 0.25 * sheen;
  sh1[i * 9 + 7] = 0.35 * sheen;
  sh1[i * 9 + 8] = 0.45 * sheen;
}
const flat = packSplats(source);
const glossy = packSplats({ ...source, sh1 });
// #endregion

// #region batch
/** Each packing as a pass registered with the renderer, and the version of the order it holds. */
interface Batch {
  readonly pass: SplatPass;
  readonly handle: PassHandle;
  uploaded: number;
}
function batch(data: SplatData, label: string): Batch {
  const pass = createSplatPass(data, label);
  return { pass, handle: renderer.registerPass(pass), uploaded: -1 };
}
const batches = { flat: batch(flat, 'garden.flat'), glossy: batch(glossy, 'garden.glossy') };
/** One sorter serves both, since their splats stand in the same places. It sorts in a worker. */
const sorter = new SplatSorter({ splats: flat });
/** File order, for the switch that turns the sort off. */
const unsorted = Uint32Array.from({ length: count }, (_, i) => i);
const local = createSplatViewLocal();
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// #endregion

/** A lantern post of ordinary geometry, standing among the splats. */
const post = renderer.createMesh(
  new MeshBuilder()
    .addBox([1.2, 1, 0.6], [0.08, 1, 0.08], [0.18, 0.17, 0.16])
    .addSphere([1.2, 2.1, 0.6], 0.16, [1, 0.8, 0.5], 1.2, 12, 8)
    .build(),
);

let sorting = flag('sort', 'on') === 'on';
let viewDependent = flag('colour', 'view') === 'view';
controls([
  {
    key: 'sort',
    label: 'sort',
    value: sorting ? 'on' : 'off',
    options: [
      { text: 'off the frame', value: 'on' },
      { text: 'none: file order', value: 'off' },
    ],
    change: (value) => {
      sorting = value === 'on';
      batches.flat.uploaded = -1;
      batches.glossy.uploaded = -1;
    },
  },
  {
    key: 'colour',
    label: 'pool colour',
    value: viewDependent ? 'view' : 'flat',
    options: [
      { text: 'changes with the view', value: 'view' },
      { text: 'flat', value: 'flat' },
    ],
    change: (value) => {
      viewDependent = value === 'view';
    },
  },
]);

const env = createEnvironment({
  directionalDir: [0.4, 0.8, 0.45],
  directionalColor: [1.4, 1.3, 1.15],
  ambient: [0.3, 0.32, 0.38],
  ambientGround: [0.1, 0.1, 0.09],
  nightFactor: 0.4,
  emissiveGain: 1.5,
});
const SKY: Vec3 = [0.5, 0.58, 0.68];
const readout = createReadout(renderer, 1);
readout.set(0, `${count} SPLATS`);

let time = 0;
stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    const turn = time * 0.12;
    camera.fovYDeg = 45;
    camera.near = 0.1;
    camera.far = 80;
    camera.position[0] = Math.sin(turn) * 10;
    camera.position[1] = 3.4;
    camera.position[2] = Math.cos(turn) * 10;
    camera.lookAt(0, 0.4, 0);
    camera.updateMatrices(stage.canvas.width / Math.max(1, stage.canvas.height));

    // #region frame
    const shown = viewDependent ? batches.glossy : batches.flat;
    /* The view first, because it decides whether the capture is in frame at all. */
    shown.pass.setView({
      view: camera.view,
      projection: camera.projection,
      widthPx: stage.canvas.width,
      heightPx: stage.canvas.height,
    });
    if (!sorting) {
      if (shown.uploaded !== -2) shown.pass.setOrder(unsorted, count);
      shown.uploaded = -2;
    } else if (shown.pass.visible) {
      /* The camera in the capture's own space; the sorter asks for a new order when it has moved. */
      resolveSplatView(camera.view, IDENTITY, local);
      sorter.frame(local);
      const order = sorter.order;
      if (order !== null && sorter.version !== shown.uploaded) {
        shown.pass.setOrder(order, sorter.drawCount);
        shown.uploaded = sorter.version;
      }
    }

    renderer.beginFrame(SKY);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(post, IDENTITY);
    /* After the meshes, so the post hides the splats behind it and not those in front. */
    renderer.drawPass(shown.handle);
    // #endregion
    readout.draw(time);
    renderer.endFrame();
  },
});
