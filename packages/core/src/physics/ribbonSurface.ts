/**
 * "Where is the ground in this column, and which way does it face?"
 *
 * The AABB strip a ribbon builds keeps a character inside the world; it is a poor
 * description of the *surface*, because a world-axis box over a banked strip has
 * a flat top at the height of the strip's highest corner. Stand on that and you
 * hover through every corner in the game.
 *
 * So the two are split. Boxes stop you falling through; this answers what you
 * are standing on, exactly, from the curve itself.
 *
 * The cost of "exactly" is a nearest-point search along a spline, which is not
 * something to do from scratch inside a fixed tick. A uniform grid of seed arc
 * lengths turns it into a lookup plus a handful of Newton steps — a fixed count,
 * so two machines get bit-identical answers, which the replay contract requires.
 */
import { Spline, createSplineSample } from '../geometry/spline.ts';
import { RIBBON_STEP_M } from '../geometry/ribbon.ts';
import type { RibbonHole } from '../geometry/ribbon.ts';

export interface SurfaceHit {
  /** Height of the surface in the queried column. */
  y: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Direction of travel at the nearest point on the centreline. */
  tangentX: number;
  tangentY: number;
  tangentZ: number;
  /** Arc length of that nearest point. How far along the route you are. */
  distanceM: number;
  /** Signed offset from the centreline, positive to the character's right. */
  lateralM: number;
  /** Half the surface's width here — how much room is left before the edge. */
  halfWidthM: number;
  bankRad: number;
  /**
   * Which way *up* looks here — the ruled surface's own normal, not the
   * cross-section's.
   *
   * A separate field because it answers a separate question. `normal` is the
   * ground a character stands on and every movement rule is tuned against it: how
   * steep is this to walk, which way does gravity pull along it, is it floor or
   * is it wall. That question is about the cross-section, and its answer is the
   * same all the way across the deck.
   *
   * This one is about how the surface *looks* where you are standing on it, and
   * on a deck whose bank rolls it is a very different number: the ruled surface
   * climbs far more steeply along the route near its edges than the centreline
   * does — 57° measured on one chicane against the centreline's 11°, and
   * past vertical on a chute. Correct geometry, and correct for orienting a body
   * that has to look like it is on the deck. Fed to the walking rules instead it
   * takes the ground away: a character met a chicane's edge as a wall and fell down
   * it at 20 m/s a hand's width above the deck, never landing, which is exactly
   * what flying looks like.
   */
  tiltX: number;
  tiltY: number;
  tiltZ: number;
}

export function createSurfaceHit(): SurfaceHit {
  return {
    y: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    tangentX: 1,
    tangentY: 0,
    tangentZ: 0,
    distanceM: 0,
    lateralM: 0,
    halfWidthM: 0,
    bankRad: 0,
    tiltX: 0,
    tiltY: 1,
    tiltZ: 0,
  };
}

/**
 * Anything that can answer "where is the ground here?".
 *
 * The seam a controller depends on, rather than on `RibbonSurface` itself: a
 * game with heightmap terrain, or a test with three lines of arithmetic, is a
 * valid ground surface and neither should have to build a spline to say so.
 */
export interface GroundSurface {
  /**
   * @param atY Height of whatever is asking, so a route that passes over itself
   * can answer with the deck *under* them rather than the highest one in the
   * column. Omitted means "the highest", which is right for a caller that has
   * no position — a generator placing a lamp, say.
   */
  sample(x: number, z: number, out: SurfaceHit, atY?: number): boolean;
  /**
   * The **highest** floor in this column whose face lies in `[loY, hiY)`, exactly.
   *
   * A second question, not a variant of the first, and the reason it cannot be
   * expressed as one: `sample` scores candidates by nearness to the asker and
   * breaks ties *against* whatever is above them, because what you are standing
   * on is the thing under your feet. "Is there a floor in the way" asks about a
   * band that is entirely above the asker, so that scoring is pointed at the
   * exact answer wanted — a deck a metre up loses to the deck underfoot and the
   * caller is told the column is clear.
   *
   * So this is a filter and not a score: every face in the band qualifies, the
   * highest wins, and nothing outside the band can outrank anything inside it.
   * No reference height, no tie-break, nothing to tune.
   *
   * Half-open on purpose. A caller testing "between my step ceiling and my head"
   * owns both of its own bounds, and a face exactly at head height is one the
   * body passes under rather than into.
   */
  sampleBand(x: number, z: number, out: SurfaceHit, loY: number, hiY: number): boolean;
}

export interface RibbonSurfaceOptions {
  /** Side of a seed grid cell, metres. */
  cellM?: number;
  /** Stretches of arc length where there is no surface at all. */
  holes?: readonly RibbonHole[];
  /**
   * Extra width, each side, that still counts as being over the surface.
   * A character is a box, not a point, and the edge should be forgiving by about
   * half of one.
   */
  marginM?: number;
  /**
   * How far the *mesh* keeps deck past the start of a hole, metres — one cross-section step.
   *
   * A hole is authored as a span of arc length and a ribbon's geometry cannot cut exactly
   * there. `buildRibbon` keeps the cross-section that *borders* a hole, deliberately, so the
   * deck before it gets its end cap in the right place instead of stopping a step short — so
   * the drawn lip can reach a full step into the authored span. A surface that does not know
   * that figure reports no ground under deck a character can plainly see and is standing on.
   *
   * Defaults to the ribbon builder's own default step, so a caller who has not changed the
   * step does not have to say so; a caller who has must pass it, or the two disagree by the
   * difference.
   */
  holeEdgeM?: number;
  /**
   * Width of the raised trim down each edge, metres, and how far it stands proud.
   *
   * A kerb is drawn as its own ribbon over the outermost band of the deck, lifted a
   * few centimetres — and a surface that does not know about it reports the deck's
   * height under geometry the player can plainly see they are standing on, so their
   * feet sink into it. The two figures are the same ones the kerb ribbon is built from,
   * passed here so the drawn trim and the walkable floor cannot disagree.
   *
   * Zero by default, which is every consumer that has no trim: the arithmetic below is
   * skipped entirely rather than adding zero.
   */
  edgeBandM?: number;
  edgeLiftM?: number;
}

/**
 * Seed-grid resolution.
 *
 * Only has to get the Newton refinement into the right basin, so it is sized
 * for build cost rather than accuracy — the answer is exact either way. At 1.5
 * a wide track stamped over two hundred thousand cells per world and a
 * two-year sweep of the generator took sixteen seconds.
 */
const DEFAULT_CELL_M = 3;
/**
 * Candidate seeds kept per cell, from arc lengths far enough apart to be
 * different passes of the route.
 *
 * One is not enough, and the failure is severe rather than cosmetic. Where a
 * route doubles back, two stretches of it share a column; a cell seeded from
 * whichever happened to be marginally closer sends the refinement to the wrong
 * pass, which reports a lateral offset outside the surface, which reports *no
 * ground*. With the ribbon contributing no collision boxes there is nothing to
 * catch that, so a single bad query is a fall through the floor — which is
 * exactly what showed up on the twisted sections.
 *
 * Four, separated by eight metres rather than twenty-five. The separation is what
 * decides whether the two legs of a hairpin get their own slots, and a one-bar
 * hairpin at 168 BPM is only about twelve metres of arc long — so at
 * twenty-five, both legs collapsed into a single slot and the loser was
 * unreachable. Which is exactly the fall-through reported on 180-degree ribbons.
 */
const SEEDS_PER_CELL = 4;
/** How far apart two seeds must be to count as different passes. */
const SEED_SEPARATION_M = 8;
/**
 * How much a deck *above* the asker is penalised when two are equally near.
 *
 * Small, and only a tie-breaker: at equal distance the floor you are standing on
 * is the one below you. Large enough to decide a tie, small enough that a deck
 * genuinely closer above still wins — which is what a character rising through a
 * split needs.
 */
const OVERPASS_TIE_BREAK = 0.4;
const DEFAULT_MARGIN_M = 0.35;

/** Spacing of the centreline samples stamped into the seed grid. */
const SEED_STEP_M = 1.5;
/**
 * Newton steps taken to refine a seed into the exact surface point.
 *
 * Fixed rather than convergence-tested, and that is the important part: a loop
 * that stops "when close enough" runs a different number of times on different
 * hardware, and a physics step whose result depends on that is a replay that
 * diverges. Five is comfortably enough from a seed within one cell.
 */
const REFINE_STEPS = 5;
/**
 * Half-span of the symmetric difference the swept normal is built from, metres.
 *
 * Short enough to follow a camber reversal — they run over a handful of metres —
 * and long enough that the difference is not reading the spline's own numerical
 * noise. See `sweptNormal`.
 */
const NORMAL_SPAN_M = 0.5;

export class RibbonSurface {
  private readonly spline: Spline;
  private readonly holes: readonly RibbonHole[];
  private readonly margin: number;
  private readonly holeEdge: number;
  /** Raised trim down each edge; see `RibbonSurfaceOptions.edgeBandM`. */
  private readonly edgeBand: number;
  private readonly edgeLift: number;
  /**
   * The mesh's own cross-section pitch, derived exactly as `buildRibbon` derives
   * it, so this surface can name the intervals the mesh really drew.
   */
  private readonly meshStep: number;

  private readonly cell: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly cellsX: number;
  private readonly cellsZ: number;
  /**
   * Candidate arc lengths per cell — `SEEDS_PER_CELL` slots each, -1 where
   * unused.
   */
  private readonly seeds: Float32Array;

  private readonly scratch = createSplineSample();
  /** Second scratch: the swept normal needs a neighbour without losing `scratch`. */
  private readonly frame = createSplineSample();

  constructor(spline: Spline, options: RibbonSurfaceOptions = {}) {
    this.spline = spline;
    this.holes = options.holes ?? [];
    this.margin = options.marginM ?? DEFAULT_MARGIN_M;
    this.holeEdge = options.holeEdgeM ?? RIBBON_STEP_M;
    this.edgeBand = options.edgeBandM ?? 0;
    this.edgeLift = options.edgeLiftM ?? 0;
    // `buildRibbon` fits a whole number of steps across the spline and uses the
    // resulting exact pitch; matching it here is what makes `inHole` exact.
    this.meshStep =
      spline.lengthM > 0
        ? spline.lengthM / Math.max(1, Math.ceil(spline.lengthM / this.holeEdge))
        : this.holeEdge;
    this.cell = options.cellM ?? DEFAULT_CELL_M;

    if (spline.lengthM <= 0) {
      this.originX = 0;
      this.originZ = 0;
      this.cellsX = 0;
      this.cellsZ = 0;
      this.seeds = new Float32Array(0);
      return;
    }

    // Two passes over the centreline: one to size the grid, one to fill it.
    // Sizing from the real samples rather than from the control points, because
    // a curve bulges outside its own hull.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxHalf = 0;
    const steps = Math.max(1, Math.ceil(spline.lengthM / SEED_STEP_M));
    for (let i = 0; i <= steps; i++) {
      spline.sampleAt((i / steps) * spline.lengthM, this.scratch);
      if (this.scratch.x < minX) minX = this.scratch.x;
      if (this.scratch.x > maxX) maxX = this.scratch.x;
      if (this.scratch.z < minZ) minZ = this.scratch.z;
      if (this.scratch.z > maxZ) maxZ = this.scratch.z;
      const half = this.scratch.widthM * 0.5;
      if (half > maxHalf) maxHalf = half;
    }

    const pad = maxHalf + this.margin + this.cell * 2;
    this.originX = minX - pad;
    this.originZ = minZ - pad;
    this.cellsX = Math.max(1, Math.ceil((maxX - minX + pad * 2) / this.cell));
    this.cellsZ = Math.max(1, Math.ceil((maxZ - minZ + pad * 2) / this.cell));
    this.seeds = new Float32Array(this.cellsX * this.cellsZ * SEEDS_PER_CELL).fill(-1);

    /*
     * Stamp each centreline sample into the cells it could plausibly serve,
     * keeping whichever arc length is nearest to each cell's centre. A cell
     * touched by two passes of a hairpin ends up seeded from the nearer one,
     * which is what stops the refinement snapping a character onto the other
     * carriageway.
     */
    const reach = maxHalf + this.margin + this.cell;
    const span = Math.ceil(reach / this.cell);
    const best = new Float32Array(this.cellsX * this.cellsZ * SEEDS_PER_CELL).fill(Infinity);
    for (let i = 0; i <= steps; i++) {
      const d = (i / steps) * spline.lengthM;
      spline.sampleAt(d, this.scratch);
      const cx = Math.floor((this.scratch.x - this.originX) / this.cell);
      const cz = Math.floor((this.scratch.z - this.originZ) / this.cell);
      for (let gz = cz - span; gz <= cz + span; gz++) {
        if (gz < 0 || gz >= this.cellsZ) continue;
        for (let gx = cx - span; gx <= cx + span; gx++) {
          if (gx < 0 || gx >= this.cellsX) continue;
          const px = this.originX + (gx + 0.5) * this.cell;
          const pz = this.originZ + (gz + 0.5) * this.cell;
          const dx = px - this.scratch.x;
          const dz = pz - this.scratch.z;
          const distanceSq = dx * dx + dz * dz;
          this.offer((gz * this.cellsX + gx) * SEEDS_PER_CELL, d, distanceSq, best);
        }
      }
    }
  }

  /**
   * Record an arc length as a candidate for one cell.
   *
   * Slots hold *distinct passes*: an arc length close to one already held
   * replaces it if nearer, and only a genuinely separate stretch of route takes
   * a new slot. Without that rule all three slots fill with neighbouring
   * samples from the same pass and the structure buys nothing.
   */
  private offer(base: number, d: number, distanceSq: number, best: Float32Array): void {
    for (let k = 0; k < SEEDS_PER_CELL; k++) {
      const held = this.seeds[base + k] ?? -1;
      if (held < 0) {
        this.seeds[base + k] = d;
        best[base + k] = distanceSq;
        return;
      }
      if (Math.abs(held - d) < SEED_SEPARATION_M) {
        if (distanceSq < (best[base + k] ?? Infinity)) {
          this.seeds[base + k] = d;
          best[base + k] = distanceSq;
        }
        return;
      }
    }
    // Every slot is taken by a different pass: displace the worst of them.
    let worst = 0;
    for (let k = 1; k < SEEDS_PER_CELL; k++) {
      if ((best[base + k] ?? 0) > (best[base + worst] ?? 0)) worst = k;
    }
    if (distanceSq < (best[base + worst] ?? Infinity)) {
      this.seeds[base + worst] = d;
      best[base + worst] = distanceSq;
    }
  }

  /**
   * Is this arc length inside a hole — measured as the *mesh* cuts one, not as the plan
   * states one?
   *
   * `buildRibbon` lays a whole number of equal steps along the spline and draws the quad
   * between two consecutive cross-sections exactly when that quad's **midpoint** lies
   * outside the authored hole. So the drawn deck is a union of whole step intervals, and
   * a hole boundary falling mid-interval leaves the whole interval drawn. This asks the
   * mesh's own question, in the mesh's own words, and cannot drift from it.
   *
   * It used to shrink every hole by a **full step at each end regardless of alignment**,
   * which is that overhang's worst case rather than its actual size: where a boundary
   * already sits on the step grid the mesh overhangs by nothing at all, and the surface
   * was handing out up to a step of deck that was never drawn — at *every* gap, ramp and
   * platform run. It showed up everywhere as the same report: every pad ending and every
   * ribbon ending carried a phantom area the player could walk out onto without falling.
   * Measured live on one route (`blocks` at 216–246 m, mesh pitch 1.9935 m): a character
   * stood still at 245.8 m over open air with this answering a metre of deck under them.
   *
   * Exact costs one floor and one multiply.
   */
  private inHole(d: number): boolean {
    if (this.holes.length === 0) return false;
    const mid = (Math.floor(d / this.meshStep) + 0.5) * this.meshStep;
    for (const hole of this.holes) {
      if (hole.toM <= hole.fromM) continue;
      if (mid > hole.fromM && mid < hole.toM) return true;
    }
    return false;
  }

  /**
   * How the surface *looks* where it is being stood on — see `SurfaceHit.tilt`.
   *
   * A cross-section's own normal describes the *centreline*, and it is the same
   * answer all the way across the deck — which is only true while the section
   * is carried along unchanged. Where the bank rolls, the surface a character
   * stands on is a ruled one, and near its edges it climbs far more steeply
   * along the route than the centreline does: measured on one camber reversal,
   * 33° at the edge against the 11° the centreline reports. Everything that reads
   * this then believes a hill is gentle when it is not — the body stands bolt
   * upright on it instead of following the surface's own tilt, and the same
   * understatement decides step limits and grip.
   *
   * So it is built from both of the surface's own tangents. Across is `right`;
   * along is the centreline's tangent plus however fast `right` itself is
   * turning, times how far out you are — the term that is exactly zero on a
   * straight or evenly-banked stretch, and the whole story on a rolling one. The
   * derivative is a symmetric difference over a fixed span, so it costs two
   * spline samples and cannot vary between machines.
   */
  private sweptNormal(d: number, lateral: number, out: SurfaceHit): void {
    const behind = Math.max(0, d - NORMAL_SPAN_M);
    const ahead = Math.min(this.spline.lengthM, d + NORMAL_SPAN_M);
    const gap = ahead - behind;
    if (gap < 1e-6 || lateral === 0) {
      out.tiltX = this.scratch.normalX;
      out.tiltY = this.scratch.normalY;
      out.tiltZ = this.scratch.normalZ;
      return;
    }

    this.spline.sampleAt(behind, this.frame);
    const bx = this.frame.rightX;
    const by = this.frame.rightY;
    const bz = this.frame.rightZ;
    this.spline.sampleAt(ahead, this.frame);
    const dRx = (this.frame.rightX - bx) / gap;
    const dRy = (this.frame.rightY - by) / gap;
    const dRz = (this.frame.rightZ - bz) / gap;

    // Along the surface, at this lateral offset.
    const ax = this.scratch.tangentX + dRx * lateral;
    const ay = this.scratch.tangentY + dRy * lateral;
    const az = this.scratch.tangentZ + dRz * lateral;
    // Across it.
    const cx = this.scratch.rightX;
    const cy = this.scratch.rightY;
    const cz = this.scratch.rightZ;

    let nx = ay * cz - az * cy;
    let ny = az * cx - ax * cz;
    let nz = ax * cy - ay * cx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-9) {
      out.tiltX = this.scratch.normalX;
      out.tiltY = this.scratch.normalY;
      out.tiltZ = this.scratch.normalZ;
      return;
    }
    nx /= len;
    ny /= len;
    nz /= len;
    // Keep the side the cross-section chose; the cross product does not know it.
    const sign =
      nx * this.scratch.normalX + ny * this.scratch.normalY + nz * this.scratch.normalZ < 0
        ? -1
        : 1;
    out.tiltX = nx * sign;
    out.tiltY = ny * sign;
    out.tiltZ = nz * sign;
  }

  /**
   * Ask what the surface is doing in the column above/below `(x, z)`.
   *
   * Returns false where there is no surface — off the edge, past either end, or
   * over a hole — and leaves `out` untouched in that case.
   */
  sample(x: number, z: number, out: SurfaceHit, atY = Infinity): boolean {
    const base = this.cellBase(x, z);
    if (base < 0) return false;

    /*
     * Every candidate pass through this column; the one *nearest the asker's
     * height* wins.
     *
     * Nearest, not "highest at or below". The earlier rule was written for a
     * flyover, where the decks are metres apart and below is obviously right —
     * but the common case is a hairpin, where the two legs sit at *similar*
     * heights. There, picking the lower one hands a character a surface half a metre
     * beneath their feet: too far to snap to, so they are left airborne over
     * ground that is directly under them, and they fall. Reported twice against
     * 180-degree ribbons: the player passes through the surface and drops.
     *
     * Nearest is also still correct for the flyover: a character on the upper deck
     * is nearest to the upper deck.
     */
    /*
     * A caller with no height — a generator placing a lamp, say — gets the
     * highest. Scoring by distance needs something to be distant *from*, and
     * `Math.abs(y - Infinity)` is Infinity for every candidate, so a naive
     * nearest rule silently reports no ground at all to every such caller.
     */
    const located = Number.isFinite(atY);
    let winner = -1;
    let best = Infinity;
    for (let k = 0; k < SEEDS_PER_CELL; k++) {
      const seed = this.seeds[base + k] ?? -1;
      if (seed < 0) continue;
      if (!this.trySeed(x, z, seed, out)) continue;
      // Ties broken toward the surface *below*, which is the one being stood on.
      const score = located
        ? Math.abs(out.y - atY) + (out.y > atY ? OVERPASS_TIE_BREAK : 0)
        : -out.y;
      if (score < best) {
        best = score;
        winner = seed;
      }
    }
    if (winner < 0) return false;
    return this.trySeed(x, z, winner, out);
  }

  /** See `GroundSurface.sampleBand`: the highest pass in the band, exactly. */
  sampleBand(x: number, z: number, out: SurfaceHit, loY: number, hiY: number): boolean {
    const base = this.cellBase(x, z);
    if (base < 0) return false;

    let winner = -1;
    let bestY = -Infinity;
    for (let k = 0; k < SEEDS_PER_CELL; k++) {
      const seed = this.seeds[base + k] ?? -1;
      if (seed < 0) continue;
      if (!this.trySeed(x, z, seed, out)) continue;
      if (out.y < loY || out.y >= hiY) continue;
      if (out.y > bestY) {
        bestY = out.y;
        winner = seed;
      }
    }
    if (winner < 0) return false;
    return this.trySeed(x, z, winner, out);
  }

  /**
   * Index of this column's seed slots, or -1 where the grid does not reach.
   *
   * Shared by both queries so the two can never disagree about which cell a
   * column falls in.
   */
  private cellBase(x: number, z: number): number {
    if (this.seeds.length === 0) return -1;
    const gx = Math.floor((x - this.originX) / this.cell);
    const gz = Math.floor((z - this.originZ) / this.cell);
    if (gx < 0 || gx >= this.cellsX || gz < 0 || gz >= this.cellsZ) return -1;
    return (gz * this.cellsX + gx) * SEEDS_PER_CELL;
  }

  /**
   * Refine one candidate seed and report whether it lands on the surface.
   *
   * Split out so the query can try several; on its own this is the original
   * single-seed search.
   */
  private trySeed(x: number, z: number, seed: number, out: SurfaceHit): boolean {
    /*
     * Refine the seed into the exact surface point, solving for arc length and
     * lateral offset *together*.
     *
     * Solving them separately — walk along the tangent to the nearest point on
     * the centreline, then measure sideways from there — is the obvious
     * approach and it is wrong on the one shape this milestone is built out of.
     * A banked surface normal on a climbing track leans backward along the
     * direction of travel, so a point offset sideways on the surface is also
     * displaced slightly *forward*, and the nearest centreline point is no
     * longer the one you are standing on. It cost about six millimetres of
     * height on a 0.45 rad bank, which is nothing to look at and exactly the
     * kind of thing that grows teeth on a steeper corner.
     *
     * Two unknowns, two equations, one 2×2 solve per step:
     *   P − C(d) = δd · tangent + u · right,  in the horizontal plane.
     */
    let d = seed;
    let lateral = 0;
    for (let i = 0; i <= REFINE_STEPS; i++) {
      this.spline.sampleAt(d, this.scratch);
      const px = x - this.scratch.x;
      const pz = z - this.scratch.z;
      const tx = this.scratch.tangentX;
      const tz = this.scratch.tangentZ;
      const rx = this.scratch.rightX;
      const rz = this.scratch.rightZ;
      const det = tx * rz - tz * rx;
      if (Math.abs(det) < 1e-9) break;
      lateral = (tx * pz - tz * px) / det;
      // The last pass reads the offset at the settled arc length rather than
      // moving again, so the two answers describe the same point.
      if (i === REFINE_STEPS) break;
      d += (px * rz - pz * rx) / det;
      if (d < 0) d = 0;
      else if (d > this.spline.lengthM) d = this.spline.lengthM;
    }

    /*
     * The ends are exclusive. A track has to stop somewhere, and clamping the
     * search means every column beyond the summit would otherwise report the
     * summit's own surface — invisible floor stretching to the horizon, in the
     * one place a fall is meant to be possible.
     */
    if (d <= 0 || d >= this.spline.lengthM) {
      const overshoot = d <= 0 ? -1 : 1;
      this.spline.sampleAt(d, this.scratch);
      const ahead =
        (x - this.scratch.x) * this.scratch.tangentX + (z - this.scratch.z) * this.scratch.tangentZ;
      if (ahead * overshoot > 1e-4) return false;
    }
    if (this.inHole(d)) return false;

    const halfWidth = this.scratch.widthM * 0.5;
    if (Math.abs(lateral) > halfWidth + this.margin) return false;

    out.y = this.scratch.y + this.scratch.rightY * lateral;
    /*
     * The kerb is floor too.
     *
     * Its band is the outermost `edgeBand` of each side and it stands `edgeLift` proud,
     * exactly as the trim ribbon is drawn — so standing on one puts the feet on top of
     * it instead of through it. The normal is untouched: a kerb's top is parallel to the
     * deck it edges, so what changes is the height and nothing else.
     */
    if (this.edgeLift > 0 && halfWidth - Math.abs(lateral) <= this.edgeBand) {
      out.y += this.edgeLift;
    }
    out.normalX = this.scratch.normalX;
    out.normalY = this.scratch.normalY;
    out.normalZ = this.scratch.normalZ;
    this.sweptNormal(d, lateral, out);
    out.tangentX = this.scratch.tangentX;
    out.tangentY = this.scratch.tangentY;
    out.tangentZ = this.scratch.tangentZ;
    out.distanceM = d;
    out.lateralM = lateral;
    out.halfWidthM = halfWidth;
    out.bankRad = this.scratch.bankRad;
    return true;
  }
}
