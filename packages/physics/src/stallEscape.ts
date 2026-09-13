import { AXIS_X, AXIS_Y, AXIS_Z, moveAxis } from './collide/index.ts';
import type { Axis, Body } from './collide/index.ts';
import type { ColliderSet } from './colliderSet.ts';

/**
 * A kinematic body that has stopped making progress: find the cheapest way out, or say it is
 * sealed.
 *
 * **Nothing else in this engine does this, and every rule in it was paid for in a shipping game.**
 * A character controller resolves a move against geometry; it has no opinion about a body that has
 * been asking to move for half a second and going nowhere. That gap is where players get stuck,
 * and the cases are specific enough that a consumer meeting them for the first time will get them
 * wrong in the same order everybody does:
 *
 * - a lamp base that arrests a fall on a contact no rule calls support, so the body is *grounded*
 *   and cannot jump;
 * - a notch with a ceiling a hand's width overhead, where every jump lifts three centimetres and
 *   drops back — so a per-tick displacement test never arms, while the body sits at the same
 *   coordinates for as long as the key is held;
 * - a deck edge that carries **no collider at all**, refused from a ground query alone, so a
 *   horizontal probe reports clear air and taking it walks the body into a slab;
 * - an analytic deck that lifts a body back every tick it is pushed down, which with a collider
 *   set that reports clear air below is a treadmill neither system is wrong about;
 * - two columns a body will never fit between, where a held input undoes every nudge — a player
 *   who was never stuck, and who must not be killed for pressing into a wall;
 * - and a player merely *leaning* on scenery, who is not stuck at all and for whom being carried
 *   sideways at a fixed rate with the controls doing nothing reads as the game shoving them.
 *
 * **Sealed is reported, never acted on.** This says there is nowhere to put the body; what that
 * costs a player is the consumer's decision, and a capability that killed a character would be
 * making a game's.
 */

/** Nothing happened: the body is getting somewhere, is not asking, or can jump out. */
/**
 * A vector's length, and **`Math.sqrt` rather than `Math.hypot`**.
 *
 * ECMAScript specifies `sqrt` exactly — it is one of the two operations it pins to IEEE-754 — and
 * leaves `hypot` to the implementation, so two engines may disagree by an ulp. A solver whose
 * replays and ghosts have to match cannot spend that, and `scripts/determinism.test.mjs` refuses it
 * by name.
 *
 * What `hypot` buys and this gives up is intermediate overflow at magnitudes near `1e154` and
 * underflow near `1e-162`. These are metres.
 */
function length(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export const ESCAPE_IDLE = 0;
/** The body was pushed along `axis`/`sign`, through the sweep, so geometry still decided. */
export const ESCAPE_PUSHED = 1;
/** Nothing had room, so the body was eased upward by hand. */
export const ESCAPE_EASED = 2;
/** No room in any of the six directions, and the budget is spent. The consumer decides. */
export const ESCAPE_SEALED = 3;

export type EscapeResult = 0 | 1 | 2 | 3;

/**
 * A world's own veto over a direction the collider set says is clear.
 *
 * **Declared structurally, so nothing is imported in either direction** — the same shape
 * `GroundProbe` uses on `CharacterController`, and for the same reason: a consumer with an
 * analytic surface has a second authority about where a body may be, and a probe that consulted
 * only the colliders would hand back directions the ordinary move refuses.
 *
 * Absent means the collider set is the whole world, which is every consumer that has not asked.
 */
export interface EscapeVeto {
  /**
   * Would the world refuse a body that had moved to `reached` along a horizontal `axis`?
   *
   * `reached` is the coordinate on that axis the probe arrived at.
   */
  horizontal(axis: Axis, reached: number): boolean;
  /**
   * Would the world undo a downward escape from where the body is now?
   *
   * Down only. A body *above* its surface falling is the ordinary case and a surface has no
   * opinion about it.
   */
  below(): boolean;
}

/** What the consumer knows about this tick that the geometry cannot say. */
export interface StallInput {
  /** Is the body being asked to move or jump at all? Standing still is not being stuck. */
  trying: boolean;
  /**
   * Did the world refuse this tick's move?
   *
   * Without it the arming window fits a body turning on the spot or wiggling in open ground, and
   * both were being pushed and then killed for it.
   */
  refused: boolean;
  /** Is there something under the feet? */
  grounded: boolean;
  /**
   * Was the contact that stopped the fall genuinely *support*, rather than a graze against a side,
   * an edge or an underside?
   *
   * Two different facts, and conflating them is the courtyard-lamp trap: a body with no support gets
   * no jump however solid the thing under it looks.
   */
  supported: boolean;
}

export interface StallEscapeOptions {
  /**
   * How far from where the window opened counts as getting somewhere, metres.
   *
   * **A question about net progress over a window, not about this tick's displacement.** A body
   * jitters in a notch — thirty times a per-tick threshold — while sitting at the same coordinates
   * for as long as the key is held. Displacement is not progress, and a trap that shakes you is
   * still a trap.
   */
  progressM?: number;
  /** How many ticks of going nowhere before the window is full. */
  stalledTicks?: number;
  /** How many of those the world must have been pushing back for. */
  refusedTicks?: number;
  /** How far each nudge moves, metres. */
  pushM?: number;
  /** How far the whole escape may push before the body is called sealed, metres. */
  budgetM?: number;
  /** How far each of the six probes reaches, metres. */
  probeM?: number;
  /** How much clear air overhead counts as being able to jump out, metres. */
  headroomM?: number;
  /**
   * How much a vertical direction's room is worth against a horizontal one's.
   *
   * Under one, and by a margin. Being eased *upward* out of scenery is the most visible possible
   * correction — it reads as levitating. Slipping sideways off the thing you are caught on reads
   * as slipping off it, which is what actually happened. Up stays available, because a pocket
   * sometimes leaves nothing else.
   */
  verticalBias?: number;
}

export class StallEscape {
  /** Which axis the last push took, and which way along it. Read after `ESCAPE_PUSHED`. */
  axis: Axis = AXIS_Y;
  sign = 1;

  private readonly progressM: number;
  private readonly stalledTicks: number;
  private readonly refusedTicksNeeded: number;
  private readonly pushM: number;
  private readonly budgetM: number;
  private readonly probeM: number;
  private readonly headroomM: number;
  private readonly verticalBias: number;

  private stalled = 0;
  private refused = 0;
  private spent = 0;
  private anchorX = 0;
  private anchorY = 0;
  private anchorZ = 0;
  private anchored = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;

  constructor(options: StallEscapeOptions = {}) {
    this.progressM = options.progressM ?? 0.5;
    this.stalledTicks = options.stalledTicks ?? 30;
    this.refusedTicksNeeded = options.refusedTicks ?? 20;
    this.pushM = options.pushM ?? 0.04;
    this.budgetM = options.budgetM ?? 4;
    this.probeM = options.probeM ?? 0.4;
    this.headroomM = options.headroomM ?? 0.5;
    this.verticalBias = options.verticalBias ?? 0.35;
  }

  /** Back to watching, for a respawn or a restart. */
  reset(): void {
    this.stalled = 0;
    this.refused = 0;
    this.spent = 0;
    this.anchored = false;
  }

  /**
   * Watch this tick, and act where the body has genuinely stopped getting anywhere.
   *
   * Call it last in a tick, after the move has been resolved: it reads where the body ended up.
   */
  step(body: Body, colliders: ColliderSet, input: StallInput, veto?: EscapeVeto): EscapeResult {
    const escaping = this.spent > 0;

    if (!this.anchored) {
      this.anchorX = body.x;
      this.anchorY = body.y;
      this.anchorZ = body.z;
      this.lastX = body.x;
      this.lastY = body.y;
      this.lastZ = body.z;
      this.anchored = true;
    }

    if (!escaping) {
      const fromAnchor = length(
        body.x - this.anchorX,
        body.y - this.anchorY,
        body.z - this.anchorZ,
      );
      if (!input.trying || fromAnchor > this.progressM) return this.standDown(body);
      if (input.refused) this.refused++;
      if (++this.stalled < this.stalledTicks) {
        this.remember(body);
        return ESCAPE_IDLE;
      }
      /* And the world was pushing back for most of it. See `refused`. */
      if (this.refused < this.refusedTicksNeeded) return this.standDown(body);
    }

    /*
     * Under way again — by more than the push itself. An escape clears any small threshold by
     * construction, so measuring against one would have it read its own nudge as success and
     * stand down on the tick after it starts.
     */
    const moved = length(body.x - this.lastX, body.y - this.lastY, body.z - this.lastZ);
    this.remember(body);
    if (escaping && moved > this.pushM * 2) {
      this.stalled = 0;
      this.refused = 0;
      this.spent = 0;
      return ESCAPE_IDLE;
    }

    /*
     * **A body that can jump out is not stuck**, and asking here rather than at the top means the
     * probe is paid for only on the rare tick where something is about to be pushed.
     */
    if (this.canJumpOut(body, colliders, input)) return this.standDown(body);

    if (this.spent >= this.budgetM) {
      this.stalled = 0;
      this.refused = 0;
      this.spent = 0;
      /*
       * **Asked without the veto, because this question is a different one.** Above, the veto
       * answers *which way out is worth taking*; here the answer decides whether the consumer is
       * told there is nowhere to put the body, and a direction that exists but gets undone is not
       * the same thing as no direction at all. Conflating them turned a body wedged under a deck,
       * which had real room below it, into one reported as sealed for holding forward.
       */
      return this.bestEscape(body, colliders, undefined) <= this.pushM
        ? ESCAPE_SEALED
        : ESCAPE_IDLE;
    }

    const room = this.bestEscape(body, colliders, veto);
    this.spent += this.pushM;
    if (room <= this.pushM) {
      /*
       * Genuinely enclosed — no direction has room for even one push. The vertical ease by hand is
       * the only move left, and it is what this whole mechanism was originally written for: a
       * pocket at an intersection that no single axis can retrace.
       */
      body.y += this.pushM;
      this.remember(body);
      return ESCAPE_EASED;
    }

    /*
     * Otherwise take the freest direction, **through the sweep** so solid geometry still decides.
     *
     * Which is the whole point: an earlier version *bailed* whenever any direction had room, on
     * the reasoning that a body with room is not wedged — true, and beside the point. Both of the
     * traps this exists for had two free directions the entire time; what neither had was a way
     * for the *consumer's inputs* to reach one, because holding forward asks for the direction
     * that is refused and a dead stop asks for nothing at all. A body with somewhere to go and no
     * way to get there is stuck, and the sum over six probes cannot tell the difference.
     */
    moveAxis(body, colliders, this.axis, this.sign * this.pushM);
    this.remember(body);
    return ESCAPE_PUSHED;
  }

  /** Clear the window and re-anchor where the body is now. */
  private standDown(body: Body): EscapeResult {
    this.stalled = 0;
    this.refused = 0;
    this.spent = 0;
    this.anchorX = body.x;
    this.anchorY = body.y;
    this.anchorZ = body.z;
    this.remember(body);
    return ESCAPE_IDLE;
  }

  private remember(body: Body): void {
    this.lastX = body.x;
    this.lastY = body.y;
    this.lastZ = body.z;
  }

  /**
   * Is the body standing on something, with room over its head to get off it?
   *
   * The one question that separates a trap from a player leaning on scenery. **Grounded** and
   * **supported** are two different facts; **headroom** is what the notch lacked.
   *
   * Probed through the sweep rather than assumed, and the body is put back: a question may not
   * move anything.
   */
  private canJumpOut(body: Body, colliders: ColliderSet, input: StallInput): boolean {
    if (!input.grounded || !input.supported) return false;
    const wasY = body.y;
    const room = moveAxis(body, colliders, AXIS_Y, this.headroomM);
    body.y = wasY;
    return room >= this.headroomM;
  }

  /**
   * The freest of the six axis directions, in metres of room. Writes the winner into
   * `axis`/`sign`.
   *
   * Every probe is undone before the next: a question may not move anything.
   */
  private bestEscape(body: Body, colliders: ColliderSet, veto: EscapeVeto | undefined): number {
    const x = body.x;
    const y = body.y;
    const z = body.z;
    let bestRoom = 0;
    let bestScore = 0;
    this.axis = AXIS_Y;
    this.sign = 1;

    for (let i = 0; i < 6; i++) {
      const axis: Axis = i < 2 ? AXIS_X : i < 4 ? AXIS_Y : AXIS_Z;
      const sign = i % 2 === 0 ? 1 : -1;
      const room = Math.abs(moveAxis(body, colliders, axis, sign * this.probeM));
      const reached = axis === AXIS_X ? body.x : axis === AXIS_Z ? body.z : 0;
      body.x = x;
      body.y = y;
      body.z = z;

      if (
        veto !== undefined &&
        (axis === AXIS_X || axis === AXIS_Z) &&
        room > this.pushM &&
        veto.horizontal(axis, reached)
      ) {
        continue;
      }
      if (veto !== undefined && axis === AXIS_Y && sign < 0 && veto.below()) continue;

      const score = axis === AXIS_Y ? room * this.verticalBias : room;
      if (score <= bestScore) continue;
      bestScore = score;
      bestRoom = room;
      this.axis = axis;
      this.sign = sign;
    }
    return bestRoom;
  }
}
