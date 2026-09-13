/**
 * That a world whose colliders stream is both fast and still correct.
 *
 * **The report.** A consumer moving to a 9.3 × 4.9 km world could not rebuild its `ColliderSet` at
 * a region crossing: measured on their machine, a rebuild costs about 2.1 µs a box and is linear,
 * which is 16.9 ms at the 6,076 colliders they have and 41.2 ms at the 15,000 they are moving to —
 * a whole frame today and two and a half in the world coming, every few seconds, while somebody is
 * driving. The alternative they shipped was one set per region and a query against the nine around
 * the player, which measured 1.19 µs a query against 0.16 µs for a single set: affordable, and a
 * 7.5x multiplier on every collision query in the game.
 *
 * **What this measures.** The engine's real sweep, in Node, against one set that is mutated as a
 * body drives across region boundaries — groups added ahead of it and dropped behind it — at five
 * frame rates: exactly sixty, sixty with the jitter a real clock has, 59.94 like a real panel, 120
 * and 144.
 *
 * **Three of the six assertions are about speed and three are about whether removal works at
 * all**, and the second three exist because the first three cannot see the defect this machinery
 * can actually have. A `remove` that misses a bucket entry leaves the slot marked dead — so the
 * fingerprint skips it and is right, and nothing walks it by index — while the stale entry goes on
 * naming it: `query` returns it, and the sweep reads its stale bounds and collides with geometry
 * that is gone. Frame time is unchanged, the query ratio is unchanged, the hash is unchanged, and
 * a player drives into a wall that is not there.
 *
 * **It churns for hundreds of crossings before it measures.** Live slots reach free-list order
 * only after that, and free-list order is unrelated to spatial order while the freshly built
 * comparison set has slot order equal to input order — which is what assertion 2 is exposed to. A
 * short run passes for a reason the field would not.
 *
 * If this ever fails at every rate except 59.94, the cause is not here: at that rate the steps per
 * frame are exactly one, and a fault that hides there is a fault in the loop's stepping and not in
 * the collider set.
 *
 * **The geometry is built before the clock starts, and the first draft of this check did not do
 * that.** It called `boxCollider` inside the crossing frame and reported 6 to 7 ms, which read
 * exactly like a broadphase that had not been fixed. Measured apart: generating 150 colliders is
 * 2.086 ms, because `boxCollider` runs `hullShape` on eight points, while `add` is 0.164 ms and
 * `remove` is 0.165 ms. So five sixths of that frame was the harness inventing a world. A streamer
 * loads geometry from data or builds it off the main thread; what this track changed is the two
 * calls that put it into the set and take it out, and those are what the clock is around.
 *
 * `npm run check:streaming`.
 */
import { AXIS_X, AXIS_Z } from '../src/collide/body';
import { moveAxis } from '../src/collide/sweep';
import type { Body } from '../src/collide/body';
import { ColliderSet, boxCollider } from '../src/colliderSet';
import type { Collider, ColliderGroup } from '../src/colliderSet';
import { fingerprintColliders } from '../src/fingerprint';

/** Metres a side. The consumer's own region size, so the numbers are about their world. */
const REGION = 500;
/** Colliders in a region, at the density the world being moved to has. */
const PER_REGION = 150;
/** How many regions stay resident around the player: the ring a streamer keeps. */
const RESIDENT = 9;
/** Crossings driven before anything is measured. See the header on free-list order. */
const WARMUP_CROSSINGS = 400;
/** Crossings measured after that. */
const MEASURED_CROSSINGS = 200;
/** Regions the drive will touch, generated once and shared by all five rates. */
const TOTAL_REGIONS = WARMUP_CROSSINGS + MEASURED_CROSSINGS + RESIDENT;
/** Metres a second. Ninety an hour, which is what the report was driving at. */
const SPEED = 25;

/**
 * What a crossing may typically cost, in milliseconds.
 *
 * **Measured at 0.090 ms, and the rebuild it replaces costs 41 ms at this size.** So the threshold
 * sits far closer to what is measured than to what it replaces, and a regression that matters here
 * is an order of magnitude and not a few per cent. Five times the measurement is headroom for a
 * slower machine, not slack for a change.
 *
 * **This is the median and not the maximum**, which is the split the first draft of this check got
 * wrong. See `CROSSING_WORST_MS`.
 */
const CROSSING_MEDIAN_MS = 0.5;

/**
 * What a crossing may cost in the worst case, in milliseconds: a whole frame.
 *
 * **Because the maximum here is the runtime's and not the engine's.** Measured over two hundred
 * crossings the median is 0.090 ms and the p99 is 0.38 ms, while the maximum lands between 1.6 and
 * 4.4 ms at every rate — and it moves between runs on identical work, which is a garbage
 * collection landing in the sample. Two hundred samples put the p99 on its last two, so no
 * percentile at this sample size can tell a pause from a regression.
 *
 * So the two claims are asserted separately: the collider work is the median, and the claim a
 * player would care about is that **no crossing drops a frame even with the runtime's pauses in
 * it**, which is this one. A threshold on the maximum tight enough to catch a regression would be
 * a check that fails at random, which is worse than no check.
 */
const CROSSING_WORST_MS = 16.7;

/**
 * How much dearer a query on the streamed set may be than on a freshly built one.
 *
 * **Not 1.0, and the reason is cache locality rather than anything the structure does wrong.**
 * After hundreds of cycles the live slots sit in free-list order, which is a function of load
 * history, while the comparison set has slot order equal to input order — and the sweep indexes
 * `data` at exactly those slots. The number that matters is that it is nowhere near the 7.5x the
 * per-region workaround costs: this is the assertion that the workaround can be deleted. If it
 * ever approaches 7.5 the answer is a compaction pass and not a bug hunt.
 *
 * Measured between 1.24 and 1.30 across the five rates, so this sits nearer the measurement than
 * the thing it rules out.
 */
const QUERY_RATIO = 2.5;

const FRAME_RATES: readonly (readonly [string, number, number])[] = [
  ['60', 60, 0],
  ['60 jittered', 60, 0.3],
  ['59.94', 59.94, 0],
  ['120', 120, 0],
  ['144', 144, 0],
];

/** A deterministic generator, so a failure is reproducible and a rerun is comparable. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}

/**
 * One region's colliders, laid along the drive so the body meets them.
 *
 * **Seeded from the region index**, so every rate drives the same world and a failure at one rate
 * and not another is about the loop and not about the geometry.
 */
function region(index: number): Collider[] {
  const random = rng(0x9e37 + index * 2654435761);
  const boxes: Collider[] = [];
  const originX = index * REGION;
  for (let i = 0; i < PER_REGION; i++) {
    const x = originX + random() * REGION;
    const z = (random() - 0.5) * 60;
    /* Kept clear of the driving line at z = 0 so the body meets walls without being trapped by
       them: this measures a broadphase, not a pathfinder. */
    const offset = z >= 0 ? z + 6 : z - 6;
    boxes.push(boxCollider(x, 1.5, offset, 1 + random() * 3, 1.5, 1 + random() * 3));
  }
  return boxes;
}

/*
 * **Every region built once, before any clock starts.** See the header: generating a region is
 * 2.086 ms of `hullShape` and is the consumer's cost, not the engine's, and leaving it inside the
 * timed frame made a fixed broadphase read as a broken one.
 */
const WORLD: readonly Collider[][] = Array.from({ length: TOTAL_REGIONS }, (_, i) => region(i));

interface Rig {
  readonly set: ColliderSet;
  readonly resident: Map<number, ColliderGroup>;
}

function newRig(): Rig {
  return { set: new ColliderSet([]), resident: new Map() };
}

/** Load what the player can see and drop what they cannot, which is what a streamer does. */
function stream(rig: Rig, centre: number): void {
  const half = (RESIDENT - 1) / 2;
  for (let r = centre - half; r <= centre + half; r++) {
    if (r < 0 || r >= WORLD.length || rig.resident.has(r)) continue;
    rig.resident.set(r, rig.set.add(WORLD[r] as Collider[]));
  }
  for (const [r, group] of [...rig.resident]) {
    if (Math.abs(r - centre) <= half) continue;
    rig.set.remove(group);
    rig.resident.delete(r);
  }
}

/** Every live collider in the set, as a fresh dense array, for the comparison build. */
function liveColliders(set: ColliderSet): Collider[] {
  const out: Collider[] = [];
  for (let slot = 0; slot < set.capacity; slot++) {
    if (!set.liveAt(slot)) continue;
    const o = slot * 6;
    out.push({
      minX: set.data[o] as number,
      minY: set.data[o + 1] as number,
      minZ: set.data[o + 2] as number,
      maxX: set.data[o + 3] as number,
      maxY: set.data[o + 4] as number,
      maxZ: set.data[o + 5] as number,
      shape: set.shapeAt(slot),
    });
  }
  return out;
}

/** Microseconds a query, averaged over a sweep of the resident band. */
function queryCostUs(set: ColliderSet, centre: number, samples: number): number {
  const hits = new Int32Array(ColliderSet.MAX_HITS);
  const from = (centre - 4) * REGION;
  const started = performance.now();
  for (let i = 0; i < samples; i++) {
    const x = from + ((i * 977) % (REGION * RESIDENT));
    set.query(x - 0.5, 0, -1.5, x + 0.5, 2, 1.5, hits);
  }
  return ((performance.now() - started) * 1000) / samples;
}

const failures: string[] = [];
function check(ok: boolean, message: string): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${message}`);
  if (!ok) failures.push(message);
}

/* ------------------------------------------------------------------ 3, 4, 5, 6 */

console.log('\ncorrectness');

/*
 * **Assertion 3.** A set built in one shot hashes to the string it hashed to before any of this
 * existed. The literal is the same one `fingerprint.test.ts` pins, and it is here as well as there
 * because a recording is compared against a *running* engine and not against a unit test.
 */
{
  const one = new ColliderSet([
    { minX: -1, minY: -2, minZ: -3, maxX: 1, maxY: 2, maxZ: 3 },
    { minX: 9.5, minY: -4.5, minZ: 6.5, maxX: 10.5, maxY: -3.5, maxZ: 7.5 },
  ]);
  check(
    fingerprintColliders(one) === '8e0eb495365aade7',
    `a one-shot set fingerprints as it always did (${fingerprintColliders(one)})`,
  );
}

/*
 * **Assertion 4.** After a group is dropped, a query over the volume it occupied returns none of
 * its slots, and a body driven through where it stood passes. The second half is the one a player
 * would notice, and it is the reason this is not just a query test.
 */
{
  const set = new ColliderSet([]);
  const wall = set.add([boxCollider(10, 1.5, 0, 0.5, 1.5, 8)]);
  const body: Body = { x: 0, y: 1, z: 0, hx: 0.4, hy: 1, hz: 0.4 };
  let travelled = 0;
  for (let i = 0; i < 400; i++) travelled += moveAxis(body, set, AXIS_X, 0.05);
  check(
    travelled < 12,
    `a wall stops the body while it is there (travelled ${travelled.toFixed(2)} m)`,
  );

  set.remove(wall);
  const hits = new Int32Array(ColliderSet.MAX_HITS);
  check(set.query(9, 0, -8, 11, 3, 8, hits) === 0, 'a query over the dropped volume finds nothing');

  const after: Body = { x: 0, y: 1, z: 0, hx: 0.4, hy: 1, hz: 0.4 };
  let free = 0;
  for (let i = 0; i < 400; i++) free += moveAxis(after, set, AXIS_X, 0.05);
  check(free > 19.9, `and the body passes through where it was (travelled ${free.toFixed(2)} m)`);
}

/*
 * **Assertion 5.** The inverse, which catches an insert that ran late or not at all: a group put
 * down ahead of the body is solid by the time the body reaches it.
 */
{
  const set = new ColliderSet([]);
  const body: Body = { x: 0, y: 1, z: 0, hx: 0.4, hy: 1, hz: 0.4 };
  for (let i = 0; i < 100; i++) moveAxis(body, set, AXIS_X, 0.05);
  set.add([boxCollider(10, 1.5, 0, 0.5, 1.5, 8)]);
  let travelled = body.x;
  for (let i = 0; i < 400; i++) moveAxis(body, set, AXIS_X, 0.05);
  travelled = body.x;
  check(
    travelled < 12,
    `a group added ahead is solid when the body arrives (stopped at ${travelled.toFixed(2)} m)`,
  );
}

/* ------------------------------------------------------------------ 1, 2, 6 */

console.log('\nthe drive, at five rates');

for (const [name, hz, jitter] of FRAME_RATES) {
  const rig = newRig();
  const random = rng(hz * 1000);
  const body: Body = { x: 0, y: 1, z: 0, hx: 0.4, hy: 1, hz: 0.4 };
  const crossingMs: number[] = [];
  let crossings = 0;
  let region0 = -1;

  const total = WARMUP_CROSSINGS + MEASURED_CROSSINGS;
  while (crossings < total) {
    const dt = (1 / hz) * (1 + (jitter === 0 ? 0 : (random() - 0.5) * 2 * jitter));
    body.x += SPEED * dt;
    moveAxis(body, rig.set, AXIS_X, 0);
    moveAxis(body, rig.set, AXIS_Z, 0);

    const here = Math.floor(body.x / REGION);
    if (here === region0) continue;

    const started = performance.now();
    stream(rig, here);
    const ms = performance.now() - started;
    region0 = here;
    crossings++;
    /* Warm-up crossings are driven but not judged: the first ones allocate, and the free list has
       not reached the order assertion 2 is exposed to. */
    if (crossings > WARMUP_CROSSINGS) crossingMs.push(ms);
  }
  crossingMs.sort((a, b) => a - b);
  const at = (q: number): number =>
    crossingMs[Math.min(crossingMs.length - 1, Math.floor(crossingMs.length * q))] as number;
  const medianMs = at(0.5);
  const p99Ms = at(0.99);
  const worstMs = crossingMs[crossingMs.length - 1] as number;

  const centre = Math.floor(body.x / REGION);
  const comparison = new ColliderSet(liveColliders(rig.set));
  /* Discarded: the first timed loop of the process pays for JIT that every later one inherits, and
     charging it to whichever set went first made that set look 40% dearer than it is. */
  queryCostUs(rig.set, centre, 20000);
  queryCostUs(comparison, centre, 20000);
  const streamed = queryCostUs(rig.set, centre, 40000);
  const fresh = queryCostUs(comparison, centre, 40000);
  const ratio = streamed / fresh;
  const dead = rig.set.auditCells();
  const cost = rig.set.bytes();

  console.log(
    `\n  ${name} Hz — ${rig.set.count} live in ${rig.set.capacity} slots, ` +
      `${(cost.total / 1048576).toFixed(2)} MB resident`,
  );
  console.log(
    `    crossing: median ${medianMs.toFixed(3)} ms, p99 ${p99Ms.toFixed(3)} ms, worst ${worstMs.toFixed(3)} ms`,
  );
  check(
    medianMs < CROSSING_MEDIAN_MS,
    `a crossing costs ${medianMs.toFixed(3)} ms < ${CROSSING_MEDIAN_MS} ms (a rebuild here is 41 ms)`,
  );
  check(
    worstMs < CROSSING_WORST_MS,
    `and the worst of ${crossingMs.length} drops no frame: ${worstMs.toFixed(3)} ms < ${CROSSING_WORST_MS} ms`,
  );
  check(
    ratio < QUERY_RATIO,
    `query ${streamed.toFixed(3)} µs vs ${fresh.toFixed(3)} µs fresh — ${ratio.toFixed(2)}x < ${QUERY_RATIO}x ` +
      '(the per-region workaround costs 7.5x)',
  );
  check(dead === 0, `no bucket names a dead slot (${dead})`);
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('all assertions passed');
