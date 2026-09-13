/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * WebXR: sessions, stereo views, controller input and hand joints.
 *
 * **A package and not part of core**, so a game that never enters a session carries none of it.
 * `size-gate.test.mjs` keeps that a measurement rather than an intention.
 *
 * **It supplies views to a camera and core never reaches back for a session.** That is the whole
 * shape of the dependency: `Camera.adoptView` lives in core because the camera is core's, and the
 * reason a camera cannot derive an XR eye's matrices is written beside it. Everything about
 * sessions, layers, poses and hands is here.
 *
 * ## What is measured, and what is written down instead
 *
 * A real immersive session has never been run against this code. The machine it was written on has
 * no headset: `immersive-vr` reports false, and `makeXRCompatible` throws, so no `XRFrame` can be
 * produced there at all. What that machine does reach is asserted by `scripts/xr-check.mjs`, and
 * everything past the first frame is exercised against a synthetic `XRSystem` in the unit tests.
 *
 * So **stereo on hardware, controller input, hand tracking, device performance and the compositor's
 * reprojection are unmeasured**, and are tracked as such rather than claimed. Nothing
 * here says otherwise.
 */

export type {
  XrFrame,
  XrGamepad,
  XrHand,
  XrInputSource,
  XrJointPose,
  XrMode,
  XrRigidTransform,
  XrSession,
  XrSystem,
  XrView,
  XrViewerPose,
  XrViewport,
  XrWebGlLayer,
} from './types.ts';

export type { XrCompatibleContext, XrSupport } from './support.ts';
export { bestMode, probeXrSupport } from './support.ts';

export type { LayerBackend, LayerSources, XrLayer } from './layers.ts';
export { chooseLayer } from './layers.ts';

export type { EnterXrOptions, EnterXrResult, XrRun } from './session.ts';
export { enterXr } from './session.ts';

export type { EyeView } from './views.ts';
export { aimCameraAtEye, eyeViews } from './views.ts';

export type { ControllerState, Handedness, XrButton } from './input.ts';
export {
  XR_BUTTON,
  buttonPressed,
  buttonValue,
  controllerFor,
  readController,
  readControllers,
} from './input.ts';

export type { HandJoint } from './hands.ts';
export {
  HAND_JOINTS,
  HandSkeleton,
  JOINT_COUNT,
  JOINT_INDEX,
  jointPosition,
  readHand,
} from './hands.ts';
