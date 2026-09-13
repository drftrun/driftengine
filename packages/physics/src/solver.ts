import { BODY_DYNAMIC } from './bodies.ts';
import type { BodySet } from './bodies.ts';
import type { Manifold } from './manifold.ts';

/**
 * Contact constraints, and the substepped soft solve over them.
 *
 * **Soft rather than Baumgarte, and the difference is a property rather than a preference.** Every
 * constraint carries a *hertz* and a damping ratio, from which the bias rate, mass scale and
 * impulse scale are derived using the substep length. Stating stiffness as a frequency is what
 * makes the substep count a quality dial: turn it up and nothing moves differently. A Baumgarte
 * bias is a fraction of penetration per step, so it means something different at every step length,
 * and the mitigations for that are all tuning constants — which `AGENTS.md` says never to assert.
 *
 * **Nothing here recomputes a manifold.** Anchors are stored in body-local frame at prepare time
 * along with a separation offset, so the current separation is exact at any point inside the tick
 * without re-running narrowphase per substep. `s = sBase + dot((pB + rB') − (pA + rA'), n)` is that
 * identity, and it holds because `sBase` is defined to make it hold at prepare.
 *
 * **Every entry point takes an order array rather than a contiguous range.** Islands are disjoint
 * by construction, so they can be solved in any order or simultaneously — but a constraint list
 * built in pair order is not grouped by island. Indirecting through an order array groups them
 * without permuting eleven parallel arrays, and it is what lets one `solveIsland` serve both
 * executors.
 *
 * **Friction is solved before the normal**, against the normal impulse accumulated so far. Solving
 * it after means the first iteration has no normal impulse to bound against and applies none, so a
 * resting body slides for one iteration every substep.
 */

/** Contacts start with this much slack allowed before the bias fights them, in metres. */
export const LINEAR_SLOP = 0.005;
/** How fast the bias may push overlap out, in metres per second. */
export const MAX_BIAS_VELOCITY = 4;
/** Below this approach speed a bounce is not worth having, and jitters if it is applied. */
export const RESTITUTION_THRESHOLD = 1;

export class ContactConstraints {
  /** One entry per manifold. */
  count = 0;
  bodyA: Int32Array;
  bodyB: Int32Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  t1x: Float32Array;
  t1y: Float32Array;
  t1z: Float32Array;
  t2x: Float32Array;
  t2y: Float32Array;
  t2z: Float32Array;
  friction: Float32Array;
  restitution: Float32Array;
  pointStart: Int32Array;
  pointCount: Int32Array;

  /** One entry per contact point. */
  points = 0;
  localA: Float32Array;
  localB: Float32Array;
  sBase: Float32Array;
  normalMass: Float32Array;
  tangent1Mass: Float32Array;
  tangent2Mass: Float32Array;
  normalImpulse: Float32Array;
  tangent1Impulse: Float32Array;
  tangent2Impulse: Float32Array;
  /** Approach speed when the constraint was prepared, which is what restitution answers to. */
  approach: Float32Array;
  featureId: Int32Array;
  /**
   * Whether each side's anchor sits on a curved surface, one byte per point.
   *
   * A curved anchor is held in world frame rather than in the body's, for the reason `Manifold`
   * states at length: the point where a ball touches the floor does not turn with the ball, and an
   * anchor that turns anyway climbs its side and reports a gap that is not there. Per point rather
   * than per manifold so `worldAnchors` needs only the point index, which is all its callers have.
   */
  curvedA: Uint8Array;
  curvedB: Uint8Array;

  private cap: number;
  private pcap: number;

  constructor(capacity = 128) {
    this.cap = capacity;
    this.pcap = capacity * 4;
    this.bodyA = new Int32Array(this.cap);
    this.bodyB = new Int32Array(this.cap);
    this.nx = new Float32Array(this.cap);
    this.ny = new Float32Array(this.cap);
    this.nz = new Float32Array(this.cap);
    this.t1x = new Float32Array(this.cap);
    this.t1y = new Float32Array(this.cap);
    this.t1z = new Float32Array(this.cap);
    this.t2x = new Float32Array(this.cap);
    this.t2y = new Float32Array(this.cap);
    this.t2z = new Float32Array(this.cap);
    this.friction = new Float32Array(this.cap);
    this.restitution = new Float32Array(this.cap);
    this.pointStart = new Int32Array(this.cap);
    this.pointCount = new Int32Array(this.cap);
    this.localA = new Float32Array(this.pcap * 3);
    this.localB = new Float32Array(this.pcap * 3);
    this.sBase = new Float32Array(this.pcap);
    this.normalMass = new Float32Array(this.pcap);
    this.tangent1Mass = new Float32Array(this.pcap);
    this.tangent2Mass = new Float32Array(this.pcap);
    this.normalImpulse = new Float32Array(this.pcap);
    this.tangent1Impulse = new Float32Array(this.pcap);
    this.tangent2Impulse = new Float32Array(this.pcap);
    this.approach = new Float32Array(this.pcap);
    this.featureId = new Int32Array(this.pcap);
    this.curvedA = new Uint8Array(this.pcap);
    this.curvedB = new Uint8Array(this.pcap);
  }

  clear(): void {
    this.count = 0;
    this.points = 0;
  }

  reserve(pointsNeeded: number): void {
    if (this.count === this.cap) this.growConstraints();
    while (this.points + pointsNeeded > this.pcap) this.growPoints();
  }

  private growConstraints(): void {
    this.cap *= 2;
    const g = <T extends Int32Array | Float32Array>(a: T): T => {
      const out = new (a.constructor as new (n: number) => T)(this.cap);
      out.set(a);
      return out;
    };
    this.bodyA = g(this.bodyA);
    this.bodyB = g(this.bodyB);
    this.nx = g(this.nx);
    this.ny = g(this.ny);
    this.nz = g(this.nz);
    this.t1x = g(this.t1x);
    this.t1y = g(this.t1y);
    this.t1z = g(this.t1z);
    this.t2x = g(this.t2x);
    this.t2y = g(this.t2y);
    this.t2z = g(this.t2z);
    this.friction = g(this.friction);
    this.restitution = g(this.restitution);
    this.pointStart = g(this.pointStart);
    this.pointCount = g(this.pointCount);
  }

  private growPoints(): void {
    this.pcap *= 2;
    const g = <T extends Int32Array | Float32Array | Uint8Array>(a: T, stride = 1): T => {
      const out = new (a.constructor as new (n: number) => T)(this.pcap * stride);
      out.set(a);
      return out;
    };
    this.localA = g(this.localA, 3);
    this.localB = g(this.localB, 3);
    this.sBase = g(this.sBase);
    this.normalMass = g(this.normalMass);
    this.tangent1Mass = g(this.tangent1Mass);
    this.tangent2Mass = g(this.tangent2Mass);
    this.normalImpulse = g(this.normalImpulse);
    this.tangent1Impulse = g(this.tangent1Impulse);
    this.tangent2Impulse = g(this.tangent2Impulse);
    this.approach = g(this.approach);
    this.featureId = g(this.featureId);
    this.curvedA = g(this.curvedA);
    this.curvedB = g(this.curvedB);
  }
}

const invIA = new Float32Array(6);
const invIB = new Float32Array(6);

/**
 * Turn one manifold into a constraint, with its effective masses and its local anchors.
 *
 * `warm` supplies the previous tick's impulses by feature id, or −1 where there is none. Warm
 * starting is what lets a stack converge in a handful of iterations rather than a hundred.
 */
export function prepareContact(
  bodies: BodySet,
  a: number,
  b: number,
  m: Manifold,
  c: ContactConstraints,
  warmNormal: Float32Array | null,
  warmT1: Float32Array | null,
  warmT2: Float32Array | null,
): void {
  c.reserve(m.count);
  const k = c.count++;
  c.bodyA[k] = a;
  c.bodyB[k] = b;
  c.nx[k] = m.nx;
  c.ny[k] = m.ny;
  c.nz[k] = m.nz;
  // An orthonormal basis around the normal, built from comparisons and one square root.
  let t1x: number;
  let t1y: number;
  let t1z: number;
  if (Math.abs(m.nx) >= 0.57735) {
    t1x = m.ny;
    t1y = -m.nx;
    t1z = 0;
  } else {
    t1x = 0;
    t1y = m.nz;
    t1z = -m.ny;
  }
  const tl = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z) || 1;
  t1x /= tl;
  t1y /= tl;
  t1z /= tl;
  c.t1x[k] = t1x;
  c.t1y[k] = t1y;
  c.t1z[k] = t1z;
  c.t2x[k] = m.ny * t1z - m.nz * t1y;
  c.t2y[k] = m.nz * t1x - m.nx * t1z;
  c.t2z[k] = m.nx * t1y - m.ny * t1x;

  // A pair's friction and bounce are the geometric and the larger mean of the two bodies'.
  c.friction[k] = Math.sqrt((bodies.friction[a] ?? 0) * (bodies.friction[b] ?? 0));
  const ra = bodies.restitution[a] ?? 0;
  const rb = bodies.restitution[b] ?? 0;
  c.restitution[k] = ra > rb ? ra : rb;

  bodies.worldInverseInertia(a, invIA);
  bodies.worldInverseInertia(b, invIB);
  const imA = bodies.invMass[a] ?? 0;
  const imB = bodies.invMass[b] ?? 0;

  c.pointStart[k] = c.points;
  c.pointCount[k] = m.count;
  for (let i = 0; i < m.count; i++) {
    const p = c.points++;
    const px = m.points[i * 3] ?? 0;
    const py = m.points[i * 3 + 1] ?? 0;
    const pz = m.points[i * 3 + 2] ?? 0;
    const rax = px - (bodies.posX[a] ?? 0);
    const ray = py - (bodies.posY[a] ?? 0);
    const raz = pz - (bodies.posZ[a] ?? 0);
    const rbx = px - (bodies.posX[b] ?? 0);
    const rby = py - (bodies.posY[b] ?? 0);
    const rbz = pz - (bodies.posZ[b] ?? 0);
    /*
     * A flat anchor is stored in its body's frame and turned forward with it; a curved one is
     * stored in world frame and left alone. Both are read back by `worldAnchors`, which reads the
     * same flag — so the pair of them is one decision written in two places and nowhere else.
     */
    c.curvedA[p] = m.curvedA ? 1 : 0;
    c.curvedB[p] = m.curvedB ? 1 : 0;
    if (m.curvedA) {
      c.localA[p * 3] = rax;
      c.localA[p * 3 + 1] = ray;
      c.localA[p * 3 + 2] = raz;
    } else {
      unrotate(bodies, a, rax, ray, raz, c.localA, p * 3);
    }
    if (m.curvedB) {
      c.localB[p * 3] = rbx;
      c.localB[p * 3 + 1] = rby;
      c.localB[p * 3 + 2] = rbz;
    } else {
      unrotate(bodies, b, rbx, rby, rbz, c.localB, p * 3);
    }

    /*
     * The offset that makes `s = sBase + dot((pB + rB') − (pA + rA'), n)` reproduce this tick's
     * separation exactly, and every later substep's without a second narrowphase.
     */
    const nx = m.nx;
    const ny = m.ny;
    const nz = m.nz;
    const now =
      ((bodies.posX[b] ?? 0) + rbx - (bodies.posX[a] ?? 0) - rax) * nx +
      ((bodies.posY[b] ?? 0) + rby - (bodies.posY[a] ?? 0) - ray) * ny +
      ((bodies.posZ[b] ?? 0) + rbz - (bodies.posZ[a] ?? 0) - raz) * nz;
    c.sBase[p] = (m.separations[i] ?? 0) - now;

    c.normalMass[p] = effectiveMass(imA, imB, rax, ray, raz, rbx, rby, rbz, nx, ny, nz);
    c.tangent1Mass[p] = effectiveMass(imA, imB, rax, ray, raz, rbx, rby, rbz, t1x, t1y, t1z);
    c.tangent2Mass[p] = effectiveMass(
      imA,
      imB,
      rax,
      ray,
      raz,
      rbx,
      rby,
      rbz,
      c.t2x[k] ?? 0,
      c.t2y[k] ?? 0,
      c.t2z[k] ?? 0,
    );

    relativeVelocity(bodies, a, b, rax, ray, raz, rbx, rby, rbz);
    c.approach[p] = REL[0] * nx + REL[1] * ny + REL[2] * nz;
    c.featureId[p] = m.featureIds[i] ?? 0;
    c.normalImpulse[p] = warmNormal ? (warmNormal[i] ?? 0) : 0;
    c.tangent1Impulse[p] = warmT1 ? (warmT1[i] ?? 0) : 0;
    c.tangent2Impulse[p] = warmT2 ? (warmT2[i] ?? 0) : 0;
  }
}

/** Apply the impulses carried over from the previous tick, before the first iteration. */
export function warmStart(
  bodies: BodySet,
  c: ContactConstraints,
  order: Int32Array,
  from: number,
  to: number,
): void {
  for (let oi = from; oi < to; oi++) {
    const k = order[oi] ?? 0;
    const a = c.bodyA[k] ?? 0;
    const b = c.bodyB[k] ?? 0;
    bodies.worldInverseInertia(a, invIA);
    bodies.worldInverseInertia(b, invIB);
    const start = c.pointStart[k] ?? 0;
    const end = start + (c.pointCount[k] ?? 0);
    for (let p = start; p < end; p++) {
      worldAnchors(bodies, a, b, c, p);
      const px =
        (c.nx[k] ?? 0) * (c.normalImpulse[p] ?? 0) +
        (c.t1x[k] ?? 0) * (c.tangent1Impulse[p] ?? 0) +
        (c.t2x[k] ?? 0) * (c.tangent2Impulse[p] ?? 0);
      const py =
        (c.ny[k] ?? 0) * (c.normalImpulse[p] ?? 0) +
        (c.t1y[k] ?? 0) * (c.tangent1Impulse[p] ?? 0) +
        (c.t2y[k] ?? 0) * (c.tangent2Impulse[p] ?? 0);
      const pz =
        (c.nz[k] ?? 0) * (c.normalImpulse[p] ?? 0) +
        (c.t1z[k] ?? 0) * (c.tangent1Impulse[p] ?? 0) +
        (c.t2z[k] ?? 0) * (c.tangent2Impulse[p] ?? 0);
      applyImpulse(bodies, a, b, ANCHOR, px, py, pz);
    }
  }
}

/**
 * One iteration over a range of constraints.
 *
 * `useBias` is false on the relax pass, which is what removes the energy the bias added and is why
 * a stack stops breathing.
 */
/**
 * How the two tangent rows are bounded against each other.
 *
 * **`box` is two independent clamps and is what this solver has always done.** Each axis is bounded
 * at `mu * N` on its own, so along the diagonal between them the pair reaches `sqrt(2) * mu * N` —
 * forty-one per cent more friction than the same surface offers along an axis. The tangent basis is
 * constructed from the contact normal, so *which* headings are cheap is an artefact of that
 * construction rather than a fact about the world, and a box measurably slides further in some
 * directions than others.
 *
 * **`elliptical` couples them and friction becomes isotropic**, which is what it physically is. It
 * is a correctness fix and it is **not the default**, because every stacking result moves under it:
 * `fingerprintBodies`, both baselines, and any golden fingerprint or stored replay a consumer has
 * kept. A production engine does not silently invalidate those. *What would reverse
 * that:* a major version, where the honest thing is to make the ellipse the default and say so in
 * the porting guide.
 *
 * **One coefficient, not two, and that is a decision rather than an omission.** Anisotropic
 * friction is the natural API for an ellipse — different `mu` along each tangent — and it needs a
 * tangent frame anchored to a *material*, which this solver does not have: `prepareContact` builds
 * the tangents from the normal, so they rotate arbitrarily as a contact moves and a per-axis
 * coefficient would mean something different from one tick to the next. That is a silent wrong
 * answer, so the ellipse here is a circle. *What would reverse it:* a tangent frame carried by the
 * body, which is a larger change than the cone; `vehicle.ts` already needs that and answers it its
 * own way, with a grip table rather than a coefficient.
 */
export type FrictionModel = 'box' | 'elliptical';

export function solveContacts(
  bodies: BodySet,
  c: ContactConstraints,
  order: Int32Array,
  from: number,
  to: number,
  h: number,
  useBias: boolean,
  hertz: number,
  damping: number,
  /* Defaulted so a consumer calling this directly — it is exported — keeps its old numbers. */
  friction: FrictionModel = 'box',
): void {
  // The soft-constraint triple, from a frequency rather than from a per-step fraction.
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * damping + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  const biasRate = omega / a1;
  const massScale = a2 * a3;
  const impulseScale = a3;
  const invH = h > 0 ? 1 / h : 0;

  for (let oi = from; oi < to; oi++) {
    const k = order[oi] ?? 0;
    const a = c.bodyA[k] ?? 0;
    const b = c.bodyB[k] ?? 0;
    bodies.worldInverseInertia(a, invIA);
    bodies.worldInverseInertia(b, invIB);
    const nx = c.nx[k] ?? 0;
    const ny = c.ny[k] ?? 0;
    const nz = c.nz[k] ?? 0;
    const mu = c.friction[k] ?? 0;
    const start = c.pointStart[k] ?? 0;
    const end = start + (c.pointCount[k] ?? 0);

    /*
     * Friction first, bounded by the normal impulse standing from the previous iteration. Solving
     * it after the normal costs the first iteration of every substep its friction entirely, because
     * there is no accumulated normal impulse to bound against yet.
     */
    for (let p = start; p < end; p++) {
      worldAnchors(bodies, a, b, c, p);
      relativeVelocity(
        bodies,
        a,
        b,
        ANCHOR[0],
        ANCHOR[1],
        ANCHOR[2],
        ANCHOR[3],
        ANCHOR[4],
        ANCHOR[5],
      );
      const maxF = mu * (c.normalImpulse[p] ?? 0);
      if (friction === 'elliptical') {
        solveFrictionCone(bodies, a, b, k, p, c, maxF);
      } else {
        solveTangent(
          bodies,
          a,
          b,
          p,
          c.t1x[k] ?? 0,
          c.t1y[k] ?? 0,
          c.t1z[k] ?? 0,
          c.tangent1Mass,
          c.tangent1Impulse,
          maxF,
        );
        relativeVelocity(
          bodies,
          a,
          b,
          ANCHOR[0],
          ANCHOR[1],
          ANCHOR[2],
          ANCHOR[3],
          ANCHOR[4],
          ANCHOR[5],
        );
        solveTangent(
          bodies,
          a,
          b,
          p,
          c.t2x[k] ?? 0,
          c.t2y[k] ?? 0,
          c.t2z[k] ?? 0,
          c.tangent2Mass,
          c.tangent2Impulse,
          maxF,
        );
      }
    }

    for (let p = start; p < end; p++) {
      worldAnchors(bodies, a, b, c, p);
      const s =
        (c.sBase[p] ?? 0) +
        ((bodies.posX[b] ?? 0) + ANCHOR[3] - (bodies.posX[a] ?? 0) - ANCHOR[0]) * nx +
        ((bodies.posY[b] ?? 0) + ANCHOR[4] - (bodies.posY[a] ?? 0) - ANCHOR[1]) * ny +
        ((bodies.posZ[b] ?? 0) + ANCHOR[5] - (bodies.posZ[a] ?? 0) - ANCHOR[2]) * nz;

      relativeVelocity(
        bodies,
        a,
        b,
        ANCHOR[0],
        ANCHOR[1],
        ANCHOR[2],
        ANCHOR[3],
        ANCHOR[4],
        ANCHOR[5],
      );
      const vn = REL[0] * nx + REL[1] * ny + REL[2] * nz;

      let bias = 0;
      let ms = 1;
      let is = 0;
      if (s > 0) {
        // Speculative: close exactly the gap this substep and no more.
        bias = s * invH;
      } else if (useBias) {
        const want = biasRate * (s + LINEAR_SLOP);
        bias = want < -MAX_BIAS_VELOCITY ? -MAX_BIAS_VELOCITY : want > 0 ? 0 : want;
        ms = massScale;
        is = impulseScale;
      }

      const old = c.normalImpulse[p] ?? 0;
      let impulse = -(c.normalMass[p] ?? 0) * ms * (vn + bias) - is * old;
      const next = old + impulse > 0 ? old + impulse : 0;
      impulse = next - old;
      c.normalImpulse[p] = next;
      applyImpulse(bodies, a, b, ANCHOR, nx * impulse, ny * impulse, nz * impulse);
    }
  }
}

/**
 * One pass after every substep, giving back the bounce the solve suppressed.
 *
 * Applied once against the approach speed captured at prepare, so a drop returns to the same height
 * whatever the substep count. A bounce driven from the *current* velocity instead compounds with
 * every substep and turns the coefficient into a function of the dial.
 */
export function applyRestitution(
  bodies: BodySet,
  c: ContactConstraints,
  order: Int32Array,
  from: number,
  to: number,
): void {
  for (let oi = from; oi < to; oi++) {
    const k = order[oi] ?? 0;
    const e = c.restitution[k] ?? 0;
    if (e === 0) continue;
    const a = c.bodyA[k] ?? 0;
    const b = c.bodyB[k] ?? 0;
    bodies.worldInverseInertia(a, invIA);
    bodies.worldInverseInertia(b, invIB);
    const nx = c.nx[k] ?? 0;
    const ny = c.ny[k] ?? 0;
    const nz = c.nz[k] ?? 0;
    const start = c.pointStart[k] ?? 0;
    const end = start + (c.pointCount[k] ?? 0);
    for (let p = start; p < end; p++) {
      const approach = c.approach[p] ?? 0;
      if (approach > -RESTITUTION_THRESHOLD || (c.normalImpulse[p] ?? 0) === 0) continue;
      worldAnchors(bodies, a, b, c, p);
      relativeVelocity(
        bodies,
        a,
        b,
        ANCHOR[0],
        ANCHOR[1],
        ANCHOR[2],
        ANCHOR[3],
        ANCHOR[4],
        ANCHOR[5],
      );
      const vn = REL[0] * nx + REL[1] * ny + REL[2] * nz;
      const old = c.normalImpulse[p] ?? 0;
      let impulse = -(c.normalMass[p] ?? 0) * (vn + e * approach);
      const next = old + impulse > 0 ? old + impulse : 0;
      impulse = next - old;
      c.normalImpulse[p] = next;
      applyImpulse(bodies, a, b, ANCHOR, nx * impulse, ny * impulse, nz * impulse);
    }
  }
}

/* ---------- shared scratch, so nothing allocates per contact ---------- */

const ANCHOR = new Float64Array(6);
const REL = new Float64Array(3);

/**
 * One friction axis, solved against the anchors and relative velocity already in scratch.
 *
 * **It takes no `ContactConstraints`, and it used to.** The parameter was dead: everything this
 * needs is either in the module-scope `REL` and `ANCHOR` that the caller filled, or in the two
 * arrays it is handed. A parameter nothing reads is a claim about what a function depends on, and
 * this one said it depended on the whole constraint block.
 *
 * Found by a consumer's typecheck rather than by this repository's: one of them runs
 * `noUnusedParameters` over engine source where the engine's own config does not, on the grounds
 * that the flag costs the engine nothing and catches a real class of mistake. This is it being
 * right, and it arrived as a red CI in a repository that had changed nothing.
 */
function solveTangent(
  bodies: BodySet,
  a: number,
  b: number,
  p: number,
  tx: number,
  ty: number,
  tz: number,
  massArray: Float32Array,
  impulseArray: Float32Array,
  maxF: number,
): void {
  const vt = REL[0] * tx + REL[1] * ty + REL[2] * tz;
  const old = impulseArray[p] ?? 0;
  let impulse = -(massArray[p] ?? 0) * vt;
  let next = old + impulse;
  if (next > maxF) next = maxF;
  else if (next < -maxF) next = -maxF;
  impulse = next - old;
  impulseArray[p] = next;
  applyImpulse(bodies, a, b, ANCHOR, tx * impulse, ty * impulse, tz * impulse);
}

/**
 * Both friction axes at once, with the pair projected onto a disc of radius `maxF`.
 *
 * **Two differences from the pair of `solveTangent` calls it replaces, and only one of them is the
 * clamp.** The clamp is the point: the accumulated `(P1, P2)` is scaled onto the circle rather than
 * each component being clipped to a square, so the total friction impulse is `mu * N` whatever the
 * heading. The other is that **both rows read one relative velocity** — the box path re-reads it
 * between the two axes, which makes the second row see the first row's push, and there is no
 * meaningful way to keep that while solving them jointly. That is why this is not a change a stored
 * replay survives, and why it is behind an option.
 *
 * The impulse is applied once, as the sum of the two deltas, rather than twice: two applications of
 * a jointly-solved pair would each disturb the other's velocity between them, which is the sequential
 * behaviour this exists to leave behind.
 */
function solveFrictionCone(
  bodies: BodySet,
  a: number,
  b: number,
  k: number,
  p: number,
  c: ContactConstraints,
  maxF: number,
): void {
  const t1x = c.t1x[k] ?? 0;
  const t1y = c.t1y[k] ?? 0;
  const t1z = c.t1z[k] ?? 0;
  const t2x = c.t2x[k] ?? 0;
  const t2y = c.t2y[k] ?? 0;
  const t2z = c.t2z[k] ?? 0;

  const vt1 = REL[0] * t1x + REL[1] * t1y + REL[2] * t1z;
  const vt2 = REL[0] * t2x + REL[1] * t2y + REL[2] * t2z;
  const old1 = c.tangent1Impulse[p] ?? 0;
  const old2 = c.tangent2Impulse[p] ?? 0;

  let next1 = old1 - (c.tangent1Mass[p] ?? 0) * vt1;
  let next2 = old2 - (c.tangent2Mass[p] ?? 0) * vt2;

  const length = Math.sqrt(next1 * next1 + next2 * next2);
  if (length > maxF) {
    /* `length > maxF` implies `length > 0` for a non-negative bound, so the divide is safe: a zero
       normal impulse gives `maxF = 0` and a zero length fails the compare. */
    const scale = maxF / length;
    next1 *= scale;
    next2 *= scale;
  }

  const delta1 = next1 - old1;
  const delta2 = next2 - old2;
  c.tangent1Impulse[p] = next1;
  c.tangent2Impulse[p] = next2;
  applyImpulse(
    bodies,
    a,
    b,
    ANCHOR,
    t1x * delta1 + t2x * delta2,
    t1y * delta1 + t2y * delta2,
    t1z * delta1 + t2z * delta2,
  );
}

/** `1 / (mA + mB + (rA×n)ᵀ IA (rA×n) + (rB×n)ᵀ IB (rB×n))`, or zero where nothing can move. */
function effectiveMass(
  imA: number,
  imB: number,
  rax: number,
  ray: number,
  raz: number,
  rbx: number,
  rby: number,
  rbz: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const ax = ray * nz - raz * ny;
  const ay = raz * nx - rax * nz;
  const az = rax * ny - ray * nx;
  const bx = rby * nz - rbz * ny;
  const by = rbz * nx - rbx * nz;
  const bz = rbx * ny - rby * nx;
  const k = imA + imB + quadratic(invIA, ax, ay, az) + quadratic(invIB, bx, by, bz);
  return k > 0 ? 1 / k : 0;
}

/** `vᵀ M v` for a symmetric M stored as six terms. */
function quadratic(m: Float32Array, x: number, y: number, z: number): number {
  return (
    (m[0] ?? 0) * x * x +
    (m[1] ?? 0) * y * y +
    (m[2] ?? 0) * z * z +
    2 * ((m[3] ?? 0) * x * y + (m[4] ?? 0) * x * z + (m[5] ?? 0) * y * z)
  );
}

/** Rotate the stored local anchors into world, into `ANCHOR[0..5]`. */
function worldAnchors(
  bodies: BodySet,
  a: number,
  b: number,
  c: ContactConstraints,
  p: number,
): void {
  if (c.curvedA[p]) {
    ANCHOR[0] = c.localA[p * 3] ?? 0;
    ANCHOR[1] = c.localA[p * 3 + 1] ?? 0;
    ANCHOR[2] = c.localA[p * 3 + 2] ?? 0;
  } else {
    rotate(
      bodies,
      a,
      c.localA[p * 3] ?? 0,
      c.localA[p * 3 + 1] ?? 0,
      c.localA[p * 3 + 2] ?? 0,
      ANCHOR,
      0,
    );
  }
  if (c.curvedB[p]) {
    ANCHOR[3] = c.localB[p * 3] ?? 0;
    ANCHOR[4] = c.localB[p * 3 + 1] ?? 0;
    ANCHOR[5] = c.localB[p * 3 + 2] ?? 0;
  } else {
    rotate(
      bodies,
      b,
      c.localB[p * 3] ?? 0,
      c.localB[p * 3 + 1] ?? 0,
      c.localB[p * 3 + 2] ?? 0,
      ANCHOR,
      3,
    );
  }
}

/** `(vB + wB × rB) − (vA + wA × rA)`, into `REL`. */
function relativeVelocity(
  bodies: BodySet,
  a: number,
  b: number,
  rax: number,
  ray: number,
  raz: number,
  rbx: number,
  rby: number,
  rbz: number,
): void {
  const wax = bodies.angX[a] ?? 0;
  const way = bodies.angY[a] ?? 0;
  const waz = bodies.angZ[a] ?? 0;
  const wbx = bodies.angX[b] ?? 0;
  const wby = bodies.angY[b] ?? 0;
  const wbz = bodies.angZ[b] ?? 0;
  REL[0] =
    (bodies.velX[b] ?? 0) +
    (wby * rbz - wbz * rby) -
    (bodies.velX[a] ?? 0) -
    (way * raz - waz * ray);
  REL[1] =
    (bodies.velY[b] ?? 0) +
    (wbz * rbx - wbx * rbz) -
    (bodies.velY[a] ?? 0) -
    (waz * rax - wax * raz);
  REL[2] =
    (bodies.velZ[b] ?? 0) +
    (wbx * rby - wby * rbx) -
    (bodies.velZ[a] ?? 0) -
    (wax * ray - way * rax);
}

/** Apply `+P` to B at `rB` and `−P` to A at `rA`. */
function applyImpulse(
  bodies: BodySet,
  a: number,
  b: number,
  anchors: Float64Array,
  px: number,
  py: number,
  pz: number,
): void {
  const imA = bodies.invMass[a] ?? 0;
  if (imA > 0) {
    bodies.velX[a] = (bodies.velX[a] ?? 0) - px * imA;
    bodies.velY[a] = (bodies.velY[a] ?? 0) - py * imA;
    bodies.velZ[a] = (bodies.velZ[a] ?? 0) - pz * imA;
    const tx = anchors[1] * pz - anchors[2] * py;
    const ty = anchors[2] * px - anchors[0] * pz;
    const tz = anchors[0] * py - anchors[1] * px;
    bodies.angX[a] = (bodies.angX[a] ?? 0) - multiply(invIA, tx, ty, tz, 0);
    bodies.angY[a] = (bodies.angY[a] ?? 0) - multiply(invIA, tx, ty, tz, 1);
    bodies.angZ[a] = (bodies.angZ[a] ?? 0) - multiply(invIA, tx, ty, tz, 2);
  }
  const imB = bodies.invMass[b] ?? 0;
  if (imB > 0) {
    bodies.velX[b] = (bodies.velX[b] ?? 0) + px * imB;
    bodies.velY[b] = (bodies.velY[b] ?? 0) + py * imB;
    bodies.velZ[b] = (bodies.velZ[b] ?? 0) + pz * imB;
    const tx = anchors[4] * pz - anchors[5] * py;
    const ty = anchors[5] * px - anchors[3] * pz;
    const tz = anchors[3] * py - anchors[4] * px;
    bodies.angX[b] = (bodies.angX[b] ?? 0) + multiply(invIB, tx, ty, tz, 0);
    bodies.angY[b] = (bodies.angY[b] ?? 0) + multiply(invIB, tx, ty, tz, 1);
    bodies.angZ[b] = (bodies.angZ[b] ?? 0) + multiply(invIB, tx, ty, tz, 2);
  }
}

/** Row `row` of `M v`, for a symmetric M stored as six terms. */
function multiply(m: Float32Array, x: number, y: number, z: number, row: number): number {
  if (row === 0) return (m[0] ?? 0) * x + (m[3] ?? 0) * y + (m[4] ?? 0) * z;
  if (row === 1) return (m[3] ?? 0) * x + (m[1] ?? 0) * y + (m[5] ?? 0) * z;
  return (m[4] ?? 0) * x + (m[5] ?? 0) * y + (m[2] ?? 0) * z;
}

function rotate(
  bodies: BodySet,
  i: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  at: number,
): void {
  const qx = bodies.rotX[i] ?? 0;
  const qy = bodies.rotY[i] ?? 0;
  const qz = bodies.rotZ[i] ?? 0;
  const qw = bodies.rotW[i] ?? 1;
  // v + 2w(q × v) + 2(q × (q × v)), the standard quaternion rotation without a matrix.
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[at] = x + qw * tx + (qy * tz - qz * ty);
  out[at + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[at + 2] = z + qw * tz + (qx * ty - qy * tx);
}

function unrotate(
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

/** Whether a body is one the solver may move. */
export function isDynamicBody(bodies: BodySet, i: number): boolean {
  return bodies.type[i] === BODY_DYNAMIC;
}
