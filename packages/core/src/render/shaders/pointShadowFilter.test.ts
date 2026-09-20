/**
 * The point-shadow filter's tap set, and the pair of pixels that completes it.
 *
 * **Written because the thing that went wrong here was arithmetic nobody could see.** The filter
 * shipped twelve offsets that were eight: they were carried as `vec3` from the era when a tap
 * perturbed a direction by a 3D vector, and flattening a cube's eight corners onto a plane makes
 * four coincident pairs. Every gate in this repository was green the whole time, because a
 * duplicate tap compiles, draws, and is only visible as a penumbra that moves in steps twice the
 * size it should — reported from two different games as a coarse cross-hatch.
 *
 * So these read the numbers the shader ships and check the properties the filter is built on,
 * rather than checking that a string is still present. GLSL cannot be executed here and the look
 * of a shadow needs a device; what can be settled here is whether the twelve places are twelve,
 * spread, and still spread when a lower profile takes only the first four or eight of them — and
 * whether the second pixel of a pair lands between the first's taps rather than on top of them.
 */
import { expect, test } from 'vitest';
import { flatFrag } from './flat/index.ts';

type Tap = readonly [number, number];

const source = flatFrag({
  pointShadows: true,
  directionalShadows: true,
  environmentProbe: false,
  nightEmissive: false,
});

/** The tap offsets, read out of the shader that ships them. */
function taps(): readonly Tap[] {
  const at = source.indexOf('const vec2 PCF_OFFSETS[');
  expect(at, 'the point filter declares its offsets as a vec2 array').toBeGreaterThan(-1);
  const body = source.slice(at, source.indexOf(');', at));
  return [...body.matchAll(/vec2\(\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)].map(
    (match) => [Number(match[1]), Number(match[2])] as const,
  );
}

/** The angle between the two tap sets a pixel pair uses, read the same way. */
function pairTurn(): number {
  const match = /const float PCF_PAIR_TURN = (-?[\d.]+);/.exec(source);
  expect(match, 'the pair turn is a named constant').not.toBeNull();
  return Number(match?.[1]);
}

const length = (tap: Tap): number => Math.hypot(tap[0], tap[1]);

/** The closest two of a set. Zero means two taps are asking the same question. */
function closestPair(set: readonly Tap[]): number {
  let closest = Infinity;
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const a = set[i] as Tap;
      const b = set[j] as Tap;
      closest = Math.min(closest, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  return closest;
}

/** How far off centre a set sits, as a fraction of a tap. A biased set drags the shadow. */
function offCentre(set: readonly Tap[]): number {
  const x = set.reduce((sum, tap) => sum + tap[0], 0) / set.length;
  const y = set.reduce((sum, tap) => sum + tap[1], 0) / set.length;
  return Math.hypot(x, y);
}

function turned(set: readonly Tap[], angle: number): readonly Tap[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return set.map((tap) => [tap[0] * c - tap[1] * s, tap[0] * s + tap[1] * c] as const);
}

test('TWELVE TAPS ARE TWELVE PLACES, not eight with four of them asked twice', () => {
  const set = taps();
  expect(set, 'the filter ships one offset per tap of its budget').toHaveLength(12);
  expect(
    new Set(set.map((tap) => tap.join(','))).size,
    'and no two of them are the same place',
  ).toBe(12);
  /*
   * A bound rather than an identity, because the point is the *separation* and not these
   * particular numbers. The set that ships is 0.355 apart at its closest; the set it replaced
   * was 0.000, which is what this is here to refuse.
   */
  expect(closestPair(set), 'the closest two taps are a real distance apart').toBeGreaterThan(0.3);
});

test('AND THEY COVER A DISK RATHER THAN A RIM, without reaching further than the filter did', () => {
  const set = taps();
  const radii = set.map(length);
  /*
   * The old set put eight taps at 1.414 and four at 1.0 and nothing anywhere else, so it read
   * the penumbra's outer edge twice as often as its middle. An even disk has taps at every
   * radius: the innermost inside a third of the reach, the outermost near the whole of it.
   */
  expect(Math.min(...radii), 'something samples near the centre').toBeLessThan(0.45);
  expect(Math.max(...radii), 'and something reaches the rim').toBeGreaterThan(1.2);
  /*
   * The reach is `MAX_FILTER_RADIUS`'s to set, not this list's. 1.414 is what the old corners
   * reached, so staying inside it is what keeps this change about sampling rather than about
   * how wide a shadow is.
   */
  expect(Math.max(...radii), 'and no further than the set it replaced').toBeLessThanOrEqual(1.414);
});

test('EVERY PROFILE GETS A DISK, because a short filter is a prefix of this list', () => {
  const set = taps();
  /*
   * `shadowFilterTaps` is 4, 8 or 12 and the loop simply stops early, so the first four and the
   * first eight are filters somebody ships. In plain spiral order they would be the four
   * innermost taps — a filter a third of the width the caller asked for, on the profile least
   * able to notice. The radii are dealt round instead, and this is what says so.
   */
  for (const count of [4, 8, 12]) {
    const prefix = set.slice(0, count);
    expect(
      Math.max(...prefix.map(length)),
      `the first ${count} taps still reach the rim`,
    ).toBeGreaterThan(1.2);
    expect(
      offCentre(prefix),
      `the first ${count} taps sit around the centre rather than to one side`,
    ).toBeLessThan(0.3);
    expect(closestPair(prefix), `and no two of the first ${count} coincide`).toBeGreaterThan(0.3);
  }
});

test('THE PAIR OF PIXELS IS ONE FILTER, its second half falling between the first half', () => {
  const set = taps();
  const pair = [...set, ...turned(set, pairTurn())];
  expect(pair, 'a pair of pixels holds twenty-four taps between them').toHaveLength(24);
  /*
   * The point of the turn is that the two pixels do not sample the same places. A half turn
   * would put the second set 0.175 from the first at its closest and a whole golden angle
   * 0.233; half a golden angle gives 0.305, which is nearly the separation of the twelve on
   * their own — so the pair's filter is as even as the set it is built from.
   *
   * This is the assertion that fails if somebody rounds the turn to something tidy.
   */
  expect(
    closestPair(pair),
    'the second pixel samples between the first pixel s taps, not on top of them',
  ).toBeGreaterThan(0.25);
});

test('THE TURN IS THE COLUMN AND NOTHING ELSE, because the resolve depends on it', () => {
  /*
   * The filter and the resolve are one mechanism: `main` averages a pixel with its neighbour
   * across x, which is only the average of the two tap sets if the tap set is a function of x
   * alone. Measured on hardware that answers a coarse derivative, a turn taken from a
   * per-fragment hash made the same resolve *worse* than no resolve — the second row of a quad
   * borrows the first row's difference, which is only the right difference when both rows hold
   * the same two tap sets.
   */
  const compact = source.replace(/\s+/g, ' ');
  expect(compact, 'the taps turn on the pixel column').toContain(
    'float angle = float(int(gl_FragCoord.x) & 1) * PCF_PAIR_TURN;',
  );
  expect(compact, 'and the resolve signs itself by the same column').toContain(
    'dFdx(lampShade) * (float(int(gl_FragCoord.x) & 1) - 0.5)',
  );
  /*
   * `int(...) & 1` rather than `mod(x, 2.0)`: this is an index lattice, and a compiler is free
   * to implement a float remainder as a multiply by a reciprocal — a GPU here answers 3 for
   * `3.0 % 3.0`. See AGENTS.md, 2026-09-20.
   */
  expect(compact, 'and neither asks a float for a parity').not.toContain(
    'mod(gl_FragCoord.x, 2.0)',
  );
});

test('AND NO DERIVATIVE SITS INSIDE THE LIGHT LOOP, where none is defined', () => {
  /*
   * The whole reason the resolve lives in `main` after both lamp loops. Inside, the control
   * flow is not uniform — the point loop `continue`s on falloff and on facing, and the
   * clustered arm reads its trip count from a froxel — so a derivative there is undefined and
   * invites a compiler to flatten the loop and pay for every arm. AGENTS.md, 2026-08-07.
   *
   * Perturb by moving the `dFdx` back beside the taps and this goes red.
   */
  const start = source.indexOf('float pointShadow(');
  const end = source.indexOf('out vec4 outColor;');
  expect(start, 'the round filter is in the source').toBeGreaterThan(-1);
  expect(end, 'and the shadow chunk ends before the fragment output').toBeGreaterThan(start);
  const filters = source.slice(start, end);
  expect(filters, 'no derivative is taken inside either shadow filter').not.toMatch(/dFdx|dFdy/);
});
