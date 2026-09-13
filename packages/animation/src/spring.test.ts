import { expect, test } from 'vitest';
import {
  sampleSpring,
  sampleSpringChain,
  springChainSettleSec,
  springSettleSec,
} from './spring.ts';
import type { SpringLink, SpringSettings } from './spring.ts';

/**
 * Secondary motion, and the one property that makes it belong in this package.
 *
 * **It is a pure function of the time it is asked about.** Hair, a coat, an antenna and a chain
 * should react to what the subject is doing, and the obvious tool for that is a ragdoll — which the
 * consumer who asked for this refused in writing, because a ragdoll integrates state and therefore
 * cannot answer *what is the pose at time t* for a `t` reached by dragging a playhead backwards.
 * Their preview reads `sample(plan, t)` against an audio clock and their export reads the same
 * function against a frame index, so anything that accumulates makes those two disagree and makes
 * two exports of one project differ.
 *
 * **What makes the pure version possible is that a damped spring forgets.** The influence of the
 * anchor at time τ on the mass at time t decays as `e^(-ζω(t-τ))`, so past some settle time it is
 * below any tolerance you name. Evaluating at `t` means starting at rest a settle time earlier and
 * marching forward — bounded work, no history, and the same answer whichever direction the caller
 * scrubs.
 *
 * The test that matters is the third one: evaluating at `t` directly must equal marching from the
 * very beginning, or the forgetting argument is wrong and everything above it is decoration.
 */

/** A sinusoidal anchor, which is a driver with no settling of its own to hide behind. */
function swinging(hz: number, amplitude = 1) {
  return (timeSec: number, out: Float32Array): void => {
    out[0] = amplitude * Math.sin(2 * Math.PI * hz * timeSec);
    out[1] = 0;
    out[2] = 0;
  };
}

/** An anchor that steps from 0 to 1 at t = 0 and stays, which is what an overshoot is read off. */
function stepped(timeSec: number, out: Float32Array): void {
  out[0] = timeSec < 0 ? 0 : 1;
  out[1] = 0;
  out[2] = 0;
}

const OUT = new Float32Array(3);

test('a spring whose anchor never moves sits exactly on it', () => {
  const settings: SpringSettings = { frequencyHz: 3, damping: 0.5 };
  const still = (_t: number, out: Float32Array): void => {
    out[0] = 4;
    out[1] = -2;
    out[2] = 7;
  };
  sampleSpring(settings, still, 1.25, OUT);
  expect([...OUT]).toEqual([4, -2, 7]);
});

test('an underdamped spring overshoots a step and a critically damped one does not', () => {
  const loose: SpringSettings = { frequencyHz: 2, damping: 0.15 };
  const critical: SpringSettings = { frequencyHz: 2, damping: 1 };

  /* A quarter of a period past the step is where an underdamped mass is past its target. */
  let peak = 0;
  for (let t = 0; t < 1; t += 1 / 240) {
    sampleSpring(loose, stepped, t, OUT);
    peak = Math.max(peak, OUT[0]!);
  }
  expect(peak).toBeGreaterThan(1.2);

  let criticalPeak = 0;
  for (let t = 0; t < 1; t += 1 / 240) {
    sampleSpring(critical, stepped, t, OUT);
    criticalPeak = Math.max(criticalPeak, OUT[0]!);
  }
  expect(criticalPeak).toBeLessThanOrEqual(1.001);
});

/**
 * **The claim the whole design rests on.**
 *
 * If a spring's memory really is bounded, then evaluating at `t` from a settle time earlier is the
 * same answer as marching to `t` from the beginning of time. If it is not, this is a stateful
 * simulation wearing a pure signature, and every scrub backwards would show it.
 */
test('evaluating at t is the same as marching to t from the beginning', () => {
  const settings: SpringSettings = { frequencyHz: 2.5, damping: 0.35 };
  const anchor = swinging(0.7);

  /* The reference: one integration from zero, at a step far finer than the sampler's own. */
  const step = 1 / 4000;
  const position = new Float32Array(3);
  const velocity = new Float32Array(3);
  const at = new Float32Array(3);
  anchor(0, at);
  position.set(at);

  const omega = 2 * Math.PI * settings.frequencyHz;
  const checkpoints = [1.5, 2.0, 3.25, 4.0];
  const marched = new Map<number, number>();
  for (let t = 0, n = 0; t <= 4.0001; n += 1, t = n * step) {
    for (const checkpoint of checkpoints) {
      if (Math.abs(t - checkpoint) < step / 2 && !marched.has(checkpoint)) {
        marched.set(checkpoint, position[0]!);
      }
    }
    anchor(t, at);
    const accel =
      omega * omega * (at[0]! - position[0]!) - 2 * settings.damping * omega * velocity[0]!;
    velocity[0] = velocity[0]! + accel * step;
    position[0] = position[0]! + velocity[0]! * step;
  }

  for (const checkpoint of checkpoints) {
    sampleSpring(settings, anchor, checkpoint, OUT);
    expect(OUT[0]!).toBeCloseTo(marched.get(checkpoint)!, 2);
  }
});

test('scrubbing backwards gives what scrubbing forwards gave, value for value', () => {
  const settings: SpringSettings = { frequencyHz: 4, damping: 0.2 };
  const anchor = swinging(1.3);
  const times = [0.5, 0.9, 1.4, 2.2, 3.1];

  const forwards = times.map((t) => {
    sampleSpring(settings, anchor, t, OUT);
    return OUT[0]!;
  });
  const backwards = [...times].reverse().map((t) => {
    sampleSpring(settings, anchor, t, OUT);
    return OUT[0]!;
  });
  expect(backwards.reverse()).toEqual(forwards);
});

test('a heavier damping settles sooner, and the settle time is what the lookback is built from', () => {
  expect(springSettleSec({ frequencyHz: 2, damping: 0.8 })).toBeLessThan(
    springSettleSec({ frequencyHz: 2, damping: 0.2 }),
  );
  /* And a faster spring settles sooner than a slow one at the same damping. */
  expect(springSettleSec({ frequencyHz: 8, damping: 0.5 })).toBeLessThan(
    springSettleSec({ frequencyHz: 1, damping: 0.5 }),
  );
});

test('a maximum offset holds the mass within reach of its anchor', () => {
  /* A slack spring under a fast anchor lags furthest, which is where a clamp has to hold. */
  const settings: SpringSettings = { frequencyHz: 0.4, damping: 0.05, maxOffsetM: 0.25 };
  const anchor = swinging(3, 4);
  for (let t = 0; t < 2; t += 1 / 120) {
    sampleSpring(settings, anchor, t, OUT);
    const target = new Float32Array(3);
    anchor(t, target);
    const lag = Math.hypot(OUT[0]! - target[0]!, OUT[1]! - target[1]!, OUT[2]! - target[2]!);
    expect(lag).toBeLessThanOrEqual(0.2500001);
  }
});

test('refuses settings that describe no spring, at the call rather than in the frame', () => {
  expect(() => sampleSpring({ frequencyHz: 0, damping: 0.5 }, stepped, 1, OUT)).toThrow(
    /frequency/i,
  );
  expect(() => sampleSpring({ frequencyHz: -2, damping: 0.5 }, stepped, 1, OUT)).toThrow(
    /frequency/i,
  );
  expect(() => sampleSpring({ frequencyHz: 2, damping: -0.1 }, stepped, 1, OUT)).toThrow(
    /damping/i,
  );
});

/**
 * **An overdamped spring is allowed and an undamped one is not.**
 *
 * Damping above 1 is a real setting — a coat that sags rather than swings — and it has a closed
 * form like any other. Damping at exactly 0 is the one value the forgetting argument fails for: an
 * undamped spring rings forever, so no lookback is long enough and there is no honest answer to
 * give. Refused by name rather than clamped, because a caller who wrote 0 meant something.
 */
test('damping at zero is refused, because a spring that never forgets cannot be sampled', () => {
  expect(() => sampleSpring({ frequencyHz: 2, damping: 0 }, stepped, 1, OUT)).toThrow(
    /never settles|forget/i,
  );
  /* Overdamped is ordinary. */
  sampleSpring({ frequencyHz: 2, damping: 2.5 }, stepped, 1, OUT);
  expect(OUT[0]!).toBeGreaterThan(0);
  expect(OUT[0]!).toBeLessThanOrEqual(1.0001);
});

test('a time before the anchor has moved gives the anchor, not a transient from nowhere', () => {
  const settings: SpringSettings = { frequencyHz: 3, damping: 0.4 };
  sampleSpring(settings, stepped, -1, OUT);
  expect(OUT[0]!).toBe(0);
});

/**
 * **A chain is not a list of independent springs, and that is the whole of what it adds.**
 *
 * Each link hangs off the one before it, so the second link's anchor is where the first link
 * actually *is* — lagging, overshooting and all — rather than where the rig says it should be. That
 * is what makes a braid read as a braid instead of as three ribbons on one hook, and it is also
 * what makes the purity argument need re-checking: a chain remembers longer than any single link,
 * because a disturbance has to travel down it before it can die out.
 */

/** A chain hanging in -Y, every link the same, which is the case where memory runs longest. */
function hanging(count: number, frequencyHz: number, damping: number): SpringLink[] {
  return Array.from({ length: count }, () => ({
    frequencyHz,
    damping,
    restOffsetM: [0, -0.2, 0] as const,
  }));
}

test('a chain whose root never moves hangs exactly on its rest offsets', () => {
  const links = hanging(4, 3, 0.4);
  const root = (_t: number, out: Float32Array): void => {
    out[0] = 1;
    out[1] = 5;
    out[2] = -2;
  };
  const out = new Float32Array(12);
  sampleSpringChain(links, root, 2.5, out);
  /* Exactly, not nearly: a still anchor leaves every link's offset and velocity at zero, so the
     march writes the anchor back unchanged. Compared in the precision it is written in, because
     4.8 is not a float32 and the literal would be measuring that instead. */
  expect([...out]).toEqual([...new Float32Array([1, 4.8, -2, 1, 4.6, -2, 1, 4.4, -2, 1, 4.2, -2])]);
});

/**
 * **The same claim as for one spring, made again because a chain is not covered by it.**
 *
 * One link forgets in `-ln(ε)/(ζω)`. Four links in series do not: the response of a cascade carries
 * a polynomial in `t` alongside the exponential, so the settle time grows with depth and a lookback
 * that was right for one link is short for four. If this passes, `springChainSettleSec` has that
 * right; if it fails, the chain is a stateful simulation wearing a pure signature.
 */
test('evaluating a chain at t is the same as marching the whole chain from the beginning', () => {
  const links = hanging(4, 2.5, 0.3);
  const root = swinging(0.7);

  const step = 1 / 8000;
  const position = links.map(() => new Float32Array(3));
  const velocity = links.map(() => new Float32Array(3));
  const at = new Float32Array(3);
  const anchor = new Float32Array(3);

  root(0, at);
  for (let i = 0; i < links.length; i += 1) {
    const rest = links[i]!.restOffsetM;
    const above = i === 0 ? at : position[i - 1]!;
    position[i]![0] = above[0]! + rest[0]!;
    position[i]![1] = above[1]! + rest[1]!;
    position[i]![2] = above[2]! + rest[2]!;
  }

  /*
   * **Every checkpoint sits past the chain's own settle time, and that is the reference's
   * constraint rather than the sampler's.** The march starts at rest at t = 0, so it only stands
   * for "from the beginning of time" once its own opening transient has died — which for this
   * chain takes about 2.8 s. Asking it at 2.0 would compare the sampler against a reference that
   * is still warming up, and read the difference as the sampler's.
   */
  const checkpoints = [3.5, 5.0, 6.5];
  const marched = new Map<number, number[]>();
  for (let t = 0, n = 0; t <= 6.5001; n += 1, t = n * step) {
    for (const checkpoint of checkpoints) {
      if (Math.abs(t - checkpoint) < step / 2 && !marched.has(checkpoint)) {
        marched.set(
          checkpoint,
          position.map((p) => p[0]!),
        );
      }
    }
    root(t, at);
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i]!;
      const omega = 2 * Math.PI * link.frequencyHz;
      const above = i === 0 ? at : position[i - 1]!;
      for (let axis = 0; axis < 3; axis += 1) {
        anchor[axis] = above[axis]! + link.restOffsetM[axis]!;
      }
      /* The sweep runs root-downwards, so link i sees link i-1 already advanced. */
      for (let axis = 0; axis < 3; axis += 1) {
        const accel =
          omega * omega * (anchor[axis]! - position[i]![axis]!) -
          2 * link.damping * omega * velocity[i]![axis]!;
        velocity[i]![axis] = velocity[i]![axis]! + accel * step;
        position[i]![axis] = position[i]![axis]! + velocity[i]![axis]! * step;
      }
    }
  }

  const out = new Float32Array(3 * links.length);
  for (const checkpoint of checkpoints) {
    sampleSpringChain(links, root, checkpoint, out);
    const reference = marched.get(checkpoint)!;
    for (let i = 0; i < links.length; i += 1) {
      expect(out[3 * i]!).toBeCloseTo(reference[i]!, 2);
    }
  }
});

test('a chain remembers longer than any one of its links, and by more the deeper it is', () => {
  const one = springChainSettleSec(hanging(1, 2, 0.3));
  expect(one).toBeCloseTo(springSettleSec({ frequencyHz: 2, damping: 0.3 }), 6);
  expect(springChainSettleSec(hanging(4, 2, 0.3))).toBeGreaterThan(one);
  expect(springChainSettleSec(hanging(8, 2, 0.3))).toBeGreaterThan(
    springChainSettleSec(hanging(4, 2, 0.3)),
  );
  /* And the slowest link is what sets the rate, not the average. */
  const mixed: SpringLink[] = [
    { frequencyHz: 9, damping: 0.9, restOffsetM: [0, -0.2, 0] },
    { frequencyHz: 1, damping: 0.1, restOffsetM: [0, -0.2, 0] },
  ];
  expect(springChainSettleSec(mixed)).toBeGreaterThan(springChainSettleSec(hanging(2, 9, 0.9)));
});

test('the further down a chain a link sits, the further it trails the root', () => {
  const links = hanging(4, 2, 0.25);
  const root = swinging(1.1, 0.5);
  const out = new Float32Array(3 * links.length);
  const target = new Float32Array(3);
  const worst = [0, 0, 0, 0];
  for (let t = 0; t < 3; t += 1 / 120) {
    sampleSpringChain(links, root, t, out);
    root(t, target);
    for (let i = 0; i < links.length; i += 1) {
      worst[i] = Math.max(worst[i]!, Math.abs(out[3 * i]! - target[0]!));
    }
  }
  expect(worst[1]!).toBeGreaterThan(worst[0]!);
  expect(worst[2]!).toBeGreaterThan(worst[1]!);
  expect(worst[3]!).toBeGreaterThan(worst[2]!);
});

test('a chain scrubbed backwards gives what it gave forwards, value for value', () => {
  const links = hanging(3, 4, 0.2);
  const root = swinging(1.3);
  const times = [0.5, 0.9, 1.4, 2.2, 3.1];
  const out = new Float32Array(9);

  const forwards = times.map((t) => {
    sampleSpringChain(links, root, t, out);
    return [...out];
  });
  const backwards = [...times].reverse().map((t) => {
    sampleSpringChain(links, root, t, out);
    return [...out];
  });
  expect(backwards.reverse()).toEqual(forwards);
});

test('a chain refuses an output too small to hold it, by name and by number', () => {
  const links = hanging(3, 2, 0.4);
  expect(() => sampleSpringChain(links, stepped, 1, new Float32Array(8))).toThrow(/9|three links/i);
});
