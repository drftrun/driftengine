#!/usr/bin/env node
/**
 * What best fit costs a world that remeshes its chunks, counted rather than argued.
 *
 * **§3.5 of `specs/2026-09-18-gpu-driven-living-scene-design.md` left one decision open and said a
 * measurement would settle it.** `RangeAlloc` is a best-fit free list, which is the first
 * implementation rather than the proven one; the alternative is fixed-size pages, which bound the
 * worst case by construction and put an indirection in the vertex fetch — four shaders changed to
 * solve a problem nobody had measured. This is the measurement.
 *
 * **The number that names fragmentation is not occupancy.** A scene that fills up has run out, and
 * running out is a budget being wrong rather than an allocator being wrong. The failure a free list
 * has and a page table does not is an add refused *while the total free exceeds what it asked for*:
 * the room is there, in pieces, and no piece is long enough. So that is what is counted, and it is
 * the only thing this script exits non-zero on.
 *
 * **The workload is the one that would cause it**, which is a voxel world rather than a scene:
 *
 * - chunks arrive and leave as a player walks an outward spiral, so a ring of loaded chunks sweeps
 *   across new ground for the whole run and the free list never gets a quiet moment;
 * - a chunk's size is drawn toward the small end with a long tail, because most of a voxel world is
 *   solid rock or open air and almost all of the geometry is the thin surface between them;
 * - **one operation in twenty is a remesh**, which is a block being broken or placed: the chunk is
 *   removed and added back *at a slightly different size*. That is the move a free list is worst at
 *   — a run of 1,040 handed back and 1,065 asked for immediately after — and it is what a player
 *   with a pickaxe does all day.
 *
 * **The geometry is not the subject and is not pretended to be.** Every chunk is a sheet of quads
 * written out of one scratch mesh sized to the largest chunk, handed to `add` as views. What varies
 * is the *sizes*, because sizes are all a free list can see. A cluster holds at most 128 triangles
 * here because that is what `visbuffer.ts` packs into seven bits, so the cluster counts are the
 * pipeline's own and not a guess.
 *
 * **Capacity comes from a pilot run rather than from a constant**, so "headroom" means what it
 * says. The walk is run once against an allocator large enough that it can never refuse, which
 * gives the peak live units the workload actually needs; every measured run is then that peak times
 * a headroom. A capacity picked by hand would have been the answer smuggled into the question.
 *
 * It needs no GPU and no browser — fragmentation is a property of the allocator and the workload:
 *
 *     node scripts/stream-fragmentation.mjs
 *
 * **What it will not tell you** is whether the engine is fast. It counts refusals, and an allocator
 * that never refuses may still be spending a millisecond a frame walking its holes. Nothing here
 * measures that, and the timings printed are wall clock over a whole run, for scale only.
 */

import { StreamingScene } from '../packages/core/src/render/gpudriven/streamScene.ts';

/* --------------------------------------------------------------- the world */

/** Triangles a cluster, which is what `visbuffer.ts` packs into seven bits. */
const CLUSTER_TRIANGLES = 128;
/** A quad is two triangles and four vertices, so a full cluster is this many quads. */
const QUADS_PER_CLUSTER = CLUSTER_TRIANGLES / 2;

/** The smallest and largest chunk mesh, in quads. A chunk is drawn between them. */
const MIN_QUADS = 128;
const MAX_QUADS = 2048;

/** Chebyshev radius of the loaded ring, in chunks. Five gives an 11 by 11 ring of 121. */
const RING = 5;
const RING_CELLS = (RING * 2 + 1) ** 2;

/** Operations to run, and how often a row is printed. Both from the plan's task 7. */
const OPERATIONS = 20000;
const REPORT_EVERY = 1000;

/** One operation in twenty is a block edit. */
const REMESH_IN = 20;

/**
 * The headroom the gate runs at, and the ladder reported beneath it.
 *
 * **A quarter spare is what a streaming budget can afford**, and it is the number the exit code
 * keys on. The ladder exists because one headroom is one point: a free list that is clean at 1.50
 * and refuses at 1.05 has not been shown to be clean, it has been shown to be untested, and where
 * it starts to fail is the number the page-table decision would actually be made on.
 */
const HEADROOM = 1.25;

/**
 * The rungs reported beneath the gate, ending below 1.00 on purpose.
 *
 * **The last rung is a budget that cannot hold the world**, and it is there to show that the two
 * counters can be told apart rather than to measure the allocator. Every rung at or above 1.00
 * refuses with room or not at all, so on those alone the sentence "no single run was long enough"
 * is an assertion about a branch nothing ever takes; at 0.85 the ring genuinely does not fit and
 * the refusals land in the other column, which is what makes the zeros above mean something.
 */
const LADDER = [1.5, 1.35, 1.25, 1.15, 1.05, 0.85];

/* ------------------------------------------------------------ the scratch mesh */

/**
 * One mesh at the largest size a chunk can be, which every chunk is a prefix of.
 *
 * A quad `q` owns vertices `4q` to `4q+3` and triangles `2q` and `2q+1`, so every array here is
 * valid for any prefix and only the per-cluster triangle counts change from chunk to chunk.
 */
function scratchMesh() {
  const verts = MAX_QUADS * 4;
  const tris = MAX_QUADS * 2;
  const clusters = Math.ceil(MAX_QUADS / QUADS_PER_CLUSTER);

  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const colours = new Float32Array(verts * 3);
  const indices = new Uint32Array(tris * 3);

  for (let q = 0; q < MAX_QUADS; q += 1) {
    /* A strip of unit quads laid along x, folded into rows so a chunk stays roughly square. */
    const row = Math.floor(q / 45);
    const col = q % 45;
    for (let corner = 0; corner < 4; corner += 1) {
      const v = q * 4 + corner;
      positions[v * 3] = col + (corner === 1 || corner === 2 ? 1 : 0);
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = row + (corner >= 2 ? 1 : 0);
      normals[v * 3 + 1] = 1;
      colours[v * 3] = 0.5;
      colours[v * 3 + 1] = 0.5;
      colours[v * 3 + 2] = 0.5;
    }
    const base = q * 4;
    const at = q * 6;
    indices[at] = base;
    indices[at + 1] = base + 1;
    indices[at + 2] = base + 2;
    indices[at + 3] = base;
    indices[at + 4] = base + 2;
    indices[at + 5] = base + 3;
  }

  const triangleOffsets = new Uint32Array(clusters);
  const triangleCounts = new Uint32Array(clusters);
  const boundsCentre = new Float32Array(clusters * 3);
  const boundsRadius = new Float32Array(clusters);
  const coneAxis = new Float32Array(clusters * 3);
  const coneCutoff = new Float32Array(clusters);
  const ownError = new Float32Array(clusters);
  const parentError = new Float32Array(clusters);
  for (let c = 0; c < clusters; c += 1) {
    triangleOffsets[c] = c * CLUSTER_TRIANGLES;
    boundsCentre[c * 3] = (c % 8) * 6;
    boundsCentre[c * 3 + 2] = Math.floor(c / 8) * 6;
    boundsRadius[c] = 5;
    coneAxis[c * 3 + 1] = 1;
    coneCutoff[c] = -1;
    ownError[c] = 0;
    parentError[c] = 1e30;
  }

  return {
    positions,
    normals,
    colours,
    indices,
    triangleOffsets,
    triangleCounts,
    boundsCentre,
    boundsRadius,
    coneAxis,
    coneCutoff,
    ownError,
    parentError,
  };
}

/** A `GpuDrivenMesh` of `quads` quads, as views into the scratch. Nothing is allocated. */
function chunkMesh(scratch, quads) {
  const tris = quads * 2;
  const clusters = Math.ceil(quads / QUADS_PER_CLUSTER);
  for (let c = 0; c < clusters; c += 1) {
    scratch.triangleCounts[c] = Math.min(CLUSTER_TRIANGLES, tris - c * CLUSTER_TRIANGLES);
  }
  return {
    positions: scratch.positions.subarray(0, quads * 12),
    normals: scratch.normals.subarray(0, quads * 12),
    colours: scratch.colours.subarray(0, quads * 12),
    clusters: {
      count: clusters,
      triangleOffsets: scratch.triangleOffsets.subarray(0, clusters),
      triangleCounts: scratch.triangleCounts.subarray(0, clusters),
      boundsCentre: scratch.boundsCentre.subarray(0, clusters * 3),
      boundsRadius: scratch.boundsRadius.subarray(0, clusters),
      coneAxis: scratch.coneAxis.subarray(0, clusters * 3),
      coneCutoff: scratch.coneCutoff.subarray(0, clusters),
      ownError: scratch.ownError.subarray(0, clusters),
      parentError: scratch.parentError.subarray(0, clusters),
      indices: scratch.indices.subarray(0, quads * 6),
    },
    material: 0,
  };
}

/** What a chunk of `quads` quads costs on each axis. */
function unitsOf(quads) {
  return {
    vertices: quads * 4,
    indices: quads * 6,
    clusters: Math.ceil(quads / QUADS_PER_CLUSTER),
    meshes: 1,
  };
}

/* ------------------------------------------------------------------ the walk */

/** A deterministic value in [0, 1) for a chunk, so a world is the same world on every run. */
function hash2(x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A chunk's size before anybody digs in it.
 *
 * **Squared rather than uniform**, because most of a voxel world is solid or empty and the
 * geometry lives on the thin surface between: a lot of small chunks, a few very large ones. A
 * uniform draw would be a kinder workload than the thing being modelled.
 */
function baseQuads(x, z) {
  const u = hash2(x, z);
  return Math.round(MIN_QUADS + (MAX_QUADS - MIN_QUADS) * u * u);
}

/** The next cell of an outward square spiral, one call a player step. */
function spiralWalk() {
  let x = 0;
  let z = 0;
  let dx = 1;
  let dz = 0;
  let leg = 1;
  let taken = 0;
  let turns = 0;
  return () => {
    const here = [x, z];
    x += dx;
    z += dz;
    taken += 1;
    if (taken === leg) {
      taken = 0;
      const swap = dx;
      dx = -dz;
      dz = swap;
      turns += 1;
      if (turns === 2) {
        turns = 0;
        leg += 1;
      }
    }
    return here;
  };
}

/* -------------------------------------------------------------------- the run */

const AXES = ['vertices', 'indices', 'clusters', 'meshes'];

/**
 * Walk the world against one capacity and report.
 *
 * `rows` is a row every `REPORT_EVERY` operations; `refusedWithRoom` is the number the decision
 * rests on and `refusedFull` is the ordinary case of a budget being too small.
 */
function run(scratch, capacity) {
  const scene = new StreamingScene(capacity);
  const loaded = new Map();
  const size = new Map();
  const live = { vertices: 0, indices: 0, clusters: 0, meshes: 0 };
  const peak = { vertices: 0, indices: 0, clusters: 0, meshes: 0 };
  const transform = new Float32Array(16);
  transform[0] = 1;
  transform[5] = 1;
  transform[10] = 1;
  transform[15] = 1;

  let ops = 0;
  let refusedWithRoom = 0;
  let refusedFull = 0;
  let owedRemeshes = 0;
  let nextReport = REPORT_EVERY;
  const rows = [];
  const step = spiralWalk();
  const started = process.hrtime.bigint();

  const quadsAt = (x, z) => {
    const key = `${x},${z}`;
    const held = size.get(key);
    return held === undefined ? baseQuads(x, z) : held;
  };

  const place = (x, z, quads) => {
    const want = unitsOf(quads);
    transform[12] = x * 48;
    transform[14] = z * 48;
    const handle = scene.add(chunkMesh(scratch, quads), transform, 0);
    if (handle === null) {
      /*
       * **Room on every axis and a refusal anyway is the whole measurement.** The total free is
       * larger than the request and no single run is long enough — which is the one failure a free
       * list has that a page table does not, and the one §3.5 opens the escape hatch for.
       */
      const roomEverywhere = AXES.every((axis) => want[axis] <= capacity[axis] - live[axis]);
      if (roomEverywhere) refusedWithRoom += 1;
      else refusedFull += 1;
      return false;
    }
    loaded.set(`${x},${z}`, handle);
    size.set(`${x},${z}`, quads);
    for (const axis of AXES) {
      live[axis] += want[axis];
      if (live[axis] > peak[axis]) peak[axis] = live[axis];
    }
    return true;
  };

  const drop = (key) => {
    const handle = loaded.get(key);
    if (handle === undefined) return;
    scene.remove(handle);
    loaded.delete(key);
    const want = unitsOf(size.get(key));
    for (const axis of AXES) live[axis] -= want[axis];
  };

  const report = () => {
    /*
     * **The script's own bookkeeping against the allocator's**, on the one axis the class exposes.
     * If these ever disagree the refusal classification above is worthless, because it is computed
     * from this side of the pair.
     */
    const theirs = scene.freeVertices;
    const mine = capacity.vertices - live.vertices;
    if (theirs !== mine) {
      throw new Error(
        `driftengine: the walk thinks ${String(mine)} vertices are free and the scene thinks ` +
          `${String(theirs)}. One of them has lost a range and the refusal counts below are ` +
          `computed from the walk's side, so the run is not worth reading.`,
      );
    }
    const high = scene.highWater;
    rows.push({
      ops,
      live: { ...live },
      high: { ...high },
      refusedWithRoom,
      refusedFull,
    });
  };

  while (ops < OPERATIONS) {
    const [px, pz] = step();
    let reconciled = 0;

    for (const key of [...loaded.keys()]) {
      const [kx, kz] = key.split(',').map(Number);
      if (Math.abs(kx - px) <= RING && Math.abs(kz - pz) <= RING) continue;
      drop(key);
      reconciled += 1;
      ops += 1;
      if (ops >= nextReport) {
        report();
        nextReport += REPORT_EVERY;
      }
    }

    for (let dz = -RING; dz <= RING && ops < OPERATIONS; dz += 1) {
      for (let dx = -RING; dx <= RING && ops < OPERATIONS; dx += 1) {
        const x = px + dx;
        const z = pz + dz;
        if (loaded.has(`${x},${z}`)) continue;
        place(x, z, quadsAt(x, z));
        reconciled += 1;
        ops += 1;
        if (ops >= nextReport) {
          report();
          nextReport += REPORT_EVERY;
        }
      }
    }

    /*
     * **A remesh every nineteen reconciles, which makes it one operation in twenty**, carried as a
     * fraction so the long-run rate is exact rather than rounded up on every short step.
     */
    owedRemeshes += reconciled / (REMESH_IN - 1);
    while (owedRemeshes >= 1 && ops < OPERATIONS) {
      owedRemeshes -= 1;
      const keys = [...loaded.keys()];
      if (keys.length === 0) break;
      const key = keys[Math.floor(hash2(ops, px * 31 + pz) * keys.length)];
      const [kx, kz] = key.split(',').map(Number);
      const was = size.get(key);
      /* A block broken or placed moves the mesh a little, which is the hard case, not a fresh draw. */
      const shift = 0.85 + 0.3 * hash2(ops * 7 + 1, kx * 17 + kz);
      const now = Math.min(MAX_QUADS, Math.max(MIN_QUADS, Math.round(was * shift)));
      drop(key);
      size.set(key, now);
      place(kx, kz, now);
      ops += 1;
      if (ops >= nextReport) {
        report();
        nextReport += REPORT_EVERY;
      }
    }
  }

  if (rows.length === 0 || rows[rows.length - 1].ops !== ops) report();

  return {
    rows,
    peak,
    high: scene.highWater,
    refusedWithRoom,
    refusedFull,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

/* ------------------------------------------------------------------ reporting */

function grouped(n) {
  const digits = String(Math.round(n));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

function pct(part, whole) {
  return whole === 0 ? '  n/a' : `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

const scratch = scratchMesh();

/*
 * **The pilot, against an allocator that cannot refuse.** Its capacity is the analytic worst case —
 * every cell of the ring at the largest a chunk can be — so the peak it reports is the workload's
 * own demand rather than anything this script chose.
 */
const unbounded = {
  vertices: RING_CELLS * MAX_QUADS * 4,
  indices: RING_CELLS * MAX_QUADS * 6,
  clusters: RING_CELLS * Math.ceil(MAX_QUADS / QUADS_PER_CLUSTER),
  meshes: RING_CELLS,
};
const pilot = run(scratch, unbounded);
if (pilot.refusedWithRoom + pilot.refusedFull > 0) {
  throw new Error(
    'driftengine: the pilot run refused an add against a capacity sized to the analytic worst ' +
      'case. The bound is wrong, so every headroom below it is measured against nothing.',
  );
}

console.log(`=== ${grouped(OPERATIONS)} operations, a ring of ${String(RING_CELLS)} chunks ===\n`);
console.log(
  `chunks are ${grouped(MIN_QUADS)} to ${grouped(MAX_QUADS)} quads, drawn toward the small end; ` +
    `one operation in ${String(REMESH_IN)} is a remesh`,
);
console.log(
  `peak live: ${grouped(pilot.peak.vertices)} vertices, ${grouped(pilot.peak.indices)} indices, ` +
    `${grouped(pilot.peak.clusters)} clusters, ${grouped(pilot.peak.meshes)} meshes ` +
    `(${pilot.ms.toFixed(0)} ms unbounded)\n`,
);

function capacityFor(headroom) {
  return {
    vertices: Math.ceil(pilot.peak.vertices * headroom),
    indices: Math.ceil(pilot.peak.indices * headroom),
    clusters: Math.ceil(pilot.peak.clusters * headroom),
    meshes: Math.ceil(pilot.peak.meshes * headroom),
  };
}

const gate = capacityFor(HEADROOM);
const gated = run(scratch, gate);

console.log(`--- the gate: ${HEADROOM.toFixed(2)}x headroom ---`);
console.log(
  `capacity ${grouped(gate.vertices)} vertices, ${grouped(gate.indices)} indices, ` +
    `${grouped(gate.clusters)} clusters, ${grouped(gate.meshes)} meshes\n`,
);
console.log('     ops    vert   vertHW     idx    idxHW    clus    clusHW    mesh   room   full');
for (const row of gated.rows) {
  console.log(
    `${grouped(row.ops).padStart(8)}  ${pct(row.live.vertices, gate.vertices)}   ` +
      `${pct(row.high.vertices, gate.vertices)}  ${pct(row.live.indices, gate.indices)}   ` +
      `${pct(row.high.indices, gate.indices)}  ${pct(row.live.clusters, gate.clusters)}   ` +
      `${pct(row.high.clusters, gate.clusters)}  ${pct(row.live.meshes, gate.meshes)}  ` +
      `${String(row.refusedWithRoom).padStart(5)}  ${String(row.refusedFull).padStart(5)}`,
  );
}

console.log('\n--- where it starts to fail ---\n');
console.log('  headroom   refused with room   refused full   ms');
for (const headroom of LADDER) {
  const result = headroom === HEADROOM ? gated : run(scratch, capacityFor(headroom));
  console.log(
    `     ${headroom.toFixed(2)}x   ${String(result.refusedWithRoom).padStart(17)}   ` +
      `${String(result.refusedFull).padStart(12)}   ${result.ms.toFixed(0).padStart(4)}`,
  );
}

console.log(
  `\nrefused with room at ${HEADROOM.toFixed(2)}x headroom: ${String(gated.refusedWithRoom)}`,
);
if (gated.refusedWithRoom > 0) {
  console.log(
    'Fragmentation bites. Section 3.5 of the spec names the answer — fixed-size pages — and says\n' +
      'it is a change to four shaders that deserves its own decision. Stop the plan and raise it.',
  );
  process.exitCode = 1;
} else {
  console.log('Best fit holds on this workload. No page table.');
}
