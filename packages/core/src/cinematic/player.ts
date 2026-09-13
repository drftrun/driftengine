import { lerp } from '../math/scalar.ts';
import type { ShotKind, ShotParams } from '../render/cinematicCamera.ts';
import { validateCinematic } from './script.ts';
import type { CameraKeyframe, CinematicLine, CinematicScript } from './script.ts';

/**
 * Plays a `CinematicScript`: a clock, the shot it is currently in, and the line
 * that is currently up.
 *
 * It knows about time, camera placements and timed strings, and nothing else.
 * Which shot suits which moment is the script's business, what a `look` means
 * is the presentation's, and what any of it is *about* is the game's.
 *
 * Everything is derived from accumulated time rather than advanced per frame,
 * so a script plays identically on a 144 Hz desktop and a phone dropping frames
 * — a playback that steps an index per frame tells a different story at a
 * different frame rate, and only one of the two was ever written down.
 *
 * The caller drives a `CinematicCamera` from it:
 *
 * ```ts
 * player.update(dt);
 * if (player.shotChanged) camera.cut(player.shot, player.timeSec);
 * camera.update(dt, x, y, z, yaw);
 * ```
 *
 * `shotChanged` is true only at a *cut*. A keyframed shot moves while it holds,
 * and the object handed out by `shot` is a live view that keeps moving — so the
 * rig damps its way along the authored path instead of snapping to it every
 * frame. Copy it if you need to keep it past the next `update`.
 */
export class CinematicPlayer {
  private readonly script: CinematicScript;
  private time = 0;
  private shotIndex = -1;
  private lineIndex = -1;
  private cut = false;
  private current: ShotParams | null = null;
  /**
   * Scratch for keyframed shots, reused every frame. A cinematic is not a hot
   * path in the sim sense, but it runs over a live world and a per-frame object
   * is a per-frame collection somewhere later.
   */
  private readonly moving: MovingShot = { kind: 'chase', distance: 6, height: 2, fovDeg: 70 };
  private readonly movingAnchor: [number, number, number] = [0, 0, 0];

  constructor(script: CinematicScript, name = 'cinematic') {
    // Even a script that came through `defineCinematic` is checked again: the
    // ordering and non-overlap rules are what make "the line right now" a
    // single answer, and this is the object that relies on them.
    validateCinematic(name, script);
    this.script = script;
  }

  get timeSec(): number {
    return this.time;
  }

  get finished(): boolean {
    return this.time >= this.script.durationSec;
  }

  /** The placement the camera should be holding, or null before the first shot. */
  get shot(): ShotParams | null {
    return this.current;
  }

  /** True on the frame a cut lands — the cue to `cut` the rig. */
  get shotChanged(): boolean {
    return this.cut;
  }

  /** The one line on screen, or null. Never two: the script cannot express it. */
  get line(): CinematicLine | null {
    return this.lineIndex < 0 ? null : this.script.lines[this.lineIndex];
  }

  update(frameDt: number): void {
    this.cut = false;
    if (this.finished) return;
    this.time = Math.min(this.time + Math.max(0, frameDt), this.script.durationSec);
    this.selectShot();
    this.selectLine();
  }

  /**
   * Straight to the end, holding nothing.
   *
   * Every returning player takes this path, so it has to leave the player inert
   * rather than merely finished: a skip that leaves a cinematic shot behind
   * hands somebody a run they cannot see.
   */
  skip(): void {
    this.time = this.script.durationSec;
    this.clear();
  }

  /** Back to the top, for a replay from the menu. */
  reset(): void {
    this.time = 0;
    this.clear();
  }

  private clear(): void {
    this.shotIndex = -1;
    this.lineIndex = -1;
    this.current = null;
    this.cut = false;
  }

  /**
   * Scanned from the start rather than advanced from the last index: the answer
   * is then a function of the clock alone, which is what survives a `reset`, a
   * long frame that crosses two cuts, and a script short enough that the scan
   * costs less than the branch saving it would.
   */
  private selectShot(): void {
    const shots = this.script.shots;
    let index = -1;
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].atSec > this.time) break;
      index = i;
    }
    if (index < 0) {
      this.current = null;
      return;
    }
    if (index !== this.shotIndex) {
      this.shotIndex = index;
      this.cut = true;
    }

    const camera = shots[index].camera;
    this.current = 'kind' in camera ? camera : this.sample(camera, this.time - shots[index].atSec);
  }

  private selectLine(): void {
    const lines = this.script.lines;
    let index = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.atSec > this.time) break;
      // The window is closed at its end, so a line and its successor cannot
      // both claim the instant one hands over to the other.
      if (this.time < line.atSec + line.holdSec) {
        index = i;
        break;
      }
    }
    this.lineIndex = index;
  }

  /**
   * The placement `localSec` into a keyframed shot.
   *
   * Linear between keyframes, and deliberately not eased: the rig already damps
   * its own motion, and easing each segment would stall the move at every key —
   * a push-in that pulses instead of pushing.
   */
  private sample(frames: readonly CameraKeyframe[], localSec: number): ShotParams {
    let index = 0;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].atSec > localSec) break;
      index = i;
    }
    const from = frames[index].camera;
    const fromSec = frames[index].atSec;
    const hasNext = index + 1 < frames.length;
    const to = hasNext ? frames[index + 1].camera : from;
    const span = hasNext ? frames[index + 1].atSec - fromSec : 0;
    // Past the last keyframe a shot holds its final placement rather than
    // running on; the timeline says when it ends.
    const t = span > 0 ? Math.min(1, (localSec - fromSec) / span) : 1;

    const moving = this.moving;
    moving.kind = from.kind;
    moving.distance = lerp(from.distance, to.distance, t);
    moving.height = lerp(from.height, to.height, t);
    moving.fovDeg = lerp(from.fovDeg, to.fovDeg, t);

    const fromRate = from.orbitRate;
    const toRate = to.orbitRate;
    moving.orbitRate =
      fromRate === undefined || toRate === undefined ? fromRate : lerp(fromRate, toRate, t);

    const fromAnchor = from.anchor;
    const toAnchor = to.anchor;
    if (fromAnchor === undefined || toAnchor === undefined) {
      moving.anchor = fromAnchor;
    } else {
      const anchor = this.movingAnchor;
      anchor[0] = lerp(fromAnchor[0], toAnchor[0], t);
      anchor[1] = lerp(fromAnchor[1], toAnchor[1], t);
      anchor[2] = lerp(fromAnchor[2], toAnchor[2], t);
      moving.anchor = anchor;
    }
    return moving;
  }
}

/** `ShotParams` with the readonly taken off, for the one instance we mutate. */
interface MovingShot {
  kind: ShotKind;
  distance: number;
  height: number;
  fovDeg: number;
  orbitRate?: number | undefined;
  anchor?: readonly [number, number, number] | undefined;
}
