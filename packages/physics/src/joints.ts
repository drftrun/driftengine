import { BODY_DYNAMIC } from './bodies.ts';
import type { BodySet } from './bodies.ts';

/**
 * Joints: seven types, each solved with its own rows unrolled.
 *
 * **This file refused a configurable 6-DOF joint until 2026-08-27, and the refusal was narrower
 * than it read.** What it argued against was replacing the six unrolled types with *one* joint
 * whose constraint set is decided at runtime — a branch per row in the hottest loop in the engine,
 * and a megamorphic call site at the top of it. That argument still stands and nothing here has
 * changed: the six keep their own arms, their own rows and their own numbers, and none of them
 * gained a branch.
 *
 * What arrived instead is a **seventh type**, which is exactly what that refusal named as its own
 * cost — "the package has to grow a type" — so the branch a six-DOF joint pays for is paid by
 * six-DOF joints and by nothing else. The stated reversal condition was three consumers wanting
 * three different exotic joints; growing three more unrolled types is the outcome this answers
 * more cheaply than it answers the question of whether three have asked.
 *
 * **`JOINT_SIX_DOF` solves six independent scalar rows, not two coupled 3x3 blocks**, because a
 * coupled solve has no meaning when a caller has made only some of the rows exist. *Cost:* an
 * all-locked six-DOF joint is measurably softer than `JOINT_FIXED` at the same substep count, so
 * reach for `JOINT_FIXED` when all six are locked. *What would make this wrong:* a caller wanting
 * an all-locked six-DOF joint to be as stiff as a fixed one, and the honest answer there is to use
 * the fixed one.
 *
 * **No angle appears anywhere.** A swing limit compares a dot product against a stored cosine; a
 * twist limit compares a quaternion component against the half-angle's sine. `Math.acos` and
 * `Math.atan2` are both on the banned list, and writing the limits this way from the start is
 * cheaper than repairing them — the comparison is what the solver wanted anyway, since it clamps
 * rather than measures.
 *
 * **A point-to-point constraint solves its full 3×3 effective mass** rather than three sequential
 * scalars. The matrix inverts in closed form, so one exact solve replaces three approximate ones
 * that would each disturb the others. *What it costs* is an inversion per joint per iteration.
 *
 * Joints are solved **before** contacts in each iteration, because a joint is a hard structural
 * relationship and a contact is a transient one: letting contacts win produces a limb that pulls
 * out of its socket when something lands on it.
 */

export const JOINT_DISTANCE = 0;
export const JOINT_SPHERICAL = 1;
export const JOINT_REVOLUTE = 2;
export const JOINT_PRISMATIC = 3;
export const JOINT_FIXED = 4;
export const JOINT_CONE_TWIST = 5;
export const JOINT_SIX_DOF = 6;
export type JointType = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * What one degree of freedom does, for `JOINT_SIX_DOF`.
 *
 * **Locked is zero so that a zero-filled array is a rigid joint.** A joint somebody forgot to
 * describe holds its bodies together rather than letting them fly apart, which is the safe
 * direction for a default nobody chose.
 *
 * **Explicit rather than inferred from the bounds.** The widespread convention is that
 * `lower > upper` means free and `lower === upper` means locked, which needs no extra field and
 * turns a caller who swapped their two numbers into a joint that silently does nothing. A mode is
 * one byte and it cannot be mistyped into the wrong meaning.
 */
export const DOF_LOCKED = 0;
export const DOF_LIMITED = 1;
export const DOF_FREE = 2;
export type DofMode = 0 | 1 | 2;

/** Six degrees: linear x, y, z, then angular x, y, z — all in body A's local frame. */
export const DOF_COUNT = 6;

export interface JointDesc {
  readonly type: JointType;
  readonly bodyA: number;
  readonly bodyB: number;
  /** Anchor in each body's local frame. */
  readonly anchorAX?: number;
  readonly anchorAY?: number;
  readonly anchorAZ?: number;
  readonly anchorBX?: number;
  readonly anchorBY?: number;
  readonly anchorBZ?: number;
  /** The free axis, in A's local frame: a hinge turns about it, a slider travels along it. */
  readonly axisX?: number;
  readonly axisY?: number;
  readonly axisZ?: number;
  /** Distance joints: the length held. Others: unused. */
  readonly length?: number;
  /** Limits, as a cosine for a cone and as metres or a sine of a half-angle otherwise. */
  readonly lower?: number;
  readonly upper?: number;
  /** A cone half-angle's cosine, and a twist half-angle's sine. Cone-twist only. */
  readonly swingCos?: number;
  readonly twistSin?: number;
  readonly motorSpeed?: number;
  readonly motorMaxForce?: number;
  /** Accumulated impulse above which the joint gives way. `Infinity` never breaks. */
  readonly breakImpulse?: number;
  /**
   * Six-DOF only: what each degree of freedom does.
   *
   * **The order is linear x, y, z then angular x, y, z, all in body A's local frame** — not in a
   * frame of the joint's own. *Cost:* a caller wanting axes that are not A's own has to orient A,
   * or place the anchors so that A's frame is the one it means. *What would reverse it:* a
   * consumer whose parent body cannot be oriented, and the answer then is four more floats per
   * joint holding a frame quaternion.
   *
   * Shorter than six, or absent, and the rest are locked.
   */
  readonly dof?: readonly DofMode[];
  /**
   * Lower bounds, one per degree, read only where the mode is `DOF_LIMITED`.
   *
   * **Linear bounds are metres of offset from the anchor; angular bounds are sines of half
   * angles.** The second is this package's own convention rather than a shortcut — a swing limit
   * compares a dot product against a stored cosine and a twist limit a quaternion component against
   * a half-angle's sine, because `Math.acos` and `Math.atan2` are both on the banned list and the
   * comparison is what the solver wanted anyway. A quarter turn is `Math.sin(Math.PI / 4)`.
   */
  readonly dofLower?: readonly number[];
  /** Upper bounds, in the same units and the same order. */
  readonly dofUpper?: readonly number[];
}

export class JointSet {
  count = 0;
  type: Uint8Array;
  bodyA: Int32Array;
  bodyB: Int32Array;
  localA: Float32Array;
  localB: Float32Array;
  axis: Float32Array;
  /** The relative rotation held at rest, captured when the joint is made. */
  restRel: Float32Array;
  length: Float32Array;
  lower: Float32Array;
  upper: Float32Array;
  swingCos: Float32Array;
  twistSin: Float32Array;
  motorSpeed: Float32Array;
  motorMaxForce: Float32Array;
  breakImpulse: Float32Array;
  broken: Uint8Array;
  /** Six accumulated impulses per joint: three linear, three angular or scalar rows. */
  impulse: Float32Array;
  motorImpulse: Float32Array;
  /** Six-DOF only: a mode per degree, and the bounds the limited ones are held between. */
  dofMode: Uint8Array;
  dofLower: Float32Array;
  dofUpper: Float32Array;

  private cap: number;

  constructor(capacity = 32) {
    this.cap = capacity;
    this.type = new Uint8Array(this.cap);
    this.bodyA = new Int32Array(this.cap);
    this.bodyB = new Int32Array(this.cap);
    this.localA = new Float32Array(this.cap * 3);
    this.localB = new Float32Array(this.cap * 3);
    this.axis = new Float32Array(this.cap * 3);
    this.restRel = new Float32Array(this.cap * 4);
    this.length = new Float32Array(this.cap);
    this.lower = new Float32Array(this.cap);
    this.upper = new Float32Array(this.cap);
    this.swingCos = new Float32Array(this.cap);
    this.twistSin = new Float32Array(this.cap);
    this.motorSpeed = new Float32Array(this.cap);
    this.motorMaxForce = new Float32Array(this.cap);
    this.breakImpulse = new Float32Array(this.cap);
    this.broken = new Uint8Array(this.cap);
    this.impulse = new Float32Array(this.cap * 6);
    this.motorImpulse = new Float32Array(this.cap);
    /* Zero is `DOF_LOCKED`, so a fresh row is a rigid joint without anything filling it. */
    this.dofMode = new Uint8Array(this.cap * DOF_COUNT);
    this.dofLower = new Float32Array(this.cap * DOF_COUNT);
    this.dofUpper = new Float32Array(this.cap * DOF_COUNT);
  }

  add(bodies: BodySet, d: JointDesc): number {
    if (this.count === this.cap) this.grow();
    const j = this.count++;
    this.type[j] = d.type;
    this.bodyA[j] = d.bodyA;
    this.bodyB[j] = d.bodyB;
    /*
     * With no anchor given, the anchor is *where B already is*, expressed in A's frame.
     *
     * That makes the promise this method's own comment carries true for the offset as well as the
     * rotation: pose a rig, joint it, and nothing moves on the first tick. Defaulting both anchors
     * to the body centres instead welds the two centres together, which yanked a fixed joint's body
     * two metres onto its anchor — a snap on the first tick, from a default.
     *
     * A distance joint is the exception, because its anchors *are* the endpoints it measures
     * between and deriving them would give it a length of zero.
     */
    const given =
      d.anchorAX !== undefined ||
      d.anchorAY !== undefined ||
      d.anchorAZ !== undefined ||
      d.anchorBX !== undefined ||
      d.anchorBY !== undefined ||
      d.anchorBZ !== undefined;
    if (!given && d.type !== JOINT_DISTANCE) {
      unrotateInto(
        bodies,
        d.bodyA,
        (bodies.posX[d.bodyB] ?? 0) - (bodies.posX[d.bodyA] ?? 0),
        (bodies.posY[d.bodyB] ?? 0) - (bodies.posY[d.bodyA] ?? 0),
        (bodies.posZ[d.bodyB] ?? 0) - (bodies.posZ[d.bodyA] ?? 0),
        this.localA,
        j * 3,
      );
      this.localB[j * 3] = 0;
      this.localB[j * 3 + 1] = 0;
      this.localB[j * 3 + 2] = 0;
    } else {
      this.localA[j * 3] = d.anchorAX ?? 0;
      this.localA[j * 3 + 1] = d.anchorAY ?? 0;
      this.localA[j * 3 + 2] = d.anchorAZ ?? 0;
      this.localB[j * 3] = d.anchorBX ?? 0;
      this.localB[j * 3 + 1] = d.anchorBY ?? 0;
      this.localB[j * 3 + 2] = d.anchorBZ ?? 0;
    }
    let ax = d.axisX ?? 0;
    let ay = d.axisY ?? 1;
    let az = d.axisZ ?? 0;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= alen;
    ay /= alen;
    az /= alen;
    this.axis[j * 3] = ax;
    this.axis[j * 3 + 1] = ay;
    this.axis[j * 3 + 2] = az;
    this.length[j] = d.length ?? 1;
    this.lower[j] = d.lower ?? -Infinity;
    this.upper[j] = d.upper ?? Infinity;
    this.swingCos[j] = d.swingCos ?? -1;
    this.twistSin[j] = d.twistSin ?? 1;
    this.motorSpeed[j] = d.motorSpeed ?? 0;
    this.motorMaxForce[j] = d.motorMaxForce ?? 0;
    this.breakImpulse[j] = d.breakImpulse ?? Infinity;
    this.broken[j] = 0;
    for (let k = 0; k < 6; k++) this.impulse[j * 6 + k] = 0;
    this.motorImpulse[j] = 0;

    for (let k = 0; k < DOF_COUNT; k++) {
      this.dofMode[j * DOF_COUNT + k] = d.dof?.[k] ?? DOF_LOCKED;
      this.dofLower[j * DOF_COUNT + k] = d.dofLower?.[k] ?? 0;
      this.dofUpper[j * DOF_COUNT + k] = d.dofUpper?.[k] ?? 0;
    }
    /*
     * A motor asked for and not delivered is a silent no-op: nothing throws, the axis never
     * drives, and it reads as a broken motor rather than as an unsupported one. Said out loud
     * here, which is init, rather than left for somebody to discover in a frame.
     *
     * Once per process rather than once per joint, on `refuseIfUnvouched`'s pattern: a rig with
     * forty six-DOF joints would otherwise flood a console somebody needs to read.
     */
    if (d.type === JOINT_SIX_DOF && (d.motorMaxForce ?? 0) > 0 && !warnedSixDofMotor) {
      warnedSixDofMotor = true;
      console.warn(
        '[driftengine] a six-DOF joint was given a motor and has none: the type carries free, ' +
          'limited and locked axes and nothing that drives one. Use a revolute or prismatic ' +
          'joint for a powered axis, or say so and the type grows twelve more numbers.',
      );
    }

    /*
     * The relative rotation now becomes the one the joint holds. Capturing it here rather than
     * taking it as a parameter is what lets a caller pose a rig and then joint it, which is how
     * `ragdollFromSkeleton` will build one — and it is the only sane default, since any other
     * choice would snap the bodies on the first tick.
     */
    relativeRotation(bodies, d.bodyA, d.bodyB, this.restRel, j * 4);
    return j;
  }

  private grow(): void {
    this.cap *= 2;
    const g = <T extends Uint8Array | Int32Array | Float32Array>(a: T, stride = 1): T => {
      const out = new (a.constructor as new (n: number) => T)(this.cap * stride);
      out.set(a);
      return out;
    };
    this.type = g(this.type);
    this.bodyA = g(this.bodyA);
    this.bodyB = g(this.bodyB);
    this.localA = g(this.localA, 3);
    this.localB = g(this.localB, 3);
    this.axis = g(this.axis, 3);
    this.restRel = g(this.restRel, 4);
    this.length = g(this.length);
    this.lower = g(this.lower);
    this.upper = g(this.upper);
    this.swingCos = g(this.swingCos);
    this.twistSin = g(this.twistSin);
    this.motorSpeed = g(this.motorSpeed);
    this.motorMaxForce = g(this.motorMaxForce);
    this.breakImpulse = g(this.breakImpulse);
    this.broken = g(this.broken);
    this.impulse = g(this.impulse, 6);
    this.motorImpulse = g(this.motorImpulse);
    this.dofMode = g(this.dofMode, DOF_COUNT);
    this.dofLower = g(this.dofLower, DOF_COUNT);
    this.dofUpper = g(this.dofUpper, DOF_COUNT);
  }
}

/**
 * Clear every joint's accumulated impulse, once per tick, before the substeps.
 *
 * **The soft-constraint relaxation term makes a joint a spring whose sag is proportional to what it
 * is carrying**, through `−impulseScale · accumulated`. Contacts reset that accumulator every tick
 * when `prepareContact` reloads them from the warm-start store; joints had nothing doing the same,
 * so it grew without bound — measured, a distance joint's went from −17.7 on the first tick to
 * −5,278 by the three hundredth, and the body it held sagged 83 millimetres and was still sinking.
 *
 * **What this gives up** is warm starting for joints: a heavily loaded one starts each tick from
 * zero and needs the substeps to find its impulse again. **What would make it wrong** is a rig
 * whose joints visibly soften under load at four substeps, and the answer then is to carry the
 * impulse as a warm start and reset the accumulator, rather than to leave it running.
 */
export function resetJointImpulses(joints: JointSet): void {
  for (let j = 0; j < joints.count; j++) {
    for (let k = 0; k < 6; k++) joints.impulse[j * 6 + k] = 0;
    joints.motorImpulse[j] = 0;
  }
}

/** So the motor refusal above is said once per process rather than once per joint. */
let warnedSixDofMotor = false;

const iA = new Float32Array(6);
const iB = new Float32Array(6);
const rA = new Float64Array(3);
const rB = new Float64Array(3);
const K = new Float64Array(6);
const KINV = new Float64Array(6);
const V = new Float64Array(3);
const AXIS = new Float64Array(3);
const REL = new Float64Array(4);
// Preallocated, because the hot-path rule applies here as much as anywhere.
const FRAME = new Float64Array(9);
const DOF_ANG = new Float64Array(3);
const SKEW = new Float64Array(9);
const MAT = new Float64Array(9);
const TMP = new Float64Array(9);
const OUT9 = new Float64Array(9);

/**
 * Solve every joint in a range, one iteration.
 *
 * `useBias` is false on the relax pass, exactly as it is for contacts, so the positional push a
 * joint applies is taken back rather than left as energy.
 */
export function solveJoints(
  bodies: BodySet,
  joints: JointSet,
  order: Int32Array,
  from: number,
  to: number,
  h: number,
  /**
   * The whole tick, which is what a motor's force budget is measured over.
   *
   * `maxForce` means a force, and a force acting for a tick is `maxForce · dt` of impulse. Bounding
   * the accumulator by `maxForce · h` instead gives the entire tick one substep's worth, so raising
   * the substep count silently weakens every motor — measured, a hinge told to reach 4 rad/s got to
   * 0.13 in a tick where it should have reached 0.5.
   */
  dt: number,
  useBias: boolean,
  hertz: number,
  damping: number,
): void {
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * damping + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  const biasRate = useBias ? omega / a1 : 0;
  const massScale = useBias ? a2 * a3 : 1;
  const impulseScale = useBias ? a3 : 0;

  for (let oi = from; oi < to; oi++) {
    const j = order[oi] ?? 0;
    if (joints.broken[j]) continue;
    const a = joints.bodyA[j] ?? 0;
    const b = joints.bodyB[j] ?? 0;
    bodies.worldInverseInertia(a, iA);
    bodies.worldInverseInertia(b, iB);
    rotateLocal(bodies, a, joints.localA, j * 3, rA);
    rotateLocal(bodies, b, joints.localB, j * 3, rB);

    const type = joints.type[j];
    if (type === JOINT_DISTANCE) {
      solveDistance(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
    } else if (type === JOINT_SIX_DOF) {
      /* Its own arm above the chain rather than inside it: a six-DOF joint owns all six rows and
         must not also take `solvePoint`, which is the three linear rows locked outright. */
      solveSixDof(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
    } else {
      if (type !== JOINT_PRISMATIC) {
        solvePoint(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
      }
      if (type === JOINT_FIXED) {
        solveAngularLock(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
      } else if (type === JOINT_REVOLUTE) {
        solveRevolute(bodies, joints, j, a, b, dt, biasRate, massScale, impulseScale);
      } else if (type === JOINT_PRISMATIC) {
        solvePrismatic(bodies, joints, j, a, b, dt, biasRate, massScale, impulseScale);
      } else if (type === JOINT_CONE_TWIST) {
        solveConeTwist(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
      }
    }

    // A joint gives way when what it is carrying exceeds what it was told to carry.
    const p = joints.impulse;
    const px = p[j * 6] ?? 0;
    const py = p[j * 6 + 1] ?? 0;
    const pz = p[j * 6 + 2] ?? 0;
    const mag = Math.sqrt(px * px + py * py + pz * pz);
    if (mag > (joints.breakImpulse[j] ?? Infinity)) joints.broken[j] = 1;
  }
}

/** Three linear rows, solved together through the inverse of the 3×3 effective mass. */
function solvePoint(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  pointMass(bodies, a, b);
  invertSymmetric3(K, KINV);
  // C, the positional error the bias answers to.
  const cx = (bodies.posX[b] ?? 0) + rB[0] - (bodies.posX[a] ?? 0) - rA[0];
  const cy = (bodies.posY[b] ?? 0) + rB[1] - (bodies.posY[a] ?? 0) - rA[1];
  const cz = (bodies.posZ[b] ?? 0) + rB[2] - (bodies.posZ[a] ?? 0) - rA[2];
  pointVelocity(bodies, a, b);
  const dx = V[0] + biasRate * cx;
  const dy = V[1] + biasRate * cy;
  const dz = V[2] + biasRate * cz;
  const at = j * 6;
  const ox = joints.impulse[at] ?? 0;
  const oy = joints.impulse[at + 1] ?? 0;
  const oz = joints.impulse[at + 2] ?? 0;
  const px = -massScale * multiply3(KINV, dx, dy, dz, 0) - impulseScale * ox;
  const py = -massScale * multiply3(KINV, dx, dy, dz, 1) - impulseScale * oy;
  const pz = -massScale * multiply3(KINV, dx, dy, dz, 2) - impulseScale * oz;
  joints.impulse[at] = ox + px;
  joints.impulse[at + 1] = oy + py;
  joints.impulse[at + 2] = oz + pz;
  applyLinear(bodies, a, b, px, py, pz);
}

/** Three angular rows: hold the relative rotation the joint was made at. */
function solveAngularLock(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  angularMass();
  invertSymmetric3(K, KINV);
  orientationError(bodies, joints, j, a, b);
  const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0) + biasRate * V[0];
  const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0) + biasRate * V[1];
  const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0) + biasRate * V[2];
  const at = j * 6 + 3;
  const ox = joints.impulse[at] ?? 0;
  const oy = joints.impulse[at + 1] ?? 0;
  const oz = joints.impulse[at + 2] ?? 0;
  const px = -massScale * multiply3(KINV, wx, wy, wz, 0) - impulseScale * ox;
  const py = -massScale * multiply3(KINV, wx, wy, wz, 1) - impulseScale * oy;
  const pz = -massScale * multiply3(KINV, wx, wy, wz, 2) - impulseScale * oz;
  joints.impulse[at] = ox + px;
  joints.impulse[at + 1] = oy + py;
  joints.impulse[at + 2] = oz + pz;
  applyAngular(bodies, a, b, px, py, pz);
}

/**
 * One scalar row along the line between anchors, with an optional min and max.
 *
 * **A limit is one-sided and that is not a detail.** Between its bounds the row is *skipped
 * entirely*, not merely given a zero error: a row with `C = 0` still removes all axial velocity, so
 * a body that should hang free is held exactly where it is. And the accumulated impulse is clamped
 * to the side the limit can push, or the row would pull the body back off the limit it is resting
 * against on the following iteration.
 */
function solveDistance(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  let ux = (bodies.posX[b] ?? 0) + rB[0] - (bodies.posX[a] ?? 0) - rA[0];
  let uy = (bodies.posY[b] ?? 0) + rB[1] - (bodies.posY[a] ?? 0) - rA[1];
  let uz = (bodies.posZ[b] ?? 0) + rB[2] - (bodies.posZ[a] ?? 0) - rA[2];
  const len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (len < 1e-9) return;
  ux /= len;
  uy /= len;
  uz /= len;
  const lower = joints.lower[j] ?? -Infinity;
  const upper = joints.upper[j] ?? Infinity;
  const limited = lower !== -Infinity || upper !== Infinity;
  const at = j * 6;

  let c: number;
  let minP = -Infinity;
  let maxP = Infinity;
  if (limited) {
    if (len >= lower && len <= upper) {
      joints.impulse[at] = 0;
      return;
    }
    if (len < lower) {
      c = len - lower;
      minP = 0; // may only push apart
    } else {
      c = len - upper;
      maxP = 0; // may only pull together
    }
  } else {
    c = len - (joints.length[j] ?? 1);
  }

  const mass = axisMass(bodies, a, b, ux, uy, uz);
  pointVelocity(bodies, a, b);
  const cdot = V[0] * ux + V[1] * uy + V[2] * uz;
  const old = joints.impulse[at] ?? 0;
  let next = old - mass * massScale * (cdot + biasRate * c) - impulseScale * old;
  if (next < minP) next = minP;
  else if (next > maxP) next = maxP;
  const p = next - old;
  joints.impulse[at] = next;
  joints.impulse[at + 1] = 0;
  joints.impulse[at + 2] = 0;
  applyLinear(bodies, a, b, ux * p, uy * p, uz * p);
}

/** Point-to-point plus two angular rows locking everything but the axis, then limit and motor. */
function solveRevolute(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  dt: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  worldAxis(bodies, joints, j, a);
  perpendicularPair(AXIS[0], AXIS[1], AXIS[2]);
  lockAboutTwoAxes(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
  motorAndLimit(bodies, joints, j, a, b, dt, biasRate, massScale, impulseScale, true);
}

/** Three angular rows plus two linear rows perpendicular to the axis, then limit and motor. */
function solvePrismatic(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  dt: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  solveAngularLock(bodies, joints, j, a, b, biasRate, massScale, impulseScale);
  worldAxis(bodies, joints, j, a);
  const ax = AXIS[0];
  const ay = AXIS[1];
  const az = AXIS[2];
  perpendicularPair(ax, ay, az);
  const p1x = PERP[0];
  const p1y = PERP[1];
  const p1z = PERP[2];
  const p2x = PERP[3];
  const p2y = PERP[4];
  const p2z = PERP[5];
  const cx = (bodies.posX[b] ?? 0) + rB[0] - (bodies.posX[a] ?? 0) - rA[0];
  const cy = (bodies.posY[b] ?? 0) + rB[1] - (bodies.posY[a] ?? 0) - rA[1];
  const cz = (bodies.posZ[b] ?? 0) + rB[2] - (bodies.posZ[a] ?? 0) - rA[2];
  for (let row = 0; row < 2; row++) {
    const nx = row === 0 ? p1x : p2x;
    const ny = row === 0 ? p1y : p2y;
    const nz = row === 0 ? p1z : p2z;
    const c = cx * nx + cy * ny + cz * nz;
    const mass = axisMass(bodies, a, b, nx, ny, nz);
    pointVelocity(bodies, a, b);
    const cdot = V[0] * nx + V[1] * ny + V[2] * nz;
    const at = j * 6 + row;
    const old = joints.impulse[at] ?? 0;
    const p = -mass * massScale * (cdot + biasRate * c) - impulseScale * old;
    joints.impulse[at] = old + p;
    applyLinear(bodies, a, b, nx * p, ny * p, nz * p);
  }
  // The travel along the axis: one-sided at each end, free between them.
  const travel = cx * ax + cy * ay + cz * az;
  const lower = joints.lower[j] ?? -Infinity;
  const upper = joints.upper[j] ?? Infinity;
  const at2 = j * 6 + 2;
  if (travel < lower || travel > upper) {
    const low = travel < lower;
    const c = low ? travel - lower : travel - upper;
    const mass = axisMass(bodies, a, b, ax, ay, az);
    pointVelocity(bodies, a, b);
    const cdot = V[0] * ax + V[1] * ay + V[2] * az;
    const old = joints.impulse[at2] ?? 0;
    let next = old - mass * massScale * (cdot + biasRate * c) - impulseScale * old;
    if (low && next < 0) next = 0;
    if (!low && next > 0) next = 0;
    const p = next - old;
    joints.impulse[at2] = next;
    applyLinear(bodies, a, b, ax * p, ay * p, az * p);
  } else {
    joints.impulse[at2] = 0;
  }
  const maxF = joints.motorMaxForce[j] ?? 0;
  if (maxF > 0) {
    const mass = axisMass(bodies, a, b, ax, ay, az);
    pointVelocity(bodies, a, b);
    const cdot = V[0] * ax + V[1] * ay + V[2] * az;
    const old = joints.motorImpulse[j] ?? 0;
    let next = old - mass * (cdot - (joints.motorSpeed[j] ?? 0));
    const bound = maxF * dt;
    if (next > bound) next = bound;
    else if (next < -bound) next = -bound;
    const p = next - old;
    joints.motorImpulse[j] = next;
    applyLinear(bodies, a, b, ax * p, ay * p, az * p);
  }
}

/** A swing cone and a twist limit, both as comparisons rather than as angles. */
function solveConeTwist(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  relativeRotation(bodies, a, b, REL, 0);
  // The rest frame's axis, and where B has taken it.
  worldAxis(bodies, joints, j, a);
  const ax = AXIS[0];
  const ay = AXIS[1];
  const az = AXIS[2];
  rotateVectorByBody(bodies, b, joints.axis, j * 3, V);
  const cos = ax * V[0] + ay * V[1] + az * V[2];
  const limit = joints.swingCos[j] ?? -1;
  if (cos < limit) {
    /*
     * Outside the cone. The correction axis is the one that closes the swing, which is the cross
     * product of where the axis is and where it is allowed to be — no angle is measured, only the
     * comparison above and the direction here.
     */
    let nx = ay * V[2] - az * V[1];
    let ny = az * V[0] - ax * V[2];
    let nz = ax * V[1] - ay * V[0];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
      nz /= len;
      const mass = angularAxisMass(nx, ny, nz);
      const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0);
      const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0);
      const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0);
      const cdot = wx * nx + wy * ny + wz * nz;
      const at = j * 6 + 3;
      const old = joints.impulse[at] ?? 0;
      const p = -mass * massScale * (cdot + biasRate * (limit - cos)) - impulseScale * old;
      joints.impulse[at] = old + p;
      applyAngular(bodies, a, b, nx * p, ny * p, nz * p);
    }
  }
  // The twist about the axis, as the relative quaternion's component along it.
  const twist = REL[0] * ax + REL[1] * ay + REL[2] * az;
  const bound = joints.twistSin[j] ?? 1;
  if (Math.abs(twist) > bound) {
    const over = twist > 0 ? twist - bound : twist + bound;
    const mass = angularAxisMass(ax, ay, az);
    const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0);
    const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0);
    const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0);
    const cdot = wx * ax + wy * ay + wz * az;
    const at = j * 6 + 4;
    const old = joints.impulse[at] ?? 0;
    const p = -mass * massScale * (cdot + biasRate * 2 * over) - impulseScale * old;
    joints.impulse[at] = old + p;
    applyAngular(bodies, a, b, ax * p, ay * p, az * p);
  }
}

/**
 * Six independent scalar rows, one per degree of freedom, in body A's frame.
 *
 * **Scalar rows rather than two coupled 3x3 blocks**, and the reason is that the blocks would not
 * exist: a caller who leaves linear y free and locks x and z has a 2x2, and the next caller has a
 * different one. Solving each row on its own is the only shape that survives every configuration.
 * *Cost:* an all-locked six-DOF joint is softer than `JOINT_FIXED`, which solves both blocks
 * coupled — measured as a millimetre of extra sag on a half-tonne box at four substeps.
 *
 * **A free axis is skipped entirely and its accumulator zeroed**, never given a zero error. A row
 * with `C = 0` still removes all velocity along its axis, so a body that should fall would be held
 * exactly where it is — the distinction `solveDistance` draws between its bounds, one dimension up.
 */
function solveSixDof(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  bodyFrame(bodies, a);
  const base = j * DOF_COUNT;

  /* The offset between the two anchors, which every linear row projects onto its own axis. */
  const cx = (bodies.posX[b] ?? 0) + rB[0] - (bodies.posX[a] ?? 0) - rA[0];
  const cy = (bodies.posY[b] ?? 0) + rB[1] - (bodies.posY[a] ?? 0) - rA[1];
  const cz = (bodies.posZ[b] ?? 0) + rB[2] - (bodies.posZ[a] ?? 0) - rA[2];

  for (let k = 0; k < 3; k++) {
    const mode = joints.dofMode[base + k] ?? DOF_LOCKED;
    const at = j * 6 + k;
    if (mode === DOF_FREE) {
      joints.impulse[at] = 0;
      continue;
    }
    const nx = FRAME[k * 3] as number;
    const ny = FRAME[k * 3 + 1] as number;
    const nz = FRAME[k * 3 + 2] as number;
    const offset = cx * nx + cy * ny + cz * nz;

    let c = offset;
    let minP = -Infinity;
    let maxP = Infinity;
    if (mode === DOF_LIMITED) {
      const lower = joints.dofLower[base + k] ?? 0;
      const upper = joints.dofUpper[base + k] ?? 0;
      if (offset >= lower && offset <= upper) {
        joints.impulse[at] = 0;
        continue;
      }
      if (offset < lower) {
        c = offset - lower;
        minP = 0; // may only push out
      } else {
        c = offset - upper;
        maxP = 0; // may only pull back
      }
    }

    const mass = axisMass(bodies, a, b, nx, ny, nz);
    pointVelocity(bodies, a, b);
    const cdot = V[0] * nx + V[1] * ny + V[2] * nz;
    const old = joints.impulse[at] ?? 0;
    let next = old - mass * massScale * (cdot + biasRate * c) - impulseScale * old;
    if (next < minP) next = minP;
    else if (next > maxP) next = maxP;
    const p = next - old;
    joints.impulse[at] = next;
    applyLinear(bodies, a, b, nx * p, ny * p, nz * p);
  }

  /*
   * The angular half reads the drift from the rest rotation rather than the raw relative one, so a
   * bound means "this far from where the joint was made" — which is what a rig posed and then
   * jointed needs, and is the same quantity `solveAngularLock` drives to zero.
   *
   * Twice the vector part is the small-angle rotation vector the locked rows want; the vector part
   * itself is the sine of the half angle the limits are stated in. One computation, two scales.
   */
  orientationErrorInto(bodies, joints, j, a, b, DOF_ANG, 1);
  for (let k = 0; k < 3; k++) {
    const mode = joints.dofMode[base + 3 + k] ?? DOF_LOCKED;
    const at = j * 6 + 3 + k;
    if (mode === DOF_FREE) {
      joints.impulse[at] = 0;
      continue;
    }
    const nx = FRAME[k * 3] as number;
    const ny = FRAME[k * 3 + 1] as number;
    const nz = FRAME[k * 3 + 2] as number;
    const sin = DOF_ANG[0] * nx + DOF_ANG[1] * ny + DOF_ANG[2] * nz;

    /* Locked drives the rotation vector, which is twice the sine, exactly as the fixed joint's
       three rows do. Limited compares the sine against the bound and then answers with the same
       doubled error, so both arms push in the units the solver is calibrated for. */
    let c = 2 * sin;
    let minP = -Infinity;
    let maxP = Infinity;
    if (mode === DOF_LIMITED) {
      const lower = joints.dofLower[base + 3 + k] ?? 0;
      const upper = joints.dofUpper[base + 3 + k] ?? 0;
      if (sin >= lower && sin <= upper) {
        joints.impulse[at] = 0;
        continue;
      }
      if (sin < lower) {
        c = 2 * (sin - lower);
        minP = 0;
      } else {
        c = 2 * (sin - upper);
        maxP = 0;
      }
    }

    const mass = angularAxisMass(nx, ny, nz);
    const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0);
    const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0);
    const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0);
    const cdot = wx * nx + wy * ny + wz * nz;
    const old = joints.impulse[at] ?? 0;
    let next = old - mass * massScale * (cdot + biasRate * c) - impulseScale * old;
    if (next < minP) next = minP;
    else if (next > maxP) next = maxP;
    const p = next - old;
    joints.impulse[at] = next;
    applyAngular(bodies, a, b, nx * p, ny * p, nz * p);
  }
}

/** Body A's three local axes in world space, as three consecutive triples in `FRAME`. */
function bodyFrame(bodies: BodySet, i: number): void {
  const x = bodies.rotX[i] ?? 0;
  const y = bodies.rotY[i] ?? 0;
  const z = bodies.rotZ[i] ?? 0;
  const w = bodies.rotW[i] ?? 1;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  FRAME[0] = 1 - 2 * (yy + zz);
  FRAME[1] = 2 * (xy + wz);
  FRAME[2] = 2 * (xz - wy);
  FRAME[3] = 2 * (xy - wz);
  FRAME[4] = 1 - 2 * (xx + zz);
  FRAME[5] = 2 * (yz + wx);
  FRAME[6] = 2 * (xz + wy);
  FRAME[7] = 2 * (yz - wx);
  FRAME[8] = 1 - 2 * (xx + yy);
}

/* ---------- shared rows ---------- */

const PERP = new Float64Array(6);

/** Two unit vectors perpendicular to `n` and to each other, without a trig call. */
function perpendicularPair(nx: number, ny: number, nz: number): void {
  let t1x: number;
  let t1y: number;
  let t1z: number;
  if (Math.abs(nx) >= 0.57735) {
    t1x = ny;
    t1y = -nx;
    t1z = 0;
  } else {
    t1x = 0;
    t1y = nz;
    t1z = -ny;
  }
  const len = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z) || 1;
  PERP[0] = t1x / len;
  PERP[1] = t1y / len;
  PERP[2] = t1z / len;
  PERP[3] = ny * PERP[2] - nz * PERP[1];
  PERP[4] = nz * PERP[0] - nx * PERP[2];
  PERP[5] = nx * PERP[1] - ny * PERP[0];
}

/** Lock relative rotation about the two axes perpendicular to the free one. */
function lockAboutTwoAxes(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
): void {
  orientationError(bodies, joints, j, a, b);
  const ex = V[0];
  const ey = V[1];
  const ez = V[2];
  for (let row = 0; row < 2; row++) {
    const nx = PERP[row * 3];
    const ny = PERP[row * 3 + 1];
    const nz = PERP[row * 3 + 2];
    const c = ex * nx + ey * ny + ez * nz;
    const mass = angularAxisMass(nx, ny, nz);
    const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0);
    const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0);
    const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0);
    const cdot = wx * nx + wy * ny + wz * nz;
    const at = j * 6 + 3 + row;
    const old = joints.impulse[at] ?? 0;
    const p = -mass * massScale * (cdot + biasRate * c) - impulseScale * old;
    joints.impulse[at] = old + p;
    applyAngular(bodies, a, b, nx * p, ny * p, nz * p);
  }
}

/** A hinge's rotation limit and its motor, both about the free axis. */
function motorAndLimit(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  dt: number,
  biasRate: number,
  massScale: number,
  impulseScale: number,
  angular: boolean,
): void {
  const ax = AXIS[0];
  const ay = AXIS[1];
  const az = AXIS[2];
  const lower = joints.lower[j] ?? -Infinity;
  const upper = joints.upper[j] ?? Infinity;
  if (lower !== -Infinity || upper !== Infinity) {
    relativeRotation(bodies, a, b, REL, 0);
    // The rotation about the axis, as the relative quaternion's component along it.
    const s = REL[0] * ax + REL[1] * ay + REL[2] * az;
    const at = j * 6 + 5;
    if (s < lower || s > upper) {
      const low = s < lower;
      const c = low ? s - lower : s - upper;
      const mass = angularAxisMass(ax, ay, az);
      const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0);
      const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0);
      const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0);
      const cdot = wx * ax + wy * ay + wz * az;
      const old = joints.impulse[at] ?? 0;
      let next = old - mass * massScale * (cdot + biasRate * 2 * c) - impulseScale * old;
      if (low && next < 0) next = 0;
      if (!low && next > 0) next = 0;
      const p = next - old;
      joints.impulse[at] = next;
      applyAngular(bodies, a, b, ax * p, ay * p, az * p);
    } else {
      joints.impulse[at] = 0;
    }
  }
  const maxF = joints.motorMaxForce[j] ?? 0;
  if (maxF > 0 && angular) {
    const mass = angularAxisMass(ax, ay, az);
    const wx = (bodies.angX[b] ?? 0) - (bodies.angX[a] ?? 0);
    const wy = (bodies.angY[b] ?? 0) - (bodies.angY[a] ?? 0);
    const wz = (bodies.angZ[b] ?? 0) - (bodies.angZ[a] ?? 0);
    const cdot = wx * ax + wy * ay + wz * az;
    const old = joints.motorImpulse[j] ?? 0;
    let next = old - mass * (cdot - (joints.motorSpeed[j] ?? 0));
    const bound = maxF * dt;
    if (next > bound) next = bound;
    else if (next < -bound) next = -bound;
    const p = next - old;
    joints.motorImpulse[j] = next;
    applyAngular(bodies, a, b, ax * p, ay * p, az * p);
  }
}

/* ---------- arithmetic ---------- */

function pointMass(bodies: BodySet, a: number, b: number): void {
  const m = (bodies.invMass[a] ?? 0) + (bodies.invMass[b] ?? 0);
  // K = (mA + mB)·I − skew(rA)·IA·skew(rA) − skew(rB)·IB·skew(rB), six symmetric terms.
  K[0] = m;
  K[1] = m;
  K[2] = m;
  K[3] = 0;
  K[4] = 0;
  K[5] = 0;
  accumulateSkew(iA, rA);
  accumulateSkew(iB, rB);
}

/**
 * Add `skew(r)ᵀ·I·skew(r)` into `K`, which is symmetric and positive semi-definite.
 *
 * **The sign is the whole of it.** `skew(r)ᵀ = −skew(r)`, so the term is `−skew·I·skew`, and what
 * the multiplication below produces — `skew·I·skewᵀ` — is already exactly that. It is *added*.
 * Subtracting it instead shrinks the effective mass toward singular, which came out as every joint
 * sagging 83 millimetres under load and a spherical joint answering NaN.
 */
function accumulateSkew(inv: Float32Array, r: Float64Array): void {
  const x = r[0];
  const y = r[1];
  const z = r[2];
  SKEW[0] = 0;
  SKEW[1] = -z;
  SKEW[2] = y;
  SKEW[3] = z;
  SKEW[4] = 0;
  SKEW[5] = -x;
  SKEW[6] = -y;
  SKEW[7] = x;
  SKEW[8] = 0;
  const ixx = inv[0] ?? 0;
  const iyy = inv[1] ?? 0;
  const izz = inv[2] ?? 0;
  const ixy = inv[3] ?? 0;
  const ixz = inv[4] ?? 0;
  const iyz = inv[5] ?? 0;
  MAT[0] = ixx;
  MAT[1] = ixy;
  MAT[2] = ixz;
  MAT[3] = ixy;
  MAT[4] = iyy;
  MAT[5] = iyz;
  MAT[6] = ixz;
  MAT[7] = iyz;
  MAT[8] = izz;
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 3; k++) {
      TMP[i * 3 + k] =
        SKEW[i * 3] * MAT[k] + SKEW[i * 3 + 1] * MAT[3 + k] + SKEW[i * 3 + 2] * MAT[6 + k];
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      OUT9[i * 3 + j] =
        TMP[i * 3] * SKEW[j * 3] +
        TMP[i * 3 + 1] * SKEW[j * 3 + 1] +
        TMP[i * 3 + 2] * SKEW[j * 3 + 2];
    }
  }
  K[0] += OUT9[0];
  K[1] += OUT9[4];
  K[2] += OUT9[8];
  K[3] += OUT9[1];
  K[4] += OUT9[2];
  K[5] += OUT9[5];
}

function angularMass(): void {
  for (let k = 0; k < 6; k++) K[k] = (iA[k] ?? 0) + (iB[k] ?? 0);
}

function angularAxisMass(nx: number, ny: number, nz: number): number {
  const k = quad(iA, nx, ny, nz) + quad(iB, nx, ny, nz);
  return k > 0 ? 1 / k : 0;
}

function axisMass(
  bodies: BodySet,
  a: number,
  b: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const cax = rA[1] * nz - rA[2] * ny;
  const cay = rA[2] * nx - rA[0] * nz;
  const caz = rA[0] * ny - rA[1] * nx;
  const cbx = rB[1] * nz - rB[2] * ny;
  const cby = rB[2] * nx - rB[0] * nz;
  const cbz = rB[0] * ny - rB[1] * nx;
  const k =
    (bodies.invMass[a] ?? 0) +
    (bodies.invMass[b] ?? 0) +
    quad(iA, cax, cay, caz) +
    quad(iB, cbx, cby, cbz);
  return k > 0 ? 1 / k : 0;
}

function quad(m: Float32Array, x: number, y: number, z: number): number {
  return (
    (m[0] ?? 0) * x * x +
    (m[1] ?? 0) * y * y +
    (m[2] ?? 0) * z * z +
    2 * ((m[3] ?? 0) * x * y + (m[4] ?? 0) * x * z + (m[5] ?? 0) * y * z)
  );
}

function multiply3(m: Float64Array, x: number, y: number, z: number, row: number): number {
  if (row === 0) return m[0] * x + m[3] * y + m[4] * z;
  if (row === 1) return m[3] * x + m[1] * y + m[5] * z;
  return m[4] * x + m[5] * y + m[2] * z;
}

/** Invert a symmetric 3×3 held as six terms. A singular matrix inverts to zero, never to NaN. */
function invertSymmetric3(m: Float64Array, out: Float64Array): void {
  const c00 = m[1] * m[2] - m[5] * m[5];
  const c01 = m[4] * m[5] - m[3] * m[2];
  const c02 = m[3] * m[5] - m[4] * m[1];
  const det = m[0] * c00 + m[3] * c01 + m[4] * c02;
  if (det === 0) {
    for (let k = 0; k < 6; k++) out[k] = 0;
    return;
  }
  const inv = 1 / det;
  out[0] = c00 * inv;
  out[1] = (m[0] * m[2] - m[4] * m[4]) * inv;
  out[2] = (m[0] * m[1] - m[3] * m[3]) * inv;
  out[3] = c01 * inv;
  out[4] = c02 * inv;
  out[5] = (m[3] * m[4] - m[0] * m[5]) * inv;
}

function pointVelocity(bodies: BodySet, a: number, b: number): void {
  const wax = bodies.angX[a] ?? 0;
  const way = bodies.angY[a] ?? 0;
  const waz = bodies.angZ[a] ?? 0;
  const wbx = bodies.angX[b] ?? 0;
  const wby = bodies.angY[b] ?? 0;
  const wbz = bodies.angZ[b] ?? 0;
  V[0] =
    (bodies.velX[b] ?? 0) +
    (wby * rB[2] - wbz * rB[1]) -
    (bodies.velX[a] ?? 0) -
    (way * rA[2] - waz * rA[1]);
  V[1] =
    (bodies.velY[b] ?? 0) +
    (wbz * rB[0] - wbx * rB[2]) -
    (bodies.velY[a] ?? 0) -
    (waz * rA[0] - wax * rA[2]);
  V[2] =
    (bodies.velZ[b] ?? 0) +
    (wbx * rB[1] - wby * rB[0]) -
    (bodies.velZ[a] ?? 0) -
    (wax * rA[1] - way * rA[0]);
}

function applyLinear(
  bodies: BodySet,
  a: number,
  b: number,
  px: number,
  py: number,
  pz: number,
): void {
  const imA = bodies.invMass[a] ?? 0;
  if (imA > 0) {
    bodies.velX[a] = (bodies.velX[a] ?? 0) - px * imA;
    bodies.velY[a] = (bodies.velY[a] ?? 0) - py * imA;
    bodies.velZ[a] = (bodies.velZ[a] ?? 0) - pz * imA;
    torque(
      bodies,
      a,
      iA,
      rA[1] * pz - rA[2] * py,
      rA[2] * px - rA[0] * pz,
      rA[0] * py - rA[1] * px,
      -1,
    );
  }
  const imB = bodies.invMass[b] ?? 0;
  if (imB > 0) {
    bodies.velX[b] = (bodies.velX[b] ?? 0) + px * imB;
    bodies.velY[b] = (bodies.velY[b] ?? 0) + py * imB;
    bodies.velZ[b] = (bodies.velZ[b] ?? 0) + pz * imB;
    torque(
      bodies,
      b,
      iB,
      rB[1] * pz - rB[2] * py,
      rB[2] * px - rB[0] * pz,
      rB[0] * py - rB[1] * px,
      1,
    );
  }
}

function applyAngular(
  bodies: BodySet,
  a: number,
  b: number,
  px: number,
  py: number,
  pz: number,
): void {
  if ((bodies.invMass[a] ?? 0) > 0 || bodies.type[a] === BODY_DYNAMIC)
    torque(bodies, a, iA, px, py, pz, -1);
  if ((bodies.invMass[b] ?? 0) > 0 || bodies.type[b] === BODY_DYNAMIC)
    torque(bodies, b, iB, px, py, pz, 1);
}

function torque(
  bodies: BodySet,
  i: number,
  inv: Float32Array,
  tx: number,
  ty: number,
  tz: number,
  sign: number,
): void {
  bodies.angX[i] =
    (bodies.angX[i] ?? 0) + sign * ((inv[0] ?? 0) * tx + (inv[3] ?? 0) * ty + (inv[4] ?? 0) * tz);
  bodies.angY[i] =
    (bodies.angY[i] ?? 0) + sign * ((inv[3] ?? 0) * tx + (inv[1] ?? 0) * ty + (inv[5] ?? 0) * tz);
  bodies.angZ[i] =
    (bodies.angZ[i] ?? 0) + sign * ((inv[4] ?? 0) * tx + (inv[5] ?? 0) * ty + (inv[2] ?? 0) * tz);
}

function rotateLocal(
  bodies: BodySet,
  i: number,
  src: Float32Array,
  at: number,
  out: Float64Array,
): void {
  const x = src[at] ?? 0;
  const y = src[at + 1] ?? 0;
  const z = src[at + 2] ?? 0;
  const qx = bodies.rotX[i] ?? 0;
  const qy = bodies.rotY[i] ?? 0;
  const qz = bodies.rotZ[i] ?? 0;
  const qw = bodies.rotW[i] ?? 1;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/** A world vector in a body's local frame, written into `out`. */
function unrotateInto(
  bodies: BodySet,
  i: number,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  at: number,
): void {
  const qx = -(bodies.rotX[i] ?? 0);
  const qy = -(bodies.rotY[i] ?? 0);
  const qz = -(bodies.rotZ[i] ?? 0);
  const qw = bodies.rotW[i] ?? 1;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[at] = x + qw * tx + (qy * tz - qz * ty);
  out[at + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[at + 2] = z + qw * tz + (qx * ty - qy * tx);
}

function rotateVectorByBody(
  bodies: BodySet,
  i: number,
  src: Float32Array,
  at: number,
  out: Float64Array,
): void {
  rotateLocal(bodies, i, src, at, out);
}

function worldAxis(bodies: BodySet, joints: JointSet, j: number, a: number): void {
  rotateLocal(bodies, a, joints.axis, j * 3, AXIS);
}

/** `conj(qA) · qB`, into `out`, as xyzw. */
export function relativeRotation(
  bodies: BodySet,
  a: number,
  b: number,
  out: Float32Array | Float64Array,
  at: number,
): void {
  const ax = -(bodies.rotX[a] ?? 0);
  const ay = -(bodies.rotY[a] ?? 0);
  const az = -(bodies.rotZ[a] ?? 0);
  const aw = bodies.rotW[a] ?? 1;
  const bx = bodies.rotX[b] ?? 0;
  const by = bodies.rotY[b] ?? 0;
  const bz = bodies.rotZ[b] ?? 0;
  const bw = bodies.rotW[b] ?? 1;
  out[at] = aw * bx + ax * bw + ay * bz - az * by;
  out[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * How far the relative rotation has drifted from the one the joint was made at, as a rotation
 * vector in world space, into `V`.
 *
 * Twice the vector part of `rel · conj(rest)` is the small-angle rotation vector, which is exact
 * enough for a constraint that drives it to zero and needs no `acos` to obtain.
 */
function orientationError(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
): void {
  orientationErrorInto(bodies, joints, j, a, b, V, 2);
}

/**
 * The same error at a chosen scale, into a chosen target.
 *
 * Split out for `solveSixDof`, which wants the vector part *undoubled* — that is the sine of the
 * half angle, which is the unit every limit in this file is stated in. Shared rather than written
 * twice, because two implementations of one decision drift and they drift invisibly when they
 * start identical. `orientationError` passes 2 and is bit-identical to what it was.
 */
function orientationErrorInto(
  bodies: BodySet,
  joints: JointSet,
  j: number,
  a: number,
  b: number,
  out: Float64Array,
  scale: number,
): void {
  relativeRotation(bodies, a, b, REL, 0);
  const at = j * 4;
  const rx = -(joints.restRel[at] ?? 0);
  const ry = -(joints.restRel[at + 1] ?? 0);
  const rz = -(joints.restRel[at + 2] ?? 0);
  const rw = joints.restRel[at + 3] ?? 1;
  let ex = REL[3] * rx + REL[0] * rw + REL[1] * rz - REL[2] * ry;
  let ey = REL[3] * ry - REL[0] * rz + REL[1] * rw + REL[2] * rx;
  let ez = REL[3] * rz + REL[0] * ry - REL[1] * rx + REL[2] * rw;
  const ew = REL[3] * rw - REL[0] * rx - REL[1] * ry - REL[2] * rz;
  // Take the shorter arc, or a joint past a half turn would be driven the long way round.
  if (ew < 0) {
    ex = -ex;
    ey = -ey;
    ez = -ez;
  }
  // Into A's world frame: the error is expressed in A's local frame by construction.
  const qx = bodies.rotX[a] ?? 0;
  const qy = bodies.rotY[a] ?? 0;
  const qz = bodies.rotZ[a] ?? 0;
  const qw = bodies.rotW[a] ?? 1;
  const tx = 2 * (qy * ez - qz * ey);
  const ty = 2 * (qz * ex - qx * ez);
  const tz = 2 * (qx * ey - qy * ex);
  out[0] = scale * (ex + qw * tx + (qy * tz - qz * ty));
  out[1] = scale * (ey + qw * ty + (qz * tx - qx * tz));
  out[2] = scale * (ez + qw * tz + (qx * ty - qy * tx));
}
