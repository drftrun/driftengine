/**
 * Driving a controller's motors, and saying so when the platform cannot.
 *
 * **The refusal is half the capability.** Most pads on most browsers have no actuator at all, and a
 * settings screen that offers a rumble slider a player's hardware ignores is worse than one that
 * greys it out. So every verb here answers a boolean — the same rule the host seam keeps for a
 * window mode a shell cannot enter — rather than accepting the call and doing nothing quietly.
 *
 * **The engine takes durations and magnitudes, and nothing else.** A magnitude is a fraction of a
 * motor and a duration is milliseconds; what a rumble *means* is the consumer's. There is no
 * pattern language, no named effect and no curve, because every one of those would be a decision
 * about what a game does with the hardware.
 *
 * ## What this reaches, and what it does not
 *
 * `GamepadHapticActuator.playEffect('dual-rumble', …)` and nothing else. Two motors of different
 * masses, which is what a standard pad has: `strong` is the low-frequency one and `weak` the
 * high-frequency one.
 *
 * **`hapticActuators[].pulse` is not used, on purpose.** It is a non-standard surface with a
 * different model — one magnitude where this has two — so serving it would mean either dropping
 * the weak motor or averaging the pair, and both are a silent lie about what the caller asked for.
 * A platform with only `pulse` answers `false` and is greyed out, which is true rather than
 * convenient. **What would make that wrong** is a measurement on a browser a consumer actually
 * ships to where `pulse` exists and `vibrationActuator` does not.
 *
 * **Trigger rumble is not reached either.** `'trigger-rumble'` drives two more motors that only
 * some pads have, so it needs its own capability answer beside `canRumble` rather than riding this
 * one; it is a row of its own the day somebody wants it.
 */

/**
 * The actuator, named here so this file does not depend on lib.dom's version of it.
 *
 * `reset` is optional because an older Chromium ships `playEffect` without it, and a pad that can
 * play an effect can always be stopped by a zero one — which is what `stopRumble` falls back to.
 */
export interface RawHapticActuator {
  playEffect(type: string, params: Readonly<Record<string, number>>): Promise<string>;
  reset?(): Promise<string>;
}

/**
 * The specification's ceiling on one effect, in milliseconds.
 *
 * Clamped here rather than left to the platform, because a longer request is not an error the
 * caller can see: the promise resolves with a word nobody reads, and browsers differ on whether
 * they clamp it or drop it. A caller wanting a longer rumble re-issues, which it has to anyway —
 * any effect can be preempted by the next one.
 */
export const MAX_RUMBLE_MS = 5000;

/**
 * The parameters, claimed once.
 *
 * `playEffect` converts this to a dictionary synchronously at the call, so one object rewritten in
 * place is safe and is what the hot-path rule asks for even though a rumble is an event rather
 * than a frame.
 */
const params: Record<string, number> = {
  duration: 0,
  startDelay: 0,
  strongMagnitude: 0,
  weakMagnitude: 0,
};

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Play one dual-rumble effect. Answers whether the platform took it.
 *
 * `false` means the caller should stop offering the control, and it is answered for three separate
 * states that are one thing to a player: no actuator, an actuator this browser cannot drive, and a
 * duration there is nothing to play for.
 *
 * A rejection is swallowed and reported through `onFailure`, once per pad. `playEffect` rejects
 * when the pad goes away mid-effect, which is a thing a player does with a cable; an unhandled
 * rejection is a stack trace nobody can act on, and silence leaves a player whose pad stopped
 * rumbling with nothing to read. **This never throws**, because it is reachable from a frame.
 */
export function playRumble(
  actuator: RawHapticActuator | null,
  durationMs: number,
  strong: number,
  weak: number,
  onFailure: () => void,
): boolean {
  if (actuator === null || typeof actuator.playEffect !== 'function') return false;
  if (!(durationMs > 0)) return false;

  params.duration = durationMs > MAX_RUMBLE_MS ? MAX_RUMBLE_MS : durationMs;
  params.strongMagnitude = clamp01(strong);
  params.weakMagnitude = clamp01(weak);
  return dispatch(actuator, onFailure);
}

/**
 * Stop whatever is playing. Answers whether the platform took it.
 *
 * `reset` where the actuator has one, and a zero effect where it does not — a zero-magnitude,
 * zero-duration effect preempts the one in flight, which is the same result by the specification's
 * own rule about preemption. Answering `false` for a missing `reset` would grey out a control the
 * hardware can honour.
 */
export function stopRumble(actuator: RawHapticActuator | null, onFailure: () => void): boolean {
  if (actuator === null || typeof actuator.playEffect !== 'function') return false;
  if (typeof actuator.reset === 'function') {
    swallow(actuator.reset(), onFailure);
    return true;
  }
  params.duration = 0;
  params.strongMagnitude = 0;
  params.weakMagnitude = 0;
  return dispatch(actuator, onFailure);
}

function dispatch(actuator: RawHapticActuator, onFailure: () => void): boolean {
  /*
   * The call itself is guarded, not only its promise. A browser that rejects the *arguments* throws
   * synchronously rather than rejecting, and this is reachable from a frame — where the house rule
   * is that nothing throws.
   */
  try {
    swallow(actuator.playEffect('dual-rumble', params), onFailure);
  } catch {
    onFailure();
    return false;
  }
  return true;
}

function swallow(result: Promise<string> | undefined, onFailure: () => void): void {
  if (result === undefined || typeof result.then !== 'function') return;
  void result.then(undefined, onFailure);
}
