/**
 * The skinned cloth's solver on the device, in WGSL, hand-authored under the compute exception
 * `AGENTS.md` records (2026-08-24): a compute shader has no WebGL2 twin to generate from, and
 * `npm run wgsl` neither writes nor polices this file.
 *
 * **Written to be read beside `@driftengine/physics`' `skinnedClothSolve.ts` and `clothLimits.ts`**:
 * each kernel there is an entry point here, one invocation a particle or a constraint, and the loop
 * over a batch is the dispatch. `clothPose.ts`' `skinParticles` is `pose`. The order of a step —
 * begin, then per substep predict, the batches, the limits, finish; then the blend — is
 * `gpuClothSet.ts`', taken from the same `ClothControl` the CPU solver is driven by.
 *
 * **Where it differs, it says so.** Single precision throughout, where the CPU rounds to single
 * only on a store. And the bending angle is `atan2(|n1 × n2|, n1 · n2)` rather than `acos(n1 · n2)`
 * with its sine from `sqrt(1 − d²)`: the same function, but a garment spends its life near flat,
 * where `d` is near −1 and `1 − d²` in single precision is rounding — a sine of a few ten-thousandths
 * out of nothing, and a fold pushed by it. The cross product's length is exact there.
 *
 * **How far the two solvers part, measured** (`demo/dev/skinnedCloth.html?parity=1`, RX 9070 XT):
 * a cape hanging in still air agrees to 0.016 mm after 150 frames. With tethers, backstops and a
 * gusting wind it parts by up to 11 mm — and the CPU solver against itself, nudged a tenth of a
 * micrometre a frame, parts by 9 mm at the same frame, and by as much as the device at every
 * checkpoint from the sixtieth on. Contact, buckling and gusts carry a rounding difference that
 * far; the device adds rounding and nothing else. Dropping one multiplier reset parts them by
 * 67 mm, which is the instrument seeing a real difference.
 *
 * **Every particle's state in a few buffers of sections**, because WebGPU grants eight storage
 * buffers to a stage: `state` is the positions, the substep's start, the velocities and the step's
 * start; `pose` the two skinned poses a step interpolates between and the latest skinned normals;
 * `statics` everything per particle that never changes. A section's offset is a multiple of the
 * particle count, which the constants carry — so no offset is a uniform to keep in step.
 *
 * **One dispatch serves every garment of a set** (`clothSetPack.ts`): the particles, constraints,
 * joints and colliders of all of them in those buffers, and each garment's numbers — its step's
 * fraction and blend, its damping, gravity and limits — a record of its own in `paces`, at the
 * round's place. A kernel finds its garment from the particle, and returns at once where that
 * garment has nothing to do this round: a garment that took fewer steps, or one settling alone after
 * a reset, sits the round out while the rest of the set runs it.
 */
export const CLOTH_WORKGROUP = 64;

export const CLOTH_SOLVE_WGSL = /* wgsl */ `
/* The set's: every garment's particles, records, skin matrices and colliders, and the step length
   they all share. */
struct Constants {
  count: u32,
  distances: u32,
  bendings: u32,
  joints: u32,
  colliders: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  h: f32,
  invH: f32,
  invH2: f32,
  pad3: f32,
}

/* Where this dispatch's round of records starts in paces, at a dynamic offset. */
struct Round {
  at: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

/* One garment's numbers for one round: its step's, and its own that never change. */
struct Pace {
  fraction: f32,
  blend: f32,
  alpha: f32,
  carry: u32,
  /* Where the pose a step starts from and the one it moves toward sit in pose, in floats. */
  fromAt: u32,
  toAt: u32,
  /* 0 where the garment sits this round out. Not active, which WGSL reserves. */
  live: u32,
  /* 1 a max distance, 2 a backstop, 4 a frontstop: which limits the garment has at all. */
  limits: u32,
  /* The character's turn since the last step, by columns; origin.w is the share carried. */
  turn0: vec4<f32>,
  turn1: vec4<f32>,
  turn2: vec4<f32>,
  origin: vec4<f32>,
  shift: vec4<f32>,
  /* The frame's wind: one wind, sampled once a frame, so a step's rather than the set-up's. */
  wind: vec4<f32>,
  colliderBase: u32,
  colliders: u32,
  width: u32,
  pad0: u32,
  keep: f32,
  dragKeep: f32,
  maxDistanceScale: f32,
  margin: f32,
  gravity: vec4<f32>,
}

/* One colour of one kind of constraint across the set, at a dynamic offset; first resets the
   multipliers. Publishing reads one garment's particles as begin to end, and first is the garment. */
struct Batch {
  begin: u32,
  end: u32,
  first: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> c: Constants;
@group(0) @binding(1) var<uniform> round: Round;
@group(0) @binding(2) var<uniform> batch: Batch;
@group(0) @binding(3) var<storage, read_write> state: array<f32>;
@group(0) @binding(4) var<storage, read_write> pose: array<f32>;
@group(0) @binding(5) var<storage, read> statics: array<f32>;
@group(0) @binding(6) var<storage, read> constraints: array<u32>;
@group(0) @binding(7) var<storage, read_write> lambda: array<f32>;
@group(0) @binding(8) var<storage, read> frame: array<f32>;
@group(0) @binding(9) var<storage, read> paces: array<Pace>;

/* The record of particle i's garment this round: which garment a particle is, in statics. */
fn paceAt(i: u32) -> u32 {
  return round.at + u32(statics[29u * c.count + i]);
}

fn stateAt(section: u32, i: u32) -> u32 {
  return section * 3u * c.count + i * 3u;
}

fn load(at: u32) -> vec3<f32> {
  return vec3<f32>(state[at], state[at + 1u], state[at + 2u]);
}

fn store(at: u32, v: vec3<f32>) {
  state[at] = v.x;
  state[at + 1u] = v.y;
  state[at + 2u] = v.z;
}

fn poseOf(at: u32) -> vec3<f32> {
  return vec3<f32>(pose[at], pose[at + 1u], pose[at + 2u]);
}

/* Sections of state. */
const POSITION = 0u;
const PREVIOUS = 1u;
const VELOCITY = 2u;
const START = 3u;

fn inverseMass(i: u32) -> f32 {
  return statics[i];
}

/* Where skinning puts particle i, fraction of the way from the last pose to the latest. */
fn skinnedAt(i: u32, g: u32) -> vec3<f32> {
  let a = poseOf(paces[g].fromAt + i * 3u);
  let b = poseOf(paces[g].toAt + i * 3u);
  return a + (b - a) * paces[g].fraction;
}

fn skinMatrix(j: u32) -> mat4x4<f32> {
  let at = j * 16u;
  return mat4x4<f32>(
    vec4<f32>(frame[at], frame[at + 1u], frame[at + 2u], frame[at + 3u]),
    vec4<f32>(frame[at + 4u], frame[at + 5u], frame[at + 6u], frame[at + 7u]),
    vec4<f32>(frame[at + 8u], frame[at + 9u], frame[at + 10u], frame[at + 11u]),
    vec4<f32>(frame[at + 12u], frame[at + 13u], frame[at + 14u], frame[at + 15u]));
}

/* skinParticles: each particle's skinned position and normal by up to eight influences. */
@compute @workgroup_size(64)
fn clothPose(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count) {
    return;
  }
  let g = paceAt(i);
  if (paces[g].live == 0u) {
    return;
  }
  let n = c.count;
  let restAt = 7u * n + i * 3u;
  let normalAt = 10u * n + i * 3u;
  let x = vec4<f32>(statics[restAt], statics[restAt + 1u], statics[restAt + 2u], 1.0);
  let q0 = vec3<f32>(statics[normalAt], statics[normalAt + 1u], statics[normalAt + 2u]);
  var p = vec3<f32>(0.0);
  var q = vec3<f32>(0.0);
  for (var half = 0u; half < 2u; half++) {
    for (var k = 0u; k < 4u; k++) {
      let at = 13u * n + i * 16u + half * 8u;
      let w = statics[at + 4u + k];
      if (w == 0.0) {
        continue;
      }
      let m = skinMatrix(u32(statics[at + k]));
      p += w * (m * x).xyz;
      q += w * (mat3x3<f32>(m[0].xyz, m[1].xyz, m[2].xyz) * q0);
    }
  }
  let to = paces[g].toAt + i * 3u;
  pose[to] = p.x;
  pose[to + 1u] = p.y;
  pose[to + 2u] = p.z;
  let len = sqrt(dot(q, q));
  let inv = select(0.0, 1.0 / len, len > 1e-12);
  let normal = 6u * n + i * 3u;
  pose[normal] = q.x * inv;
  pose[normal + 1u] = q.y * inv;
  pose[normal + 2u] = q.z * inv;
}

/* SkinnedCloth.rest: every particle at the latest skinned position, at rest. */
@compute @workgroup_size(64)
fn clothRest(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count) {
    return;
  }
  let g = paceAt(i);
  if (paces[g].live == 0u) {
    return;
  }
  let p = poseOf(paces[g].toAt + i * 3u);
  store(stateAt(POSITION, i), p);
  store(stateAt(START, i), p);
  store(stateAt(VELOCITY, i), vec3<f32>(0.0));
}

/* The step's start: the step start kept, a free particle carried, a kinematic one placed. */
@compute @workgroup_size(64)
fn clothBegin(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count) {
    return;
  }
  let g = paceAt(i);
  if (paces[g].live == 0u) {
    return;
  }
  let at = stateAt(POSITION, i);
  let p = load(at);
  store(stateAt(START, i), p);
  if (inverseMass(i) == 0.0) {
    store(at, skinnedAt(i, g));
    return;
  }
  if (paces[g].carry == 0u) {
    return;
  }
  /* carryParticles: the share of the character's turn about its old origin, and of its move. */
  let turn = mat3x3<f32>(paces[g].turn0.xyz, paces[g].turn1.xyz, paces[g].turn2.xyz);
  let share = paces[g].origin.w;
  let x = p - paces[g].origin.xyz;
  store(at, p + (turn * x - x) * share + paces[g].shift.xyz);
  let vAt = stateAt(VELOCITY, i);
  let v = load(vAt);
  store(vAt, v + (turn * v - v) * share);
}

/* predictParticles. */
@compute @workgroup_size(64)
fn clothPredict(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count) {
    return;
  }
  let g = paceAt(i);
  if (paces[g].live == 0u) {
    return;
  }
  let at = stateAt(POSITION, i);
  let p = load(at);
  store(stateAt(PREVIOUS, i), p);
  if (inverseMass(i) == 0.0) {
    return;
  }
  let vAt = stateAt(VELOCITY, i);
  let air = paces[g].wind.xyz;
  let v = air + (load(vAt) * paces[g].keep - air) * paces[g].dragKeep + paces[g].gravity.xyz * c.h;
  store(vAt, v);
  store(at, p + v * c.h);
}

/* solveDistanceBatch: one invocation a constraint of the batch, constraints sorted by batch. */
@compute @workgroup_size(64)
fn clothDistance(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = batch.begin + id.x;
  if (k >= batch.end) {
    return;
  }
  let a = constraints[k * 4u];
  let b = constraints[k * 4u + 1u];
  /* A garment sitting the round out solves nothing, and its next step's first pass resets. */
  if (paces[paceAt(a)].live == 0u) {
    return;
  }
  /* The first pass of a substep starts the multiplier at nothing, as the CPU's fill(0) does —
     written before any early return, so a skipped constraint does not carry the last one. */
  if (batch.first == 1u) {
    lambda[k] = 0.0;
  }
  let wa = inverseMass(a);
  let wb = inverseMass(b);
  let w = wa + wb;
  if (w == 0.0) {
    return;
  }
  let aAt = stateAt(POSITION, a);
  let bAt = stateAt(POSITION, b);
  let d = load(bAt) - load(aAt);
  let len = sqrt(dot(d, d));
  if (len < 1e-9) {
    return;
  }
  let alpha = bitcast<f32>(constraints[k * 4u + 3u]) * c.invH2;
  let old = lambda[k];
  let delta = (-(len - bitcast<f32>(constraints[k * 4u + 2u])) - alpha * old) / (w + alpha);
  lambda[k] = old + delta;
  let s = delta / len;
  /* A pinned particle is shared across a batch, so it is never written, even with itself. */
  if (wa > 0.0) {
    store(aAt, load(aAt) - d * s * wa);
  }
  if (wb > 0.0) {
    store(bAt, load(bAt) + d * s * wb);
  }
}

/* solveBendingBatch, with the angle from atan2 (see the header). */
@compute @workgroup_size(64)
fn clothBending(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = batch.begin + id.x;
  if (k >= batch.end) {
    return;
  }
  let at = c.distances * 4u + k * 6u;
  let slot = c.distances + k;
  if (paces[paceAt(constraints[at])].live == 0u) {
    return;
  }
  if (batch.first == 1u) {
    lambda[slot] = 0.0;
  }
  let ids = vec4<u32>(constraints[at], constraints[at + 1u], constraints[at + 2u], constraints[at + 3u]);
  let w = vec4<f32>(inverseMass(ids.x), inverseMass(ids.y), inverseMass(ids.z), inverseMass(ids.w));
  if (w.x + w.y + w.z + w.w == 0.0) {
    return;
  }
  let origin = load(stateAt(POSITION, ids.x));
  let e = load(stateAt(POSITION, ids.y)) - origin;
  let p3 = load(stateAt(POSITION, ids.z)) - origin;
  let p4 = load(stateAt(POSITION, ids.w)) - origin;
  var n1 = cross(e, p3);
  var n2 = cross(e, p4);
  let l1 = sqrt(dot(n1, n1));
  let l2 = sqrt(dot(n2, n2));
  if (l1 < 1e-12 || l2 < 1e-12) {
    return;
  }
  n1 = n1 / l1;
  n2 = n2 / l2;
  let d = clamp(dot(n1, n2), -1.0, 1.0);
  let sine = sqrt(dot(cross(n1, n2), cross(n1, n2)));
  if (sine < 1e-6) {
    return;
  }
  /* The q vectors: the negative of the derivative of n1 · n2. See solveBendingBatch. */
  let q3 = (cross(e, n2) + cross(n1, e) * d) / l1;
  let q4 = (cross(e, n1) + cross(n2, e) * d) / l2;
  let q2 = -((cross(p3, n2) + cross(n1, p3) * d) / l1 + (cross(p4, n1) + cross(n2, p4) * d) / l2);
  let q1 = -(q2 + q3 + q4);
  var sum = w.x * dot(q1, q1) + w.y * dot(q2, q2) + w.z * dot(q3, q3) + w.w * dot(q4, q4);
  sum = sum / (sine * sine);
  if (sum < 1e-12) {
    return;
  }
  let alpha = bitcast<f32>(constraints[at + 5u]) * c.invH2;
  let old = lambda[slot];
  let angle = atan2(sine, d);
  let delta = (-(angle - bitcast<f32>(constraints[at + 4u])) - alpha * old) / (sum + alpha);
  lambda[slot] = old + delta;
  let scale = delta / sine;
  if (w.x > 0.0) {
    let p = stateAt(POSITION, ids.x);
    store(p, load(p) + w.x * scale * q1);
  }
  if (w.y > 0.0) {
    let p = stateAt(POSITION, ids.y);
    store(p, load(p) + w.y * scale * q2);
  }
  if (w.z > 0.0) {
    let p = stateAt(POSITION, ids.z);
    store(p, load(p) + w.z * scale * q3);
  }
  if (w.w > 0.0) {
    let p = stateAt(POSITION, ids.w);
    store(p, load(p) + w.w * scale * q4);
  }
}

/* solveTethers, one invocation a tether of the batch: a batch holds a particle once. */
@compute @workgroup_size(64)
fn clothTether(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = batch.begin + id.x;
  if (k >= batch.end) {
    return;
  }
  let at = c.distances * 4u + c.bendings * 6u + k * 3u;
  if (paces[paceAt(constraints[at])].live == 0u) {
    return;
  }
  let pAt = stateAt(POSITION, constraints[at]);
  let anchor = load(stateAt(POSITION, constraints[at + 1u]));
  let d = load(pAt) - anchor;
  let dist = sqrt(dot(d, d));
  let reach = bitcast<f32>(constraints[at + 2u]);
  if (dist <= reach || dist < 1e-9) {
    return;
  }
  store(pAt, anchor + d * (reach / dist));
}

/* pushOut: the point onto the sphere's surface if it is inside. A point at the centre stays. */
fn pushOut(p: vec3<f32>, centre: vec3<f32>, radius: f32) -> vec3<f32> {
  let d = p - centre;
  let d2 = dot(d, d);
  if (d2 >= radius * radius || d2 < 1e-18) {
    return p;
  }
  return centre + d * (radius / sqrt(d2));
}

/* applyMaxDistance, applyStops (back, then front) and applyColliders, in that order. */
@compute @workgroup_size(64)
fn clothLimit(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count || inverseMass(i) == 0.0) {
    return;
  }
  let g = paceAt(i);
  if (paces[g].live == 0u) {
    return;
  }
  let limits = paces[g].limits;
  let n = c.count;
  let at = stateAt(POSITION, i);
  var p = load(at);
  let t = skinnedAt(i, g);
  /* A max distance below zero is none: the CPU's Infinity, which a device may not be handed. */
  let maxDistance = statics[n + i];
  if ((limits & 1u) != 0u && maxDistance >= 0.0) {
    let limit = maxDistance * paces[g].maxDistanceScale;
    let d = p - t;
    let d2 = dot(d, d);
    if (d2 > limit * limit) {
      p = t + d * (limit / sqrt(d2));
    }
  }
  let normal = poseOf(6u * n + i * 3u);
  if ((limits & 2u) != 0u) {
    let radius = statics[2u * n + i * 2u + 1u];
    if (radius > 0.0) {
      p = pushOut(p, t - normal * (statics[2u * n + i * 2u] + radius), radius);
    }
  }
  if ((limits & 4u) != 0u) {
    let radius = statics[4u * n + i * 2u + 1u];
    if (radius > 0.0) {
      p = pushOut(p, t + normal * (statics[4u * n + i * 2u] + radius), radius);
    }
  }
  let pad = statics[6u * n + i] + paces[g].margin;
  let ends = c.joints * 16u;
  let radii = ends + c.colliders * 6u;
  let first = paces[g].colliderBase;
  for (var k = first; k < first + paces[g].colliders; k++) {
    let a = vec3<f32>(frame[ends + k * 6u], frame[ends + k * 6u + 1u], frame[ends + k * 6u + 2u]);
    let e = vec3<f32>(frame[ends + k * 6u + 3u], frame[ends + k * 6u + 4u], frame[ends + k * 6u + 5u]) - a;
    let e2 = dot(e, e);
    var s = 0.0;
    if (e2 > 1e-18) {
      s = clamp(dot(p - a, e) / e2, 0.0, 1.0);
    }
    let r0 = frame[radii + k * 2u];
    let r1 = frame[radii + k * 2u + 1u];
    p = pushOut(p, a + e * s, r0 + (r1 - r0) * s + pad);
  }
  store(at, p);
}

/* finishParticles. */
@compute @workgroup_size(64)
fn clothFinish(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count) {
    return;
  }
  if (paces[paceAt(i)].live == 0u) {
    return;
  }
  let vAt = stateAt(VELOCITY, i);
  if (inverseMass(i) == 0.0) {
    store(vAt, vec3<f32>(0.0));
    return;
  }
  store(vAt, (load(stateAt(POSITION, i)) - load(stateAt(PREVIOUS, i))) * c.invH);
}

/* SkinnedCloth.blend: after a reset, the simulation's share grows over the blend's steps. */
@compute @workgroup_size(64)
fn clothBlend(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= c.count) {
    return;
  }
  /* A blend of 0 is none, not a last step of one: see ClothDevice.step. */
  let g = paceAt(i);
  let blend = paces[g].blend;
  if (paces[g].live == 0u || blend <= 0.0) {
    return;
  }
  let t = skinnedAt(i, g);
  let at = stateAt(POSITION, i);
  store(at, t + (load(at) - t) * blend);
  let vAt = stateAt(VELOCITY, i);
  store(vAt, load(vAt) * blend);
}

@group(1) @binding(0) var output: texture_storage_2d<rgba32float, write>;

/* SkinnedCloth.interpolate, into the particle texture the vertex stage reads: one garment's, whose
   particles are batch.begin to batch.end and whose record is batch.first's. */
@compute @workgroup_size(64)
fn clothPublish(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = batch.begin + id.x;
  if (i >= batch.end) {
    return;
  }
  let g = round.at + batch.first;
  let a = load(stateAt(START, i));
  let p = a + (load(stateAt(POSITION, i)) - a) * paces[g].alpha;
  let local = id.x;
  let width = paces[g].width;
  textureStore(output, vec2<u32>(local % width, local / width), vec4<f32>(p, 0.0));
}
`;
