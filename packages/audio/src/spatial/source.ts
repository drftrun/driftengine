import type { MixBus } from '../mix/bus.ts';
import { ProbeScheduler, occlusionCutoffHz, occlusionGainFor, smoothToward } from './occlusion.ts';
import type { AudioListenerGraph } from './listener.ts';
import { type ReverbZone, SourceZoneSend, busFeeds } from './zones.ts';

/**
 * A sound placed in the world, heard from where the listener is standing.
 *
 * ```
 *   buffer source ─ detune ─→ occlusion lowpass ─→ occlusion gain ─→ panner (HRTF) ─→ a bus
 * ```
 *
 * **A function rather than a method on the console, and that is a size decision rather than a
 * style one.** A method would be a static reference from the mix to the panner, which no bundler
 * can shake out, so every consumer that imports the mix would carry the HRTF machinery whether or
 * not it ever places a sound. `scripts/size-gate.test.mjs` publishes what each package costs and
 * promises you pay only for what you import; this is what keeps that true.
 *
 * **This is the expensive path and it is meant to be.** `distanceGain` and `stereoPan` still exist
 * and are still right for a fire, a shoreline or a storm column — diffuse things where what a
 * player reads is "how close" and "which way". Reach for a panner when the *direction* is
 * information: a footstep behind you, a voice through a doorway, something you are meant to turn
 * towards.
 */
export interface SpatialOptions {
  /** Where this lands in the mix. The console's `effects` bus when omitted. */
  readonly bus?: MixBus;
  readonly loop?: boolean;
  /**
   * Shift the pitch with relative motion.
   *
   * **Off by default, deliberately.** On a looping bed — a fire, a waterfall — a listener walking
   * past makes the bed's pitch wander, which reads as the sound being broken rather than as motion.
   * Turn it on for something that genuinely passes: a vehicle, a projectile, a siren.
   */
  readonly doppler?: boolean;
  /** Metres per second. 343 in air; a game whose world is not in metres will want its own. */
  readonly speedOfSound?: number;
  /** How far the pitch is allowed to move, in cents. A whole tone each way by default. */
  readonly maxDopplerCents?: number;
  /** Distance-model parameters, passed to the panner unchanged. */
  readonly refDistance?: number;
  readonly maxDistance?: number;
  readonly rolloff?: number;
  /**
   * How fast occlusion follows the world, per second.
   *
   * Slow enough that a probe landing on a different answer does not click, fast enough that walking
   * through a doorway is heard as walking through a doorway.
   */
  readonly occlusionRate?: number;
}

/**
 * How long a zone send takes to reach a new value, as `setTargetAtTime`'s time constant.
 *
 * The same shape `MixBus` ramps its own sends with, and for the same reason: a send stepping to a
 * new value is a click, and a source crossing a threshold is exactly when that would happen.
 */
const ZONE_RAMP = 0.03;

/**
 * Buses already warned about, so the refusal is once per misconfigured bus rather than once per
 * source. A game with two hundred sources on one wrong bus is one line, not two hundred; a game
 * with two wrong buses is two lines, which is two things to fix. See `attachZone`.
 */
const warnedDoubleZoneBuses = new Set<string>();

const DEFAULT_SPEED_OF_SOUND = 343;
const DEFAULT_MAX_DOPPLER_CENTS = 200;
const DEFAULT_OCCLUSION_RATE = 6;

export class SpatialSource {
  private readonly node: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly panner: PannerNode;
  private readonly probes = new ProbeScheduler();
  private readonly slot: number;

  private posX = 0;
  private posY = 0;
  private posZ = 0;
  private velX = 0;
  private velY = 0;
  private velZ = 0;
  private placed = false;
  private occlusionTarget = 0;
  private occlusionNow = 0;
  private cents = 0;
  private started = false;
  private stopped = false;
  /**
   * The zones this source carries the tail of, from its own position.
   *
   * An array rather than a map, because it is walked every frame and never looked up by key — the
   * budget below caps it at a handful, and `resolveZones`'s own reason for a two-slot scan over a
   * sort applies here one level down.
   */
  private readonly zoneSends: SourceZoneSend[] = [];

  constructor(
    private readonly listener: AudioListenerGraph,
    buffer: AudioBuffer,
    private readonly options: SpatialOptions = {},
  ) {
    const mix = listener.console;
    const context = mix.context;
    this.slot = listener.claimProbeSlot();

    this.node = context.createBufferSource();
    this.node.buffer = buffer;
    this.node.loop = options.loop === true;

    this.filter = context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = occlusionCutoffHz(0);
    this.filter.Q.value = 0.707;

    this.gain = context.createGain();
    this.gain.gain.value = 1;

    this.panner = context.createPanner();
    /*
     * The whole reason this class exists. `equalpower` is a stereo balance and says nothing about
     * front, back or height; `HRTF` convolves against a head model, which is what puts a sound
     * *behind* somebody. It costs a convolution per source, which is why the cheap path is kept
     * beside it rather than replaced by it.
     */
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = options.refDistance ?? 1;
    this.panner.maxDistance = options.maxDistance ?? 10000;
    this.panner.rolloffFactor = options.rolloff ?? 1;

    this.node.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(this.panner);
    this.bus = options.bus ?? mix.bus('effects');
    this.panner.connect(this.bus.input);
  }

  /** Where this source's dry signal lands, which is what decides whether a zone would double. */
  private readonly bus: MixBus;

  /**
   * Carry the tail of a space this **source** is in, rather than one the listener is in.
   *
   * The case `zones.ts` names as the one its own model cannot serve: a sound inside a cave heard
   * from outside carries whatever space the *listener* stands in, which is wrong exactly when
   * somebody is listening *into* a space. A source-attached zone is a second **routing** into a
   * return that already carries a convolver, so it costs one `GainNode` rather than one convolution.
   *
   * **`MAX_OPEN_ZONES` still binds, and it binds per source.** The budget is not about the sends,
   * which are nearly free; it is about how many convolvers are audible at once, and a source driving
   * four returns makes four of them audible. Two is the space being left and the space being
   * entered, here as for the listener.
   *
   * The send is taken from the **occluded, unpanned** signal: a reverb send comes off the channel on
   * any console, and the return is itself a stereo space, so a point-panned tail would arrive from
   * the source's direction rather than from the room. Occlusion is upstream because a sound behind a
   * wall has a muffled tail too.
   */
  attachZone(zone: ReverbZone): void {
    if (this.zoneSends.some((send) => send.zone === zone)) return;
    /*
     * **Both routings into one return double the tail, and it is silent.** The listener's zones send
     * from a whole bus, so a source sitting on that bus — or on a descendant of it — is already
     * reaching this return whenever the listener is in the same space. Said here, which is setup,
     * once per process rather than once per source.
     */
    if (!warnedDoubleZoneBuses.has(this.bus.name) && busFeeds(this.bus, zone.from)) {
      warnedDoubleZoneBuses.add(this.bus.name);
      console.warn(
        `[driftengine] a source on bus "${this.bus.name}" attached the zone "${zone.name}", which ` +
          `is fed from "${zone.from.name}" — the same signal reaches that return twice whenever ` +
          'the listener is in the same space. Put source-zoned sources on a bus outside the ' +
          "zone's own feed.",
      );
    }
    const context = this.listener.console.context;
    const gain = context.createGain();
    gain.gain.value = 0;
    this.gain.connect(gain);
    gain.connect(zone.bus.input);
    this.zoneSends.push(
      new SourceZoneSend(zone, gain, (param, value) => {
        const at = this.listener.console.scheduleAt();
        param.cancelScheduledValues(at);
        param.setTargetAtTime(value, at, ZONE_RAMP);
      }),
    );
  }

  /** What this source is currently sending into that zone's return. */
  zoneSend(zone: ReverbZone): number {
    return this.zoneSends.find((send) => send.zone === zone)?.value ?? 0;
  }

  /** The pitch shift currently applied, in cents. Zero with doppler off. */
  get detuneCents(): number {
    return this.cents;
  }

  /** How blocked this source is right now, after smoothing. */
  get occlusion(): number {
    return this.occlusionNow;
  }

  /**
   * Where this source is, this frame.
   *
   * Velocity is derived here exactly as the listener derives its own, and for the same reason. A
   * source that teleports should be moved with `warp`.
   */
  place(x: number, y: number, z: number, dtSec: number): void {
    if (this.placed && dtSec > 0) {
      this.velX = (x - this.posX) / dtSec;
      this.velY = (y - this.posY) / dtSec;
      this.velZ = (z - this.posZ) / dtSec;
    }
    this.posX = x;
    this.posY = y;
    this.posZ = z;
    this.placed = true;

    this.writePosition(x, y, z);

    this.updateDoppler();
    this.updateOcclusion(dtSec);
    this.updateZones(x, y, z);
  }

  /** Move without having travelled: a respawn, a cut, an object put back at the start. */
  warp(x: number, y: number, z: number): void {
    this.posX = x;
    this.posY = y;
    this.posZ = z;
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.placed = true;
  }

  /**
   * Say how blocked this source is, 0 clear to 1 solid.
   *
   * For a consumer that already knows — a door with a state, a sound that is definitionally
   * indoors — and for anyone who would rather not hand the listener a probe. Overrides whatever the
   * probe last answered until the probe answers again.
   */
  setOcclusion(amount: number): void {
    this.occlusionTarget = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 1) : 0;
  }

  start(when = 0): void {
    if (this.started) return;
    this.started = true;
    this.node.start(when);
  }

  stop(): void {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    try {
      this.node.stop();
    } catch {
      // Already ended. Nothing to undo about a node we were about to discard.
    }
  }

  /**
   * Which of this source's zones sound, from where the source is standing.
   *
   * The same two-slot scan `resolveZones` makes for the listener, written out here rather than
   * shared because the listener's version fills a `Map` keyed by zone and this one walks an array
   * of sends — the ranking is six lines and a shared version taking both shapes would be longer
   * than either. What would make that wrong is a third caller.
   *
   * **Two slots is `MAX_OPEN_ZONES`**, written out rather than looped because two is what a
   * crossfade needs. `sourceZone.test.ts` asserts the constant is still two, so raising it fails
   * there and sends whoever raised it to read this.
   */
  private updateZones(x: number, y: number, z: number): void {
    if (this.zoneSends.length === 0) return;
    let best: SourceZoneSend | null = null;
    let bestAmount = 0;
    let second: SourceZoneSend | null = null;
    let secondAmount = 0;

    for (const send of this.zoneSends) {
      const amount = send.zone.amountAt(x, y, z);
      if (amount <= 0) continue;
      if (amount > bestAmount) {
        second = best;
        secondAmount = bestAmount;
        best = send;
        bestAmount = amount;
      } else if (amount > secondAmount) {
        second = send;
        secondAmount = amount;
      }
    }
    for (const send of this.zoneSends) {
      if (send === best) send.set(bestAmount);
      else if (send === second) send.set(secondAmount);
      else send.set(0);
    }
  }

  dispose(): void {
    this.stop();
    for (const send of this.zoneSends) send.dispose();
    this.zoneSends.length = 0;
    try {
      this.panner.disconnect();
      this.gain.disconnect();
      this.filter.disconnect();
      this.node.disconnect();
    } catch {
      // The graph was torn down under us; there is nothing left to disconnect from.
    }
    this.probes.forget(this.slot);
  }

  /**
   * Where the panner thinks this source is, through whichever surface the browser has.
   *
   * The same pair as the listener's, for the same reason and with the same cost: the deprecated
   * setter steps where the parameters can glide. Assigned rather than ramped on both paths, because
   * this is written every frame and the interpolation that matters is the panner's own, between
   * render blocks.
   */
  private writePosition(x: number, y: number, z: number): void {
    const modern = this.panner as unknown as Record<string, { value: number } | undefined>;
    if (modern.positionX !== undefined) {
      modern.positionX.value = x;
      if (modern.positionY !== undefined) modern.positionY.value = y;
      if (modern.positionZ !== undefined) modern.positionZ.value = z;
      return;
    }
    (
      this.panner as unknown as { setPosition?: (x: number, y: number, z: number) => void }
    ).setPosition?.(x, y, z);
  }

  /**
   * The doppler ratio, and why it is ours to compute.
   *
   * `PannerNode` carried `dopplerFactor` and `speedOfSound` and the specification removed both, so
   * there is nothing to configure and nothing to fall back to: the shift is arithmetic on two
   * velocities projected onto the line between the two objects.
   *
   * With `d` the unit vector from listener to source, the ratio is
   * `(c + vListener·d) / (c + vSource·d)` — a listener closing on a source raises the numerator, a
   * source closing on the listener lowers the denominator, and both raise the pitch.
   *
   * Clamped in cents rather than in ratio, because cents are what a listener hears: a whole tone
   * each way is a strong, obviously-moving effect and anything past it stops reading as motion.
   * Cost: a deliberately supersonic source stops shifting at the clamp instead of doing something
   * dramatic. What would make this wrong is a game whose subject *is* the sonic boom, which wants a
   * different model rather than a wider clamp.
   */
  private updateDoppler(): void {
    if (this.options.doppler !== true) {
      this.cents = 0;
      return;
    }
    const dx = this.posX - this.listener.x;
    const dy = this.posY - this.listener.y;
    const dz = this.posZ - this.listener.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-4) {
      this.cents = 0;
      return;
    }
    const ux = dx / distance;
    const uy = dy / distance;
    const uz = dz / distance;
    const c = this.options.speedOfSound ?? DEFAULT_SPEED_OF_SOUND;
    const towardListener =
      this.listener.velocityX * ux + this.listener.velocityY * uy + this.listener.velocityZ * uz;
    const towardSource = this.velX * ux + this.velY * uy + this.velZ * uz;
    const denominator = c + towardSource;
    if (!(denominator > 1e-3)) {
      this.cents = this.options.maxDopplerCents ?? DEFAULT_MAX_DOPPLER_CENTS;
      this.writeDetune();
      return;
    }
    const ratio = (c + towardListener) / denominator;
    const limit = this.options.maxDopplerCents ?? DEFAULT_MAX_DOPPLER_CENTS;
    this.cents = Math.min(Math.max(1200 * Math.log2(ratio), -limit), limit);
    this.writeDetune();
  }

  /**
   * Apply the shift, through `detune` where the browser has it and `playbackRate` where it does not.
   *
   * `detune` is in cents, which is the unit the arithmetic above produces and the unit a musician
   * would state it in. `playbackRate` is the ratio, and it is the older surface: converting back is
   * exact, so the fallback is a different spelling rather than a different effect.
   */
  private writeDetune(): void {
    const detune = (this.node as { detune?: AudioParam }).detune;
    if (detune !== undefined) {
      detune.value = this.cents;
      return;
    }
    this.node.playbackRate.value = 2 ** (this.cents / 1200);
  }

  /**
   * Ask the world whether something is in the way, at most once per period, then approach it.
   *
   * The probe is the consumer's own collision code and is the expensive part; the smoothing is what
   * keeps a probe that lands on a different answer from clicking.
   */
  private updateOcclusion(dtSec: number): void {
    const probe = this.listener.probe;
    if (
      probe !== null &&
      this.probes.due(this.slot, this.listener.probeSlots, this.listener.elapsedSec)
    ) {
      const blocked = probe(
        this.listener.x,
        this.listener.y,
        this.listener.z,
        this.posX,
        this.posY,
        this.posZ,
      );
      this.occlusionTarget = Number.isFinite(blocked) ? Math.min(Math.max(blocked, 0), 1) : 0;
    }
    const rate = this.options.occlusionRate ?? DEFAULT_OCCLUSION_RATE;
    const next = smoothToward(this.occlusionNow, this.occlusionTarget, rate, dtSec);
    if (Math.abs(next - this.occlusionNow) < 1e-4) return;
    this.occlusionNow = next;
    // Assigned rather than ramped: this is already a smoothed value written every frame, and a ramp
    // per frame on top of it would schedule sixty events a second to reach a target that has moved.
    this.filter.frequency.value = occlusionCutoffHz(next);
    this.gain.gain.value = occlusionGainFor(next);
  }
}

/** Place a sound in the world. See `SpatialSource` for when this is the right tool and when it is not. */
export function createSpatialSource(
  listener: AudioListenerGraph,
  buffer: AudioBuffer,
  options?: SpatialOptions,
): SpatialSource {
  return new SpatialSource(listener, buffer, options);
}
