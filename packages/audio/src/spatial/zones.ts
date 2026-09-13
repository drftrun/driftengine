import type { MixBus } from '../mix/bus.ts';
import { convolverInsert } from '../mix/returns.ts';
import type { AudioListenerGraph } from './listener.ts';

/**
 * A space the listener can be inside, and the tail it lends to everything heard there.
 *
 * A zone is a **return bus carrying a convolver**, which is the point of having built a mix tree
 * rather than a fixed set of sends: a room is not a special case in the mixer, it is a bus like any
 * other, and the listener simply decides how much goes to it.
 *
 * **Listener-based, and that is the whole model.** Whichever space the listener occupies decides
 * the reverb, for every source at once. Cost: a sound inside a cave heard from *outside* it does
 * not carry the cave's tail — it carries whatever space the listener is standing in, which is wrong
 * in exactly the case where somebody is listening into a space rather than standing in one. The
 * alternative is a convolver per source, which is the general answer and is priced accordingly.
 * What would make this wrong is a scene whose drama is standing at a threshold listening in; that
 * is when to pay for the other model.
 */
export interface ZoneShape {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Inside this, the zone is at full wet. */
  readonly radius: number;
  /** Metres beyond the radius over which it fades out. Zero is a hard edge, which is audible. */
  readonly blend: number;
}

export interface ZoneOptions {
  /** How long the tail is. */
  readonly seconds: number;
  /** How fast it decays inside that. Larger is a drier, tighter room. */
  readonly decay: number;
  /** How much reaches the return when the listener is fully inside. */
  readonly wet: number;
  /**
   * What feeds this zone. The console's `effects` bus when omitted.
   *
   * A zone is a property of the *world*, so what it should carry is the world's own sound. A
   * consumer with its own tree names the bus; one using the default layout gets the bus every
   * placed source and ambient loop already lands on.
   */
  readonly from?: MixBus;
}

/**
 * How many zones may sound at once.
 *
 * Two: the space being left and the space being entered. A convolver is the most expensive node in
 * this graph and N of them is N times that, and a third is inaudible under a crossfade between the
 * first two while costing everything a second one costs.
 */
export const MAX_OPEN_ZONES = 2;

export class ReverbZone {
  constructor(
    readonly name: string,
    readonly shape: ZoneShape,
    readonly wet: number,
    /** The return, carrying the convolver. */
    readonly bus: MixBus,
    /** What feeds it. */
    readonly from: MixBus,
  ) {}

  /**
   * How much of the world this zone should be carrying, from a listener at this point.
   *
   * Full inside the radius, fading to nothing across `blend`, zero beyond. A hard edge is audible
   * as the room switching on, which is the one thing a reverb must never do.
   */
  amountAt(x: number, y: number, z: number): number {
    const distance = Math.hypot(x - this.shape.x, y - this.shape.y, z - this.shape.z);
    if (distance <= this.shape.radius) return this.wet;
    if (!(this.shape.blend > 0)) return 0;
    const past = distance - this.shape.radius;
    if (past >= this.shape.blend) return 0;
    return this.wet * (1 - past / this.shape.blend);
  }
}

/**
 * Register a space. **Its convolver is built here and never on entry.**
 *
 * Building an impulse allocates a stereo buffer and fills it sample by sample, which costs
 * milliseconds; doing that when a player crosses a threshold would put both the allocation and the
 * cost on the input path at the exact moment something is supposed to happen. `graph.ts` already
 * refuses to do it on a jump for the same reason.
 *
 * The return is parented to `master`, so a zone's tail goes through the master filter. **That is
 * deliberately unlike the three legacy returns**, which join downstream of it: those carry the
 * score, and a score is not in the world. A zone is the world, and the master filter is what "under
 * water" means for it — a room whose tail stayed bright while everything else muffled would read as
 * the reverb having come from somewhere else.
 */
export function addReverbZone(
  listener: AudioListenerGraph,
  name: string,
  shape: ZoneShape,
  options: ZoneOptions,
): ReverbZone {
  const mix = listener.console;
  const bus = mix.bus(name);
  bus.insert(convolverInsert(mix.context, options.seconds, options.decay, () => mix.random()));
  const from = options.from ?? mix.bus('effects');
  // At zero: a zone that springs into existence sending is a room that switches on.
  from.send(bus, 0);
  const zone = new ReverbZone(name, shape, options.wet, bus, from);
  listener.addZone(zone);
  return zone;
}

/**
 * A source's own routing into one zone's return.
 *
 * **A second routing, not a second convolver**, which is the whole reason this is affordable: the
 * zone's return already carries a convolver built at registration, and this is one `GainNode` from
 * the source into that same input. A convolver per source is the general answer to spatial reverb
 * and is priced accordingly — `zones.ts` has said so since it was written, and this row is what
 * that sentence was waiting for.
 *
 * **Taken before the panner and after the occlusion.** A reverb send is taken from the channel on
 * any console, and the return is itself a stereo space: a tail that arrived point-panned would come
 * from the source's direction rather than from the room. Occlusion is upstream on purpose, because
 * a sound behind a wall has a muffled tail too.
 */
export class SourceZoneSend {
  private amount = 0;

  constructor(
    readonly zone: ReverbZone,
    private readonly gain: GainNode,
    private readonly rampTo: (param: AudioParam, value: number) => void,
  ) {}

  /** What this source is currently sending into that return. */
  get value(): number {
    return this.amount;
  }

  /** Ramped rather than assigned, because a send stepping to a new value is a click. */
  set(value: number): void {
    const floored = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (floored === this.amount) return;
    this.amount = floored;
    this.rampTo(this.gain.gain, floored);
  }

  dispose(): void {
    this.amount = 0;
    try {
      this.gain.disconnect();
    } catch {
      // The graph was torn down under us; there is nothing left to disconnect from.
    }
  }
}

/**
 * Whether `bus` reaches `target` by its parent chain, so a send into `target` would double.
 *
 * The listener's zones send from a whole bus, so anything landing on that bus **or on a descendant
 * of it** is already reaching the return whenever the listener is in the same space. Walking the
 * chain rather than comparing one reference is the difference between catching the obvious case and
 * catching the case a consumer with its own tree actually builds.
 */
export function busFeeds(bus: MixBus, target: MixBus): boolean {
  for (let at: MixBus | null = bus; at !== null; at = at.parent) {
    if (at === target) return true;
  }
  return false;
}

/**
 * Decide what every zone should be sending, and close everything past the nearest two.
 *
 * Called once per listener move. Allocation-free: the ranking is a two-slot scan rather than a
 * sort, because this runs every frame and a sort of a small array still allocates a comparator's
 * worth of work sixty times a second.
 */
export function resolveZones(
  zones: readonly ReverbZone[],
  x: number,
  y: number,
  z: number,
  out: Map<ReverbZone, number>,
): void {
  let bestZone: ReverbZone | null = null;
  let bestAmount = 0;
  let secondZone: ReverbZone | null = null;
  let secondAmount = 0;

  for (const zone of zones) {
    const amount = zone.amountAt(x, y, z);
    if (amount <= 0) continue;
    if (amount > bestAmount) {
      secondZone = bestZone;
      secondAmount = bestAmount;
      bestZone = zone;
      bestAmount = amount;
    } else if (amount > secondAmount) {
      secondZone = zone;
      secondAmount = amount;
    }
  }

  for (const zone of zones) {
    if (zone === bestZone) out.set(zone, bestAmount);
    else if (zone === secondZone) out.set(zone, secondAmount);
    else out.set(zone, 0);
  }
}
