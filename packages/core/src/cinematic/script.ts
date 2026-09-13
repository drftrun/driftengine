import type { ShotParams } from '../render/cinematicCamera.ts';

/**
 * A cinematic, as data: when the camera cuts, and what is on screen when.
 *
 * A sequence is a *file*, not a function. That is the whole point of the split
 * — a new season, a new trailer or a different cut of the same footage must be
 * a data change, and the moment one of them needs a branch in TypeScript the
 * boundary has moved to the wrong place.
 *
 * Which means data is where the mistakes will be, and this module is where they
 * are caught. Everything a timeline can get wrong — two lines up at once, an
 * entry written above the one it plays after, a keyframe past the end of the
 * shot it belongs to — is rejected the moment the script is loaded, by name and
 * by index. The alternative is a cinematic that silently drops its fourth line,
 * which nobody notices until a player asks what it said.
 *
 * Nothing here knows what is being narrated. A shot is a placement, a line is a
 * string with a window and a `look` the presentation layer resolves.
 */

/** One camera placement inside a shot. Times are from the shot's own start. */
export interface CameraKeyframe {
  readonly atSec: number;
  readonly camera: ShotParams;
}

/**
 * A cut, at `atSec`.
 *
 * A shot is either a fixed placement or a list of keyframes moved through while
 * it holds. Keyframes are a *move*, never a second cut: they may not change the
 * kind of shot, because that is a cut and belongs on the timeline where an
 * editor can see it.
 */
export interface CinematicShot {
  readonly atSec: number;
  readonly camera: ShotParams | readonly CameraKeyframe[];
}

export interface CinematicLine {
  readonly atSec: number;
  readonly holdSec: number;
  readonly text: string;
  /** A presentation key — 'story', 'rule'. The player never resolves it. */
  readonly look: string;
}

export interface CinematicScript {
  readonly durationSec: number;
  /** In play order. May be empty: a sequence of lines over live gameplay. */
  readonly shots: readonly CinematicShot[];
  /** In play order, non-overlapping. */
  readonly lines: readonly CinematicLine[];
}

const SHOT_KINDS: readonly string[] = ['chase', 'lowWide', 'orbit', 'flyby', 'overhead', 'lookAt'];

/**
 * Validate a script and hand it back, so a data module fails on import:
 *
 * ```ts
 * export const SEASON_ONE = defineCinematic('season1', { ... });
 * ```
 *
 * Loud at load is the only useful moment. A malformed timeline cannot be
 * repaired at runtime and must not be played half-right.
 */
export function defineCinematic(name: string, script: CinematicScript): CinematicScript {
  validateCinematic(name, script);
  return script;
}

/** Throws on the first thing wrong, naming the entry and both times. */
export function validateCinematic(name: string, script: CinematicScript): void {
  const fail = (message: string): never => {
    throw new Error(`cinematic "${name}": ${message}`);
  };

  const duration = script.durationSec;
  if (!Number.isFinite(duration) || duration <= 0) {
    fail(`runs for ${duration}s, which is not a length`);
  }

  validateShots(script, duration, fail);
  validateLines(script, duration, fail);
}

function validateShots(
  script: CinematicScript,
  duration: number,
  fail: (message: string) => never,
): void {
  const shots = script.shots;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (!Number.isFinite(shot.atSec) || shot.atSec < 0) {
      fail(`shot ${i} cuts at ${shot.atSec}s`);
    }
    if (i === 0 && shot.atSec !== 0) {
      fail(`shot 0 cuts at ${shot.atSec}s — the camera has nowhere to be before it`);
    }
    if (i > 0 && shot.atSec <= shots[i - 1].atSec) {
      fail(
        `shot ${i} cuts at ${shot.atSec}s, at or before shot ${i - 1} at ` +
          `${shots[i - 1].atSec}s — shots must be written in the order they play`,
      );
    }
    if (shot.atSec >= duration) {
      fail(`shot ${i} cuts at ${shot.atSec}s, after the script ends at ${duration}s`);
    }
    // How long this shot holds — what a keyframe inside it has to fit within.
    const span = (i + 1 < shots.length ? shots[i + 1].atSec : duration) - shot.atSec;
    validateCamera(shot.camera, span, i, fail);
  }
}

function validateCamera(
  camera: ShotParams | readonly CameraKeyframe[],
  spanSec: number,
  index: number,
  fail: (message: string) => never,
): void {
  if ('kind' in camera) {
    validateShotParams(camera, `shot ${index}`, fail);
    return;
  }

  if (camera.length === 0) fail(`shot ${index} is keyframed but has no keyframes`);
  const first = camera[0];
  if (first.atSec !== 0) {
    fail(`shot ${index} keyframe 0 is at ${first.atSec}s — a move must start where the cut lands`);
  }

  for (let i = 0; i < camera.length; i++) {
    const frame = camera[i];
    const where = `shot ${index} keyframe ${i}`;
    if (!Number.isFinite(frame.atSec) || frame.atSec < 0) fail(`${where} is at ${frame.atSec}s`);
    if (i > 0 && frame.atSec <= camera[i - 1].atSec) {
      fail(
        `${where} is at ${frame.atSec}s, at or before keyframe ${i - 1} at ` +
          `${camera[i - 1].atSec}s — keyframes must be written in the order they play`,
      );
    }
    if (frame.atSec > spanSec) {
      fail(`${where} is at ${frame.atSec}s but the shot holds ${spanSec}s — it would never play`);
    }
    if (frame.camera.kind !== first.camera.kind) {
      fail(
        `${where} changes the shot from ${first.camera.kind} to ${frame.camera.kind} — ` +
          'a change of kind is a cut, and cuts belong on the timeline',
      );
    }
    /*
     * An optional parameter has to be on every keyframe of a shot or none of
     * them. Interpolating toward a missing anchor would send the shot to the
     * world origin, which reads as the camera being thrown rather than as a
     * mistake in the data.
     */
    if ((frame.camera.anchor === undefined) !== (first.camera.anchor === undefined)) {
      fail(`${where} adds or drops an anchor mid-move`);
    }
    if ((frame.camera.orbitRate === undefined) !== (first.camera.orbitRate === undefined)) {
      fail(`${where} adds or drops an orbit rate mid-move`);
    }
    validateShotParams(frame.camera, where, fail);
  }
}

function validateShotParams(
  shot: ShotParams,
  where: string,
  fail: (message: string) => never,
): void {
  if (!SHOT_KINDS.includes(shot.kind))
    fail(`${where} is a "${shot.kind}" shot, which is not a shot`);
  for (const [label, value] of [
    ['distance', shot.distance],
    ['height', shot.height],
    ['fovDeg', shot.fovDeg],
  ] as const) {
    if (!Number.isFinite(value)) fail(`${where} has ${label} ${value}`);
  }
  if (shot.orbitRate !== undefined && !Number.isFinite(shot.orbitRate)) {
    fail(`${where} has orbitRate ${shot.orbitRate}`);
  }
  const anchor = shot.anchor;
  if (anchor !== undefined && (anchor.length !== 3 || !anchor.every(Number.isFinite))) {
    fail(`${where} has an anchor that is not three finite numbers`);
  }
}

function validateLines(
  script: CinematicScript,
  duration: number,
  fail: (message: string) => never,
): void {
  const lines = script.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.text.length === 0) fail(`line ${i} has nothing to say`);
    if (line.look.length === 0) fail(`line ${i} ("${line.text}") has no look`);
    if (!Number.isFinite(line.atSec) || line.atSec < 0) {
      fail(`line ${i} ("${line.text}") opens at ${line.atSec}s`);
    }
    if (!Number.isFinite(line.holdSec) || line.holdSec <= 0) {
      fail(`line ${i} ("${line.text}") holds for ${line.holdSec}s`);
    }
    if (i > 0) {
      const previous = lines[i - 1];
      if (line.atSec <= previous.atSec) {
        fail(
          `line ${i} ("${line.text}") opens at ${line.atSec}s, at or before line ${i - 1} at ` +
            `${previous.atSec}s — lines must be written in the order they play`,
        );
      }
      if (line.atSec < previous.atSec + previous.holdSec) {
        fail(
          `line ${i} ("${line.text}") opens at ${line.atSec}s while line ${i - 1} is still up ` +
            `until ${previous.atSec + previous.holdSec}s — two lines at once is unreadable`,
        );
      }
    }
    if (line.atSec + line.holdSec > duration) {
      fail(
        `line ${i} ("${line.text}") is still up at ${line.atSec + line.holdSec}s, ` +
          `after the script ends at ${duration}s`,
      );
    }
  }
}
