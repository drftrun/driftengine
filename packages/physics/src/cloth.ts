import { BODY_STATIC } from './bodies.ts';
import { LOCAL_POSE, closestOnCylinder, isCylinder, readCylinder } from './cylinder.ts';
import { faceCount } from './faces.ts';
import type { ShapePose } from './manifold.ts';
import type { ConvexShape } from './shape.ts';
import type { PhysicsWorld } from './world.ts';

/**
 * Cloth, as position-based dynamics with compliance.
 *
 * **A separate solver from the rigid bodies, deliberately, and it is §5's decision in a different
 * place.** Thousands of rotationless particles are the wrong data layout for a rigid constraint
 * graph: every particle would carry an orientation it never uses and an inertia tensor that is
 * always zero. Two solvers with two jobs, not two implementations of one decision.
 *
 * **Compliance rather than a stiffness constant**, for the same reason §7 states contact stiffness
 * as a frequency: `α = compliance / h²` makes a constraint's stiffness independent of the step
 * length, so the iteration count is a quality dial rather than a behaviour change. A raw
 * position-based solver's stiffness is a function of how many times you iterated, which means
 * tuning it is tuning the solver rather than the cloth.
 *
 * **Two-way coupled since 2026-08-27, by an impulse exchange rather than by a merged island.** The
 * refusal this replaces was right about the price and wrong about the only way to pay it. Putting
 * particles into the rigid solver's constraint graph *would* merge islands — a character in a cloak
 * becomes one island with everything the cloak brushes, and merged islands are what §8a's
 * parallelism is made of. So that is still refused. What ships instead is the exchange the two
 * solvers can make **without either learning about the other's structure**: the collision pass
 * already moves a particle out of a body, and a particle moved by `d` in a tick of `h` has had its
 * momentum changed by `m·d/h`; the body receives the opposite of that at the contact point, through
 * the same `applyImpulse` any consumer would call.
 *
 * **What that costs, said plainly.** The exchange is *explicit* — the body responds on the next
 * tick rather than in the same solve — so it is a spring with a one-tick delay in it, and a very
 * heavy sheet landing on a very light body can oscillate. `coupling` is a scale from 0 to 1 and
 * **0 is the default**, so no existing consumer's world moves by a millimetre until it asks. *What
 * would reverse the remaining refusal:* a consumer who needs the sheet and the body to converge
 * together in one solve, at which point the price is the island structure and it is a track rather
 * than a field.
 */

export interface ClothOptions {
  /** Metres of stretch per newton. Zero is inextensible; larger is stretchier. */
  stretchCompliance?: number;
  /** The same, for the constraints that resist folding. */
  bendCompliance?: number;
  /** Solver passes per tick. A quality dial: compliance keeps stiffness meaningful across it. */
  iterations?: number;
  /**
   * How close two unconnected particles may come before they push each other apart, in metres.
   *
   * **0 is off and is the default**, because self-collision is the half of cloth whose *tuning*
   * decides whether it ships: a sheet that resists itself at a distance larger than its own
   * spacing cannot lie flat, and one that resists at a distance far smaller than a fold's
   * thickness passes through itself anyway. A consumer sets this from the sheet they built, and
   * the honest starting point is **a little under the grid spacing** — `makeClothGrid` at 5 cm
   * wants about 3 to 4 cm.
   *
   * **Particles joined by a constraint are exempt**, and that is not an optimisation. A stretch
   * link's rest length is the spacing, so a self-collision distance anywhere near it would have
   * every neighbour pair fighting its own link at every step — the sheet would inflate rather than
   * drape, which is the failure that reads as a solver bug. `ClothBody` builds the adjacency once
   * at construction for exactly this.
   */
  selfDistance?: number;
  /** Per-second velocity retained, as a fraction. */
  damping?: number;
  /** How far a particle is held off a surface it meets. */
  thickness?: number;
  /**
   * How much of the momentum a pushed particle gave up is handed back to the body, 0 to 1.
   *
   * **0 by default, which is one-way coupling and is what every consumer had before this existed.**
   * 1 is the whole exchange; anything between is a sheet that pushes less than its mass says it
   * should, which is the dial a consumer reaches for when the delay in the exchange makes a light
   * body jitter.
   */
  coupling?: number;
  /**
   * What one particle weighs, in kilograms. Only the coupling reads it.
   *
   * **Separate from `invMass`, and the separation is deliberate.** That array is a *relative
   * weight* in the position solve — every free particle is 1 and a pinned one is 0 — and the
   * compliance is tuned against it, so redefining it as an inverse mass in kilograms would move
   * every sheet any consumer has ever tuned. The coupling needs kilograms and nothing else does,
   * so it takes them here.
   *
   * The default is fifty grams: a square metre of ordinary cloth is two to three hundred grams,
   * and `makeClothGrid` at a five-centimetre spacing puts four hundred particles in that square
   * metre. A consumer building a tarpaulin or a chainmail cape sets it.
   */
  particleMass?: number;
  gravityX?: number;
  gravityY?: number;
  gravityZ?: number;
}

export class ClothBody {
  /** xyz-packed particle positions. */
  readonly position: Float32Array;
  /** xyz-packed velocities. */
  readonly velocity: Float32Array;
  /** Inverse mass per particle. Zero pins it. */
  readonly invMass: Float32Array;
  readonly count: number;

  /** Two particle indices per constraint. */
  private readonly link: Int32Array;
  private readonly rest: Float32Array;
  /** Compliance per constraint, so stretch and bend can differ. */
  private readonly compliance: Float32Array;
  private readonly previous: Float32Array;
  private readonly lambda: Float32Array;
  private readonly linkCount: number;

  readonly iterations: number;
  readonly damping: number;
  readonly thickness: number;
  /** See `ClothOptions.coupling`. 0 is one-way, which is the default. */
  readonly coupling: number;
  /** See `ClothOptions.particleMass`. Kilograms, read only by the coupling. */
  readonly particleMass: number;
  /** See `ClothOptions.selfDistance`. 0 is off, which is the default. */
  readonly selfDistance: number;

  /**
   * Who is linked to whom, as CSR: `neighbourStart[i]` to `neighbourStart[i + 1]` indexes
   * `neighbour`.
   *
   * **Built once, because the link set never changes** and the self-collision pass asks "are these
   * two linked" once per candidate pair per tick. A `Set` of packed pairs would answer the same
   * question with a hash probe and an allocation at construction the size of the link list; a
   * sorted adjacency answers it with a scan over the eight or so neighbours a grid particle has,
   * which is shorter than the probe.
   *
   * Empty when `selfDistance` is 0, so a sheet that does not collide with itself pays neither the
   * memory nor the build.
   */
  private readonly neighbourStart: Int32Array;
  private readonly neighbour: Int32Array;

  /**
   * The spatial hash the self-collision pass rebuilds each tick: a cell list over the particles.
   *
   * **A hash rather than a grid, because a sheet has no bounds worth allocating for.** A curtain
   * hanging in a room occupies a sliver of it, and a dense grid over the room's extent would be
   * mostly empty cells rebuilt every tick. The table is sized once from the particle count and
   * reused; `cellHead` and `cellNext` are the standard two arrays, so a rebuild is one pass that
   * writes and allocates nothing.
   */
  private readonly cellHead: Int32Array;
  private readonly cellNext: Int32Array;
  gravityX: number;
  gravityY: number;
  gravityZ: number;

  constructor(
    positions: Float32Array,
    links: Int32Array,
    bendLinks: Int32Array,
    options: ClothOptions = {},
  ) {
    this.count = positions.length / 3;
    this.position = new Float32Array(positions);
    this.velocity = new Float32Array(positions.length);
    this.invMass = new Float32Array(this.count).fill(1);
    this.previous = new Float32Array(positions.length);
    this.iterations = Math.max(1, options.iterations ?? 8);
    this.damping = options.damping ?? 0.02;
    this.thickness = options.thickness ?? 0.02;
    this.coupling = Math.min(1, Math.max(0, options.coupling ?? 0));
    this.particleMass = Math.max(0, options.particleMass ?? 0.05);
    this.selfDistance = Math.max(0, options.selfDistance ?? 0);
    this.gravityX = options.gravityX ?? 0;
    this.gravityY = options.gravityY ?? -9.81;
    this.gravityZ = options.gravityZ ?? 0;

    const stretch = options.stretchCompliance ?? 0;
    const bend = options.bendCompliance ?? 1e-4;
    const total = links.length / 2 + bendLinks.length / 2;
    this.linkCount = total;
    this.link = new Int32Array(total * 2);
    this.rest = new Float32Array(total);
    this.compliance = new Float32Array(total);
    this.lambda = new Float32Array(total);
    let at = 0;
    for (const [set, value] of [
      [links, stretch],
      [bendLinks, bend],
    ] as const) {
      for (let i = 0; i + 1 < set.length; i += 2) {
        const a = set[i] ?? 0;
        const b = set[i + 1] ?? 0;
        this.link[at * 2] = a;
        this.link[at * 2 + 1] = b;
        this.rest[at] = distance(this.position, a, b);
        this.compliance[at] = value;
        at++;
      }
    }

    /*
     * The adjacency and the hash, built only where self-collision is on.
     *
     * Two counting passes rather than an array of arrays: the first counts each particle's links
     * and the second fills them, which is the standard CSR build and allocates two typed arrays
     * instead of one per particle.
     *
     * The table has one bucket a particle. A hash with as many buckets as things in it averages
     * one occupant a bucket, and the cost of a collision is a longer scan rather than a wrong
     * answer — the cell key is part of the comparison below, so two particles that hash together
     * from different cells are separated by the distance test they were going to take anyway.
     */
    if (this.selfDistance > 0) {
      this.neighbourStart = new Int32Array(this.count + 1);
      for (let k = 0; k < total; k++) {
        this.neighbourStart[(this.link[k * 2] ?? 0) + 1]++;
        this.neighbourStart[(this.link[k * 2 + 1] ?? 0) + 1]++;
      }
      for (let i = 0; i < this.count; i++) {
        this.neighbourStart[i + 1] =
          (this.neighbourStart[i + 1] ?? 0) + (this.neighbourStart[i] ?? 0);
      }
      this.neighbour = new Int32Array(total * 2);
      const cursor = new Int32Array(this.neighbourStart.subarray(0, this.count));
      for (let k = 0; k < total; k++) {
        const a = this.link[k * 2] ?? 0;
        const b = this.link[k * 2 + 1] ?? 0;
        this.neighbour[cursor[a]++] = b;
        this.neighbour[cursor[b]++] = a;
      }
      this.cellHead = new Int32Array(Math.max(1, this.count)).fill(-1);
      this.cellNext = new Int32Array(this.count);
    } else {
      this.neighbourStart = EMPTY_INDEX;
      this.neighbour = EMPTY_INDEX;
      this.cellHead = EMPTY_INDEX;
      this.cellNext = EMPTY_INDEX;
    }
  }

  /** Pin a particle where it is, or release it. */
  pin(index: number, pinned = true): void {
    this.invMass[index] = pinned ? 0 : 1;
  }

  /**
   * Advance one fixed tick.
   *
   * Integrate, project every constraint `iterations` times, then derive velocity from how far each
   * particle actually moved — which is what makes it position-based: a constraint that moves a
   * particle also, by construction, changes its velocity, so nothing has to reconcile the two.
   */
  step(world: PhysicsWorld | null, dt: number): void {
    const n = this.count;
    const retain = 1 / (1 + this.damping * dt);
    for (let i = 0; i < n; i++) {
      const im = this.invMass[i] ?? 0;
      this.previous[i * 3] = this.position[i * 3] ?? 0;
      this.previous[i * 3 + 1] = this.position[i * 3 + 1] ?? 0;
      this.previous[i * 3 + 2] = this.position[i * 3 + 2] ?? 0;
      if (im === 0) continue;
      const vx = ((this.velocity[i * 3] ?? 0) + this.gravityX * dt) * retain;
      const vy = ((this.velocity[i * 3 + 1] ?? 0) + this.gravityY * dt) * retain;
      const vz = ((this.velocity[i * 3 + 2] ?? 0) + this.gravityZ * dt) * retain;
      this.position[i * 3] = (this.position[i * 3] ?? 0) + vx * dt;
      this.position[i * 3 + 1] = (this.position[i * 3 + 1] ?? 0) + vy * dt;
      this.position[i * 3 + 2] = (this.position[i * 3 + 2] ?? 0) + vz * dt;
    }

    this.lambda.fill(0);
    const invH2 = 1 / (dt * dt);
    for (let pass = 0; pass < this.iterations; pass++) {
      for (let k = 0; k < this.linkCount; k++) this.project(k, invH2);
    }
    /*
     * Self-collision after the constraints and before the bodies, which is the order that makes
     * both of them mean what they say. A sheet resolved against itself *first* would then be
     * stretched back into its own fold by the distance constraints; one resolved against the world
     * first would be pushed back into a body by its own self-collision. The world is what the
     * sheet may not enter under any circumstances, so it goes last.
     */
    if (this.selfDistance > 0) this.collideSelf();
    if (world) this.collideParticles(world, dt);

    const invDt = 1 / dt;
    for (let i = 0; i < n; i++) {
      if ((this.invMass[i] ?? 0) === 0) {
        this.velocity[i * 3] = 0;
        this.velocity[i * 3 + 1] = 0;
        this.velocity[i * 3 + 2] = 0;
        continue;
      }
      this.velocity[i * 3] = ((this.position[i * 3] ?? 0) - (this.previous[i * 3] ?? 0)) * invDt;
      this.velocity[i * 3 + 1] =
        ((this.position[i * 3 + 1] ?? 0) - (this.previous[i * 3 + 1] ?? 0)) * invDt;
      this.velocity[i * 3 + 2] =
        ((this.position[i * 3 + 2] ?? 0) - (this.previous[i * 3 + 2] ?? 0)) * invDt;
    }
  }

  /**
   * One distance constraint, with its compliance.
   *
   * `α = compliance / h²` is what makes the stiffness independent of the step and of the iteration
   * count. At zero compliance this reduces exactly to an ordinary position-based projection, which
   * is why an inextensible sheet costs nothing extra.
   */
  private project(k: number, invH2: number): void {
    const a = this.link[k * 2] ?? 0;
    const b = this.link[k * 2 + 1] ?? 0;
    const wa = this.invMass[a] ?? 0;
    const wb = this.invMass[b] ?? 0;
    const w = wa + wb;
    if (w === 0) return;
    const dx = (this.position[b * 3] ?? 0) - (this.position[a * 3] ?? 0);
    const dy = (this.position[b * 3 + 1] ?? 0) - (this.position[a * 3 + 1] ?? 0);
    const dz = (this.position[b * 3 + 2] ?? 0) - (this.position[a * 3 + 2] ?? 0);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-9) return;
    const c = length - (this.rest[k] ?? 0);
    const alpha = (this.compliance[k] ?? 0) * invH2;
    const old = this.lambda[k] ?? 0;
    const delta = (-c - alpha * old) / (w + alpha);
    this.lambda[k] = old + delta;
    const nx = (dx / length) * delta;
    const ny = (dy / length) * delta;
    const nz = (dz / length) * delta;
    this.position[a * 3] = (this.position[a * 3] ?? 0) - nx * wa;
    this.position[a * 3 + 1] = (this.position[a * 3 + 1] ?? 0) - ny * wa;
    this.position[a * 3 + 2] = (this.position[a * 3 + 2] ?? 0) - nz * wa;
    this.position[b * 3] = (this.position[b * 3] ?? 0) + nx * wb;
    this.position[b * 3 + 1] = (this.position[b * 3 + 1] ?? 0) + ny * wb;
    this.position[b * 3 + 2] = (this.position[b * 3 + 2] ?? 0) + nz * wb;
  }

  /**
   * Keep the sheet out of itself: a spatial hash over the particles, and a symmetric push apart.
   *
   * **The hash is rebuilt every tick and that is the cheap half.** One pass over the particles
   * writing two integers each, against a structure that tried to be incremental and would have to
   * know which particles moved — which in a cloth solver is all of them.
   *
   * The cell size is the self-collision distance, so a particle's neighbours are in its own cell
   * and the twenty-six around it. **The 3x3x3 scan is what makes the answer complete**: a pair at
   * the distance exactly cannot be in cells more than one apart, and a scan of the own cell alone
   * would miss every pair straddling a boundary — which is most of them, since a folded sheet lies
   * along one.
   *
   * **Each pair is resolved once, by index order.** Visiting both halves would apply the
   * correction twice and turn a resting fold into a buzzing one; the `other > i` test is what
   * makes the pass a sweep over pairs rather than over particles.
   *
   * A projection rather than a constraint with compliance, unlike the distance links: a contact is
   * an inequality — it does nothing until it is violated — and XPBD's accumulated multiplier is
   * for a constraint that holds all tick. *What that gives up* is that the stiffness of a fold is
   * the iteration count's again, for this one term. *What would make it wrong* is a consumer
   * wanting a fold to have a measurable resistance, at which point it needs its own multiplier
   * array and a sign clamp on it.
   */
  private collideSelf(): void {
    const n = this.count;
    const radius = this.selfDistance;
    const inverseCell = 1 / radius;
    this.cellHead.fill(-1);
    const buckets = this.cellHead.length;
    for (let i = 0; i < n; i++) {
      const key = cellKey(
        Math.floor((this.position[i * 3] ?? 0) * inverseCell),
        Math.floor((this.position[i * 3 + 1] ?? 0) * inverseCell),
        Math.floor((this.position[i * 3 + 2] ?? 0) * inverseCell),
        buckets,
      );
      this.cellNext[i] = this.cellHead[key] ?? -1;
      this.cellHead[key] = i;
    }

    for (let i = 0; i < n; i++) {
      const wi = this.invMass[i] ?? 0;
      const px = this.position[i * 3] ?? 0;
      const py = this.position[i * 3 + 1] ?? 0;
      const pz = this.position[i * 3 + 2] ?? 0;
      const cx = Math.floor(px * inverseCell);
      const cy = Math.floor(py * inverseCell);
      const cz = Math.floor(pz * inverseCell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            let other = this.cellHead[cellKey(cx + dx, cy + dy, cz + dz, buckets)] ?? -1;
            while (other >= 0) {
              /* Index order, so a pair is met once however many cells they share a bucket with. */
              if (other > i && !this.linked(i, other)) {
                this.separate(i, other, wi, px, py, pz, radius);
              }
              other = this.cellNext[other] ?? -1;
            }
          }
        }
      }
    }
  }

  /** Whether a link joins these two. A scan over the eight or so a grid particle has. */
  private linked(a: number, b: number): boolean {
    const from = this.neighbourStart[a] ?? 0;
    const to = this.neighbourStart[a + 1] ?? from;
    for (let at = from; at < to; at++) {
      if (this.neighbour[at] === b) return true;
    }
    return false;
  }

  /** Push two particles apart to exactly `radius`, split by their inverse masses. */
  private separate(
    a: number,
    b: number,
    wa: number,
    ax: number,
    ay: number,
    az: number,
    radius: number,
  ): void {
    const wb = this.invMass[b] ?? 0;
    const w = wa + wb;
    if (w === 0) return;
    const dx = (this.position[b * 3] ?? 0) - ax;
    const dy = (this.position[b * 3 + 1] ?? 0) - ay;
    const dz = (this.position[b * 3 + 2] ?? 0) - az;
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared >= radius * radius) return;
    const length = Math.sqrt(squared);
    /*
     * Two particles at exactly the same point have no direction to separate along, and picking one
     * arbitrarily would pick the same one for every such pair — so a whole collapsed fold would
     * open along one axis. Left alone instead: the next tick's integration moves them apart, and a
     * pair genuinely coincident is a sheet that has already failed.
     */
    if (length < 1e-9) return;
    const push = (radius - length) / length / w;
    const mx = dx * push;
    const my = dy * push;
    const mz = dz * push;
    this.position[a * 3] = ax - mx * wa;
    this.position[a * 3 + 1] = ay - my * wa;
    this.position[a * 3 + 2] = az - mz * wa;
    this.position[b * 3] = (this.position[b * 3] ?? 0) + mx * wb;
    this.position[b * 3 + 1] = (this.position[b * 3 + 1] ?? 0) + my * wb;
    this.position[b * 3 + 2] = (this.position[b * 3 + 2] ?? 0) + mz * wb;
  }

  /**
   * Push every particle out of anything it has entered, and hand the body back what it took.
   *
   * **The impulse is derived from the correction rather than measured**, which is what makes the
   * exchange cost one multiply: the constraint solve has already decided where the particle would
   * be, the push says where it must be instead, and the difference over the tick is the velocity
   * the collision removed from it. `m·Δ/h` is that momentum, and the body gets its negative at the
   * point of contact — a push straight down on a plank's end tips the plank, because
   * `applyImpulse` takes the point.
   *
   * A static body is skipped for the impulse rather than for the push: scenery does not move, and
   * `applyImpulse` would return without doing anything anyway.
   */
  private collideParticles(world: PhysicsWorld, dt: number): void {
    const bodies = world.bodies;
    const exchange = this.coupling > 0 ? (this.particleMass * this.coupling) / dt : 0;
    for (let i = 0; i < this.count; i++) {
      if ((this.invMass[i] ?? 0) === 0) continue;
      const px = this.position[i * 3] ?? 0;
      const py = this.position[i * 3 + 1] ?? 0;
      const pz = this.position[i * 3 + 2] ?? 0;
      for (let b = 0; b < bodies.count; b++) {
        const shape = bodies.shape[b];
        if (!shape) continue;
        // A cheap reject before anything expensive: the shape's own bounding sphere.
        const bx = bodies.posX[b] ?? 0;
        const by = bodies.posY[b] ?? 0;
        const bz = bodies.posZ[b] ?? 0;
        const dx = px - bx;
        const dy = py - by;
        const dz = pz - bz;
        const reach = shape.boundRadius + this.thickness;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;

        POSE.x = bx;
        POSE.y = by;
        POSE.z = bz;
        POSE.qx = bodies.rotX[b] ?? 0;
        POSE.qy = bodies.rotY[b] ?? 0;
        POSE.qz = bodies.rotZ[b] ?? 0;
        POSE.qw = bodies.rotW[b] ?? 1;
        if (!pushOut(shape, POSE, px, py, pz, this.thickness, OUT)) continue;
        this.position[i * 3] = OUT[0];
        this.position[i * 3 + 1] = OUT[1];
        this.position[i * 3 + 2] = OUT[2];
        /*
         * The other half of the exchange. Negated, because the push moved the particle *away*
         * from the body and the body is what pushed it — Newton's third law with the tick length
         * folded in. At the contact point rather than at the centre, so a sheet landing on one end
         * of a plank tips it.
         */
        if (exchange > 0 && bodies.type[b] !== BODY_STATIC) {
          world.applyImpulse(
            b,
            -(OUT[0] - px) * exchange,
            -(OUT[1] - py) * exchange,
            -(OUT[2] - pz) * exchange,
            px,
            py,
            pz,
          );
        }
        // A static body is scenery, so one push settles it; a moving one is resolved next tick.
        if (bodies.type[b] === BODY_STATIC) break;
      }
    }
  }
}

/** What a sheet with no self-collision carries instead of four arrays it will never read. */
const EMPTY_INDEX = new Int32Array(0);

const POSE: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
const OUT = new Float64Array(3);
const LOCAL = new Float64Array(3);
const CYLINDER = new Float64Array(11);
const SURFACE = new Float64Array(7);

/**
 * Move a point to the outside of a shape, if it is inside. Returns whether it moved.
 *
 * Works in the shape's own frame so a rotated body costs one rotation rather than a transformed
 * copy of its geometry. A faceless shape is a sphere or a capsule and is handled by its radius; a
 * polytope is pushed out along its least-penetrating face.
 */
function pushOut(
  shape: ConvexShape,
  pose: ShapePose,
  px: number,
  py: number,
  pz: number,
  thickness: number,
  out: Float64Array,
): boolean {
  unrotate(pose, px - pose.x, py - pose.y, pz - pose.z, LOCAL);
  const lx = LOCAL[0];
  const ly = LOCAL[1];
  const lz = LOCAL[2];
  const faces = faceCount(shape);

  if (isCylinder(shape)) {
    /*
     * A cylinder in its own coordinates, which is where this function already is. `closestOnCylinder`
     * answers all four regions — beside the side, past a cap, past a rim, inside — so a particle
     * that has entered near the rim comes out at the rim rather than being pushed through the solid
     * along whichever of the two surfaces the code happened to test first.
     */
    readCylinder(shape, LOCAL_POSE, CYLINDER);
    closestOnCylinder(CYLINDER, lx, ly, lz, SURFACE);
    const want = shape.radius + thickness;
    if (SURFACE[6] >= want) return false;
    rotate(
      pose,
      SURFACE[0] + SURFACE[3] * want,
      SURFACE[1] + SURFACE[4] * want,
      SURFACE[2] + SURFACE[5] * want,
      out,
    );
    out[0] += pose.x;
    out[1] += pose.y;
    out[2] += pose.z;
    return true;
  }

  if (faces === 0) {
    // The segment the shape is built on, then its radius.
    const count = shape.vertices.length / 3;
    const ax = shape.vertices[0] ?? 0;
    const ay = shape.vertices[1] ?? 0;
    const az = shape.vertices[2] ?? 0;
    const bx = count > 1 ? (shape.vertices[3] ?? 0) : ax;
    const by = count > 1 ? (shape.vertices[4] ?? 0) : ay;
    const bz = count > 1 ? (shape.vertices[5] ?? 0) : az;
    const ex = bx - ax;
    const ey = by - ay;
    const ez = bz - az;
    const ee = ex * ex + ey * ey + ez * ez;
    let t = 0;
    if (ee > 1e-12) {
      t = ((lx - ax) * ex + (ly - ay) * ey + (lz - az) * ez) / ee;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const cx = ax + ex * t;
    const cy = ay + ey * t;
    const cz = az + ez * t;
    let nx = lx - cx;
    let ny = ly - cy;
    let nz = lz - cz;
    const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const want = shape.radius + thickness;
    if (d >= want) return false;
    if (d < 1e-9) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= d;
      ny /= d;
      nz /= d;
    }
    rotate(pose, cx + nx * want, cy + ny * want, cz + nz * want, out);
    out[0] += pose.x;
    out[1] += pose.y;
    out[2] += pose.z;
    return true;
  }

  let bestFace = 0;
  let best = -Infinity;
  for (let f = 0; f < faces; f++) {
    const d =
      lx * (shape.facePlanes[f * 4] ?? 0) +
      ly * (shape.facePlanes[f * 4 + 1] ?? 0) +
      lz * (shape.facePlanes[f * 4 + 2] ?? 0) -
      (shape.facePlanes[f * 4 + 3] ?? 0) -
      shape.radius;
    if (d > best) {
      best = d;
      bestFace = f;
    }
  }
  if (best >= thickness) return false;
  const move = thickness - best;
  rotate(
    pose,
    lx + (shape.facePlanes[bestFace * 4] ?? 0) * move,
    ly + (shape.facePlanes[bestFace * 4 + 1] ?? 0) * move,
    lz + (shape.facePlanes[bestFace * 4 + 2] ?? 0) * move,
    out,
  );
  out[0] += pose.x;
  out[1] += pose.y;
  out[2] += pose.z;
  return true;
}

function rotate(pose: ShapePose, x: number, y: number, z: number, out: Float64Array): void {
  const tx = 2 * (pose.qy * z - pose.qz * y);
  const ty = 2 * (pose.qz * x - pose.qx * z);
  const tz = 2 * (pose.qx * y - pose.qy * x);
  out[0] = x + pose.qw * tx + (pose.qy * tz - pose.qz * ty);
  out[1] = y + pose.qw * ty + (pose.qz * tx - pose.qx * tz);
  out[2] = z + pose.qw * tz + (pose.qx * ty - pose.qy * tx);
}

function unrotate(pose: ShapePose, x: number, y: number, z: number, out: Float64Array): void {
  const qx = -pose.qx;
  const qy = -pose.qy;
  const qz = -pose.qz;
  const qw = pose.qw;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Three cell coordinates into one bucket, by the standard three-prime mix.
 *
 * The primes are the ones every published spatial hash for particles uses, and the reason to take
 * them rather than invent three is that a poor choice shows up as a *distribution* rather than as
 * an error: buckets that fill unevenly, a scan that lengthens, and a sheet that costs more the
 * further it is from the origin. `>>> 0` before the modulo, because a negative cell coordinate is
 * ordinary — a sheet hanging below the origin has them — and a negative bucket index would read
 * `undefined` out of the table and start every chain empty.
 */
function cellKey(x: number, y: number, z: number, buckets: number): number {
  return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) % buckets;
}

function distance(p: Float32Array, a: number, b: number): number {
  const dx = (p[b * 3] ?? 0) - (p[a * 3] ?? 0);
  const dy = (p[b * 3 + 1] ?? 0) - (p[a * 3 + 1] ?? 0);
  const dz = (p[b * 3 + 2] ?? 0) - (p[a * 3 + 2] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * A rectangular sheet: positions, its stretch links, and the bend links across them.
 *
 * Bend links skip a particle rather than joining diagonals, because a diagonal resists *shear* and a
 * skip resists *bowing*, and a sheet that cannot shear drapes like cardboard.
 *
 * **A skip-one distance constraint resists curvature and not orientation**, which is worth knowing
 * before tuning it: three collinear particles satisfy it at any angle, so a flat sheet and a sheet
 * hanging straight down are equally happy. Measured — a cantilever pinned along one edge settles at
 * exactly vertical whether the bend compliance is 1e-8 or 1e6. What it *does* buy is 12.5
 * millimetres less bow on a strip pinned at both ends with slack.
 *
 * **What would make it wrong** is a consumer wanting a cloak to stand out from a shoulder, and the
 * answer then is a dihedral-angle constraint over the two triangles either side of an edge, which
 * knows a rest angle and therefore knows the difference between flat and folded.
 */
export function makeClothGrid(
  columns: number,
  rows: number,
  spacing: number,
): { positions: Float32Array; links: Int32Array; bendLinks: Int32Array } {
  const positions = new Float32Array(columns * rows * 3);
  const links: number[] = [];
  const bend: number[] = [];
  const at = (c: number, r: number): number => r * columns + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = at(c, r);
      positions[i * 3] = c * spacing;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = r * spacing;
      if (c + 1 < columns) links.push(i, at(c + 1, r));
      if (r + 1 < rows) links.push(i, at(c, r + 1));
      // Shear, which a grid needs or it folds flat along a diagonal.
      if (c + 1 < columns && r + 1 < rows) links.push(i, at(c + 1, r + 1));
      if (c + 1 < columns && r + 1 < rows) links.push(at(c + 1, r), at(c, r + 1));
      if (c + 2 < columns) bend.push(i, at(c + 2, r));
      if (r + 2 < rows) bend.push(i, at(c, r + 2));
    }
  }
  return {
    positions,
    links: new Int32Array(links),
    bendLinks: new Int32Array(bend),
  };
}
