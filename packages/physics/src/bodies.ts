import { combineMassProperties, createMassProperties, shapeMassProperties } from './mass.ts';
import type { ConvexShape } from './shape.ts';

/**
 * Rigid body state, structure-of-arrays, indexed by a dense body index.
 *
 * **`Float32Array` for state and doubles for every intermediate.** A store rounds through
 * `Math.fround`, which ECMAScript specifies exactly, while the arithmetic between stores stays in
 * doubles — so the solver computes at higher precision than it keeps and halves its memory
 * bandwidth. Both halves of that are deliberate, and JavaScript has no SIMD to spend the bandwidth
 * on instead.
 *
 * **Indices are dense and removal swaps the last body in**, so a caller holding an index must be
 * told when one moves. `remove` returns the index that moved, or −1, and every structure keyed by
 * body index has to act on it.
 */

export const BODY_STATIC = 0;
export const BODY_KINEMATIC = 1;
export const BODY_DYNAMIC = 2;
/** Static never moves, kinematic moves but is not pushed, dynamic is solved. */
export type BodyType = 0 | 1 | 2;

/** Set on a body whose island is asleep. Woken bodies clear it together. */
export const BODY_SLEEPING = 1;
/**
 * A sensor reports overlap and resolves none of it.
 *
 * Narrowphase still runs — an overlap that is never computed cannot be reported — and the solver is
 * what skips it. **What this costs** is a sensor being as dear as a solid body in the broadphase and
 * narrowphase, which is where most of the cost is anyway.
 */
export const BODY_SENSOR = 2;

export interface BodyDesc {
  readonly type: BodyType;
  /**
   * The body's shape, or absent where it is made of several. Exactly one of these two.
   *
   * A body carrying both is refused at `addBody`, because there is no sensible reading of it: the
   * narrow phase would have to decide which one it meant and either choice is a body that collides
   * as something the caller did not describe.
   */
  readonly shape?: ConvexShape;
  /**
   * Several shapes, as one rigid body. What `decomposeConvex` produces, and where it goes.
   *
   * **No offset and no rotation per part**, because a `ConvexShape` is already a point cloud in the
   * body's frame — see `vertices` above. A decomposition's parts are where they belong the moment
   * they exist, and a field that would always be zero is a field somebody eventually sets wrong. The
   * kinematic `Body.parts` carries offsets because it wraps shapes built at the origin and placed
   * afterwards; nothing here does that.
   *
   * Mass is `combineMassProperties`: volumes added, the centre weighted, each tensor moved to the
   * body's centre by the parallel axis theorem. Contacts are one manifold per touching part, with
   * the part pair folded into every feature id so warm starting cannot confuse two of them.
   *
   * Refused above `MAX_BODY_PARTS`, at the call rather than in the tick.
   */
  readonly shapes?: readonly ConvexShape[];
  readonly density?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  /** Unit quaternion. Defaults to identity. */
  readonly qx?: number;
  readonly qy?: number;
  readonly qz?: number;
  readonly qw?: number;
  readonly friction?: number;
  readonly restitution?: number;
  /** Which layers this body is on, and which it layersInteract with. 32 bits each. */
  readonly layer?: number;
  readonly mask?: number;
  /** A sensor reports overlap and is never pushed out of it. */
  readonly sensor?: boolean;
}

const SCRATCH_MASS = createMassProperties();

export class BodySet {
  count = 0;

  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  rotX: Float32Array;
  rotY: Float32Array;
  rotZ: Float32Array;
  rotW: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
  angX: Float32Array;
  angY: Float32Array;
  angZ: Float32Array;
  invMass: Float32Array;
  /** Body-frame inverse inertia, six symmetric terms per body: xx, yy, zz, xy, xz, yz. */
  invInertia: Float32Array;
  /** Centre of mass in body frame, which a shape built off-centre has. */
  comX: Float32Array;
  comY: Float32Array;
  comZ: Float32Array;
  friction: Float32Array;
  restitution: Float32Array;
  type: Uint8Array;
  flags: Uint8Array;
  sleepTicks: Uint16Array;
  layer: Uint32Array;
  mask: Uint32Array;
  shape: (ConvexShape | undefined)[] = [];
  /** The parts of a compound body, or undefined where it has a single `shape`. */
  shapes: (readonly ConvexShape[] | undefined)[] = [];

  private capacity: number;

  constructor(capacity = 64) {
    this.capacity = Math.max(1, capacity | 0);
    const f = (n = 1) => new Float32Array(this.capacity * n);
    this.posX = f();
    this.posY = f();
    this.posZ = f();
    this.rotX = f();
    this.rotY = f();
    this.rotZ = f();
    this.rotW = f();
    this.velX = f();
    this.velY = f();
    this.velZ = f();
    this.angX = f();
    this.angY = f();
    this.angZ = f();
    this.invMass = f();
    this.invInertia = f(6);
    this.comX = f();
    this.comY = f();
    this.comZ = f();
    this.friction = f();
    this.restitution = f();
    this.type = new Uint8Array(this.capacity);
    this.flags = new Uint8Array(this.capacity);
    this.sleepTicks = new Uint16Array(this.capacity);
    this.layer = new Uint32Array(this.capacity);
    this.mask = new Uint32Array(this.capacity);
  }

  add(desc: BodyDesc): number {
    if (this.count === this.capacity) this.grow();
    const i = this.count++;
    this.posX[i] = desc.x ?? 0;
    this.posY[i] = desc.y ?? 0;
    this.posZ[i] = desc.z ?? 0;
    this.rotX[i] = desc.qx ?? 0;
    this.rotY[i] = desc.qy ?? 0;
    this.rotZ[i] = desc.qz ?? 0;
    this.rotW[i] = desc.qw ?? 1;
    this.velX[i] = 0;
    this.velY[i] = 0;
    this.velZ[i] = 0;
    this.angX[i] = 0;
    this.angY[i] = 0;
    this.angZ[i] = 0;
    this.type[i] = desc.type;
    this.flags[i] = desc.sensor ? BODY_SENSOR : 0;
    this.sleepTicks[i] = 0;
    this.friction[i] = desc.friction ?? 0.5;
    this.restitution[i] = desc.restitution ?? 0;
    this.layer[i] = desc.layer ?? 1;
    this.mask[i] = desc.mask ?? 0xffffffff;
    this.shape[i] = desc.shape;
    this.shapes[i] = desc.shapes;

    /*
     * A static or kinematic body has zero inverse mass and zero inverse inertia, which is what
     * makes it immovable *arithmetically* rather than by a branch in the solver. Every constraint
     * then treats it uniformly and the hot loop has one fewer test in it.
     */
    if (desc.type === BODY_DYNAMIC) {
      const density = desc.density ?? 1000;
      const m = desc.shapes
        ? combineMassProperties(desc.shapes, density, SCRATCH_MASS)
        : shapeMassProperties(desc.shape as ConvexShape, density, SCRATCH_MASS);
      const mass = m.volume * density;
      this.invMass[i] = mass > 0 ? 1 / mass : 0;
      this.comX[i] = m.comX;
      this.comY[i] = m.comY;
      this.comZ[i] = m.comZ;
      invertSymmetric(m.ixx, m.iyy, m.izz, m.ixy, m.ixz, m.iyz, this.invInertia, i * 6);
    } else {
      this.invMass[i] = 0;
      this.comX[i] = 0;
      this.comY[i] = 0;
      this.comZ[i] = 0;
      for (let k = 0; k < 6; k++) this.invInertia[i * 6 + k] = 0;
    }
    return i;
  }

  /** Swap-remove. Returns the index that moved into `index`, or −1 if it was the last. */
  remove(index: number): number {
    const last = --this.count;
    if (index === last) {
      this.shape[index] = undefined;
      this.shapes[index] = undefined;
      return -1;
    }
    const copy = (a: Float32Array | Uint8Array | Uint16Array | Uint32Array, stride = 1) => {
      for (let k = 0; k < stride; k++) a[index * stride + k] = a[last * stride + k] ?? 0;
    };
    for (const a of [
      this.posX,
      this.posY,
      this.posZ,
      this.rotX,
      this.rotY,
      this.rotZ,
      this.rotW,
      this.velX,
      this.velY,
      this.velZ,
      this.angX,
      this.angY,
      this.angZ,
      this.invMass,
      this.comX,
      this.comY,
      this.comZ,
      this.friction,
      this.restitution,
    ])
      copy(a);
    copy(this.invInertia, 6);
    copy(this.type);
    copy(this.flags);
    copy(this.sleepTicks);
    copy(this.layer);
    copy(this.mask);
    this.shape[index] = this.shape[last];
    this.shape[last] = undefined;
    this.shapes[index] = this.shapes[last];
    this.shapes[last] = undefined;
    return last;
  }

  /**
   * Fill `out` with the world-frame inverse inertia, six symmetric terms.
   *
   * `R · I⁻¹ · Rᵀ`, a congruence, rather than a diagonalisation. Storing three principal moments
   * would need an eigen decomposition, and Jacobi is iterative — a fixed sweep count would be
   * deterministic but is one more thing to get exactly right for no gain. **What this gives up** is
   * six floats per body instead of three and a congruence per substep. **What would make it wrong**
   * is a measurement showing that congruence dominates the tick.
   */
  worldInverseInertia(index: number, out: Float32Array, at = 0): void {
    const x = this.rotX[index] ?? 0;
    const y = this.rotY[index] ?? 0;
    const z = this.rotZ[index] ?? 0;
    const w = this.rotW[index] ?? 1;
    // Rotation matrix, row-major.
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - z * w);
    const r02 = 2 * (x * z + y * w);
    const r10 = 2 * (x * y + z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - x * w);
    const r20 = 2 * (x * z - y * w);
    const r21 = 2 * (y * z + x * w);
    const r22 = 1 - 2 * (x * x + y * y);

    const b = index * 6;
    const mxx = this.invInertia[b] ?? 0;
    const myy = this.invInertia[b + 1] ?? 0;
    const mzz = this.invInertia[b + 2] ?? 0;
    const mxy = this.invInertia[b + 3] ?? 0;
    const mxz = this.invInertia[b + 4] ?? 0;
    const myz = this.invInertia[b + 5] ?? 0;

    // T = R · M, then out = T · Rᵀ, keeping only the six symmetric terms.
    const t00 = r00 * mxx + r01 * mxy + r02 * mxz;
    const t01 = r00 * mxy + r01 * myy + r02 * myz;
    const t02 = r00 * mxz + r01 * myz + r02 * mzz;
    const t10 = r10 * mxx + r11 * mxy + r12 * mxz;
    const t11 = r10 * mxy + r11 * myy + r12 * myz;
    const t12 = r10 * mxz + r11 * myz + r12 * mzz;
    const t20 = r20 * mxx + r21 * mxy + r22 * mxz;
    const t21 = r20 * mxy + r21 * myy + r22 * myz;
    const t22 = r20 * mxz + r21 * myz + r22 * mzz;

    out[at] = t00 * r00 + t01 * r01 + t02 * r02;
    out[at + 1] = t10 * r10 + t11 * r11 + t12 * r12;
    out[at + 2] = t20 * r20 + t21 * r21 + t22 * r22;
    out[at + 3] = t00 * r10 + t01 * r11 + t02 * r12;
    out[at + 4] = t00 * r20 + t01 * r21 + t02 * r22;
    out[at + 5] = t10 * r20 + t11 * r21 + t12 * r22;
  }

  private grow(): void {
    const next = this.capacity * 2;
    const wider = <T extends Float32Array | Uint8Array | Uint16Array | Uint32Array>(
      a: T,
      stride = 1,
    ): T => {
      const out = new (a.constructor as new (n: number) => T)(next * stride);
      out.set(a);
      return out;
    };
    this.posX = wider(this.posX);
    this.posY = wider(this.posY);
    this.posZ = wider(this.posZ);
    this.rotX = wider(this.rotX);
    this.rotY = wider(this.rotY);
    this.rotZ = wider(this.rotZ);
    this.rotW = wider(this.rotW);
    this.velX = wider(this.velX);
    this.velY = wider(this.velY);
    this.velZ = wider(this.velZ);
    this.angX = wider(this.angX);
    this.angY = wider(this.angY);
    this.angZ = wider(this.angZ);
    this.invMass = wider(this.invMass);
    this.invInertia = wider(this.invInertia, 6);
    this.comX = wider(this.comX);
    this.comY = wider(this.comY);
    this.comZ = wider(this.comZ);
    this.friction = wider(this.friction);
    this.restitution = wider(this.restitution);
    this.type = wider(this.type);
    this.flags = wider(this.flags);
    this.sleepTicks = wider(this.sleepTicks);
    this.layer = wider(this.layer);
    this.mask = wider(this.mask);
    this.capacity = next;
  }
}

/**
 * Invert a symmetric 3×3 in closed form, writing six terms.
 *
 * A singular tensor — a shape with no volume — inverts to zero rather than to infinity, which makes
 * it behave as a point mass instead of producing NaN in every constraint that touches it. An
 * unwritten uniform is zero and zero is a real value, which is the failure this engine has recorded
 * twice; here zero is the *correct* value and the comment is what says so.
 */
function invertSymmetric(
  xx: number,
  yy: number,
  zz: number,
  xy: number,
  xz: number,
  yz: number,
  out: Float32Array,
  at: number,
): void {
  const c00 = yy * zz - yz * yz;
  const c01 = xz * yz - xy * zz;
  const c02 = xy * yz - xz * yy;
  const det = xx * c00 + xy * c01 + xz * c02;
  if (det === 0) {
    for (let k = 0; k < 6; k++) out[at + k] = 0;
    return;
  }
  const inv = 1 / det;
  out[at] = c00 * inv;
  out[at + 1] = (xx * zz - xz * xz) * inv;
  out[at + 2] = (xx * yy - xy * xy) * inv;
  out[at + 3] = c01 * inv;
  out[at + 4] = c02 * inv;
  out[at + 5] = (xy * xz - xx * yz) * inv;
}
