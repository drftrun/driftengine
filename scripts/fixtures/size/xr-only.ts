/**
 * The XR package on its own, which is what a game that never enters a session does not pay.
 *
 * It imports `@driftengine/core` for the camera it supplies views to, so this figure is not the
 * package alone; it is the smallest thing that can use one, which is the number a consumer deciding
 * whether to add the import actually wants. `boundaries.test.mjs` asserts the direction of that
 * dependency and this asserts its consequence.
 */
import { Camera } from '@driftengine/core';
import {
  HandSkeleton,
  aimCameraAtEye,
  enterXr,
  eyeViews,
  jointPosition,
  probeXrSupport,
  readControllers,
  readHand,
} from '@driftengine/xr';

/** Ask, enter, and draw both eyes. The whole of what a consumer writes. */
export async function present(gl: unknown): Promise<number> {
  const support = await probeXrSupport(gl as { makeXRCompatible?(): Promise<void> });
  if (!support.immersiveVr) return 0;

  const entered = await enterXr({ sources: { gl }, optionalFeatures: ['hand-tracking'] });
  if (!entered.ok) return 0;

  const camera = new Camera();
  const skeleton = new HandSkeleton();
  const at = new Float32Array(3);
  let drawn = 0;

  entered.run.frameSource.requestAnimationFrame((_time, frame) => {
    const xrFrame = frame as Parameters<typeof readControllers>[1];
    const pose = xrFrame.getViewerPose(entered.run.referenceSpace);
    if (pose === null || pose === undefined) return;
    for (const eye of eyeViews(pose, entered.run.layer.baseLayer)) {
      aimCameraAtEye(camera, eye);
      drawn++;
    }
    for (const state of readControllers(entered.run.session, xrFrame, entered.run.referenceSpace)) {
      if (state.tracked) drawn++;
    }
    for (const source of entered.run.session.inputSources) {
      readHand(source, xrFrame, entered.run.referenceSpace, skeleton);
      jointPosition(skeleton, 'index-finger-tip', at);
    }
  });

  return drawn;
}
