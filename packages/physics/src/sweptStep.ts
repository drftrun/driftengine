import { AXIS_X, AXIS_Y, AXIS_Z, moveAxis } from './collide/index.ts';
import type { Axis, Body } from './collide/index.ts';
import type { ColliderSet } from './colliderSet.ts';

/**
 * Moving a kinematic body horizontally, one axis at a time, through a world that has opinions.
 *
 * **The half a sweep does not cover.** `moveAxis` answers "what stopped me"; it has nothing to say
 * about whether the thing that stopped you was a kerb you should have stepped over, a face the
 * world calls solid but carries no collider for, a facet seam you clipped in mid-air, or a corner
 * that has just trapped you because both axes refused in the same tick. Every one of those is a
 * rule rather than a query, and every one of them is the same in any game.
 *
 * **Three opinions the geometry cannot hold**, taken structurally through `WorldOpinion` — the
 * third time this package has needed that shape, after `GroundProbe` and `EscapeVeto`, and for the
 * same reason each time: a consumer with an analytic surface knows things a collider set does not.
 * A deck drawn as a smooth ribbon carries no boxes at all, so its *edge* is as solid as a wall and
 * nothing in the collider set says so.
 *
 * **What it will not do is decide what you are standing on.** That question drags in every noun a
 * game has — what the surface is made of, whether it burns, whether it launches you — and it stays
 * with the consumer. This owns the move; the consumer owns the meaning.
 */

/** Anything with a planar velocity the sweep may redirect. */
export interface SweptState {
  velX: number;
  velZ: number;
}

/**
 * What the world knows that its colliders do not.
 *
 * Declared structurally, so nothing is imported in either direction.
 */
export interface WorldOpinion {
  /**
   * Is there a face standing where the body has just moved to, that it can neither step onto nor
   * pass under? `from` is where it started on `axis`.
   *
   * The case this exists for: a deck drawn as a smooth surface carries no collision boxes, so
   * every one of its edges is scenery. A body walks into the side of a raised slab and keeps
   * going, which looks exactly like clipping through the world because it is.
   */
  blocked(axis: Axis, from: number): boolean;
  /**
   * How far the world's own surface would rise to meet a body standing at `(x, z)` with its feet
   * at `feetY`, or null where it has no opinion. Negative for a descent.
   */
  riseTo(x: number, z: number, feetY: number): number | null;
  /**
   * Whether the world vouches for its own rises *here*.
   *
   * The retry below overrules a collider that refused a move, on the grounds that the surface says
   * the ground rises to meet it. That is right on ground the world authored as travelable and
   * wrong everywhere else: a terrace wall, a station lip and a courtyard edge are real, intended walls
   * and the hull is the only honest answer for them. A consumer with no such distinction answers
   * the same thing every time and pays nothing.
   */
  vouches(): boolean;
}

export interface SweptStepOptions {
  /** How high a lip may be and still be stepped over. */
  stepHeight?: number;
  /**
   * How much of a shortfall counts as a graze rather than a wall, for a body in the air, metres.
   *
   * A facet seam is a few centimetres and mid-flight is exactly where one is most likely to be
   * clipped in passing rather than run into. A genuine wall does not pass it: hit one square and
   * the move is near zero regardless of how small it was.
   */
  grazeM?: number;
  /**
   * How wide something has to be before it is scenery rather than a post, metres.
   *
   * A deck's own geometry spans most of a cross-section by construction, metres in at least one
   * direction; a lamp post is fourteen centimetres. The width test alone tells them apart, and it
   * is what keeps the vouched retry from walking a body through a real obstacle.
   */
  propFootprintM?: number;
  /** How much exploratory lift a vouched retry is worth where the surface reports no rise. */
  facetClearM?: number;
  /** A rise smaller than this is not a rise. Matches whatever the consumer's own snap ignores. */
  riseSlackM?: number;
  /**
   * The least horizontal contact normal that counts as a wall.
   *
   * Below it the contact is a floor or a ceiling, and redirecting horizontal motion along one of
   * those would let a body climb.
   */
  wallNormalMin?: number;
  /** How hard a body slides off something it is merely perched on, metres per second squared. */
  slipAccel?: number;
  /** The speed a slip starts at, so it is not defeated by a body pressing into the contact. */
  slipNudge?: number;
  /** How little movement counts as a slip having achieved nothing, metres. */
  slipBlockedM?: number;
  /** How long after a step up a rim is still treated as a plateau rather than a wall, seconds. */
  stepGraceSec?: number;
}

/** Floating-point slack for "did the move arrive". */
const EPSILON = 1e-9;

export class SweptStep {
  /**
   * Whether the world refused a horizontal move this tick.
   *
   * Read by anything that wants to tell a body that is stuck from one that is going in circles —
   * `StallEscape` is the obvious consumer, and the two were written for each other.
   */
  moveRefused = false;
  /** Seconds since the last successful step up. See `stepGraceSec`. */
  sinceStepUp = Infinity;

  private readonly stepHeight: number;
  private readonly grazeM: number;
  private readonly propFootprintM: number;
  private readonly facetClearM: number;
  private readonly riseSlackM: number;
  private readonly wallNormalMin: number;
  private readonly slipAccel: number;
  private readonly slipNudge: number;
  private readonly slipBlockedM: number;
  private readonly stepGraceSec: number;

  /**
   * Open a tick: forget last tick's refusal and age the step-up grace.
   *
   * **Both counters live here or they live in two places**, which is exactly the bug this seam
   * shipped with for one commit: the consumer kept its own `sinceStepUp`, advanced it, and the
   * engine's stayed pinned at whatever the last step set — so the grace below never expired and a
   * body perched on a rim was told, for ever, that it had just climbed onto a plateau.
   */
  beginTick(dt: number): void {
    this.moveRefused = false;
    this.sinceStepUp += dt;
  }

  /**
   * Scratch for the prop query, claimed once and sized for the worst measured.
   *
   * A dense cluster of geometry can return dozens of candidates — measured at 102 in one query on
   * a wide bank — and a buffer smaller than that silently drops whatever does not fit, dropping
   * the one post among them exactly as often as it keeps it.
   */
  private readonly propProbe = new Int32Array(256);

  constructor(options: SweptStepOptions = {}) {
    this.stepHeight = options.stepHeight ?? 0.35;
    this.grazeM = options.grazeM ?? 0.12;
    this.propFootprintM = options.propFootprintM ?? 1.2;
    this.facetClearM = options.facetClearM ?? 0.3;
    this.riseSlackM = options.riseSlackM ?? 0.02;
    this.wallNormalMin = options.wallNormalMin ?? 0.2;
    this.slipAccel = options.slipAccel ?? 18;
    this.slipNudge = options.slipNudge ?? 3.5;
    this.slipBlockedM = options.slipBlockedM ?? 0.002;
    this.stepGraceSec = options.stepGraceSec ?? 0.1;
  }

  slipOffContact(body: Body, state: SweptState, dt: number, colliders: ColliderSet): boolean {
    let nx = body.contactNormalX ?? 0;
    let nz = body.contactNormalZ ?? 0;
    let len = Math.sqrt(nx * nx + nz * nz);
    if (len <= this.wallNormalMin) {
      /* What the character just climbed onto looks exactly like a rim until they settle on it.
         See `this.stepGraceSec` for the plateau this turned into a wall. */
      if (this.sinceStepUp < this.stepGraceSec) return true;
      /*
       * **A perch on a rim has a contact normal pointing straight up, and this method used to
       * give up on exactly that case.**
       *
       * The engine refuses to call a contact support unless the body's own column is over the
       * thing holding it, which is right: a foot's corner on a nine-centimetre sliver of a slab
       * is a tip-over, not standing. But the normal it reports is the way out of the *clamp*,
       * and for a downward clamp on a walkable plane that is up. So the horizontal length was
       * zero, this returned, and nothing at all pushed the body off — while `grounded` stayed
       * false, so no jump, and the blocked fall re-clamped the vertical speed every tick, so
       * gravity never accumulated either.
       *
       * Measured at the reporter's own coordinates on a courtyard pillar: **five seconds of held
       * forward input, zero metres of descent**, the character standing in clear air on the corner
       * of a column. Sliding along the rim did not help, because the rim runs the length of the
       * slab: the only direction that ends it is off the edge, and the sweep is the only thing
       * that saw which edge. It reports it now.
       */
      nx = body.contactRimX ?? 0;
      nz = body.contactRimZ ?? 0;
      len = Math.sqrt(nx * nx + nz * nz);
      /* No normal and no rim: the sweep has named no way off, so there is none to try and
         nothing here can say whether one exists. Left exactly as it was found. */
      if (len <= this.wallNormalMin) return true;
    }
    const ux = nx / len;
    const uz = nz / len;
    /*
     * **Whatever is pushing into the contact is dropped first, and without this the rest of
     * this method loses an argument it cannot win.**
     *
     * A graze grants no grounding, so the drive that runs before this is the *air* one, and
     * `airAccel` in its Quake form is `airAccel x wishSpeed` — 1.4 times a wish of twenty is
     * 28 m/s² pointed straight into the face. `this.slipAccel` is 6, and small on purpose:
     * the note above says a bigger number reads as being shoved by the scenery. So holding
     * forward beat the slip roughly five to one, and it beat gravity too, because a blocked
     * fall re-clamps `velY` to the distance the sweep allowed on *every* tick — the pull never
     * accumulates while the contact keeps refusing it.
     *
     * The result was a character standing in clear air against the flank or the underside of a
     * slab, motionless for as long as the key was held, with nothing drawn under them.
     * Reported from the courtyard lamps, from a pillar row and from the ribbon's own edge, and
     * called what it is: *"like glued while I keep press W."*
     *
     * You cannot accelerate into something you are already touching, so the component of the
     * horizontal velocity pointing into the contact is removed and the tangential part is
     * kept — the same clip a solid surface would apply, applied to a contact solid enough to
     * stop a fall. Sliding *along* the flank survives untouched, which is what keeps a character
     * brushing a wall at speed from being stopped by it. What does not survive is holding
     * yourself onto it.
     */
    /*
     * **The nudge goes first, because it is also the only honest test of the premise.**
     *
     * Everything below this takes something away from the player — the drive that pushes
     * into the contact — on the understanding that they are hanging off an edge and about to
     * come off it. A body that the world refuses to move is not hanging off anything, and
     * charging it the clip anyway is how a character standing between two lamp bases ends up
     * unable to walk out *and* unable to jump. So: try to leave first, and only pay for the
     * slide if the slide happened.
     */
    const step = this.slipNudge * dt;
    const slidX = moveAxis(body, colliders, AXIS_X, ux * step);
    const slidZ = moveAxis(body, colliders, AXIS_Z, uz * step);
    if (Math.abs(slidX) + Math.abs(slidZ) < this.slipBlockedM) return false;

    const into = state.velX * ux + state.velZ * uz;
    if (into < 0) {
      state.velX -= ux * into;
      state.velZ -= uz * into;
    }
    state.velX += ux * this.slipAccel * dt;
    state.velZ += uz * this.slipAccel * dt;
    return true;
  }

  moveHorizontal(
    body: Body,
    state: SweptState,
    axis: Axis,
    want: number,
    colliders: ColliderSet,
    supported: boolean,
    world: WorldOpinion,
  ): void {
    const before = axis === AXIS_X ? body.x : body.z;
    const moved = moveAxis(body, colliders, axis, want);
    /*
     * A deck's *edge* is as solid as a wall, and no box says so.
     *
     * A ridden deck may carry no collision boxes at all — deliberately, and the reasoning
     * is sound: a world-axis box around a banked cross-section has a
     * flat lid at its highest corner, which is floor where nothing is drawn and a wall
     * where the next slab's lid rises above the character's feet. So a ribbon is solid from
     * *above* only, because that is the one question `GroundSurface` answers.
     *
     * Which leaves every deck edge as scenery. Where a split's branch crosses the main
     * line it stands a little higher, and a character on the lower deck walks straight into
     * the side of the upper slab and keeps going — reported as passing through the link
     * outright, as though the element were not solid. The same hole is under every raised
     * lip and every raised platform.
     *
     * So the surface itself is asked, once per axis, whether the place the body just moved
     * into has a *floor standing in it*. Three bands, and the boundaries are the movement
     * model's own numbers rather than new ones:
     *
     * - a top at or below `feet + stepHeight` is a step, and `tryStepUp` owns it;
     * - a top above the character's head is a flyover, and they pass underneath;
     * - anything between is a face they cannot climb, so it stops them.
     *
     * Cheap and safe on a bank, which was the worry: this tests a single tick's
     * displacement, and even at top speed across the steepest bank the generator authors
     * that is under 0.4 m of rise — inside `stepHeight`, so a tube cannot wall itself off.
     *
     * Grounded characters only. The check predates the deck being solid; for a body in the
     * air the hulls are the honest answer now, and the surface prediction was stopping
     * jumps in open air a stride short of the drawn face — measured on day 9 as 13 m/s
     * dying mid-flight over a gap, the character hanging where nothing is drawn.
     */
    if (supported && world.blocked(axis, before)) {
      if (axis === AXIS_X) body.x = before;
      else body.z = before;
      if (axis === AXIS_X) state.velX = 0;
      else state.velZ = 0;
      // The world pushed back. `unwedge` is the only reader, and it is the difference
      // between a character who is stuck and one who is merely going in circles.
      this.moveRefused = true;
      return;
    }
    if (Math.abs(moved - want) <= EPSILON) return;
    if (supported && this.tryStepUp(body, axis, want - moved, colliders, world)) {
      return;
    }
    this.moveRefused = true;
    /*
     * A graze, mid-air, is not a wall either — there is simply nothing to lift
     * off of to find out. `tryStepUp` is a grounded character's tool; a body
     * genuinely clear of the deck (`supported` false here means exactly that —
     * not this tick's jump, not coyote, no floor under it at all) has no floor
     * to step up onto, but a facet seam is still only a few centimetres, and
     * mid-flight is exactly where one is most likely to be clipped in passing
     * rather than run into. Measured on a low hop through a hairpin: a 1 cm
     * shortfall — `moved` still 94% of `want` — killed a character's whole speed
     * on the axis it grazed, well clear of the deck by the character's own
     * reckoning. A genuine wall does not pass this: hit one square and `moved`
     * is near zero regardless of how small `want` was that tick, so the ratio
     * test still tells the two apart at a walking pace, not only a sprint.
     */
    if (
      !supported &&
      Math.abs(want - moved) <= this.grazeM &&
      Math.abs(moved) >= Math.abs(want) * 0.5
    ) {
      return;
    }
    /*
     * On a vouched deck, a rise that the surface itself vouches for is worth a
     * second attempt at the same sweep, lifted to meet it. The requirement is
     * that a ridden surface's tilt is followed however extreme — past vertical
     * if the deck says so, which looks wrong and is correct — but only where
     * the surface vouches, never on ordinary geometry. A banked span wide enough to
     * matter builds a hull tall enough that a landing a few centimetres to
     * the wrong side of its own facet seam can refuse *both* axes outright —
     * not a graze, a flat `moved = 0`, on a column the smooth curve answers
     * as perfectly ordinary track. `tryStepUp` already tried this with only
     * `stepHeight` of lift and failed; this tries again with however much
     * the deck's own rise actually calls for, uncapped.
     *
     * The retry is a real sweep, not an assumption — `moveAxis` decides,
     * exactly as it did the first time, and only a *clean* result (the full
     * remaining distance, not merely something nonzero) counts. That is what
     * keeps this from being a licence to walk through anything the surface
     * merely doesn't object to: a wall built across the deck — as opposed to
     * being part of it — has nothing under it to lift into, so a flat deck's
     * zero-rise retry meets exactly the same wall a second time and this
     * falls through to the ordinary response below, same as it always did.
     * `velocity.test.ts`'s own deliberate wall caught the difference between
     * "trust the answer" and "retry the sweep": the surface still called the
     * column ahead ordinary track (a synthetic wall carries no surface
     * opinion at all), and trusting that outright walked a character straight
     * through it.
     *
     * `world.vouches()` is the gate that keeps this off ordinary geometry: a
     * terrace, a raised lip, a courtyard are all real, intended walls the hull
     * is the only honest answer for, and none of them are ridden deck.
     *
     * Not gated on `supported` here — `surfaceRiseTo` already carries its own,
     * tighter version of that question (ridden, or falling and within a snap
     * of the deck below), which is what actually matters for a low hop that
     * clips the same tall wedge without ever losing its claim to the ground
     * underneath it. A real jump over open water is nowhere near a surface
     * answer either way, so it never reaches here regardless.
     *
     * A lift left short of what it promised is put back exactly as it found
     * it, along with the axis — nothing here is allowed to leave the body
     * somewhere the ordinary sweep never actually cleared. Descents are left
     * alone, the same "rises only" rule `preLift` follows: settling onto a
     * lower column is an ordinary fall `resolveSurface` already owns.
     */
    if (world.vouches()) {
      const targetX = axis === AXIS_X ? before + want : body.x;
      const targetZ = axis === AXIS_Z ? before + want : body.z;
      const rise = world.riseTo(targetX, targetZ, body.y - body.hy);
      if (rise !== null && !this.blockedByProp(body, axis, before, want, colliders)) {
        const savedY = body.y;
        /*
         * A near-flat or descending target still earns a *small* exploratory
         * lift, capped at facet scale rather than left at the bare rise. The
         * deck's own hull sits a `RIBBON_COLLIDER_GIVE_M` give under the
         * curve and a `MAX_FACET_SLIP_M` ridge is normal at any bank — the
         * ordinary sub-step budget nothing here changes — so a target the
         * surface calls level can still be blocked by a genuine facet seam a
         * few centimetres tall the smooth curve was never going to report as
         * a rise. `this.facetClearM` is comfortably past both those tolerances
         * and nowhere near tall enough to matter for a real wall — the same
         * synthetic 12 m wall this whole retry exists to still refuse.
         */
        const wanted =
          rise > this.riseSlackM
            ? rise - this.riseSlackM
            : rise > -this.facetClearM
              ? this.facetClearM
              : 0;
        if (wanted > 0) moveAxis(body, colliders, AXIS_Y, wanted);
        const remaining = want - moved;
        const along = moveAxis(body, colliders, axis, remaining);
        if (Math.abs(along - remaining) <= EPSILON) return;
        // The deck's own rise did not clear it either — put both back.
        if (axis === AXIS_X) body.x = before + moved;
        else body.z = before + moved;
        body.y = savedY;
      }
    }
    /*
     * A genuine wall. The move is refused — but the *velocity* is redirected along the
     * face rather than deleted on this axis.
     *
     * Zeroing the axis is what turned every corner in the world into a trap. Movement
     * resolves X and Z separately, so at any corner, edge or obliquely-met face both
     * axes refuse in the same tick and both get zeroed: the body ends the tick pressed
     * against the geometry with no speed, and next tick it asks for the same refused
     * move again. Reported from two unrelated places: a character trapped with no jump
     * available to it, able only to go back and fall.
     *
     * Sliding fixes it without weakening anything, because it removes only the
     * component going *into* the surface. Met square on, the contact normal is the
     * direction of travel and the projection takes the whole of it — a wall across the
     * way costs exactly what it always did, which `edgeEscape.test.ts` guards with a
     * twelve-metre slab. Met at an angle, the tangential part survives and the character
     * skims along it, which is both what a skater would do and the escape route that
     * was missing.
     *
     * Walls only, by the contact's own normal: a near-horizontal contact is a floor or
     * a ceiling, and redirecting horizontal motion along one of those would let a body
     * climb. `resolveSurface` owns those.
     */
    const nx = body.contactNormalX ?? 0;
    const nz = body.contactNormalZ ?? 0;
    const acrossLen = Math.sqrt(nx * nx + nz * nz);
    if (acrossLen > this.wallNormalMin) {
      const ux = nx / acrossLen;
      const uz = nz / acrossLen;
      const into = state.velX * ux + state.velZ * uz;
      // Negative means travelling into the face; a positive dot is already leaving it.
      if (into < 0) {
        state.velX -= ux * into;
        state.velZ -= uz * into;
      }
      return;
    }
    if (axis === AXIS_X) state.velX = 0;
    else state.velZ = 0;
  }

  /**
   * Is a standalone prop — not the deck's own wedge geometry — actually
   * standing anywhere along this axis's swept move? The one distinction the
   * on-Way trust in `moveHorizontal` cannot make from the smooth surface
   * alone: the ground query answers for the deck itself, so a lamp, a
   * brazier's stand or an arch post planted exactly where the deck reads
   * clear is invisible to it. Real obstacles still have to collide — a lamp
   * or any other placed item in the path must still register an impact — so
   * before the deck's own hull is overruled, this asks whether anything
   * narrow enough to be a *post*
   * rather than a *slab* occupies the path. The deck's own wedges span most
   * of a cross-section by construction, metres in at least one horizontal
   * direction; a lamp post is fourteen centimetres. `this.propFootprintM` sits
   * comfortably between the two, so the width test alone tells them apart.
   *
   * The box spans `before` to the full `want`, not only the endpoint —
   * `moveAxis` already stopped short of a real prop, so the prop itself sits
   * somewhere inside that span, never exactly on the far end this checks
   * against. A box at the endpoint alone missed it outright: placed items
   * such as lamps were ignored and a body passed straight through them.
   *
   * A dense cluster of wedges nearby can return dozens of candidates —
   * measured at 102 in one query on a wide bank — well past the buffer this
   * used to carry, which silently dropped whatever did not fit and dropped
   * the one lamp among them exactly as often as it kept it. `propProbe` is
   * sized for the worst of what was actually measured, with headroom.
   */

  private blockedByProp(
    body: Body,
    axis: Axis,
    before: number,
    want: number,
    colliders: ColliderSet,
  ): boolean {
    const half = body.hx + 0.05;
    const lo = Math.min(before, before + want) - half;
    const hi = Math.max(before, before + want) + half;
    const minX = axis === AXIS_X ? lo : body.x - half;
    const maxX = axis === AXIS_X ? hi : body.x + half;
    const minZ = axis === AXIS_Z ? lo : body.z - half;
    const maxZ = axis === AXIS_Z ? hi : body.z + half;
    const q = this.propProbe;
    const n = colliders.query(minX, body.y - body.hy, minZ, maxX, body.y + body.hy, maxZ, q);
    const data = colliders.data;
    for (let k = 0; k < n; k++) {
      const o = q[k] * 6;
      const width = data[o + 3] - data[o];
      const depth = data[o + 5] - data[o + 2];
      if (width < this.propFootprintM && depth < this.propFootprintM) return true;
    }
    return false;
  }

  /**
   * Is there a walkable face standing in the body's current column that the character can
   * neither step onto nor pass under? See `moveHorizontal` for why this exists.
   *
   * Uses its own hit rather than `this.hit`, which `resolveSurface` owns for the whole
   * tick and reads after both axes have moved.
   */

  private tryStepUp(
    body: Body,
    axis: Axis,
    remaining: number,
    colliders: ColliderSet,
    world: WorldOpinion,
  ): boolean {
    const savedX = body.x;
    const savedY = body.y;
    const savedZ = body.z;

    /*
     * The lift is resolved, and it can be refused — but by then it never is by
     * the floor itself: a body inside the deck it stands on is put back on top
     * of it in `integrate`, before anything sweeps. What can still refuse a lift
     * here is a genuine ceiling, and a character under one should not be stepping.
     */
    /*
     * The budget is `stepHeight`, unless the deck being ridden itself vouches
     * for more — see `surfaceRiseTo`.
     *
     * `stepHeight` is sized for a literal kerb, and it is the wrong number
     * once the axis being swept stops agreeing with the road: `moveHorizontal`
     * resolves X and Z one at a time, so a corner banked steeply enough asks a
     * *pure*-X (or pure-Z) sweep to climb the bank directly whenever the road's
     * own tangent runs mostly along the other axis — a real slope, just not one
     * either isolated axis meets at its own angle. Measured on a hairpin banked
     * 25°: the combined move asked `preLift` for 20 cm and got it, but the
     * following pure-X sweep alone met a wall a full `stepHeight` could not
     * clear, and the character's whole speed on that axis died on a bank the same
     * tick's own pre-lift had already vouched for. Reported on the same class of
     * junction: a body impacting the deck itself while sliding, and sometimes
     * pushed off the track.
     *
     * Only the ridden deck's own rise can raise the budget — `surfaceRiseTo`
     * is the same same-deck, same-normal check `preLift` trusts, so this can
     * still never climb a railing or a prop standing beside the track: ask it
     * about a point under either and it answers with the deck's own gentle
     * rise, not the thing standing on it, and the budget stays at `stepHeight`.
     * What actually stops a step, lift or not, is still `moveAxis`'s own sweep
     * a few lines down — this only ever raises how far that sweep is allowed
     * to *try*.
     */
    const targetX = axis === AXIS_X ? body.x + remaining : body.x;
    const targetZ = axis === AXIS_Z ? body.z + remaining : body.z;
    const surfaceRise = world.riseTo(targetX, targetZ, body.y - body.hy);
    const liftBudget =
      surfaceRise !== null && surfaceRise + this.riseSlackM > this.stepHeight
        ? surfaceRise + this.riseSlackM
        : this.stepHeight;
    const lifted = moveAxis(body, colliders, AXIS_Y, liftBudget);
    const along = moveAxis(body, colliders, axis, remaining);
    moveAxis(body, colliders, AXIS_Y, -(lifted + 0.002));

    /*
     * Accepted on the physics alone: it went somewhere, and it climbed no more
     * than the budget it was given. `climbed` is the guard that matters — a
     * railing's bar tops out at `stepHeight × 1.4` precisely so an ordinary
     * step can never mount it, and `liftBudget` only ever exceeds `stepHeight`
     * when the ridden deck itself vouched for the extra, which a railing never
     * does (see above) — so the railing's own margin over `stepHeight` still
     * holds exactly as before.
     *
     * There used to be a third condition here, "the step must land on ground
     * the surface recognises", refusing any landing 0.35–0.95 m above the
     * surface's answer. It guarded against stepping onto collider tops standing
     * proud of the drawn deck — which the twisted spans' hulls really did,
     * before they were split into strips. Now a hull is the drawn slab to
     * within centimetres, so anything a step can physically settle on *is*
     * drawn, standable world — and the refusal's only remaining work was false:
     * the finish terrace and the courtyard lips are drawn boxes a stride above a
     * deck whose surface still answers underneath them, and refusing those
     * turned every mixed-surface seam into a wall. Measured on day 8: a clean
     * step onto the terrace refused, 10.7 m/s killed at the lip, and the last
     * metres of the race crossed at a grind.
     */
    const progressed = Math.abs(along) > 1e-4;
    const climbed = body.y > savedY + 1e-4 && body.y <= savedY + liftBudget + 1e-3;
    if (progressed && climbed) {
      /* What the character just climbed onto reads as a rim until they settle on it, and the
         rim escape would shove them straight back off. See `this.stepGraceSec`. */
      this.sinceStepUp = 0;
      return true;
    }

    body.x = savedX;
    body.y = savedY;
    body.z = savedZ;
    return false;
  }

  /**
   * Skim a short break in the ground at speed instead of dipping into it.
   *
   * A velocity rule, not a collision one: a character at speed should cross a
   * short break without falling, while one walking slowly may not. The reach is
   * `speed × gapCoastTime`, so pace is the gate itself: a sprint clears a seam
   * or a broken lip, a walk gets centimetres and still falls at an edge.
   * Designed jump-holes stay jumps — they are several times longer than any
   * reach this grants, and the far side must be drawn, walkable deck at run
   * height for the skim to hold.
   */
}
