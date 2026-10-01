/**
 * `npm run district:movers`: the district's traffic, baked from the source's own animation.
 *
 *     npm run district:movers                       the whole source's movers
 *     npm run district:movers -- --out <dir>        where to write (demo/dev/public/district)
 *
 * **The source animates its city.** Some seven hundred objects carry keyed motion — road cars and
 * taxis along the streets, flying cars and sky cabs over them, lift cabs up the towers, trains,
 * a tram and boats. Each is sampled here at `RATE` a second as a position and a rotation in the
 * engine's space, **over its own keys rather than the scene's two minutes**: the source's keys run
 * minutes past its frame range, so a two-minute loop sent nearly every car back to its start at
 * once — 9 of 691 ended where they began. Each mover loops its own route instead, phased so that
 * at time nought it stands where the source's first frame puts it, and its wrap is its own.
 *
 * **Its own container, apart from the city's**: each mover's mesh once for every colour it is worn
 * in, placed as instances at rest, with its own materials and pictures. So the traffic can be
 * baked and rebaked without the city, and the runtime draws each model as one instanced batch
 * whose placements it rewrites each frame. Writes `movers.drft`, `movers.json` (which mover each
 * placement is) and `movers.bin` (seven floats a sample: position, then a quaternion x, y, z, w).
 *
 * What it gives up: anything between two samples is a straight line and a turn's arc is cut a
 * little at `RATE`; and a mover whose parent moves is sampled as though its parent stood still,
 * which no mover in the source does.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Animation, activeScene, localMatrix } from '@driftengine/assets';
import type { DrftInstanceGroup, DrftMaterial, MeshData } from '@driftengine/drft';
import { writeDrft } from '@driftengine/drft';

import { buildPiece } from './kit.ts';
import type { KitPiece } from './kit.ts';
import { Materials } from './materials.ts';
import { multiply, readScene, toYUp } from './scene.ts';
import type { Mat4 } from './scene.ts';
import { DEFAULT_SOURCE, openSource } from './source.ts';
import { Pictures } from './textures.ts';

/** Samples a second: a car at city speed moves two and a half metres between two. */
const RATE = 4;
/** The longest a mover's own loop is kept, seconds: a train's route is longer than a visit. */
const LONGEST_SEC = 720;

/** What the runtime reads beside the tracks. */
export interface MoversFile {
  readonly version: 2;
  readonly rate: number;
  /** One per mesh of `movers.drft`, in its order: which movers it is placed as, in instance order. */
  readonly variants: readonly { readonly movers: readonly number[] }[];
  /**
   * Per mover: its scale, which the tracks do not carry; where it rests, which names its batch;
   * where its samples start in `movers.bin` and how many; and how far into its own loop, seconds,
   * the scene's first frame falls.
   */
  readonly movers: readonly {
    readonly scale: readonly [number, number, number];
    readonly rest: readonly [number, number, number];
    readonly offset: number;
    readonly samples: number;
    readonly phase: number;
  }[];
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** A 4×4 inverse by cofactors, column-major; the matrices here are a transform and invertible. */
function invert(m: Mat4): Mat4 {
  const a = (i: number): number => m[i] as number;
  const inv = new Array<number>(16);
  inv[0] =
    a(5) * a(10) * a(15) -
    a(5) * a(11) * a(14) -
    a(9) * a(6) * a(15) +
    a(9) * a(7) * a(14) +
    a(13) * a(6) * a(11) -
    a(13) * a(7) * a(10);
  inv[4] =
    -a(4) * a(10) * a(15) +
    a(4) * a(11) * a(14) +
    a(8) * a(6) * a(15) -
    a(8) * a(7) * a(14) -
    a(12) * a(6) * a(11) +
    a(12) * a(7) * a(10);
  inv[8] =
    a(4) * a(9) * a(15) -
    a(4) * a(11) * a(13) -
    a(8) * a(5) * a(15) +
    a(8) * a(7) * a(13) +
    a(12) * a(5) * a(11) -
    a(12) * a(7) * a(9);
  inv[12] =
    -a(4) * a(9) * a(14) +
    a(4) * a(10) * a(13) +
    a(8) * a(5) * a(14) -
    a(8) * a(6) * a(13) -
    a(12) * a(5) * a(10) +
    a(12) * a(6) * a(9);
  inv[1] =
    -a(1) * a(10) * a(15) +
    a(1) * a(11) * a(14) +
    a(9) * a(2) * a(15) -
    a(9) * a(3) * a(14) -
    a(13) * a(2) * a(11) +
    a(13) * a(3) * a(10);
  inv[5] =
    a(0) * a(10) * a(15) -
    a(0) * a(11) * a(14) -
    a(8) * a(2) * a(15) +
    a(8) * a(3) * a(14) +
    a(12) * a(2) * a(11) -
    a(12) * a(3) * a(10);
  inv[9] =
    -a(0) * a(9) * a(15) +
    a(0) * a(11) * a(13) +
    a(8) * a(1) * a(15) -
    a(8) * a(3) * a(13) -
    a(12) * a(1) * a(11) +
    a(12) * a(3) * a(9);
  inv[13] =
    a(0) * a(9) * a(14) -
    a(0) * a(10) * a(13) -
    a(8) * a(1) * a(14) +
    a(8) * a(2) * a(13) +
    a(12) * a(1) * a(10) -
    a(12) * a(2) * a(9);
  inv[2] =
    a(1) * a(6) * a(15) -
    a(1) * a(7) * a(14) -
    a(5) * a(2) * a(15) +
    a(5) * a(3) * a(14) +
    a(13) * a(2) * a(7) -
    a(13) * a(3) * a(6);
  inv[6] =
    -a(0) * a(6) * a(15) +
    a(0) * a(7) * a(14) +
    a(4) * a(2) * a(15) -
    a(4) * a(3) * a(14) -
    a(12) * a(2) * a(7) +
    a(12) * a(3) * a(6);
  inv[10] =
    a(0) * a(5) * a(15) -
    a(0) * a(7) * a(13) -
    a(4) * a(1) * a(15) +
    a(4) * a(3) * a(13) +
    a(12) * a(1) * a(7) -
    a(12) * a(3) * a(5);
  inv[14] =
    -a(0) * a(5) * a(14) +
    a(0) * a(6) * a(13) +
    a(4) * a(1) * a(14) -
    a(4) * a(2) * a(13) -
    a(12) * a(1) * a(6) +
    a(12) * a(2) * a(5);
  inv[3] =
    -a(1) * a(6) * a(11) +
    a(1) * a(7) * a(10) +
    a(5) * a(2) * a(11) -
    a(5) * a(3) * a(10) -
    a(9) * a(2) * a(7) +
    a(9) * a(3) * a(6);
  inv[7] =
    a(0) * a(6) * a(11) -
    a(0) * a(7) * a(10) -
    a(4) * a(2) * a(11) +
    a(4) * a(3) * a(10) +
    a(8) * a(2) * a(7) -
    a(8) * a(3) * a(6);
  inv[11] =
    -a(0) * a(5) * a(11) +
    a(0) * a(7) * a(9) +
    a(4) * a(1) * a(11) -
    a(4) * a(3) * a(9) -
    a(8) * a(1) * a(7) +
    a(8) * a(3) * a(5);
  inv[15] =
    a(0) * a(5) * a(10) -
    a(0) * a(6) * a(9) -
    a(4) * a(1) * a(10) +
    a(4) * a(2) * a(9) +
    a(8) * a(1) * a(6) -
    a(8) * a(2) * a(5);
  const det =
    a(0) * (inv[0] as number) +
    a(1) * (inv[4] as number) +
    a(2) * (inv[8] as number) +
    a(3) * (inv[12] as number);
  return inv.map((v) => v / det);
}

/** A matrix's rotation as a unit quaternion x, y, z, w, its columns' scale divided out first. */
function rotationOf(m: Mat4, scale: readonly number[], out: Float32Array, at: number): void {
  const r = (col: number, row: number): number =>
    (m[col * 4 + row] as number) / (scale[col] as number);
  const trace = r(0, 0) + r(1, 1) + r(2, 2);
  let [x, y, z, w] = [0, 0, 0, 1];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r(1, 2) - r(2, 1)) / s;
    y = (r(2, 0) - r(0, 2)) / s;
    z = (r(0, 1) - r(1, 0)) / s;
  } else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) {
    const s = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2;
    w = (r(1, 2) - r(2, 1)) / s;
    x = s / 4;
    y = (r(1, 0) + r(0, 1)) / s;
    z = (r(2, 0) + r(0, 2)) / s;
  } else if (r(1, 1) > r(2, 2)) {
    const s = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2;
    w = (r(2, 0) - r(0, 2)) / s;
    x = (r(1, 0) + r(0, 1)) / s;
    y = s / 4;
    z = (r(2, 1) + r(1, 2)) / s;
  } else {
    const s = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2;
    w = (r(0, 1) - r(1, 0)) / s;
    x = (r(2, 0) + r(0, 2)) / s;
    y = (r(2, 1) + r(1, 2)) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  out[at] = x / n;
  out[at + 1] = y / n;
  out[at + 2] = z / n;
  out[at + 3] = w / n;
}

async function main(): Promise<number> {
  const started = performance.now();
  const out = resolve(flag('--out') ?? 'demo/dev/public/district');
  const log = (line: string): void => console.log(line);
  const blend = openSource(resolve(flag('--source') ?? DEFAULT_SOURCE), log);
  const scene = readScene(blend);
  const render = activeScene(blend)?.sub('r');
  const [first, last] = [render?.int('sfra') ?? 0, render?.int('efra') ?? 3600];
  const fps = (render?.int('frs_sec') ?? 30) / (render?.float('frs_sec_base') ?? 1);
  log(
    `movers: ${scene.movers.length}, the scene's frames ${first}..${last} at ${fps} fps, each sampled over its own keys at ${RATE} a second`,
  );

  const pieces = new Map<string, KitPiece>();
  for (const m of scene.movers) {
    if (pieces.has(m.key)) continue;
    const object = scene.sample.get(m.key);
    const piece = object === undefined ? null : buildPiece(blend, m.key, object);
    if (piece !== null) pieces.set(m.key, piece);
  }
  const pictures = new Pictures(join(homedir(), '.cache', 'district-bake'));
  const materials = new Materials(pictures, blend.header.version);
  /* One mesh a part and a colour: the same model worn in two paints is two batches. */
  const variants = new Map<string, { mesh: MeshData; row: number; movers: number[] }>();
  const placed: number[] = [];
  scene.movers.forEach((m, index) => {
    const piece = pieces.get(m.key);
    if (piece === undefined) return;
    placed.push(index);
    piece.parts.forEach((part, p) => {
      const slot = piece.slotOf[p] ?? -1;
      const row = materials.of(part, slot < 0 ? null : (m.slots[slot] ?? null));
      materials.wear(row, 50);
      const key = `${m.key}#${p}#${row}`;
      const variant = variants.get(key) ?? { mesh: part.mesh, row, movers: [] };
      variant.movers.push(index);
      variants.set(key, variant);
    });
  });
  await materials.write(log);

  /* Each mover's own span of keys, at most `LONGEST_SEC`, the scene's range for one with none. */
  const spans = scene.movers.map((m) => {
    const animation = new Animation(m.object);
    const [lo, hi] = animation.animated ? animation.range : [first, last];
    const end = Math.min(hi, lo + LONGEST_SEC * fps);
    return { animation, lo, samples: Math.max(2, Math.floor(((end - lo) / fps) * RATE) + 1) };
  });
  const tracks = new Float32Array(spans.reduce((n, span) => n + span.samples, 0) * 7);
  const movers: MoversFile['movers'][number][] = [];
  let looped = 0;
  let offset = 0;
  const values = new Map<string, number>();
  scene.movers.forEach((m, index) => {
    const { animation, lo, samples } = spans[index] as (typeof spans)[number];
    const restInverse = invert(localMatrix(m.object));
    const w = m.world;
    const scale: [number, number, number] = [0, 1, 2].map(
      (c) => Math.hypot(w[c * 4] as number, w[c * 4 + 1] as number, w[c * 4 + 2] as number) || 1,
    ) as [number, number, number];
    const period = (samples - 1) / RATE;
    const phase = ((((first - lo) / fps) % period) + period) % period;
    movers.push({
      scale,
      rest: [w[12] as number, w[13] as number, w[14] as number],
      offset,
      samples,
      phase,
    });
    for (let s = 0; s < samples; s++) {
      const frame = lo + (s / RATE) * fps;
      values.clear();
      const moving = animation.animated ? animation.values(frame, values) : undefined;
      const at: Mat4 = multiply(w, toYUp(multiply(restInverse, localMatrix(m.object, moving))));
      const o = (offset + s) * 7;
      tracks[o] = at[12] as number;
      tracks[o + 1] = at[13] as number;
      tracks[o + 2] = at[14] as number;
      rotationOf(at, scale, tracks, o + 3);
    }
    const a = offset * 7;
    const b = (offset + samples - 1) * 7;
    if (
      Math.hypot(
        (tracks[a] as number) - (tracks[b] as number),
        (tracks[a + 1] as number) - (tracks[b + 1] as number),
        (tracks[a + 2] as number) - (tracks[b + 2] as number),
      ) < 1
    )
      looped++;
    offset += samples;
  });
  log(
    `tracks: ${placed.length} movers placed, ${looped} end where they began, ${(tracks.byteLength / 1e6).toFixed(1)} MB`,
  );

  const list = [...variants.values()];
  const meshes = list.map((v) => v.mesh);
  const drfts: DrftMaterial[] = list.map(
    (v) => (materials.rows[v.row] as { drft: DrftMaterial }).drft,
  );
  const instances: DrftInstanceGroup[] = list.map((v, mesh) => {
    const transforms = new Float32Array(v.movers.length * 16);
    v.movers.forEach((index, k) =>
      transforms.set((scene.movers[index] as { world: Mat4 }).world, k * 16),
    );
    return { mesh, transforms };
  });
  const container = writeDrft({
    head: { name: 'district movers', generator: 'district bake' },
    meshes,
    materials: drfts,
    textures: pictures.written,
    texturesFirst: true,
    quantise: true,
    instances,
  });
  const file: MoversFile = {
    version: 2,
    rate: RATE,
    variants: list.map((v) => ({ movers: v.movers })),
    movers,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'movers.drft'), new Uint8Array(container));
  writeFileSync(join(out, 'movers.json'), JSON.stringify(file));
  writeFileSync(join(out, 'movers.bin'), new Uint8Array(tracks.buffer));
  log(
    `wrote movers.drft (${(container.byteLength / 1e6).toFixed(1)} MB, ${list.length} batches, ${pictures.written.length} pictures), movers.json and movers.bin, ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
