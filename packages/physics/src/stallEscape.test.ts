import { beforeEach, describe, expect, it } from 'vitest';

import { AXIS_X, AXIS_Y, AXIS_Z } from './collide/index.ts';
import type { Axis, Body } from './collide/index.ts';
import { ColliderSet, boxCollider } from './colliderSet.ts';
import {
  ESCAPE_EASED,
  ESCAPE_IDLE,
  ESCAPE_PUSHED,
  ESCAPE_SEALED,
  StallEscape,
} from './stallEscape.ts';
import type { EscapeVeto, StallInput } from './stallEscape.ts';

/**
 * A kinematic body that has stopped making progress.
 *
 * **Every case here was paid for in a shipping game**, which is why this is a capability rather
 * than a snippet: a courtyard lamp that arrested a fall on a contact no rule calls support, a deck
 * notch with a ceiling a hand's width overhead, a ribbon that lifted a body back every tick it was
 * pushed down, two columns a body will never fit between, and an auto-kick that made leaning on
 * scenery feel like being shoved.
 */

function body(x = 0, y = 0, z = 0): Body {
  return { x, y, z, hx: 0.35, hy: 0.85, hz: 0.35 };
}

/** Held, trying to move, and the world refusing every tick — the arming condition. */
function pressing(over: Partial<StallInput> = {}): StallInput {
  return { trying: true, refused: true, grounded: false, supported: false, ...over };
}

const NOTHING = new ColliderSet([]);

/** No veto: the collider set is the whole world, which is every consumer that has not asked. */
const OPEN: EscapeVeto = { horizontal: () => false, below: () => false };

/** How many ticks of being refused it takes before anything happens. */
const ARMS_AT = 30;

function press(
  escape: StallEscape,
  b: Body,
  colliders: ColliderSet,
  ticks: number,
  input = pressing(),
  veto = OPEN,
): number[] {
  const seen: number[] = [];
  for (let t = 0; t < ticks; t++) seen.push(escape.step(b, colliders, input, veto));
  return seen;
}

describe('arming', () => {
  let escape: StallEscape;
  beforeEach(() => {
    escape = new StallEscape();
  });

  it('does nothing at all to a body that is getting somewhere', () => {
    /*
     * **Progress is a question about a window, not about this tick's displacement.** A body jammed
     * in a notch with a ceiling overhead *jitters* — every jump lifts it three centimetres and
     * drops it back, thirty times a per-tick threshold — while sitting at the same coordinates for
     * as long as the key is held. So the anchor is where the body was when the window opened.
     */
    const b = body();
    for (let t = 0; t < 200; t++) {
      b.x += 0.2;
      expect(escape.step(b, NOTHING, pressing({ refused: false }), OPEN)).toBe(ESCAPE_IDLE);
    }
  });

  it('does nothing to a body that is not asking to move', () => {
    /* Standing still is not being stuck. */
    const b = body();
    const seen = press(escape, b, NOTHING, 200, pressing({ trying: false }));
    expect(seen.every((s) => s === ESCAPE_IDLE)).toBe(true);
  });

  it('does nothing while the world is not pushing back', () => {
    /*
     * Without this the same window fits a body turning on the spot or wiggling in open ground,
     * and both were being pushed and then killed for it.
     */
    const b = body();
    const seen = press(escape, b, NOTHING, 200, pressing({ refused: false }));
    expect(seen.every((s) => s === ESCAPE_IDLE)).toBe(true);
  });

  it('arms on a body held against something that will never open', () => {
    const b = body();
    const seen = press(escape, b, NOTHING, ARMS_AT + 2);
    expect(
      seen.slice(0, ARMS_AT - 1).every((s) => s === ESCAPE_IDLE),
      'quiet until it arms',
    ).toBe(true);
    expect(seen[seen.length - 1]).not.toBe(ESCAPE_IDLE);
  });
});

describe('a body that can jump out is not stuck', () => {
  /*
   * **The reporter's own definition**, and every clause is load-bearing. Standing on something,
   * with support under it, and clear air overhead is a body that can jump out and turn and walk
   * away — and being blocked is what a wall is *for*. Without this it armed on a player leaning on
   * a courtyard column: fifteen consecutive ticks of being carried sideways at a fixed rate with every
   * velocity component at zero and the controls doing nothing. *"This sort of auto-kick, it's
   * annoying."*
   */
  it('stands down where there is headroom and support', () => {
    const escape = new StallEscape();
    const b = body();
    const seen = press(escape, b, NOTHING, 200, pressing({ grounded: true, supported: true }));
    expect(seen.every((s) => s === ESCAPE_IDLE)).toBe(true);
  });

  it('does not stand down where the fall was stopped by something that is not support', () => {
    /*
     * The courtyard lamp: a fall arrested on a corner contact the collision kernel correctly refuses
     * to call support. `grounded` and `supported` are two different facts.
     */
    const escape = new StallEscape();
    const b = body();
    const seen = press(
      escape,
      b,
      NOTHING,
      ARMS_AT + 2,
      pressing({ grounded: true, supported: false }),
    );
    expect(seen[seen.length - 1]).not.toBe(ESCAPE_IDLE);
  });

  it("does not stand down under a ceiling a hand's width up", () => {
    /* The deck notch: a jump lifts three centimetres into a lid and drops back. */
    const escape = new StallEscape();
    const b = body(0, 0, 0);
    /* A lid three centimetres above the head, so a jump lifts into it and drops back. */
    const lid = new ColliderSet([boxCollider(0, b.hy + 0.03 + 0.1, 0, 4, 0.1, 4)]);
    const seen = press(escape, b, lid, ARMS_AT + 2, pressing({ grounded: true, supported: true }));
    expect(seen[seen.length - 1]).not.toBe(ESCAPE_IDLE);
  });
});

describe('choosing a way out', () => {
  it('takes a horizontal direction over a vertical one', () => {
    /*
     * Being eased *upward* out of scenery is the most visible possible correction — it reads as
     * levitating, and two earlier attempts at freeing a stuck body were abandoned for exactly
     * that. Slipping sideways off the thing you are caught on reads as slipping off it, which is
     * what actually happened.
     */
    const escape = new StallEscape();
    const b = body();
    const before = { x: b.x, y: b.y };
    press(escape, b, NOTHING, ARMS_AT + 1);
    expect(Math.abs(b.x - before.x) + Math.abs(b.z), 'moved sideways').toBeGreaterThan(0);
    expect(b.y, 'and not upward').toBeCloseTo(before.y, 9);
  });

  it('refuses a horizontal direction the veto turns down', () => {
    /*
     * **The seam this capability could not exist without.** The escape probes a collider set, and
     * a consumer whose deck edge carries no collider at all — refused from a ground query alone —
     * would have a horizontal probe report clear air and walk the body bodily into a slab. Same
     * authority, same answer: a direction the ordinary move would have refused is not an escape.
     */
    const escape = new StallEscape();
    const b = body();
    const before = b.x;
    const noSideways: EscapeVeto = {
      horizontal: (axis: Axis) => axis === AXIS_X || axis === AXIS_Z,
      below: () => false,
    };
    press(escape, b, NOTHING, ARMS_AT + 1, pressing(), noSideways);
    expect(b.x, 'x refused').toBeCloseTo(before, 9);
    expect(b.y, 'so up is what is left').toBeGreaterThan(0);
  });

  it('refuses a downward direction the veto turns down', () => {
    /*
     * The ribbon treadmill: a body under an analytic deck is lifted back by the surface every
     * tick, before any horizontal move. The collider set knows nothing about that, so it reports
     * clear air below, the escape pushes down, and the surface lifts it straight back — measured
     * as five of six probes reading exactly zero and the sixth reading 0.0739 m downward, taken
     * every tick for five seconds. Neither system is wrong alone; together they are a treadmill.
     */
    const escape = new StallEscape();
    const b = body();
    const walls = new ColliderSet([
      boxCollider(1.2, 0, 0, 0.4, 4, 4),
      boxCollider(-1.2, 0, 0, 0.4, 4, 4),
      boxCollider(0, 0, 1.2, 4, 4, 0.4),
      boxCollider(0, 0, -1.2, 4, 4, 0.4),
      boxCollider(0, 2.4, 0, 4, 0.4, 4),
    ]);
    const noDown: EscapeVeto = { horizontal: () => false, below: () => true };
    const before = b.y;
    press(escape, b, walls, ARMS_AT + 1, pressing(), noDown);
    expect(b.y, 'not pushed down into the deck it is riding').toBeGreaterThanOrEqual(before);
  });

  it('eases upward where nothing has room', () => {
    /* A pocket at an intersection that no single axis can retrace. Up is the only move left. */
    const escape = new StallEscape();
    const b = body();
    /*
     * Every face two centimetres off the body — inside one push, and touching nothing, so the
     * probes report room rather than an overlap the sweep would answer differently about.
     */
    const pocket = new ColliderSet([
      boxCollider(0.77, 0, 0, 0.4, 4, 4),
      boxCollider(-0.77, 0, 0, 0.4, 4, 4),
      boxCollider(0, 0, 0.77, 4, 4, 0.4),
      boxCollider(0, 0, -0.77, 4, 4, 0.4),
      boxCollider(0, 1.27, 0, 4, 0.4, 4),
      boxCollider(0, -1.27, 0, 4, 0.4, 4),
    ]);
    const before = b.y;
    const seen = press(escape, b, pocket, ARMS_AT + 1);
    /*
     * The tick it *acts* on, not the one after. The ease is a raw write, so by the next tick the
     * body has risen into the lid and the probes answer differently — which is the behaviour, and
     * asserting the last tick would be asserting the consequence rather than the decision.
     */
    expect(seen.find((s) => s !== ESCAPE_IDLE)).toBe(ESCAPE_EASED);
    expect(b.y).toBeGreaterThan(before);
  });
});

describe('giving up', () => {
  it('reports sealed rather than acting, once the budget is spent', () => {
    /*
     * **A capability that killed a character would be making a game's decision.** The engine says
     * there is nowhere to put the body; what that costs the player belongs to the consumer.
     *
     * **The body is put back where it was every tick**, which is what a real trap does — a deck
     * that lifts it, a resolution that returns it — and is the only way the budget runs out with
     * nothing having been achieved. The vertical ease is a raw write rather than a sweep, so a
     * body nothing returns simply rises out of a pocket in a hundred ticks, which is the correct
     * behaviour and the reason sealed is a last resort rather than a common answer.
     */
    const escape = new StallEscape();
    const b = body();
    const pocket = new ColliderSet([
      boxCollider(0.77, 0, 0, 0.4, 4, 4),
      boxCollider(-0.77, 0, 0, 0.4, 4, 4),
      boxCollider(0, 0, 0.77, 4, 4, 0.4),
      boxCollider(0, 0, -0.77, 4, 4, 0.4),
      boxCollider(0, 1.27, 0, 4, 0.4, 4),
      boxCollider(0, -1.27, 0, 4, 0.4, 4),
    ]);
    let saw: number = ESCAPE_IDLE;
    for (let t = 0; t < 400 && saw !== ESCAPE_SEALED; t++) {
      saw = escape.step(b, pocket, pressing(), OPEN);
      b.x = 0;
      b.y = 0;
      b.z = 0;
    }
    expect(saw).toBe(ESCAPE_SEALED);
  });

  it('does not report sealed for a body that simply cannot fit somewhere', () => {
    /*
     * Two columns 0.41 m apart against a body 0.70 m wide. The gap refuses them, correctly and
     * for ever, so the escape nudges and the held input puts them straight back: net progress
     * zero, on somebody who was never stuck. *"The player is still dying just because tries weird
     * thing in the game, this should never happen."* Pressing into a wall is allowed to achieve
     * nothing. It is not allowed to be fatal.
     */
    const escape = new StallEscape();
    const b = body();
    const columns = new ColliderSet([
      boxCollider(0, 0, -1.5, 0.2, 4, 0.2),
      boxCollider(0, 0, 1.5, 0.2, 4, 0.2),
    ]);
    for (let t = 0; t < 2000; t++) {
      expect(escape.step(b, columns, pressing(), OPEN)).not.toBe(ESCAPE_SEALED);
    }
  });
});

describe('standing down', () => {
  it('stops once the body is genuinely under way again', () => {
    /*
     * By more than the push itself: an escape clears any small threshold by construction, so
     * measuring against one would have it read its own nudge as success and stand down on the
     * tick after it starts.
     */
    const escape = new StallEscape();
    const b = body();
    press(escape, b, NOTHING, ARMS_AT + 1);

    for (let t = 0; t < 10; t++) {
      b.x += 0.5;
      escape.step(b, NOTHING, pressing({ refused: false }), OPEN);
    }
    expect(escape.step(b, NOTHING, pressing({ refused: false }), OPEN)).toBe(ESCAPE_IDLE);
  });

  it('a reset puts it back where it started', () => {
    const escape = new StallEscape();
    const b = body();
    press(escape, b, NOTHING, ARMS_AT + 1);
    escape.reset();
    expect(escape.step(b, NOTHING, pressing(), OPEN)).toBe(ESCAPE_IDLE);
  });
});

describe('the axis it took', () => {
  it('reports which way it pushed, so a caller can answer for the velocity', () => {
    /*
     * Horizontally the fall is left alone: sliding off an edge should *become* a fall, which is
     * what a player expects when they slip off something. Vertically it has to be zeroed, or a
     * body being eased up out of geometry fights gravity's accumulation on the way. The engine
     * reports the axis and the consumer owns its own velocity.
     */
    const escape = new StallEscape();
    const b = body();
    press(escape, b, NOTHING, ARMS_AT + 1);
    expect(escape.axis === AXIS_X || escape.axis === AXIS_Z).toBe(true);
    expect(escape.sign === 1 || escape.sign === -1).toBe(true);
  });
});

describe("the numbers are the consumer's", () => {
  it('takes how long a stall has to last before anything happens', () => {
    /* Half a second at sixty ticks is this game's answer, not the engine's. */
    const escape = new StallEscape({ stalledTicks: 5, refusedTicks: 3 });
    const b = body();
    const seen = press(escape, b, NOTHING, 8);
    expect(seen[seen.length - 1]).not.toBe(ESCAPE_IDLE);
  });

  it('takes how far counts as getting somewhere', () => {
    const escape = new StallEscape({ progressM: 100 });
    const b = body();
    /* Ordinarily half a metre clears the window; against a hundred, this is still a stall. */
    for (let t = 0; t < 40; t++) {
      b.x += 0.02;
      escape.step(b, NOTHING, pressing(), OPEN);
    }
    expect(escape.step(b, NOTHING, pressing(), OPEN)).toBe(ESCAPE_PUSHED);
  });
});
