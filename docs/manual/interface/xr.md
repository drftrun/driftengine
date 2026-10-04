---
title: XR
description: Asking a browser what it can present, entering a WebXR session, and reading the head, controllers and hands each frame. Drawing into a headset is not built yet.
packages: ['@driftengine/xr']
areas: ['xr']
---

# XR

`@driftengine/xr` is the engine's WebXR. It asks a browser what it can present, enters a session,
and reads where the head is, what each controller is doing and where every joint of a tracked hand
is, every frame. It is a package of its own, so a game that never enters a session carries none of
it.

One part is missing, and it is the part a headset needs most. The renderer draws into its canvas
and into nothing else, so a session can be entered and read, and nothing appears inside the
headset. Everything on this page works against a real session; drawing into one is recorded in the
engine's `docs/IMPROVEMENTS.md`, and it is the next thing XR needs.

The example is a headset seen from across a room: its head, its two controllers and the joints of
its left hand, read every frame from a session, and a lamp over the table that the right trigger
turns up. The session is a simulated one, because almost nobody reading this has a headset on, and
what your own browser answers is written under the readout. A DriftScript module reads the trigger
and the hand. The strip pulls the trigger, hides a fingertip from the tracker, takes the headset
off, or asks your browser for a real session.

<!-- run: xr -->

## Asking the browser

```ts sample=xr/main.ts#probe
/* Asked by doing: a context of its own is offered to be made XR compatible, which is the step
   that fails on a machine with no headset attached even where every mode reports supported. */
const here = await probeXrSupport(document.createElement('canvas').getContext('webgl2'));

function said(support: XrSupport): string {
  if (!support.present) return 'this browser has no WebXR';
  const modes = [
    support.immersiveVr ? 'immersive-vr' : '',
    support.immersiveAr ? 'immersive-ar' : '',
    support.inline ? 'inline' : '',
  ].filter((mode) => mode !== '');
  const reason = support.reason.charAt(0).toUpperCase() + support.reason.slice(1);
  return `${modes.length === 0 ? 'no session mode' : modes.join(', ')}. ${reason}`;
}
```

`probeXrSupport(context)` answers with `present`, whether the browser has WebXR at all;
`immersiveVr`, `immersiveAr` and `inline` for the three session modes; `compatible`; and `reason`,
a whole sentence whenever something is missing. It asks by doing. A browser's own answer about a
mode is a promise about the mode only: on a machine with no headset it can call `inline` supported,
start the session and grant a reference space, and then refuse to make the rendering context XR
compatible. Without a compatible context there is no layer and so no frame, which is why the probe
offers the context it is given and reports what happened. Offer the context the game draws with;
the example offers one of its own, since it draws nothing into a session. `bestMode(support)`
picks the mode to ask for, immersive first.

## Entering a session

```ts sample=xr/main.ts#enter
/* A real session, from a click: `requestSession` needs a user gesture. The answer is a whole
   sentence either way, and a session that does start is ended, since nothing can be drawn into it. */
let real = '';
async function tryReal(): Promise<void> {
  real = 'asking…';
  tell();
  const entered = await enterXr({
    sources: { gl: document.createElement('canvas').getContext('webgl2', { xrCompatible: true }) },
  });
  if (!entered.ok) {
    real = entered.reason;
  } else {
    real = `entered on ${entered.run.referenceSpaceType} through ${entered.run.backend}, and ended, since nothing draws into it yet.`;
    await entered.run.end();
  }
  tell();
}

/* What this browser answered, and what a real session said when one was asked for. */
function tell(): void {
  if (answer === null) return;
  answer.textContent =
    `This browser: ${said(here)}` + (real === '' ? '' : ` A real session: ${real}`);
}
tell();
```

`enterXr` requests a session, builds the layer the session composites, and asks for a reference
space. It answers with `ok` and a `run`, or with `ok: false` and a `reason`. Call it from a click:
a browser grants a session only to a user gesture, and refuses one otherwise with the same error a
machine with no headset gives, which the reason says. The options are the `mode`, `immersive-vr`
unless asked otherwise; `optionalFeatures`, such as `hand-tracking`; the `sources` a layer is built
from, a WebGL2 context as `gl` or a GPU device as `device`; and a `system` to use in place of the
browser's.

The layer is chosen from what the session offers. Where the browser has a WebGPU binding and a
device was offered it is a projection layer, and otherwise a WebGL layer; a WebGPU layer that
cannot be built falls back to WebGL2 and says so in `run.layer.reason`. The reference space is the
first of `local-floor`, `local` and `viewer` that the session grants, and `run.referenceSpaceType`
says which.

`run.frameSource` is the session's own frame clock. Hand it to `startLoop` as
`{ frameSource: run.frameSource }` and the loop runs at the headset's rate, passing the session's
frame to `render` as its fourth argument, which is where every pose is read from. `run.onEnd` hears
the session end, through `run.end()` or because the headset came off. `eyeViews(pose, layer)` turns
a viewer pose into each eye's `view`, `projection` and `viewport`, and `aimCameraAtEye(camera, eye)`
gives one eye to a `Camera` through `adoptView`: an eye's projection is off to one side, which a
camera's own field of view cannot describe. That is as far as a frame goes today, since nothing
draws the camera into the eye's viewport.

## A simulated headset

```ts sample=xr/main.ts#simulated
/* A runtime that answers: two controllers, the left one with a hand, and a frame only when asked
   for one. `probeXrSupport` takes it in place of the browser's. */
const system = syntheticXr({
  controllers: [{ handedness: 'left', hand: true }, { handedness: 'right' }],
});
const simulated = await probeXrSupport(null, system);
```

`syntheticXr` is a runtime that answers. It grants sessions and reports two eyes 64 mm apart with
off-axis projections that differ, controllers with buttons, and hands with twenty-five joints. It
is the runtime the package's own tests run against, published with it as
`@driftengine/xr/src/testing/synthetic.ts`, and it produces a frame only when `advance` is called,
so a test asserting about a frame asserts about one it caused. `setButton` sets a controller's
button, `setJointTracked` stops reporting a joint the way a finger behind the other hand stops being
tracked, and `endLatest` ends a session the way taking a headset off does. It stands in for the
browser, and it proves nothing about a real device.

```ts sample=xr/main.ts#session
let session: SyntheticSession | null = null;
let space: unknown = null;

/* The steps `enterXr` takes, without the layer: a simulated session has nothing to draw into. */
async function putOn(): Promise<void> {
  const started = (await system.requestSession('immersive-vr', {
    optionalFeatures: ['hand-tracking'],
  })) as SyntheticSession;
  space = await started.requestReferenceSpace('local-floor');
  leftHand.clear();
  started.addEventListener('end', () => {
    if (session === started) session = null;
  });
  session = started;
  session.requestAnimationFrame(onFrame);
}
```

A simulated session has no layer to build, so the example takes the steps `enterXr` takes without
that one: request the session, ask for a reference space, listen for the end, ask for a frame. The
page's own loop calls `advance` once a frame.

## Reading a frame

```ts sample=xr/main.ts#read
/* What the frame said, kept where the script and the drawing both read it. */
const head = new Float32Array(3);
let presenting = false;
const states: ControllerState[] = [];
const leftHand = new HandSkeleton();

function onFrame(_time: number, frame: XrFrame): void {
  const current = frame.session as XrSession;
  /* A session that has ended asks for no more frames. */
  if (current !== session) return;
  const pose = frame.getViewerPose(space) ?? null;
  presenting = pose !== null;
  if (pose !== null) head.set(pose.transform.matrix.subarray(12, 15));
  readControllers(current, frame, space, states);
  let sawLeft = false;
  for (const source of current.inputSources) {
    if (source.handedness !== 'left' || source.hand === undefined) continue;
    readHand(source, frame, space, leftHand);
    sawLeft = true;
  }
  /* A hand that is not there at all is forgotten; one merely out of view keeps its last poses. */
  if (!sawLeft) leftHand.clear();
  current.requestAnimationFrame(onFrame);
}
```

Everything is read from the frame the session hands over, against the reference space.
`getViewerPose` is the head, or nothing while tracking is lost. `readControllers(session, frame,
space, out)` fills one `ControllerState` for each input source: its `handedness`, whether it is
`tracked`, the `gripMatrix` where the hand holds it and the `rayMatrix` it points along, `buttons`
and `pressed` in the standard gamepad order, and `axes`. `controllerFor(states, 'right')` finds one
by hand, and `buttonValue` and `buttonPressed` read a button by its name in `XR_BUTTON`: `trigger`,
`squeeze`, `touchpad` or `thumbstick`.

`readHand(source, frame, space, skeleton)` fills a `HandSkeleton`, allocated once: a transform for
each of the `JOINT_COUNT` joints in `matrices`, their `radii`, and `tracked`, a flag for each. A
joint the runtime stops reporting keeps its last pose with its flag down. A tracker loses fingers
constantly as they pass behind each other, and zeroing one would throw that finger onto the wrist
for a frame; what to do with a stale joint is the game's, and the example draws it amber where it
was last seen. `clear` is for a hand that has gone away altogether. `HAND_JOINTS` names the joints
in order, `JOINT_INDEX` gives a name's place, and `jointPosition` reads one joint's position without
allocating.

## From a script

```drs sample=xr/headset.drs#lamp
// The lamp follows the right trigger while a session is running and the controller is tracked. A
// headset taken off ends the session, and the lamp goes out with it.
fn light(lamp: mut Lamp, dt: f32) {
    var want: f32 = 0
    if xr.presenting() && xr.holding(Hand.Right) {
        want = xr.trigger(Hand.Right)
    }
    lamp.level = lamp.level + (want - lamp.level) * math.min(1, lamp.ease * dt)
}
```

`drift/xr` gives a script twelve reads. `presenting` says a session is running and `supported`
that the device could present at all. `headX`, `headY` and `headZ` are where the head is, in
metres. For a hand named `"left"` or `"right"`, `trigger` and `squeeze` are how far each is pulled,
`holding` says its controller is tracked, `jointX`, `jointY` and `jointZ` place a joint named as in
`HAND_JOINTS`, and `pinching` says the thumb and index tips are within 25 mm. None of them is
deterministic, because a head moves when somebody moves it: a `@deterministic` system may not read
one, and the script reads them in the frame. None of them is a matrix either, since drawing the
eyes is the host's.

```drs sample=xr/headset.drs#tip
// A joint the runtime stops reporting reads as zero, the way a fingertip that goes behind the other
// hand does on a real headset. The page colours the hand when this says so.
fn tipSeen() -> bool {
    return xr.jointY(Hand.Left, HandJoint.IndexFingerTip) != 0
}
```

A joint the runtime is not reporting reads as zero, so the script tells a lost fingertip from a
seen one by its height.

```ts sample=xr/main.ts#host
/* What `drift/xr` reads, from the state the frame left. Nothing here is deterministic, so the
   script reads it in the frame and never in the fixed step. */
const xr: XrRuntime = {
  get support() {
    return simulated;
  },
  get headPosition() {
    return session !== null && presenting ? head : null;
  },
  controller: (hand) => (session === null ? null : controllerFor(states, hand)),
  hand: (hand) => (session !== null && hand === 'left' && leftHand.visible ? leftHand : null),
};
const script = hostScript(headsetScript, { xr });
interface Lamp {
  level: number;
  ease: number;
}
const lamp = exported<() => Lamp>(script, 'createLamp')();
if (import.meta.hot) {
  import.meta.hot.accept('./headset.drs', (next) => {
    if (next !== undefined) patchModule(script, next as Record<string, unknown>, { Lamp: [lamp] });
  });
}
const light = (dt: number): void =>
  exported<(l: Lamp, dt: number) => void>(script, 'light')(lamp, dt);
const tipSeen = (): boolean => exported<() => boolean>(script, 'tipSeen')();
```

The host hands the binding four things: `support`, the probe's answer; `headPosition`, three numbers
or `null` outside a session; `controller(hand)`; and `hand(hand)`, a skeleton or `null`. The example
builds them from what the frame left and answers `null` for all of them once the headset is off,
so the lamp goes out with the session.
