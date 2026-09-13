/**
 * A continuous environmental sound: a looping buffer whose level and stereo
 * position are driven every frame by whatever the game decides is nearby.
 *
 * Not a full spatial audio node. A panner per source with an HRTF would be the
 * general answer, but the sources this is for — a fire, a shoreline, wind —
 * are diffuse and often several at once, and what actually communicates them is
 * "how close" and "which side". Those are two numbers, and paying for a panner
 * graph per brazier to produce them would be the expensive way to get the same
 * result.
 *
 * Both setters are change-gated. They are called once per frame, and scheduling
 * an `AudioParam` ramp sixty times a second for a value that has not moved is
 * work the audio thread does not need.
 */
const RAMP = 0.12;
/** Below this the ramp is inaudible; above it, skipping the update is not. */
const EPSILON = 0.004;

/**
 * Where "now" comes from, for work this loop schedules.
 *
 * Supplied rather than read off the context, because a *rendered* mix has no
 * "now": an `OfflineAudioContext` holds `currentTime` at zero for as long as the
 * caller is describing the timeline, so a loop reading it directly would stack
 * every level change a clip ever makes onto instant zero and play the last one
 * for the whole file. A fire the character sprints past would sit at its parting
 * distance from the opening frame.
 *
 * The graph that owns the loop already has exactly one answer to this question
 * for exactly this reason; this is how a loop gets to share it.
 */
export type ScheduleClock = () => number;

export class AmbientLoop {
  private lastGain = 0;
  private lastPan = 0;
  private stopped = false;

  /**
   * @param scheduleAt the instant this loop's changes land on. See `ScheduleClock`.
   * @param source the looping buffer source, already started.
   * @param gainNode its level, initially silent.
   * @param panNode present only where the browser supports stereo panning.
   */
  constructor(
    private readonly scheduleAt: ScheduleClock,
    private readonly source: AudioBufferSourceNode,
    private readonly gainNode: GainNode,
    private readonly panNode: StereoPannerNode | null,
  ) {}

  private rate = 1;

  /** 0 is silent, 1 is the buffer at its authored level. */
  setGain(gain: number): void {
    const next = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 0;
    if (Math.abs(next - this.lastGain) < EPSILON) return;
    this.lastGain = next;
    this.ramp(this.gainNode.gain, next);
  }

  /**
   * Pitch the bed, for a loop whose *state* should be audible.
   *
   * Ramped like gain and pan rather than set, because a stepped playback rate
   * on a continuous source is a click. Change-gated by the same rule: a rate
   * written every frame would schedule sixty ramps a second.
   */
  setRate(rate: number): void {
    const next = Math.max(0.05, rate);
    if (Math.abs(next - this.rate) < 0.005) return;
    this.rate = next;
    this.ramp(this.source.playbackRate, next);
  }

  /** -1 hard left, 0 centre, 1 hard right. A no-op without stereo panning. */
  setPan(pan: number): void {
    if (this.panNode === null) return;
    const next = Number.isFinite(pan) ? Math.min(Math.max(pan, -1), 1) : 0;
    if (Math.abs(next - this.lastPan) < EPSILON) return;
    this.lastPan = next;
    this.ramp(this.panNode.pan, next);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.source.stop();
    } catch {
      // Never started, or already stopped. Nothing to undo.
    }
  }

  private ramp(param: AudioParam, value: number): void {
    const at = this.scheduleAt();
    param.cancelScheduledValues(at);
    param.setTargetAtTime(value, at, RAMP);
  }
}
