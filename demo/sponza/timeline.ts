/**
 * Where the scene is in its loop, and the transport that moves it: play, pause, stop and seek.
 *
 * It owns the loop's state so the frame reads one answer. `?hour=` holds an hour for a capture:
 * the eye starts adapted and the probe grid is baked whole. Any transport action lets go of the
 * hold. A jump, whether a stop or a seek, makes the light wrong everywhere at once, so it asks the
 * frame to snap the exposure and re-bake the grid quickly rather than letting both drift there.
 */
import type { ClockControl } from '../types';
import { LOOP_SEC, clockText, hourAtLoop, loopAtHour } from './clock';

export class SponzaTimeline implements ClockControl {
  readonly lengthSec = LOOP_SEC;
  /** Seconds into the loop. */
  atSec = 0;
  /** The hour `?hour=` holds, until the transport is touched. */
  held: number | undefined;
  /**
   * Whether the courtyard is on screen. Until it is, the transport is hidden and the loop waits, so
   * the day begins when the picture does rather than twenty minutes into it behind the load screen.
   */
  ready = false;
  private paused = false;
  private readonly speed: number;
  /** Set by a jump and taken by the frame: snap the exposure. */
  private jumpedFlag = false;
  /** Frames left of a fast re-bake after a jump. */
  private refreshing = 0;

  constructor(heldHour: number | undefined, speed: number) {
    this.held = heldHour;
    this.speed = speed;
    if (heldHour !== undefined) this.atSec = loopAtHour(heldHour);
  }

  get playing(): boolean {
    return !this.paused && this.held === undefined;
  }

  /** The local hour on screen. */
  get hour(): number {
    return this.held ?? hourAtLoop(this.atSec);
  }

  get label(): string {
    return clockText(this.hour);
  }

  /** Move the playhead on by a frame, if it is playing and the courtyard is up. */
  advance(dtSec: number): void {
    if (this.ready && this.playing) this.atSec = (this.atSec + dtSec * this.speed) % LOOP_SEC;
  }

  /** Whether a jump happened since the last frame asked. Asking clears it. */
  takeJump(): boolean {
    const jumped = this.jumpedFlag;
    this.jumpedFlag = false;
    return jumped;
  }

  /** Whether the grid should re-bake in a burst this frame. Asking spends one frame of it. */
  takeRefresh(): boolean {
    if (this.refreshing <= 0) return false;
    this.refreshing--;
    return true;
  }

  play(): void {
    this.held = undefined;
    this.paused = false;
  }

  pause(): void {
    this.held = undefined;
    this.paused = true;
  }

  stop(): void {
    this.paused = true;
    this.jumpTo(0);
  }

  seek(atSec: number): void {
    this.jumpTo(((atSec % LOOP_SEC) + LOOP_SEC) % LOOP_SEC);
  }

  private jumpTo(atSec: number): void {
    this.atSec = atSec;
    this.held = undefined;
    this.jumpedFlag = true;
    /* Twelve frames of sixteen probes is three sweeps of the 64-probe grid. */
    this.refreshing = 12;
  }
}
