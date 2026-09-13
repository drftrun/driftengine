/**
 * The W3C Standard Gamepad, by position rather than by anybody's lettering.
 *
 * **The names are positional and that is a correctness decision, not a style one.** Index 0 is the
 * bottom button of the right cluster. It is labelled A on an Xbox pad, Cross on a PlayStation pad
 * and **B** on a Nintendo pad, because Nintendo's physical layout swaps the two. Any lettering
 * this file picked would therefore be a false statement about somebody's hardware. It names the
 * position, which is true everywhere; `gamepadIdentity.ts` answers what that position is *called*
 * on the pad actually in the player's hands.
 *
 * A browser sets `mapping: 'standard'` only when it is confident the device matches this table.
 * Anything else is served by raw index and says so once — see `InputSource`'s pad view.
 */

export type GamepadButton =
  | 'faceDown'
  | 'faceRight'
  | 'faceLeft'
  | 'faceUp'
  | 'l1'
  | 'r1'
  | 'l2'
  | 'r2'
  | 'select'
  | 'start'
  | 'l3'
  | 'r3'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'
  | 'guide';

export type GamepadAxis = 'leftX' | 'leftY' | 'rightX' | 'rightY';

export const BUTTON_INDEX: Readonly<Record<GamepadButton, number>> = {
  faceDown: 0,
  faceRight: 1,
  faceLeft: 2,
  faceUp: 3,
  l1: 4,
  r1: 5,
  /* The lower shoulders are the only members of this table that are honestly both a button and an
     axis: they carry an analog `value` beside `pressed`, so they answer `down` and `axis` alike. */
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
  l3: 10,
  r3: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  /* Optional in the specification, and a browser may withhold it entirely. A pad without one
     simply never reports it down, which is the true answer rather than a convenient one. */
  guide: 16,
};

/**
 * **Vertical axes point up at −1**, which is the specification's choice and the opposite of most
 * game code's expectation.
 *
 * It is not corrected here. An engine that silently flips a sign is one a consumer cannot reason
 * about — the value it reads would disagree with every reference about the API it came from — so a
 * caller that wants the other convention negates it at the one place that means something. What it
 * costs: a caller has to know. What would make it wrong: nothing short of the specification
 * changing, which it will not.
 */
export const AXIS_INDEX: Readonly<Record<GamepadAxis, number>> = {
  leftX: 0,
  leftY: 1,
  rightX: 2,
  rightY: 3,
};

/**
 * How far a stick must travel before it is moving at all.
 *
 * A tuning constant, so it is an option rather than a rule — `AGENTS.md` forbids asserting the
 * value of one, and `gamepadMapping.test.ts` checks only that it sits in a range a stick can
 * leave. Sticks rest off-centre by different amounts on different pads and wear looser with age,
 * which is the whole reason a deadzone exists.
 */
export const DEFAULT_DEADZONE = 0.15;

/**
 * Drop the dead region and rescale what is left, into a caller-owned target.
 *
 * **Radial rather than per-axis.** A per-axis deadzone leaves a *square* dead region, so a stick
 * pushed diagonally clears it at a smaller displacement than one pushed straight, and the diagonal
 * snaps out of nothing. What a player is controlling is the magnitude, so the magnitude is what
 * the test applies to.
 *
 * **Rescaled from the edge**, because without it the value jumps from 0 to the deadzone the
 * instant it is crossed — a stick that begins moving fast rather than from rest. What it costs:
 * full deflection is reached fractionally before the hardware's own rim. What would make it wrong:
 * a caller wanting the untouched number, which the pad view answers separately as `rawAxis`.
 *
 * Fills `out` rather than returning an object: this is a per-frame path and the house rule about
 * allocation binds it.
 */
export function applyDeadzone(
  x: number,
  y: number,
  deadzone: number,
  out: { x: number; y: number },
): void {
  const magnitude = Math.hypot(x, y);
  if (magnitude === 0 || magnitude <= deadzone) {
    out.x = 0;
    out.y = 0;
    return;
  }
  /* Clamped at 1: a stick can read slightly past its own rim, and a value above 1 would be a
     speed no caller asked to be possible. */
  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  const unit = scaled / magnitude;
  out.x = x * unit;
  out.y = y * unit;
}
