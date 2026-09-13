/**
 * Footsteps, breaking, placing and a wind bed — all synthesised, none fetched.
 *
 * **The engine ships no audio assets any more than it ships images**, and the reference makes the
 * same choice for the same reason: every sound here is an oscillator or a noise burst built at
 * runtime, so the demo adds nothing to any payload.
 *
 * `audioContextConstructor` is the engine's host seam for getting at WebAudio, and
 * `claimPlaybackSession` is what stops two things in one page fighting over the output. The
 * synthesis itself is ordinary WebAudio, because that is what it is.
 *
 * **Nothing plays before a gesture.** Browsers refuse to start a context without one, so `unlock`
 * is called from the same click that takes pointer lock.
 */
import { audioContextConstructor, claimPlaybackSession } from '@driftengine/audio';

import { Block, blockDef } from './blocks';

/** How far the underwater filter closes, in hertz. */
const MUFFLED_HZ = 420;
const OPEN_HZ = 18_000;

export class VoxelAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private muffle: BiquadFilterNode | null = null;
  private wind: AudioBufferSourceNode | null = null;
  private release: (() => void) | null = null;
  private disposed = false;

  /** Call from a real gesture. Safe to call again; the second time does nothing. */
  async unlock(): Promise<void> {
    if (this.context !== null || this.disposed) return;
    const Ctor = audioContextConstructor();
    /* Absent where the platform has no WebAudio at all, which is a quiet demo rather than a
       broken one. */
    if (Ctor === undefined || Ctor === null) return;

    const context = new Ctor();
    /* A session rather than a bare context: two things in one page sharing an output is what
       this exists to arbitrate. */
    this.release = claimPlaybackSession?.() ?? null;
    await context.resume().catch(() => undefined);

    const master = context.createGain();
    master.gain.value = 0.5;
    /* One filter everything passes through, so going under water muffles the whole world rather
       than each sound having to know about it. */
    const muffle = context.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = OPEN_HZ;
    muffle.connect(master);
    master.connect(context.destination);

    this.context = context;
    this.master = master;
    this.muffle = muffle;
    this.startWind();
  }

  /**
   * A footstep, pitched by what is underfoot.
   *
   * Filtered noise rather than a sample: sand is a soft high hiss, stone a harder low knock, and
   * the difference is a filter frequency.
   */
  footstep(blockId: number): void {
    const context = this.context;
    if (context === null || this.muffle === null) return;
    const soft = blockId === Block.SAND || blockId === Block.SNOW || blockId === Block.GRASS;
    this.noiseBurst(0.09, soft ? 1400 : 700, soft ? 0.1 : 0.16, soft ? 2.2 : 1.1);
  }

  /** A break: a noise burst with a falling body under it. */
  broke(blockId: number): void {
    const context = this.context;
    if (context === null) return;
    this.noiseBurst(0.16, 2200, 0.22, 1.4);
    this.tone(blockDef(blockId)?.fluid === true ? 220 : 150, 0.12, 0.14, 'triangle');
  }

  /** A place: a short soft knock, quieter than a break. */
  placed(_blockId: number): void {
    this.noiseBurst(0.07, 900, 0.12, 1.2);
    this.tone(320, 0.07, 0.08, 'sine');
  }

  /** Close the filter while the eye is under water. */
  update(_dtSec: number, underwater: boolean): void {
    const muffle = this.muffle;
    const context = this.context;
    if (muffle === null || context === null) return;
    const target = underwater ? MUFFLED_HZ : OPEN_HZ;
    if (Math.abs(muffle.frequency.value - target) < 1) return;
    /* A ramp rather than a jump: crossing the surface should sound like crossing it. */
    muffle.frequency.setTargetAtTime(target, context.currentTime, 0.08);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wind?.stop();
    this.wind = null;
    this.release?.();
    this.release = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  /**
   * A quiet wind bed: brown noise, which is white noise integrated.
   *
   * White noise on its own is hiss. Integrating it rolls off the high end and leaves something
   * that reads as air rather than as static, which is the reference's choice too.
   */
  private startWind(): void {
    const context = this.context;
    if (context === null || this.muffle === null) return;

    const seconds = 4;
    const buffer = context.createBuffer(
      1,
      Math.floor(context.sampleRate * seconds),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    gain.gain.value = 0.06;
    source.connect(gain);
    gain.connect(this.muffle);
    source.start();
    this.wind = source;
  }

  /** A band-passed noise burst with a fast decay. The shape of every impact here. */
  private noiseBurst(seconds: number, hz: number, gain: number, q: number): void {
    const context = this.context;
    if (context === null || this.muffle === null) return;

    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      /* An exponential decay over the burst, so it reads as a hit rather than a beep. */
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = hz;
    filter.Q.value = q;
    const level = context.createGain();
    level.gain.value = gain;
    source.connect(filter);
    filter.connect(level);
    level.connect(this.muffle);
    source.start();
    source.stop(context.currentTime + seconds);
  }

  /** A short pitched body, dropping as it fades. */
  private tone(hz: number, seconds: number, gain: number, type: OscillatorType): void {
    const context = this.context;
    if (context === null || this.muffle === null) return;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, context.currentTime);
    osc.frequency.exponentialRampToValueAtTime(hz * 0.6, context.currentTime + seconds);
    const level = context.createGain();
    level.gain.setValueAtTime(gain, context.currentTime);
    level.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + seconds);
    osc.connect(level);
    level.connect(this.muffle);
    osc.start();
    osc.stop(context.currentTime + seconds);
  }
}
