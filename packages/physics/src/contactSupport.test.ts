import { describe, expect, test } from 'vitest';
import { AXIS_Y, aabbFromCenter, moveAxis } from './collide/index.ts';
import type { Body } from './collide/index.ts';
import { ColliderSet } from './colliderSet.ts';
import { boxShape } from './shape.ts';

/**
 * **A body standing on a floor is told it is standing on it.**
 *
 * `contactSupport` is the one thing a downward move reports about the world, and every
 * consumer's grounding hangs off it: a body denied it gets no jump, keeps re-clamping
 * its fall, and — in the consumer this was captured in — has the component of its drive
 * that points into the contact dropped so that `slipOffContact` can push it off what it
 * has been told is a rim. So a false *no* does not read as a missing feature, it reads
 * as an invisible wall that a jump gets over, which is exactly how it was reported:
 *
 * > *"when I enter in the fountain area OR after the flowers in the back of columns
 * > lamps, I cannot go back, there is like an invisible wall, if I jump over it works,
 * > the same wall is also in the back borders of the courtyard."*
 *
 * Nothing covered this question before, which is how two separate ways of getting it
 * wrong shipped together. Both are asserted here on the smallest shape that shows them,
 * and both are about the same call: the footprint the column is judged against.
 *
 * The floor is one 20 x 20 m slab topping out at y = 0, and the body is the 0.70 x 1.70
 * of a character standing on it. What varies is only how the floor is *tiled* and what
 * kind of body asks — neither of which a body standing on a flat floor can feel.
 */
describe('a column over a continuous floor is supported', () => {
  const HALF = { hx: 0.35, hy: 0.85, hz: 0.35 };
  /** One slab, and the same slab cut in two along z = 0. Identical geometry. */
  const asOnePiece = new ColliderSet([aabbFromCenter(0, -1, 0, 10, 1, 10)]);
  const asTwoPieces = new ColliderSet([
    aabbFromCenter(0, -1, -5, 10, 1, 5),
    aabbFromCenter(0, -1, 5, 10, 1, 5),
  ]);
  /** A body that carries a volume takes the shape sweep; a bare one takes the AABB path. */
  const SHAPED = { shape: boxShape(HALF.hx, HALF.hy, HALF.hz), ox: 0, oy: 0, oz: 0 };

  const standing = (x: number, z: number, shaped: boolean): Body => {
    const body: Body = { x, y: HALF.hy, z, ...HALF };
    if (shaped) body.parts = [SHAPED];
    return body;
  };

  /** Every column of a 4 m line across the floor, and what the floor said about it. */
  const refusals = (floor: ColliderSet, shaped: boolean): string[] => {
    const refused: string[] = [];
    for (let i = -200; i <= 200; i++) {
      const z = i * 0.01;
      const body = standing(0, z, shaped);
      moveAxis(body, floor, AXIS_Y, -0.02);
      if (body.contactSupport === false) {
        refused.push(
          `z=${z.toFixed(2)} rim=(${(body.contactRimX ?? 0).toFixed(2)}, ` +
            `${(body.contactRimZ ?? 0).toFixed(2)})`,
        );
      }
    }
    return refused;
  };

  /**
   * **The footprint the plain path is judged against was never filled in.**
   *
   * `clampMinX`/`clampMaxX`/`clampMinZ`/`clampMaxZ` were written only where the shape
   * sweep won a clamp, and the downward report reads them whatever path clamped. A body
   * with no volume of its own therefore had its column tested against a zero-area
   * footprint at the world origin: supported at exactly (0, 0), refused everywhere else,
   * with a rim pointing radially away from the origin — (3, 0) reported (1, 0) and
   * (-7.5, 2.25) reported (-0.71, 0.71), which is a compass bearing and not a rim.
   *
   * The comment at the call already stated the rule this broke — *"the plain-AABB path
   * clamps against the move axis's own faces, so a block there is support by
   * construction"* — so the call site had outrun its own comment.
   */
  test('whatever kind of body asks', () => {
    expect(refusals(asOnePiece, false), 'a plain body on one flat slab').toEqual([]);
    expect(refusals(asOnePiece, true), 'a shaped body on one flat slab').toEqual([]);
  });

  /**
   * **Support is a question about the floor, and it was asked of one collider.**
   *
   * Only the obstacle that won the clamp had any say, so where two colliders abut to
   * make one floor, the box *behind* the body can win the clamp while the body's centre
   * is already over the box in front — and the column is outside the winner's footprint
   * by construction. Measured on the pair below: 34 of 401 columns refused, in one band
   * `hz` wide running from the join, every one of them reporting a rim pointing back the
   * way the body came. That one-sidedness is the whole of *"I can enter but I cannot go
   * back"*.
   *
   * In a real world this is not an edge case, it is most of the floor: the terrace
   * against its verge, the verge strips against each other, every deck wedge against the
   * next.
   */
  test('however the floor is tiled', () => {
    expect(refusals(asTwoPieces, false), 'a plain body across a join').toEqual([]);
    expect(refusals(asTwoPieces, true), 'a shaped body across a join').toEqual([]);
  });

  /**
   * The other half of the contract, and the reason the fix cannot be "always say yes":
   * the rim perch this test's subject exists to refuse must still be refused. A body
   * whose column is out over a hole is not standing, however little of its foot is still
   * on the last slab.
   */
  test('and a column over nothing is still not standing', () => {
    // Two slabs with a 4 m gap between them, and a body out over the gap.
    const withGap = new ColliderSet([
      aabbFromCenter(0, -1, -7, 10, 1, 5),
      aabbFromCenter(0, -1, 7, 10, 1, 5),
    ]);
    const body = standing(0, -1.9, true);
    moveAxis(body, withGap, AXIS_Y, -0.02);
    expect(body.contactSupport, 'a body out over a 4 m hole was called standing').toBe(false);
    expect(
      body.contactRimZ,
      'and the way off points on over the hole, not back onto the slab',
    ).toBeGreaterThan(0);
  });
});
