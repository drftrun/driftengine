/**
 * A banked surface swept along a spline: the drawn slab and the colliders that
 * stop you falling through it.
 *
 * Collision is the mesh: every drawn triangle of the deck becomes a wedge with
 * the slab's depth under it, so the geometry a player sees is exactly the
 * geometry that stops them — banked, climbing, or twisted. The exact ground
 * they *stand* on still comes from `RibbonSurface`, which answers from the
 * curve itself; the wedges keep a body out of the slab from every other
 * direction.
 */
import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';
import type { Collider } from '@driftengine/physics';
import { colliderFromShape } from '@driftengine/physics';
import { hullShape } from '@driftengine/physics';
import { Spline, createSplineSample } from './spline.ts';

/** A stretch of arc length where the surface simply is not there. */
export interface RibbonHole {
  fromM: number;
  toM: number;
}

export interface RibbonOptions {
  color: Vec3;
  emissive?: number;
  /** Distance between cross-sections. Smaller is smoother and heavier. */
  stepM?: number;
  /** Depth of the slab below the surface. */
  thicknessM?: number;
  /** Interruptions: an unbridged track is a jump, and jumps are the point. */
  holes?: readonly RibbonHole[];
  /**
   * Called per cross-section to vary the surface along the route.
   *
   * Writes the colour into `out` and returns the emissive strength. The hook
   * exists so a generator can give each stretch its own material without
   * building a separate ribbon per segment — a route in one flat tone reads as
   * a painted strip rather than as something built.
   */
  shade?: (distanceM: number, out: Vec3) => number;
  /**
   * Build only a band along one edge instead of the whole surface.
   *
   * For kerbs: a strip this wide, inset from the chosen edge and lifted clear,
   * with the surface's own banking. Doing it as a second ribbon rather than as
   * geometry bolted on afterwards means the kerb follows the bank exactly, and
   * it is the banking that makes an edge hard to read without one.
   */
  edgeBandM?: number;
  edgeSide?: -1 | 1;
  /**
   * Build a band between two *absolute* lateral offsets instead of edge-relative
   * ones — for anything painted at a particular place across the surface rather
   * than along its edge.
   *
   * The alternative is to lay a row of small boxes along the route, and it does
   * not work: an axis-aligned box cannot follow a curve, so the row steps into a
   * zigzag and reads as a staircase of holes rather than as a marking. Built as a
   * ribbon it follows the centreline and the bank exactly, for free.
   */
  lateralFromM?: number;
  lateralToM?: number;
  /** Restrict the build to a stretch of the curve. */
  fromM?: number;
  toM?: number;
  /** Raise the whole band by this much, so a kerb stands proud of the surface. */
  liftM?: number;
  /**
   * How far below the drawn surface the collider hulls' tops sit, metres.
   *
   * A consumer's ground query rides the *smooth* curve; the hulls are the
   * *faceted* mesh, and at a crest a facet ridge stands a few centimetres
   * proud of the curve — each ridge a micro-wall under a character's feet if the
   * hulls are exactly flush. The give hands the top few centimetres to the
   * smooth query and everything beneath to the hull: a tolerance between two
   * representations of the same surface, not a hole in the world — the slab's
   * sides and underside stay exactly where they are drawn. Zero means flush.
   */
  colliderGiveM?: number;
}

/**
 * Spacing of the cross-sections a ribbon's mesh is built from, metres.
 *
 * Exported because it is not only the builder's business: `RibbonSurface` has to know it to
 * agree with the geometry at a hole's edge, where the mesh deliberately keeps the bordering
 * section. A copy of this number in the physics module is a copy that drifts.
 */
export const RIBBON_STEP_M = 2;
const DEFAULT_STEP_M = RIBBON_STEP_M;
const DEFAULT_THICKNESS_M = 0.6;
/**
 * Default collider give: comfortably past the sagitta of a `RIBBON_STEP_M`
 * facet at the tightest curvature a route reaches (a hairpin near 6 m radius:
 * 2² / (8 · 6) ≈ 0.08), because a give that only just covers the facet error
 * still brushes the character at every ridge — felt as braking on exactly the
 * curves a route wants taken at speed. Small enough that nothing passes
 * through the gap: it is backed by solid hull immediately beneath, and only
 * the top eases — sides and underside collide exactly where they are drawn.
 */
export const RIBBON_COLLIDER_GIVE_M = 0.15;
/**
 * How far a drawn facet may fall short of the curve it approximates, metres.
 *
 * Comfortably inside `RIBBON_COLLIDER_GIVE_M`, because that give is the whole
 * budget for the two representations of a deck disagreeing: the smooth curve a
 * ground query rides, and the facets that are drawn and collided. Spend the
 * budget on the facet error and there is nothing left for the give's own job.
 */
const MAX_FACET_SLIP_M = 0.05;
/**
 * Ceiling on the cuts one step may be divided into.
 *
 * A route that still slips past `MAX_FACET_SLIP_M` at eight cuts is turning
 * roughly sixty times faster than the geometry it is made of, and no amount of
 * subdivision makes that stretch good — it is a generator bug, and quietly
 * spending a hundred facets on it would hide the bug rather than the seam.
 */
const MAX_FACET_CUTS = 8;
/**
 * How far a quad's fourth corner may sit off the plane of the other three and
 * still be collided as one hull rather than two wedges, metres.
 *
 * A flat quad is its own convex hull, so splitting it buys nothing and costs a
 * collider — and most of a route is flat in this sense: it is only where the
 * bank rolls that a quad warps at all. A centimetre is far below the give, so
 * a quad that passes here cannot stand meaningfully proud of itself.
 */
const FLAT_QUAD_M = 0.01;

export interface RibbonMesh {
  mesh: MeshData;
  colliders: Collider[];
}

function inHole(holes: readonly RibbonHole[] | undefined, d: number): boolean {
  if (holes === undefined) return false;
  for (const hole of holes) {
    if (d > hole.fromM && d < hole.toM) return true;
  }
  return false;
}

/**
 * Accumulator for one ribbon. Kept local rather than reusing `MeshBuilder`
 * because that one only knows how to emit axis-aligned boxes, and every face
 * here is oblique.
 */
class Strip {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly emissive: number[] = [];
  readonly indices: number[] = [];
  private count = 0;

  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    color: Vec3,
    emissive: number,
  ): void {
    // Flat-shaded, so the normal is the triangle's own and every face carries
    // its own four vertices. Computing it rather than passing it in means the
    // stored normal cannot disagree with the winding.
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    nx /= len;
    ny /= len;
    nz /= len;

    const i = this.count;
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let v = 0; v < 4; v++) {
      this.normals.push(nx, ny, nz);
      this.colors.push(color[0], color[1], color[2]);
      this.emissive.push(emissive);
    }
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    this.count += 4;
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      emissive: new Float32Array(this.emissive),
      indices: new Uint32Array(this.indices),
    };
  }
}

/** Four corners of one cross-section: left/right, top/bottom. */
interface Section {
  lx: number;
  ly: number;
  lz: number;
  rx: number;
  ry: number;
  rz: number;
  lbx: number;
  lby: number;
  lbz: number;
  rbx: number;
  rby: number;
  rbz: number;
  /** Collider give along this section's normal — subtracted from the top corners only. */
  gx: number;
  gy: number;
  gz: number;
}

function makeSection(): Section {
  return {
    lx: 0,
    ly: 0,
    lz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    lbx: 0,
    lby: 0,
    lbz: 0,
    rbx: 0,
    rby: 0,
    rbz: 0,
    gx: 0,
    gy: 0,
    gz: 0,
  };
}

export function buildRibbon(spline: Spline, options: RibbonOptions): RibbonMesh {
  const step = options.stepM ?? DEFAULT_STEP_M;
  const thickness = options.thicknessM ?? DEFAULT_THICKNESS_M;
  const emissive = options.emissive ?? 0;
  const strip = new Strip();
  const colliders: Collider[] = [];

  if (spline.lengthM <= 0 || step <= 0) {
    return { mesh: strip.build(), colliders };
  }

  const sample = createSplineSample();
  const color: Vec3 = [options.color[0], options.color[1], options.color[2]];
  let emissiveNow = emissive;
  const previous = makeSection();
  const current = makeSection();
  /** Scratch: the midpoint a facet is measured against, and the cuts it earns. */
  const probe = makeSection();
  const sub = makeSection();
  let havePrevious = false;

  const wedgePoints: number[] = [];
  /**
   * Extra ease for the quad being emitted, on top of the constant give.
   *
   * The give is sized for a facet's own sagitta; what it cannot know is how far
   * *this* quad falls short of the curve, which on a fast camber reversal is
   * several times larger and does not shrink to nothing even at the cut ceiling.
   * A collider standing proud of the smooth surface is the worst failure this
   * builder has: the ground query puts a character at the curve's height, the hull
   * is above them, and a body inside its own floor cannot move in any direction
   * — on that camber, a hill simply cannot be climbed. So whatever the cuts
   * could not remove is handed to the ease instead. Sitting *below* the drawn
   * deck costs nothing; the surface owns the ride, and the slab is solid the
   * whole way down.
   */
  let extraEase = 0;
  /**
   * Extra ease across the section, on top of `extraEase` along it.
   *
   * `extraEase` was sized for camber: it travels along a section's normal, and
   * a normal-direction push cannot touch an error that lives in a completely
   * different direction. On a curve tight enough that the half-width is a real
   * fraction of the radius — a hairpin's inner rail, a chicane's apex — the
   * chord between two cross-sections' inner corners cuts across the true
   * offset curve rather than following it, because the inner boundary sweeps a
   * *tighter* radius than the centreline (`radius − half`, shrinking toward
   * zero as the half-width closes on the radius) while the chord stays
   * straight. The result stands proud sideways instead of vertically: a hull
   * a hand's width into the lane a character is looking straight down, on
   * flat, ordinary-looking track. It reads as the player colliding with the
   * track itself, worst while sliding — measured at a hairpin
   * where the chord missed the true inner boundary by most of a metre and
   * cost a character their whole speed on an axis nothing was drawn across.
   *
   * `cuts` already measures this: `leftSlip`/`rightSlip` below are the same
   * per-edge chord error the cut count is chosen from. What was missing was
   * anywhere for the *leftover* of that specific error to go once the cut
   * ceiling was reached — `extraEase` only ever paid down the diagonal
   * (camber) term. This pays the lateral remainder by drawing both top
   * corners in toward the section's own centreline, which can only ever
   * shrink the hull — the ground a character stands on is still the smooth
   * curve `RibbonSurface` answers from, never this mesh, so a hull inset by
   * centimetres at an extreme apex changes nothing about where a body can
   * walk, only how snugly its sides are held.
   */
  let lateralEase = 0;

  /** One corner of a wedge: the eased top corner, and the bottom under it. */
  const corner = (s: Section, right: boolean): void => {
    // The give travels along the section's own normal; so does the extra.
    const ex =
      s.gx === 0 && s.gy === 0 && s.gz === 0 ? 0 : extraEase / Math.hypot(s.gx, s.gy, s.gz);
    const gx = s.gx * (1 + ex);
    const gy = s.gy * (1 + ex);
    const gz = s.gz * (1 + ex);
    let topX = right ? s.rx : s.lx;
    let topY = right ? s.ry : s.ly;
    let topZ = right ? s.rz : s.lz;
    if (lateralEase > 0) {
      let dx = s.rx - s.lx;
      let dy = s.ry - s.ly;
      let dz = s.rz - s.lz;
      const dl = Math.hypot(dx, dy, dz);
      if (dl > 1e-9) {
        const inset = (Math.min(lateralEase, dl * 0.45) / dl) * (right ? -1 : 1);
        dx *= inset;
        dy *= inset;
        dz *= inset;
        topX += dx;
        topY += dy;
        topZ += dz;
      }
    }
    if (right) {
      wedgePoints.push(topX - gx, topY - gy, topZ - gz, s.rbx, s.rby, s.rbz);
    } else {
      wedgePoints.push(topX - gx, topY - gy, topZ - gz, s.lbx, s.lby, s.lbz);
    }
  };

  /**
   * The collision under one drawn quad: two wedges, one per drawn triangle.
   *
   * A convex hull's *top face is a plane*, and the deck between two
   * cross-sections is not one. Hulling the whole quad therefore bridged its
   * warp, and the bridge stood proud of the deck the player walks on: measured
   * across a day's route, up to **6 m** of warp on one in eight spans, leaving
   * hull tops as much as 0.6 m above the drawn surface. A character standing where
   * the deck is drawn was then *inside* solid collision — unable to lift, so
   * auto-step could not fire, unable to move, so a full run died against
   * nothing visible. Reported on the same span every time: on a steep hill the
   * player stops climbing, forward input leaves them standing still, and they
   * are stuck inside the track's own parts.
   *
   * Splitting the quad laterally was an attempt to bound that bridge, and it
   * could not: following a 24° roll to within four centimetres needs ninety
   * strips, and the cap of six left five sixths of the error in place. A
   * triangle needs no bound. Its three corners *define* a plane, so this wedge's
   * top face is the drawn triangle exactly — the same corners, the same diagonal
   * `Strip.quad` indexes — and the pair of them tiles the quad with no seam
   * between and none to the neighbouring span. Two wedges per quad is also
   * fewer colliders than the strips averaged.
   *
   * The bottom corners hang under their own cross-section's normal, so a side
   * face can still be a little warped where the bank rolls. That bulge is
   * lateral, under the deck, bounded by the slab's own depth, and shared with
   * the wedge next door: it is not somewhere anyone stands.
   */
  const wedgeQuad = (p: Section, c: Section): void => {
    /*
     * Flat enough to be its own hull? Then one collider, not two. The warp is
     * the current-left corner's distance from the plane of the other three.
     */
    const ax = p.lx - p.gx;
    const ay = p.ly - p.gy;
    const az = p.lz - p.gz;
    const e1x = p.rx - p.gx - ax;
    const e1y = p.ry - p.gy - ay;
    const e1z = p.rz - p.gz - az;
    const e2x = c.rx - c.gx - ax;
    const e2y = c.ry - c.gy - ay;
    const e2z = c.rz - c.gz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-9) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const warp = Math.abs(
        (c.lx - c.gx - ax) * nx + (c.ly - c.gy - ay) * ny + (c.lz - c.gz - az) * nz,
      );
      if (warp <= FLAT_QUAD_M) {
        wedgePoints.length = 0;
        corner(p, false);
        corner(p, true);
        corner(c, true);
        corner(c, false);
        colliders.push(colliderFromShape(hullShape(wedgePoints)));
        return;
      }
    }
    // The diagonal the mesh indexes: previous-left to current-right.
    wedgePoints.length = 0;
    corner(p, false);
    corner(p, true);
    corner(c, true);
    colliders.push(colliderFromShape(hullShape(wedgePoints)));
    wedgePoints.length = 0;
    corner(p, false);
    corner(c, true);
    corner(c, false);
    colliders.push(colliderFromShape(hullShape(wedgePoints)));
  };

  const band = options.edgeBandM ?? 0;
  const edgeSide = options.edgeSide ?? 1;
  const lift = options.liftM ?? 0;
  const give = options.colliderGiveM ?? RIBBON_COLLIDER_GIVE_M;
  /*
   * The lateral range is normalised, and that is a correctness fix rather than tidiness.
   *
   * A slab built from a *descending* range comes out inside-out: measured signed volume
   * +256 one way round and -256 the other. With back-face culling — which the renderer
   * uses everywhere — an inside-out slab is **invisible from outside**, so you look
   * straight through it. That is exactly what shows up under a canal bridge: the ceiling
   * looks glassy and transparent from below, and fixing one side leaves the opposite one
   * untouched — because a canal on one hand
   * multiplies every offset by -1, which reverses the order and turns every band it
   * builds inside out.
   *
   * Fixing it here rather than at the call sites is the point: a caller expressing
   * "from the coping to the far bank" has said something about *space*, not about winding,
   * and no caller should have to know that the difference is visible.
   */
  const rangeA = options.lateralFromM;
  const rangeB = options.lateralToM;
  const swap = rangeA !== undefined && rangeB !== undefined && rangeA > rangeB;
  const lateralFrom = swap ? rangeB : rangeA;
  const lateralTo = swap ? rangeA : rangeB;
  const absolute = lateralFrom !== undefined && lateralTo !== undefined;

  const fill = (d: number, into: Section): void => {
    spline.sampleAt(d, sample);
    const half = sample.widthM * 0.5;
    /*
     * Three ways to span a cross-section: the whole surface, a band inset from
     * one edge (a kerb), or a band between two given offsets (a marking).
     */
    /*
     * Ordered, and the order is what decides the triangle winding.
     *
     * Every quad in this builder puts the first offset at the section's *left* corner
     * and the second at its right, and back faces are culled — so if the two ever
     * arrive the other way round, the piece is built inside out. That is exactly what
     * happened, and it was invisible for as long as it was symmetric:
     *
     * - the full surface spans `-half` to `+half`, left before right, correct;
     * - a kerb at `edgeSide = -1` spans `-half` to `-half + band`, also correct;
     * - a kerb at `edgeSide = +1` spans `+half` to `+half - band` — **reversed**, so
     *   its top face points into the deck and is culled, and what shows through is the
     *   surface underneath and the band's own underside.
     *
     * One kerb of the two, on one side of every route, worst where a curve brings it to
     * a grazing angle. Once the depth layers had cleaned up the left, the right was
     * unchanged: borders and lines still fighting the main surface, worst on curves.
     *
     * The `absolute` case has the same hazard from the same cause — the canal passes its
     * two offsets multiplied by a side — so this is not special-cased to kerbs. Sorting
     * the pair costs nothing and makes the winding a property of the builder rather than
     * of what a caller happened to pass.
     */
    const edgeA = absolute ? (lateralFrom as number) : band > 0 ? half * edgeSide : -half;
    const edgeB = absolute ? (lateralTo as number) : band > 0 ? (half - band) * edgeSide : half;
    const outer = Math.min(edgeA, edgeB);
    const inner = Math.max(edgeA, edgeB);
    const cx = sample.x + sample.normalX * lift;
    const cy = sample.y + sample.normalY * lift;
    const cz = sample.z + sample.normalZ * lift;
    const lx = cx + sample.rightX * outer;
    const ly = cy + sample.rightY * outer;
    const lz = cz + sample.rightZ * outer;
    const rx = cx + sample.rightX * inner;
    const ry = cy + sample.rightY * inner;
    const rz = cz + sample.rightZ * inner;
    into.lx = lx;
    into.ly = ly;
    into.lz = lz;
    into.rx = rx;
    into.ry = ry;
    into.rz = rz;
    into.lbx = lx - sample.normalX * thickness;
    into.lby = ly - sample.normalY * thickness;
    into.lbz = lz - sample.normalZ * thickness;
    into.rbx = rx - sample.normalX * thickness;
    into.rby = ry - sample.normalY * thickness;
    into.rbz = rz - sample.normalZ * thickness;
    // The collider's top eases below the drawn one by the give, never past the slab.
    const ease = Math.min(give, thickness * 0.5);
    into.gx = sample.normalX * ease;
    into.gy = sample.normalY * ease;
    into.gz = sample.normalZ * ease;
  };

  /** One drawn facet of the slab: four faces, and the collision under them. */
  const slab = (p: Section, c: Section): void => {
    // Top, then bottom, then the two sides. Orders chosen so each quad's
    // computed normal points out of the slab; the winding test proves it.
    strip.quad(
      p.lx,
      p.ly,
      p.lz,
      p.rx,
      p.ry,
      p.rz,
      c.rx,
      c.ry,
      c.rz,
      c.lx,
      c.ly,
      c.lz,
      color,
      emissiveNow,
    );
    strip.quad(
      c.lbx,
      c.lby,
      c.lbz,
      c.rbx,
      c.rby,
      c.rbz,
      p.rbx,
      p.rby,
      p.rbz,
      p.lbx,
      p.lby,
      p.lbz,
      color,
      emissiveNow,
    );
    strip.quad(
      p.rx,
      p.ry,
      p.rz,
      p.rbx,
      p.rby,
      p.rbz,
      c.rbx,
      c.rby,
      c.rbz,
      c.rx,
      c.ry,
      c.rz,
      color,
      emissiveNow,
    );
    strip.quad(
      p.lbx,
      p.lby,
      p.lbz,
      p.lx,
      p.ly,
      p.lz,
      c.lx,
      c.ly,
      c.lz,
      c.lbx,
      c.lby,
      c.lbz,
      color,
      emissiveNow,
    );
    // Drawn and collided in the same breath, from the same corners.
    wedgeQuad(p, c);
  };

  const copy = (from: Section, to: Section): void => {
    to.lx = from.lx;
    to.ly = from.ly;
    to.lz = from.lz;
    to.rx = from.rx;
    to.ry = from.ry;
    to.rz = from.rz;
    to.lbx = from.lbx;
    to.lby = from.lby;
    to.lbz = from.lbz;
    to.rbx = from.rbx;
    to.rby = from.rby;
    to.rbz = from.rbz;
    // The give travels with the section it was measured on. It did not have to
    // before, when only `current` was ever collided; now a wedge takes two
    // cross-sections and half of every quad would have stood flush with the
    // drawn deck — a micro-wall at each facet ridge, the whole way along.
    to.gx = from.gx;
    to.gy = from.gy;
    to.gz = from.gz;
  };

  /** Seal the open end of a piece so the slab is a closed solid. */
  const cap = (s: Section, facingForward: boolean): void => {
    if (facingForward) {
      strip.quad(
        s.rx,
        s.ry,
        s.rz,
        s.rbx,
        s.rby,
        s.rbz,
        s.lbx,
        s.lby,
        s.lbz,
        s.lx,
        s.ly,
        s.lz,
        color,
        emissiveNow,
      );
    } else {
      strip.quad(
        s.lx,
        s.ly,
        s.lz,
        s.lbx,
        s.lby,
        s.lbz,
        s.rbx,
        s.rby,
        s.rbz,
        s.rx,
        s.ry,
        s.rz,
        color,
        emissiveNow,
      );
    }
  };

  // One extra step so the final cross-section lands exactly on the end.
  const startAt = Math.max(0, options.fromM ?? 0);
  const endAt = Math.min(spline.lengthM, options.toM ?? spline.lengthM);
  const span = endAt - startAt;
  if (span <= 0) return { mesh: strip.build(), colliders };
  const steps = Math.max(1, Math.ceil(span / step));
  const exactStep = span / steps;

  for (let i = 0; i <= steps; i++) {
    const d = startAt + i * exactStep;
    /*
     * A cross-section is present when the surface exists on at least one side
     * of it. That is what makes a hole's edge sharp: the section bordering a
     * hole is still built, so the piece before it gets its end cap in the right
     * place rather than stopping a step short.
     */
    const before = i > 0 && !inHole(options.holes, d - exactStep * 0.5);
    const after = i < steps && !inHole(options.holes, d + exactStep * 0.5);
    if (!before && !after) {
      if (havePrevious) {
        cap(previous, true);
        havePrevious = false;
      }
      continue;
    }

    fill(d, current);
    if (options.shade !== undefined) emissiveNow = options.shade(d, color);

    if (!before) {
      // Opening a new piece.
      cap(current, false);
      copy(current, previous);
      havePrevious = true;
      continue;
    }

    if (havePrevious) {
      /*
       * As many facets as this stretch of curve needs, never fewer.
       *
       * `step` is one number for a whole route, and a route does not turn at one
       * rate. Where a route reverses its camber — one measured case rolls 17° one
       * way to 16° the other inside nine metres, across a deck 17 m wide — a 2 m facet
       * cuts that corner by **0.85 m**. Everything downstream then disagrees
       * about where the deck is: `RibbonSurface` answers from the smooth curve
       * and puts a character most of a metre inside the drawn slab, where they are
       * buried in their own floor. Buried, they cannot lift, so auto-step cannot
       * fire, so they cannot walk — on that exact camber the player stays stuck
       * the moment they try to run, with impacts on every ridge from the same gap.
       *
       * So the builder measures its own error and subdivides until it is small,
       * rather than trusting a constant. Only the fast-turning spans pay, and
       * they are the ones that were broken.
       */
      const dPrev = d - exactStep;
      fill((dPrev + d) * 0.5, probe);
      /*
       * Measured at the *diagonal*, which is where a quad is furthest from the
       * curve it stands for.
       *
       * Two cross-sections that differ in bank are skew lines, and the surface
       * ruled between them is not flat — but two triangles are. Both of them
       * share the diagonal, so along that diagonal the drawn deck is the plain
       * average of two opposite corners, while the real deck at the same place
       * is the mid-section's own centre. The gap between those is the whole
       * error, and it is *linear* in the step: half a metre of bank roll across
       * a seventeen-metre deck puts fourteen centimetres of it under a character's
       * feet, which is the give's entire budget spent before the give does any
       * of its own work.
       *
       * Measuring the edges instead — the obvious thing, and what this did
       * first — sees almost none of it: a chord along an edge is out by
       * millimetres where the diagonal is out by a hand's width.
       */
      const diagSlip = Math.hypot(
        (probe.lx + probe.rx) * 0.5 - (previous.lx + current.rx) * 0.5,
        (probe.ly + probe.ry) * 0.5 - (previous.ly + current.ry) * 0.5,
        (probe.lz + probe.rz) * 0.5 - (previous.lz + current.rz) * 0.5,
      );
      const leftSlip = Math.hypot(
        probe.lx - (previous.lx + current.lx) * 0.5,
        probe.ly - (previous.ly + current.ly) * 0.5,
        probe.lz - (previous.lz + current.lz) * 0.5,
      );
      const rightSlip = Math.hypot(
        probe.rx - (previous.rx + current.rx) * 0.5,
        probe.ry - (previous.ry + current.ry) * 0.5,
        probe.rz - (previous.rz + current.rz) * 0.5,
      );
      const slip = Math.max(diagSlip, leftSlip, rightSlip);
      const cuts =
        slip > MAX_FACET_SLIP_M ? Math.min(MAX_FACET_CUTS, Math.ceil(slip / MAX_FACET_SLIP_M)) : 1;
      /*
       * Whatever a whole number of cuts could not take out, the ease takes.
       * Never past the slab's own depth, so a wedge cannot turn inside out.
       */
      extraEase = Math.min(Math.max(0, slip / cuts - MAX_FACET_SLIP_M), thickness * 0.5);
      /*
       * The edge-specific half of the same leftover, paid across the section
       * instead of along it — see `lateralEase` above. `leftSlip`/`rightSlip`
       * are exactly the per-edge error `cuts` was chosen from; only their
       * share of what the cut ceiling could not remove needs paying here.
       */
      lateralEase = Math.min(
        Math.max(0, Math.max(leftSlip, rightSlip) / cuts - MAX_FACET_SLIP_M),
        1.5,
      );
      for (let s = 1; s <= cuts; s++) {
        if (s < cuts) {
          const dSub = dPrev + exactStep * (s / cuts);
          fill(dSub, sub);
          if (options.shade !== undefined) emissiveNow = options.shade(dSub, color);
          slab(previous, sub);
          copy(sub, previous);
        } else {
          if (options.shade !== undefined) emissiveNow = options.shade(d, color);
          slab(previous, current);
        }
      }
      extraEase = 0;
      lateralEase = 0;
    }

    copy(current, previous);
    havePrevious = true;

    if (!after) {
      cap(current, true);
      havePrevious = false;
    }
  }

  if (havePrevious) cap(previous, true);

  return { mesh: strip.build(), colliders };
}
