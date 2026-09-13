import { expect, test } from 'vitest';

/*
 * Only the visibility ramp is tested. Whether the streaks look like wind is
 * judged by eye (AGENTS.md); whether they appear at the right time is a
 * decision with a right answer.
 */
function strengthFor(speed: number, onset = 6, full = 11): number {
  return Math.min(Math.max((speed - onset) / Math.max(full - onset, 1e-4), 0), 1);
}

test('a calm day shows nothing at all', () => {
  /*
   * The threshold matters as much as the effect. Debris in a light breeze is
   * visual noise across the entire game; debris only when it is genuinely
   * blowing is information — it tells the player why their glide is drifting,
   * at the one moment they need to know.
   */
  expect(strengthFor(0)).toBe(0);
  expect(strengthFor(5)).toBe(0);
});

test('strength rises with wind and then stops', () => {
  expect(strengthFor(8)).toBeGreaterThan(0);
  expect(strengthFor(8)).toBeLessThan(1);
  expect(strengthFor(11)).toBe(1);
  // A fire launch does not make the sky into a sandstorm.
  expect(strengthFor(1e6)).toBe(1);
});

test('the ramp is monotonic', () => {
  let previous = -1;
  for (let speed = 0; speed <= 20; speed += 0.25) {
    const s = strengthFor(speed);
    expect(s).toBeGreaterThanOrEqual(previous);
    previous = s;
  }
});
