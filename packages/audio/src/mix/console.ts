import type { ScheduleClock } from '../ambientLoop.ts';
import { MixBus, type BusOptions } from './bus.ts';
import { captureSnapshot, recallSnapshot, type MixSnapshot } from './snapshot.ts';

export type { MixSnapshot };

/**
 * The mixer: a tree of buses, and the one place that can answer a question about all of them.
 *
 * A bus knows its own level and its own parent. Solo is the question no bus can answer alone —
 * "is anything else soloed, and am I part of it" is a property of the whole tree — so the tree is
 * held here and every bus asks this when its own solo changes.
 *
 * **Everything scheduled through one clock.** `at()` and `scheduleAt()` are the same pair
 * `AudioGraph` has always had, and for the same reason: offline there is no "now", so a render
 * describes its whole timeline against instants a caller supplies. Every bus is handed this clock
 * at construction, so there is exactly one answer to "when" in a mix rather than one per node.
 */
export interface MixConsoleOptions {
  /** Where "now" is. Defaults to the context's own clock, which is what a live mix wants. */
  readonly scheduleAt?: ScheduleClock;
  /**
   * Where randomness comes from, for anything this console builds that needs it — today, the noise
   * an impulse response is made of.
   *
   * Defaults to `Math.random`, and exists because a reverb built from an unseeded generator is a
   * different reverb on every construction, so nothing carrying wet signal can be asserted exactly.
   * The same rule `AGENTS.md` applies to storage and to clocks: take the capability as a parameter
   * and ship the browser's as the default.
   *
   * Cost: a caller that seeds this gets a reproducible reverb and also a *worse-sounding* one if
   * they seed it badly, because the tail's quality is the quality of its noise. What would make
   * this wrong is a consumer using it to make the reverb deterministic in production, which is
   * solving a problem nobody has at the price of one they will.
   */
  readonly random?: () => number;
}

export class MixConsole {
  /** Everything ends up here. Its insert chain is where a master filter belongs. */
  readonly master: MixBus;
  /**
   * What reaches the speakers, summed in one place.
   *
   * The same node, for the same reason, as the `out` that `AudioGraph` grew after every exported
   * clip turned out to be missing its send returns: "what the player hears" has to be a node, or
   * the moment anything wants to listen to the mix there is nowhere to listen.
   */
  readonly out: GainNode;

  private readonly buses = new Map<string, MixBus>();
  private readonly snapshots = new Map<string, MixSnapshot>();
  private atSec: number | null = null;
  private readonly randomSource: () => number;

  constructor(
    readonly context: BaseAudioContext,
    options: MixConsoleOptions = {},
  ) {
    this.randomSource = options.random ?? Math.random;
    /*
     * One clock, and it may belong to somebody else. A graph that owns a transport already answers
     * "when" for its own scheduling, and two answers to that question is how a move ends up on
     * instant zero in a render that asked for it at three seconds.
     */
    this.clock = options.scheduleAt ?? ((): number => this.atSec ?? this.context.currentTime);

    this.out = context.createGain();
    this.out.connect(context.destination);
    this.master = new MixBus('master', context, () => this.scheduleAt());
    this.master.output.connect(this.out);
    this.adopt(this.master);
  }

  private readonly clock: ScheduleClock;

  /**
   * The bus called `name`, created under `master` if it does not exist yet.
   *
   * One verb rather than a create and a get, because a caller declaring a bus at startup and a
   * caller reaching for one by name are asking the same question, and two verbs would mean choosing
   * between them on every line. Cost: a typo makes a bus instead of an error. What would make this
   * wrong is a console large enough to lose one in, which is when a caller should be holding the
   * reference rather than the name.
   */
  bus(name: string, options: BusOptions = {}): MixBus {
    const existing = this.buses.get(name);
    if (existing !== undefined) return existing;
    const created = new MixBus(name, this.context, () => this.scheduleAt(), {
      ...options,
      // `undefined` means "the usual place"; an explicit `null` means the caller wires it.
      parent: options.parent === undefined ? this.master : options.parent,
    });
    this.adopt(created);
    // A bus born while somebody is soloing must arrive already silenced, not at full level.
    this.resolveSolo();
    return created;
  }

  find(name: string): MixBus | undefined {
    return this.buses.get(name);
  }

  get all(): readonly MixBus[] {
    return [...this.buses.values()];
  }

  private adopt(bus: MixBus): void {
    this.buses.set(bus.name, bus);
    bus.onSoloChanged = () => this.resolveSolo();
  }

  /**
   * Recompute every bus's solo gate.
   *
   * A bus is audible under solo if it *is* soloed, contains one, or is contained by one. Walked
   * from scratch on every change rather than cached: the set of soloed buses is tiny, and a person
   * pressing solo is not a per-frame path. Cost: O(buses × soloed) per toggle, which at the size a
   * game mixes at is nothing. What would make this wrong is a console with thousands of buses,
   * which is not what this is for.
   */
  private resolveSolo(): void {
    const soloed = [...this.buses.values()].filter((bus) => bus.soloed);
    if (soloed.length === 0) {
      for (const bus of this.buses.values()) bus.setSoloGate(1);
      return;
    }
    for (const bus of this.buses.values()) {
      const audible = soloed.some(
        (one) => one === bus || isAncestorOf(one, bus) || isAncestorOf(bus, one),
      );
      bus.setSoloGate(audible ? 1 : 0);
    }
  }

  /**
   * Schedule everything that follows at `seconds` on this context's timeline, or at "now" when null.
   *
   * An offline render sets it once per frame and gets a mix whose every move lands exactly where
   * the picture is. Live callers never touch it.
   *
   * **Has no effect when a `scheduleAt` was supplied**, because then somebody else owns the answer
   * and this console is a reader of it. That is the case whenever an `AudioGraph` built the
   * console: the transport's own `at()` is the one to call.
   */
  at(seconds: number | null): void {
    this.atSec = seconds;
  }

  /** The instant scheduled work lands on. One reader, so "when" has one answer in a mix. */
  scheduleAt(): number {
    return this.clock();
  }

  /** See `MixConsoleOptions.random`. */
  random(): number {
    return this.randomSource();
  }

  /** Capture every level, mute and send, under a name. */
  snapshot(name: string): MixSnapshot {
    const captured = captureSnapshot(this);
    this.snapshots.set(name, captured);
    return captured;
  }

  /** Crossfade back to a captured snapshot over `seconds`. */
  recall(name: string, seconds = 0): void {
    const captured = this.snapshots.get(name);
    if (captured === undefined) return;
    recallSnapshot(this, captured, seconds);
  }
}

/** Whether `bus` is anywhere below `maybeAncestor` in the tree. */
function isAncestorOf(maybeAncestor: MixBus, bus: MixBus): boolean {
  for (let walk = bus.parent; walk !== null; walk = walk.parent) {
    if (walk === maybeAncestor) return true;
  }
  return false;
}
