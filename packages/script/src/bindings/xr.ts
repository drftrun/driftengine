/**
 * `drift/xr` — what a script may ask about a headset, and what it may not.
 *
 * **The last surface the linker refused, and it refused it since 1.0.** `drift/xr` has been in the
 * language's `SPECIFIED_MODULES` the whole time with nothing here describing it, which is exactly
 * the arrangement the language exists to make possible: a file naming it parsed, type-checked and
 * declined only at link time, and the same file links now without a character changing.
 *
 * ## Nothing here is deterministic, and that is the property
 *
 * A head moves because somebody moved their head. A controller reports where it is because a camera
 * saw it. None of that is a function of the simulation, so none of it may be read from inside the
 * fixed step: a `@deterministic` system branching on where a hand is would take the other branch on
 * replay, and a stored run would stop meaning anything.
 *
 * `drift/ui` settled the same question for a pointer, and the reasoning transfers unchanged: its
 * `hovered` and `pressed` are fields on a tree that `scene.read` would have type-checked and would
 * have been a lie about what they carry, so they were declared `input.read` and left outside
 * `DETERMINISTIC_EFFECTS`. A head and a hand are the same kind of fact arriving through the same
 * door.
 *
 * ## No matrices, and the argument is `drift/render`'s
 *
 * There is no `xr.projection` and no `xr.viewMatrix`. An eye's projection is a fact about somebody's
 * optics, and its view is a fact about where their head is in a room the script has never seen;
 * handing either to a script would be `drift/render`'s refused dial read in a different costume, a
 * machine-dependent number registered where a script could compare two runs with it.
 *
 * What a script gets is where the head is, whether a session is running, and what the hands are
 * doing. Drawing the two eyes is the host's, because the host owns the renderer and the loop.
 *
 * ## `presenting` is `scene.read` and the rest is `input.read`
 *
 * Whether a session is running is a fact about the view: it decides what is drawn and where, and it
 * changes when somebody puts a headset on. `scene.read` sits outside `DETERMINISTIC_EFFECTS` for
 * that reason, which is the one this needs.
 */

import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';
import { JOINT_INDEX } from '@driftengine/xr';
import type { ControllerState, HandSkeleton, Handedness, XrSupport } from '@driftengine/xr';

export const XR_MODULE = 'drift/xr';

export const XR_TYPES: readonly OpaqueType[] = [];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  doc: string,
  implementation: string,
): CapabilityDefinition =>
  defineCapability({
    module: XR_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    /*
     * Never deterministic, on every capability here. See the header: a head moves because a person
     * moved, and a `@deterministic` system reading one would take a different branch on replay.
     */
    deterministic: false,
    doc,
    implementation,
  });

/** `left`, `right`, or anything else for the source with no handedness. */
const HAND = { name: 'hand', type: 'String' };

export const XR_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'presenting',
    [],
    'bool',
    ['scene.read'],
    'Whether a session is running. False before one starts and after the user takes the headset off.',
    'XrRuntime.presenting',
  ),
  define(
    'supported',
    [],
    'bool',
    ['scene.read'],
    'Whether this device could present at all. False on a machine with no headset attached.',
    'XrRuntime.supported',
  ),
  /*
   * The head, as three reads rather than one call returning a triple.
   *
   * The language has no tuple and no out parameter, and a `data` record would be a value the host
   * allocates per call inside a frame loop. Three floats is the shape every other position on this
   * surface takes, and `drift/navigation`'s `steerX`/`steerY`/`steerZ` set the precedent.
   */
  /*
   * `f32` and not `float`. The language refuses a width-polymorphic return with no `float`
   * parameter to fix it against, which `drift/navigation.steerX` never meets because it takes the
   * position it steers from. These take a hand or nothing, so the width is stated: every position
   * this engine stores is a `Float32Array`, and answering `f64` would widen a number that was
   * never that precise.
   */
  define(
    'headX',
    [],
    'f32',
    ['input.read'],
    'Where the viewer’s head is, in metres. Zero outside a session.',
    'XrRuntime.headX',
  ),
  define(
    'headY',
    [],
    'f32',
    ['input.read'],
    'Where the viewer’s head is, in metres. Zero outside a session.',
    'XrRuntime.headY',
  ),
  define(
    'headZ',
    [],
    'f32',
    ['input.read'],
    'Where the viewer’s head is, in metres. Zero outside a session.',
    'XrRuntime.headZ',
  ),
  define(
    'trigger',
    [HAND],
    'f32',
    ['input.read'],
    'How far a hand’s trigger is pulled, 0 to 1. Zero for a hand that is not there.',
    'XrRuntime.trigger',
  ),
  define(
    'squeeze',
    [HAND],
    'f32',
    ['input.read'],
    'How far a hand’s grip is squeezed, 0 to 1. Zero for a hand that is not there.',
    'XrRuntime.squeeze',
  ),
  define(
    'holding',
    [HAND],
    'bool',
    ['input.read'],
    'Whether a hand is tracked this frame. False while a controller is set down or out of view.',
    'XrRuntime.holding',
  ),
  /*
   * A joint by name and not by index.
   *
   * `HAND_JOINTS` fixes an order and a script could be handed it, and should not be: an index is a
   * number a script would have to keep its own copy of and watch drift against a specification.
   * A name is checked at the call and answers false for one nobody has heard of.
   */
  define(
    'jointX',
    [HAND, { name: 'joint', type: 'String' }],
    'f32',
    ['input.read'],
    'Where a named hand joint is, in metres. Zero for a joint that is not tracked.',
    'XrRuntime.jointX',
  ),
  define(
    'jointY',
    [HAND, { name: 'joint', type: 'String' }],
    'f32',
    ['input.read'],
    'Where a named hand joint is, in metres. Zero for a joint that is not tracked.',
    'XrRuntime.jointY',
  ),
  define(
    'jointZ',
    [HAND, { name: 'joint', type: 'String' }],
    'f32',
    ['input.read'],
    'Where a named hand joint is, in metres. Zero for a joint that is not tracked.',
    'XrRuntime.jointZ',
  ),
  define(
    'pinching',
    [HAND],
    'bool',
    ['input.read'],
    'Whether a hand’s thumb and index tips are close enough to count as a pinch.',
    'XrRuntime.pinching',
  ),
];

/**
 * What the host keeps up to date, and what a script reads through.
 *
 * The consumer's, exactly as `AgentRegistry` and `SoundRegistry` are. This package owns neither the
 * session nor the frame, and which of them is current is not something a binding can know.
 */
export interface XrRuntime {
  readonly support: XrSupport | null;
  /** Null outside a session. */
  readonly headPosition: Float32Array | null;
  controller(hand: Handedness): ControllerState | null;
  hand(hand: Handedness): HandSkeleton | null;
}

/** How close two fingertips count as a pinch, in metres. */
const PINCH_METRES = 0.025;

function handOf(value: string): Handedness {
  return value === 'left' ? 'left' : value === 'right' ? 'right' : 'none';
}

export function xrImplementation(runtime: XrRuntime): Readonly<Record<string, unknown>> {
  const at = new Float32Array(3);
  const other = new Float32Array(3);

  const head = (axis: number): number => runtime.headPosition?.[axis] ?? 0;

  const joint = (hand: string, name: string, axis: number): number => {
    const skeleton = runtime.hand(handOf(hand));
    if (skeleton === null) return 0;
    /* The flat arrays the package already fills are read directly. `jointPosition` would answer the
       same question through a `Float32Array` this would then have to unpack, three times per joint
       per frame. */
    const index = jointIndexOf(name);
    if (index < 0 || skeleton.tracked[index] !== 1) return 0;
    return skeleton.matrices[index * 16 + 12 + axis] ?? 0;
  };

  return {
    presenting: (): boolean => runtime.headPosition !== null,
    supported: (): boolean =>
      runtime.support?.immersiveVr === true || runtime.support?.immersiveAr === true,
    headX: (): number => head(0),
    headY: (): number => head(1),
    headZ: (): number => head(2),
    trigger: (hand: string): number => runtime.controller(handOf(hand))?.buttons[0] ?? 0,
    squeeze: (hand: string): number => runtime.controller(handOf(hand))?.buttons[1] ?? 0,
    holding: (hand: string): boolean => runtime.controller(handOf(hand))?.tracked ?? false,
    jointX: (hand: string, name: string): number => joint(hand, name, 0),
    jointY: (hand: string, name: string): number => joint(hand, name, 1),
    jointZ: (hand: string, name: string): number => joint(hand, name, 2),
    pinching: (hand: string): boolean => {
      const skeleton = runtime.hand(handOf(hand));
      if (skeleton === null) return false;
      const thumb = jointIndexOf('thumb-tip');
      const index = jointIndexOf('index-finger-tip');
      if (skeleton.tracked[thumb] !== 1 || skeleton.tracked[index] !== 1) return false;
      for (let i = 0; i < 3; i++) {
        at[i] = skeleton.matrices[thumb * 16 + 12 + i] ?? 0;
        other[i] = skeleton.matrices[index * 16 + 12 + i] ?? 0;
      }
      const dx = (at[0] as number) - (other[0] as number);
      const dy = (at[1] as number) - (other[1] as number);
      const dz = (at[2] as number) - (other[2] as number);
      return Math.sqrt(dx * dx + dy * dy + dz * dz) <= PINCH_METRES;
    },
  };
}

/**
 * A joint's index by name.
 *
 * **Read from `@driftengine/xr` rather than written again here.** That package owns the order, an
 * index is written into recordings, and a second copy of the list would be a second answer to what
 * a stored hand means the first time somebody added a joint to one of them.
 */
function jointIndexOf(name: string): number {
  return JOINT_INDEX[name] ?? -1;
}
