/**
 * One island's substep loop, as a function over flat state, so a worker can run the same one.
 *
 * **This exists because `PhysicsWorld` cannot cross a realm boundary and an island's solve can.**
 * The world holds `ConvexShape` objects, a `DynamicTree` and a `Map` of warm impulses, none of which
 * a `SharedArrayBuffer` can carry. What the solve actually reads is four sets of typed arrays and
 * eleven numbers, and that much is portable.
 *
 * **One implementation, two callers.** `PhysicsWorld.solveIsland` delegates here and so does
 * `islandWorker.ts`; there is no second copy of the substep order anywhere. The rule against two
 * implementations of one decision is what makes that non-negotiable, and `splatSortWorker.ts` is the
 * precedent for satisfying it across a worker boundary — there by stringifying one function, here by
 * both sides importing one module. **What would make this wrong** is a substep loop appearing inside
 * the worker.
 *
 * The dials are a `Float64Array` and not an object because the worker reads them out of shared
 * memory, and a shape both sides agree on without a per-tick message is the cheapest way to let a
 * consumer change gravity between ticks and have the pool see it.
 */

import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import type { BodySet } from './bodies.ts';
import type { IslandSet } from './island.ts';
import { solveJoints } from './joints.ts';
import type { JointSet } from './joints.ts';
import { applyRestitution, solveContacts, warmStart } from './solver.ts';
import type { ContactConstraints, FrictionModel } from './solver.ts';

/* Slots in the dial block. Named because a worker reads them from shared memory by index. */
export const DIAL_SUBSTEPS = 0;
export const DIAL_ITERATIONS = 1;
export const DIAL_DT = 2;
export const DIAL_GRAVITY_X = 3;
export const DIAL_GRAVITY_Y = 4;
export const DIAL_GRAVITY_Z = 5;
export const DIAL_LINEAR_DAMPING = 6;
export const DIAL_ANGULAR_DAMPING = 7;
export const DIAL_CONTACT_HERTZ = 8;
export const DIAL_CONTACT_DAMPING = 9;
export const DIAL_JOINT_HERTZ = 10;
export const DIAL_JOINT_DAMPING = 11;
export const DIAL_ALLOW_SLEEP = 12;
export const DIAL_FRICTION_MODEL = 13;
/** How many slots a dial block has. */
export const DIAL_COUNT = 14;

/**
 * `FrictionModel` crosses as a number, and the mapping is written once here.
 *
 * A string would cross a `postMessage` perfectly well; it would not survive being read out of a
 * `Float64Array`, which is where the dials live so that no message is needed at all.
 */
export const FRICTION_BOX = 0;
export const FRICTION_ELLIPTICAL = 1;

export function frictionDial(model: FrictionModel): number {
  return model === 'elliptical' ? FRICTION_ELLIPTICAL : FRICTION_BOX;
}

export function frictionModelOf(dial: number): FrictionModel {
  return dial === FRICTION_ELLIPTICAL ? 'elliptical' : 'box';
}

/** Ticks below the sleep thresholds before a body is willing to sleep. */
export const SLEEP_TICKS = 60;

/** Everything one island's solve reaches, and nothing else the world holds. */
export interface IslandSolveState {
  bodies: BodySet;
  constraints: ContactConstraints;
  joints: JointSet;
  islands: IslandSet;
  /* Explicitly `ArrayBufferLike`: a pool's dials are a view on a `SharedArrayBuffer`, and the
     default parameter is `ArrayBuffer`, which a shared one does not assign to. See
     `parcel/store.ts` for the same note in the other direction. */
  dials: Float64Array<ArrayBufferLike>;
}

/** Whether a body has been still long enough to stop being solved. */
export function bodyAsleep(bodies: BodySet, allowSleep: boolean, i: number): boolean {
  return allowSleep && (bodies.sleepTicks[i] ?? 0) >= SLEEP_TICKS;
}

/** Whether every body in an island is asleep, which is what lets the island be skipped whole. */
export function islandAsleep(state: IslandSolveState, island: number): boolean {
  const allowSleep = (state.dials[DIAL_ALLOW_SLEEP] ?? 0) !== 0;
  const from = state.islands.bodyStart[island] ?? 0;
  const to = state.islands.bodyStart[island + 1] ?? from;
  for (let at = from; at < to; at++) {
    if (!bodyAsleep(state.bodies, allowSleep, state.islands.bodyOrder[at] ?? 0)) return false;
  }
  return to > from;
}

function integrateVelocities(state: IslandSolveState, h: number, from: number, to: number): void {
  const bodies = state.bodies;
  const d = state.dials;
  const allowSleep = (d[DIAL_ALLOW_SLEEP] ?? 0) !== 0;
  const gx = d[DIAL_GRAVITY_X] ?? 0;
  const gy = d[DIAL_GRAVITY_Y] ?? 0;
  const gz = d[DIAL_GRAVITY_Z] ?? 0;
  const ld = 1 / (1 + h * (d[DIAL_LINEAR_DAMPING] ?? 0));
  const ad = 1 / (1 + h * (d[DIAL_ANGULAR_DAMPING] ?? 0));
  for (let at = from; at < to; at++) {
    const i = state.islands.bodyOrder[at] ?? 0;
    if (bodies.type[i] !== BODY_DYNAMIC || bodyAsleep(bodies, allowSleep, i)) continue;
    bodies.velX[i] = ((bodies.velX[i] ?? 0) + h * gx) * ld;
    bodies.velY[i] = ((bodies.velY[i] ?? 0) + h * gy) * ld;
    bodies.velZ[i] = ((bodies.velZ[i] ?? 0) + h * gz) * ld;
    bodies.angX[i] = (bodies.angX[i] ?? 0) * ad;
    bodies.angY[i] = (bodies.angY[i] ?? 0) * ad;
    bodies.angZ[i] = (bodies.angZ[i] ?? 0) * ad;
  }
}

function integratePositions(state: IslandSolveState, h: number, from: number, to: number): void {
  const bodies = state.bodies;
  const allowSleep = (state.dials[DIAL_ALLOW_SLEEP] ?? 0) !== 0;
  for (let at = from; at < to; at++) {
    const i = state.islands.bodyOrder[at] ?? 0;
    if (bodies.type[i] === BODY_STATIC || bodyAsleep(bodies, allowSleep, i)) continue;
    bodies.posX[i] = (bodies.posX[i] ?? 0) + h * (bodies.velX[i] ?? 0);
    bodies.posY[i] = (bodies.posY[i] ?? 0) + h * (bodies.velY[i] ?? 0);
    bodies.posZ[i] = (bodies.posZ[i] ?? 0) + h * (bodies.velZ[i] ?? 0);
    // First-order exponential map, then renormalise. No sin, no cos.
    const qx = bodies.rotX[i] ?? 0;
    const qy = bodies.rotY[i] ?? 0;
    const qz = bodies.rotZ[i] ?? 0;
    const qw = bodies.rotW[i] ?? 1;
    const wx = bodies.angX[i] ?? 0;
    const wy = bodies.angY[i] ?? 0;
    const wz = bodies.angZ[i] ?? 0;
    const half = 0.5 * h;
    let nx = qx + half * (wx * qw + wy * qz - wz * qy);
    let ny = qy + half * (wy * qw + wz * qx - wx * qz);
    let nz = qz + half * (wz * qw + wx * qy - wy * qx);
    let nw = qw - half * (wx * qx + wy * qy + wz * qz);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    nw /= len;
    bodies.rotX[i] = nx;
    bodies.rotY[i] = ny;
    bodies.rotZ[i] = nz;
    bodies.rotW[i] = nw;
  }
}

/**
 * Advance one island through every substep.
 *
 * Integration is over this island's bodies only, which is what makes the call independent of every
 * other island rather than merely ordered against them.
 */
export function solveIslandInto(state: IslandSolveState, island: number): void {
  if (islandAsleep(state, island)) return;
  const d = state.dials;
  const substeps = d[DIAL_SUBSTEPS] ?? 1;
  const iterations = d[DIAL_ITERATIONS] ?? 1;
  const dt = d[DIAL_DT] ?? 0;
  const contactHertz = d[DIAL_CONTACT_HERTZ] ?? 0;
  const contactDamping = d[DIAL_CONTACT_DAMPING] ?? 0;
  const jointHertz = d[DIAL_JOINT_HERTZ] ?? 0;
  const jointDamping = d[DIAL_JOINT_DAMPING] ?? 0;
  const friction = frictionModelOf(d[DIAL_FRICTION_MODEL] ?? 0);

  const h = dt / substeps;
  const bodies = state.bodies;
  const joints = state.joints;
  const c = state.constraints;
  const order = state.islands.constraintOrder;
  const from = state.islands.constraintStart[island] ?? 0;
  const to = state.islands.constraintStart[island + 1] ?? from;
  const bodyFrom = state.islands.bodyStart[island] ?? 0;
  const bodyTo = state.islands.bodyStart[island + 1] ?? bodyFrom;
  const jointOrder = state.islands.jointOrder;
  const jointFrom = state.islands.jointStart[island] ?? 0;
  const jointTo = state.islands.jointStart[island + 1] ?? jointFrom;

  for (let s = 0; s < substeps; s++) {
    integrateVelocities(state, h, bodyFrom, bodyTo);
    warmStart(bodies, c, order, from, to);
    for (let it = 0; it < iterations; it++) {
      // Joints before contacts: a joint is structural and a contact is transient, so letting a
      // contact win produces a limb that pulls out of its socket when something lands on it.
      solveJoints(
        bodies,
        joints,
        jointOrder,
        jointFrom,
        jointTo,
        h,
        dt,
        true,
        jointHertz,
        jointDamping,
      );
      solveContacts(bodies, c, order, from, to, h, true, contactHertz, contactDamping, friction);
    }
    integratePositions(state, h, bodyFrom, bodyTo);
    // The relax pass, with the bias off, giving back the energy the bias added.
    solveJoints(
      bodies,
      joints,
      jointOrder,
      jointFrom,
      jointTo,
      h,
      dt,
      false,
      jointHertz,
      jointDamping,
    );
    solveContacts(bodies, c, order, from, to, h, false, contactHertz, contactDamping, friction);
  }
  applyRestitution(bodies, c, order, from, to);
}
