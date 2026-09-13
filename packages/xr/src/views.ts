/**
 * An `XRView` turned into something the engine's camera can adopt.
 *
 * **The whole of the stereo path is here, and it is smaller than it sounds.** A frame carries one
 * view per eye; each has a projection the runtime computed for that eye's optics and a transform
 * giving where that eye is in the reference space. The engine draws the scene once per view, into
 * that view's slice of one layer texture.
 *
 * **A view matrix is the inverse of the eye's transform**, and that is the only arithmetic in this
 * file. WebXR hands over the transform's own `inverse` when it has one, because it usually does and
 * inverting a matrix per eye per frame to recompute a number already sitting there would be work
 * for nothing. When it does not, this inverts. Both paths are exercised, because a runtime is free
 * to omit it and a path taken only on somebody else's hardware is a path nobody has run.
 */

import { mat4 } from 'gl-matrix';
import type { Camera } from '@driftengine/core';
import type { XrView, XrViewerPose, XrViewport, XrWebGlLayer } from './types.ts';

/** One eye's matrices and where it draws. */
export interface EyeView {
  readonly eye: 'left' | 'right' | 'none';
  /** The inverse of the eye's transform, which is what a camera calls its view. */
  readonly view: mat4;
  readonly projection: mat4;
  /** Where in the layer's texture this eye belongs, or null when the layer offered none. */
  readonly viewport: XrViewport | null;
}

/**
 * Reused across frames and eyes, because this runs twice a frame forever.
 *
 * Two of each, so a caller holding the left eye's matrices while it draws the right one still has
 * them. A single scratch would be the kind of reuse that works until somebody keeps a reference.
 */
const scratch = [
  { view: mat4.create(), projection: mat4.create() },
  { view: mat4.create(), projection: mat4.create() },
];

/** Grown only if a runtime ever offers more views than eyes. Nothing does today. */
function slotFor(index: number): { view: mat4; projection: mat4 } {
  while (scratch.length <= index) scratch.push({ view: mat4.create(), projection: mat4.create() });
  return scratch[index] as { view: mat4; projection: mat4 };
}

/**
 * Turn a pose's views into eye views, into reused storage.
 *
 * `out` is filled and returned so a caller in a frame loop allocates nothing. Its length is set to
 * the number of views the pose carried, which is one for an inline session and two for a stereo
 * one, and which this package never assumes.
 */
export function eyeViews(
  pose: XrViewerPose,
  layer: XrWebGlLayer | null,
  out: EyeView[] = [],
): EyeView[] {
  out.length = 0;
  for (let i = 0; i < pose.views.length; i++) {
    const view = pose.views[i] as XrView;
    const slot = slotFor(i);

    /*
     * The runtime's own inverse where there is one. A transform's `inverse` is a spec field and is
     * normally present; inverting to recompute it would be a matrix inversion per eye per frame for
     * a number already in memory.
     */
    const inverse = view.transform.inverse?.matrix;
    if (inverse !== undefined) mat4.copy(slot.view, inverse as unknown as mat4);
    else mat4.invert(slot.view, view.transform.matrix as unknown as mat4);

    mat4.copy(slot.projection, view.projectionMatrix as unknown as mat4);

    out.push({
      eye: view.eye,
      view: slot.view,
      projection: slot.projection,
      viewport: layer?.getViewport(view) ?? null,
    });
  }
  return out;
}

/**
 * Point a camera at one eye.
 *
 * A one-line function on purpose: the interesting half is `Camera.adoptView`, which lives in core
 * because the camera is core's and the reason it cannot derive these matrices is written there.
 * What this adds is the direction of the dependency. `@driftengine/xr` supplies views to a camera;
 * nothing in core reaches back for a session.
 */
export function aimCameraAtEye(camera: Camera, eye: EyeView): void {
  camera.adoptView(eye.view, eye.projection);
}
