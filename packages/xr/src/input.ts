/**
 * Controllers, read the way the rest of this engine reads input.
 *
 * **A controller is a gamepad with a pose, and the specification says so**: an `XRInputSource`
 * carries an ordinary `Gamepad` whose button order is fixed by the WebXR gamepad profile. So the
 * buttons are named here rather than indexed at every call site, and the names are the profile's
 * rather than any device's marketing: `trigger`, `squeeze`, `touchpad`, `thumbstick`.
 *
 * **What is deliberately absent is a binding layer.** This engine has `ActionMap`, and a second one
 * that only XR could reach would be a second answer to what a button means. A consumer maps a
 * trigger to an action the same way they map a key, which is why this reads state and never
 * dispatches an intent.
 *
 * **Nothing here is deterministic and none of it belongs in a fixed step.** A controller pose
 * arrives with a frame, from a device, at a rate the runtime chooses. `drift/ui` already settled
 * that a pointer position is `input.read` and outside `DETERMINISTIC_EFFECTS`, and a hand is the
 * same kind of fact.
 */

import type { XrFrame, XrInputSource, XrRigidTransform, XrSession } from './types.ts';

/** Which hand, as WebXR reports it. `none` is a source with no handedness, like a gaze pointer. */
export type Handedness = 'left' | 'right' | 'none';

/**
 * The buttons the WebXR gamepad profile fixes, in its order.
 *
 * Indexes and not a guess: the profile pins 0 to the trigger and 1 to the squeeze for every device
 * that reports `xr-standard`, which is what makes reading them by name safe. A device offering
 * fewer buttons simply has none at the higher indexes, which reads as zero rather than as an error.
 */
export const XR_BUTTON = {
  trigger: 0,
  squeeze: 1,
  touchpad: 2,
  thumbstick: 3,
} as const;

export type XrButton = keyof typeof XR_BUTTON;

/** One controller, as much of it as this engine reads. */
export interface ControllerState {
  readonly handedness: Handedness;
  /** How the source is aimed: `tracked-pointer`, `gaze` or `screen`. */
  readonly targetRayMode: string;
  /** Whether a pose was available this frame. False while a controller is out of view. */
  readonly tracked: boolean;
  /** The grip transform's matrix, valid only while `tracked`. */
  readonly gripMatrix: Float32Array | null;
  /** Where the source is aiming, which is not where it is held. */
  readonly rayMatrix: Float32Array | null;
  /** Analogue values in the profile's order, and zero for a button the device does not have. */
  readonly buttons: readonly number[];
  readonly pressed: readonly boolean[];
  readonly axes: readonly number[];
}

const NO_BUTTONS: readonly number[] = [];
const NO_PRESSED: readonly boolean[] = [];
const NO_AXES: readonly number[] = [];

/**
 * Read every input source a session currently reports.
 *
 * `out` is filled and returned, so a frame loop allocates nothing after the first call. Sources
 * come and go as controllers wake and sleep, which is why the list is read from the session every
 * frame rather than cached at `inputsourceschange`: the event exists for a consumer that wants to
 * react, and this is the polling half.
 */
export function readControllers(
  session: XrSession,
  frame: XrFrame,
  referenceSpace: unknown,
  out: ControllerState[] = [],
): ControllerState[] {
  out.length = 0;
  for (const source of session.inputSources) {
    out.push(readController(source, frame, referenceSpace));
  }
  return out;
}

function matrixOf(frame: XrFrame, space: unknown, referenceSpace: unknown): Float32Array | null {
  if (space === undefined || space === null || frame.getPose === undefined) return null;
  const pose = frame.getPose(space, referenceSpace);
  const transform = pose?.transform as XrRigidTransform | undefined;
  return transform?.matrix ?? null;
}

export function readController(
  source: XrInputSource,
  frame: XrFrame,
  referenceSpace: unknown,
): ControllerState {
  const gripMatrix = matrixOf(frame, source.gripSpace, referenceSpace);
  const rayMatrix = matrixOf(frame, source.targetRaySpace, referenceSpace);
  const pad = source.gamepad;

  return {
    handedness: source.handedness,
    targetRayMode: source.targetRayMode,
    /*
     * Tracked means a pose came back this frame, which is a different question from whether the
     * source is listed. A controller set down on a table is still an input source and has no pose,
     * and a consumer drawing a model at a stale matrix would leave it floating where it was
     * dropped.
     */
    tracked: gripMatrix !== null || rayMatrix !== null,
    gripMatrix,
    rayMatrix,
    buttons: pad ? pad.buttons.map((button) => button.value) : NO_BUTTONS,
    pressed: pad ? pad.buttons.map((button) => button.pressed) : NO_PRESSED,
    axes: pad ? [...pad.axes] : NO_AXES,
  };
}

/** One named button's analogue value, or zero where the device has no such button. */
export function buttonValue(state: ControllerState, button: XrButton): number {
  return state.buttons[XR_BUTTON[button]] ?? 0;
}

/** Whether a named button is pressed, false where the device has no such button. */
export function buttonPressed(state: ControllerState, button: XrButton): boolean {
  return state.pressed[XR_BUTTON[button]] ?? false;
}

/** The first source for a hand, or null. Two sources may share a handedness and rarely do. */
export function controllerFor(
  states: readonly ControllerState[],
  handedness: Handedness,
): ControllerState | null {
  for (const state of states) if (state.handedness === handedness) return state;
  return null;
}
