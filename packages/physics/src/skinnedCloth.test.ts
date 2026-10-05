import { describe, expect, it } from 'vitest';

import { colourConstraints } from './clothBatches.ts';
import { SkinnedCloth } from './skinnedCloth.ts';
import type { SkinnedClothSetup } from './skinnedClothSetup.ts';

/**
 * A set-up of `positions`, the first particle kinematic and every other free, joined in a chain of
 * distance constraints at their rest lengths; everything else at its default unless `extra` says.
 */
function chain(positions: number[], extra: Partial<SkinnedClothSetup> = {}): SkinnedClothSetup {
  const count = positions.length / 3;
  const pairs: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    pairs.push(i, i + 1);
    const d = Math.hypot(
      (positions[i * 3 + 3] as number) - (positions[i * 3] as number),
      (positions[i * 3 + 4] as number) - (positions[i * 3 + 1] as number),
      (positions[i * 3 + 5] as number) - (positions[i * 3 + 2] as number),
    );
    rest.push(d);
  }
  return {
    positions: new Float32Array(positions),
    inverseMass: Float32Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 1)),
    distance: {
      pairs: new Uint32Array(pairs),
      rest: new Float32Array(rest),
      compliance: new Float32Array(rest.length),
    },
    parameters: { gravity: [0, 0, 0] },
    ...extra,
  };
}

const at = (cloth: SkinnedCloth, i: number): [number, number, number] => [
  cloth.positions[i * 3] as number,
  cloth.positions[i * 3 + 1] as number,
  cloth.positions[i * 3 + 2] as number,
];

describe('the skinned cloth solver', () => {
  /*
   * **A stretched link returns to its rest length.** A particle one metre from its kinematic anchor
   * along x, at rest length one, is dragged to two metres and let go; with no compliance and no
   * gravity it is one metre from the anchor ever after, and the anchor has not moved. Where on that
   * sphere is momentum's business: the correction is velocity in XPBD, so it swings through.
   */
  it('A DISTANCE CONSTRAINT SETTLES AT ITS REST LENGTH, AND A KINEMATIC PARTICLE NEVER MOVES', () => {
    const cloth = new SkinnedCloth(chain([0, 0, 0, 1, 0, 0]));
    cloth.positions[3] = 2;
    cloth.advance(0.5);
    expect(at(cloth, 0)).toEqual([0, 0, 0]);
    expect(Math.hypot(...at(cloth, 1))).toBeCloseTo(1, 4);
  });

  /*
   * **Compliance is metres per newton, whatever the step.** A particle of one kilogram hangs from a
   * kinematic anchor at rest length one under ten metres a second squared, at compliance 0.01: at
   * rest the link carries ten newtons and stretches 0.01 × 10 = 0.1, so it settles 1.1 below the
   * anchor. Damped so it settles; the same at a step of 1/60 and of 1/120.
   */
  it('COMPLIANCE MEANS ONE STRETCH AT TWO STEP LENGTHS', () => {
    for (const step of [1 / 60, 1 / 120]) {
      const setup = chain([0, 0, 0, 0, -1, 0], {
        parameters: { gravity: [0, -10, 0], step, damping: Math.log(0.01) },
      });
      setup.distance.compliance.fill(0.01);
      const cloth = new SkinnedCloth(setup);
      cloth.advance(6);
      expect(at(cloth, 1)[1], `at a step of 1/${Math.round(1 / step)}`).toBeCloseTo(-1.1, 3);
    }
  });

  /*
   * **Damping is a decay per second in log space.** A free particle moving at 1 m/s, damping
   * ln 0.25, is moving at 0.25 m/s after one second — whatever the step. And drag relaxes it toward
   * the wind the same way: still air, ln 0.5, halves it in a second.
   */
  it('damps velocity by its log-space decay per second, and drags it toward the wind', () => {
    const free = (parameters: SkinnedClothSetup['parameters']): SkinnedCloth => {
      const cloth = new SkinnedCloth({
        positions: new Float32Array([0, 0, 0]),
        inverseMass: new Float32Array([1]),
        distance: {
          pairs: new Uint32Array(0),
          rest: new Float32Array(0),
          compliance: new Float32Array(0),
        },
        parameters,
      });
      cloth.velocities[0] = 1;
      return cloth;
    };
    const damped = free({ gravity: [0, 0, 0], damping: Math.log(0.25) });
    damped.advance(1);
    expect(damped.velocities[0]).toBeCloseTo(0.25, 3);
    const dragged = free({ gravity: [0, 0, 0], drag: Math.log(0.5), wind: [0, 0, 0] });
    dragged.advance(1);
    expect(dragged.velocities[0]).toBeCloseTo(0.5, 3);
    const blown = free({ gravity: [0, 0, 0], drag: Math.log(0.5), wind: [3, 0, 0] });
    blown.advance(1);
    /* Half of the difference from the wind is left: 3 + (1 − 3) × 0.5 = 2. */
    expect(blown.velocities[0]).toBeCloseTo(2, 3);
  });

  /*
   * **The wind is the frame's, not the set-up's** — `AGENTS.md`'s one wind, sampled once and passed
   * down. A cloth built in still air and handed a wind of 3 along x runs exactly the steps of one
   * built with it, bit for bit; and handed still air back, it relaxes toward still air again.
   */
  it("TAKES THE FRAME'S WIND, BIT FOR BIT THE WIND IT WOULD HAVE BEEN BUILT WITH", () => {
    const setup = (wind: [number, number, number]): SkinnedClothSetup =>
      chain([0, 0, 0, 0, -1, 0, 0, -2, 0], {
        parameters: { gravity: [0, -9.8, 0], drag: Math.log(0.5), wind },
      });
    const built = new SkinnedCloth(setup([3, 0, 1]));
    const handed = new SkinnedCloth(setup([0, 0, 0]));
    handed.setWind(3, 0, 1);
    built.advance(0.5);
    handed.advance(0.5);
    expect(Array.from(handed.positions)).toEqual(Array.from(built.positions));
    handed.setWind(0, 0, 0);
    const still = new SkinnedCloth(setup([0, 0, 0]));
    still.positions.set(handed.positions);
    still.velocities.set(handed.velocities);
    handed.advance(0.25);
    still.advance(0.25);
    expect(Array.from(handed.positions)).toEqual(Array.from(still.positions));
  });

  /*
   * **The fixed step is the solver's, not the caller's.** One advance of 1/30 s and two of 1/60 s
   * run the same two steps and leave the same bits; an advance shorter than a step runs none and
   * leaves the remainder for the next.
   */
  it('runs whole fixed steps whatever the frame, so one 1/30 equals two 1/60', () => {
    const setup = (): SkinnedClothSetup =>
      chain([0, 0, 0, 0, -1, 0, 0, -2, 0], { parameters: { gravity: [0, -9.8, 0] } });
    const once = new SkinnedCloth(setup());
    const twice = new SkinnedCloth(setup());
    once.advance(1 / 30);
    twice.advance(1 / 60);
    twice.advance(1 / 60);
    expect(Array.from(once.positions)).toEqual(Array.from(twice.positions));
    const short = new SkinnedCloth(setup());
    expect(short.advance(1 / 120), 'no step yet').toBe(0);
    expect(short.advance(1 / 120), 'the remainder makes one').toBe(1);
  });

  /*
   * **A folded hinge unfolds to its rest angle.** Two triangles sharing an edge along z, flat at
   * rest; the free corner is folded up through ninety degrees. A dihedral bending constraint at
   * zero compliance, with the shared edge and the other corner kinematic, brings it back flat: its
   * height ends at zero and its distance from the edge stays one.
   */
  it('A DIHEDRAL BEND RETURNS A FOLDED HINGE TO ITS REST ANGLE', () => {
    const setup: SkinnedClothSetup = {
      /* Edge (0, 1) along z; corner 2 at x = −1, corner 3 at x = +1. */
      positions: new Float32Array([0, 0, 0, 0, 0, 1, -1, 0, 0.5, 1, 0, 0.5]),
      inverseMass: new Float32Array([0, 0, 0, 1]),
      distance: {
        pairs: new Uint32Array([0, 3, 1, 3]),
        rest: new Float32Array([Math.hypot(1, 0.5), Math.hypot(1, 0.5)]),
        compliance: new Float32Array(2),
      },
      bending: {
        quads: new Uint32Array([0, 1, 2, 3]),
        rest: new Float32Array([Math.PI]),
        compliance: new Float32Array(1),
      },
      parameters: { gravity: [0, 0, 0], iterations: 8 },
    };
    const cloth = new SkinnedCloth(setup);
    cloth.positions[9] = 0;
    cloth.positions[10] = 1;
    cloth.advance(1);
    const [x, y] = at(cloth, 3);
    expect(y).toBeCloseTo(0, 2);
    expect(x).toBeCloseTo(1, 2);
  });

  /*
   * A tether is a maximum, not a spring: a particle within its length of the kinematic anchor is
   * left alone, and one beyond it is brought back to the length exactly.
   */
  it('a tether pulls a particle back to its length and leaves one within it alone', () => {
    const setup = (x: number): SkinnedClothSetup => ({
      positions: new Float32Array([0, 0, 0, x, 0, 0]),
      inverseMass: new Float32Array([0, 1]),
      distance: {
        pairs: new Uint32Array(0),
        rest: new Float32Array(0),
        compliance: new Float32Array(0),
      },
      tethers: {
        particles: new Uint32Array([1]),
        anchors: new Uint32Array([0]),
        lengths: new Float32Array([2]),
      },
      parameters: { gravity: [0, 0, 0] },
    });
    const inside = new SkinnedCloth(setup(1.5));
    inside.advance(1 / 60);
    expect(at(inside, 1)[0]).toBeCloseTo(1.5, 6);
    const outside = new SkinnedCloth(setup(3));
    outside.advance(1 / 60);
    expect(at(outside, 1)[0]).toBeCloseTo(2, 5);
  });

  it('gives the same bits for the same inputs', () => {
    const run = (): number[] => {
      const cloth = new SkinnedCloth(
        chain([0, 0, 0, 0.3, -1, 0, 0.1, -2, 0.4, -0.2, -3, 0], {
          parameters: { gravity: [0, -9.8, 0], wind: [1, 0, 0.5], drag: Math.log(0.6) },
        }),
      );
      for (let frame = 0; frame < 90; frame++) cloth.advance(1 / 75);
      return Array.from(cloth.positions);
    };
    expect(run()).toEqual(run());
  });
});

describe('colour batches', () => {
  /*
   * **No batch moves a particle twice**, which is what lets a batch run in parallel. A chain of five
   * links shares every interior particle between two links, so it needs two colours; a kinematic
   * particle may be shared freely, since nothing writes it.
   */
  it('COLOURS A CHAIN INTO BATCHES THAT NEVER MOVE A PARTICLE TWICE', () => {
    const pairs = new Uint32Array([0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
    const free = new Float32Array([0, 1, 1, 1, 1, 1]);
    const { order, batches } = colourConstraints(pairs, 2, free);
    expect(batches[batches.length - 1]).toBe(5);
    expect(batches.length - 1, 'two colours for a chain').toBe(2);
    for (let b = 0; b + 1 < batches.length; b++) {
      const seen = new Set<number>();
      for (let k = batches[b] as number; k < (batches[b + 1] as number); k++) {
        const constraint = order[k] as number;
        for (const p of [pairs[constraint * 2], pairs[constraint * 2 + 1]] as number[]) {
          if ((free[p] as number) === 0) continue;
          expect(seen.has(p), `particle ${p} twice in batch ${b}`).toBe(false);
          seen.add(p);
        }
      }
    }
  });

  /* A fan of links around a pinned particle shares it in one batch; free, it takes three. */
  it('shares a kinematic particle within a batch, and colours around a free one', () => {
    const fan = new Uint32Array([0, 1, 0, 2, 0, 3]);
    expect(colourConstraints(fan, 2, new Float32Array([0, 1, 1, 1])).batches.length - 1).toBe(1);
    expect(colourConstraints(fan, 2, new Float32Array([1, 1, 1, 1])).batches.length - 1).toBe(3);
  });

  it('refuses given batches that move a particle twice, naming the batch and the particle', () => {
    expect(
      () =>
        new SkinnedCloth(
          chain([0, 0, 0, 1, 0, 0, 2, 0, 0], {
            distance: {
              pairs: new Uint32Array([0, 1, 1, 2]),
              rest: new Float32Array([1, 1]),
              compliance: new Float32Array(2),
              batches: new Uint32Array([0, 2]),
            },
          }),
        ),
    ).toThrow(/batch 0 .* particle 1 twice/);
  });
});
