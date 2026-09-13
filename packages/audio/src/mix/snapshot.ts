import type { MixBus } from './bus.ts';
import type { MixConsole } from './console.ts';

/**
 * A mix, remembered: every fader, every mute and every send, at one instant.
 *
 * **Insert parameters are deliberately absent**, and that is the whole design decision here. The
 * master filter's cutoff is written every frame from whatever the game is doing; a snapshot that
 * captured it would fight that writer, and the winner would be whichever wrote last — which is
 * heard as a filter that sometimes sticks and cannot be reproduced on purpose.
 *
 * Cost: "underwater" as a snapshot carries its levels and its sends but not its filter, so a
 * consumer wanting both recalls the snapshot and sets the cutoff itself. What would make this wrong
 * is an insert parameter no per-frame code ever touches, which is when capturing it costs nothing;
 * this clause is what to revisit if one arrives.
 */
export interface MixSnapshot {
  readonly levels: ReadonlyMap<string, number>;
  readonly mutes: ReadonlyMap<string, boolean>;
  /** Per bus name, per return bus name, the amount that bus was sending. */
  readonly sends: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export function captureSnapshot(mix: MixConsole): MixSnapshot {
  const levels = new Map<string, number>();
  const mutes = new Map<string, boolean>();
  const sends = new Map<string, ReadonlyMap<string, number>>();
  for (const bus of mix.all) {
    levels.set(bus.name, bus.level);
    mutes.set(bus.name, bus.muted);
    const perTarget = new Map<string, number>();
    for (const target of bus.sendTargets) perTarget.set(target.name, bus.sendAmount(target));
    if (perTarget.size > 0) sends.set(bus.name, perTarget);
  }
  return { levels, mutes, sends };
}

/**
 * Move the mix back to a captured one, over `seconds`.
 *
 * **A bus the snapshot never saw is left alone**, rather than reset to a default. A snapshot is a
 * record of what was, not an assertion about what must be, and silencing a bus that did not exist
 * when it was taken is a recall destroying state it knows nothing about — a reverb zone registered
 * after a mix was captured, say, going silent the first time anybody recalls it.
 */
export function recallSnapshot(mix: MixConsole, snapshot: MixSnapshot, seconds: number): void {
  for (const [name, level] of snapshot.levels) {
    const bus = mix.find(name);
    if (bus === undefined) continue;
    applyLevel(bus, level, seconds);
    bus.setMute(snapshot.mutes.get(name) ?? false);
  }
  for (const [name, perTarget] of snapshot.sends) {
    const bus = mix.find(name);
    if (bus === undefined) continue;
    for (const [targetName, amount] of perTarget) {
      const target = mix.find(targetName);
      if (target !== undefined) bus.send(target, amount);
    }
  }
}

/**
 * `seconds` is the crossfade, and zero means immediately.
 *
 * A bus's own `setLevel` ramps at the mix's standard smoothing, which is right for a fader and
 * wrong for a scene change: a snapshot recalled over three seconds has to take three seconds.
 */
function applyLevel(bus: MixBus, level: number, seconds: number): void {
  if (seconds <= 0) {
    bus.setLevel(level);
    return;
  }
  bus.fadeLevel(level, seconds);
}
