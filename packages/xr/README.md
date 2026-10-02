# @driftengine/xr

WebXR sessions, each eye's view and projection, controller input and hand joints, with a layer on
either backend. **Drawing into a headset is not built yet**: see below.

**A package and not part of core**, so a game that never enters a session carries none of it. It
supplies views to a camera; nothing in core reaches back for a session.

```ts
import { startLoop } from '@driftengine/core';
import { aimCameraAtEye, enterXr, eyeViews } from '@driftengine/xr';
import type { XrFrame } from '@driftengine/xr';

// From a click. requestSession needs a user gesture and no wrapper can change that.
const entered = await enterXr({ sources: { gl }, optionalFeatures: ['hand-tracking'] });
if (!entered.ok) {
  showTheUser(entered.reason);
  return;
}

const { run } = entered;
const stop = startLoop(
  {
    simulate: (dt, tick) => world.step(dt, tick),
    render: (alpha, dt, wallDt, frame) => {
      const pose = (frame as XrFrame).getViewerPose(run.referenceSpace);
      if (pose === null || pose === undefined) return; // Tracking lost.
      for (const eye of eyeViews(pose, run.layer.baseLayer)) {
        aimCameraAtEye(camera, eye);
        // Drawing `camera` into `eye.viewport` of the layer is the step the renderer lacks.
      }
    },
  },
  { frameSource: run.frameSource },
);

run.onEnd(stop);
```

## Drawing into a headset is not built

A session composites a layer: on WebGL2 the `XRWebGLLayer`'s framebuffer, one viewport an eye, and
on WebGPU a texture an eye from the binding. Core's renderer draws into its own canvas and has no
call that points a frame at either, and it does not hand out the WebGL2 context or GPU device that
`sources` asks for. So a session can be entered and read, poses, controllers and hands included,
and the headset shows nothing. `docs/IMPROVEMENTS.md` in the engine repository records what it
would take.

## The camera is supplied, not configured

`Camera` derives its view from yaw and pitch and its projection from `mat4.perspective`, and it
cannot describe an XR eye. Its own note says why: _only a centred crop of a symmetric frustum is
itself a symmetric frustum; an off-centre one is sheared, which `perspective` cannot produce._ A
headset's eye projection is exactly that shear, off-axis by the distance from pupil to display
centre.

So `Camera.adoptView` takes the matrices the runtime computed. It recomputes the combined and
inverse matrices, so culling, picking and the sky keep working, and it decomposes `position` and
`forward` back out, so a listener placed at `camera.position` follows the head rather than staying
where the last flat frame left it. It leaves `yaw`, `pitch` and `roll` alone, because a supplied
rotation may be one no Euler triple describes.

## The loop runs on the session's clock

A session produces frames at whatever rate its display runs, through its own
`requestAnimationFrame`, and the callback carries the frame every pose is read from. Hand
`run.frameSource` to `startLoop` and the engine follows it. Outside a session the window drives, as
it always did.

## Nothing fails silently

Every path that does not enter a session answers with a whole sentence, because a consumer whose
button did nothing is owed the difference between a browser with no WebXR, a machine with no
headset, a context that would not become XR compatible, and a reference space the runtime declined.
Those are four different things to do next.

`probeXrSupport` asks by **doing**. `isSessionSupported` is a promise about a mode and says nothing
about whether a context can be made XR compatible, which is the step that actually fails: on a
machine with no headset, `inline` reports supported, the session starts, the reference space is
granted, and `makeXRCompatible` throws. Without it there is no base layer and therefore no frame at
all.

## Both backends

`XRGPUBinding` with a projection layer where the runtime has one, `XRWebGLLayer` otherwise, chosen
from what the session offers rather than from a preference. A WebGPU layer that fails to build falls
through to WebGL2 and says so, because a game running on WebGPU in a browser whose WebXR is
WebGL-only should enter a session rather than refuse.

WebGPU in WebXR is experimental. In Chrome it is behind `--enable-experimental-web-platform-features`
and its own note calls it available for developer testing on Windows and Android. This package does
not ask a consumer to ship that flag; it uses the binding when a browser already offers one.

## From a script

`drift/xr` binds twelve capabilities: whether a session is presenting, where the head is, what each
hand's trigger and grip are doing, where a named joint is, and whether a hand is pinching. **None of
them is deterministic**, so a `@deterministic` system cannot ask where a head is, which is the
property the annotation exists for. **None of them is a matrix**: drawing the two eyes is the host's,
because the host owns the renderer.

## What has been measured, and what has not

The machine this was written on has no headset. `immersive-vr` reports false and `makeXRCompatible`
throws, so no `XRFrame` can be produced there at all.

- **Measured** by `npm run check:xr` against a real browser: capability detection, a real `inline`
  session requested and ended, a real reference space, the WebGPU binding constructing under the
  flag, and every refusal path.
- **Measured** by the unit tests against a synthetic runtime: two views with different off-axis
  projections, the camera adopting each, controller buttons and poses, twenty-five hand joints, and
  a joint that stops being tracked keeping its last pose.
- **Not measured**: a real immersive session, stereo on hardware, controller input from a device,
  hand tracking, device performance, and the compositor's reprojection.

That last line is an open row, unmeasured rather than claimed. Nothing here says otherwise.
