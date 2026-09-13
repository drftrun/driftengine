import type { Camera } from './camera.ts';

/**
 * What a drawing path needs from the camera, which is not the camera.
 *
 * **The seam reversed depth was waiting on.** WebGPU corrects a projection once a frame, in one
 * place, at the last moment before drawing. WebGL2 had no such place: the camera's raw matrix was
 * read directly by the main renderer and by the plume, water, caustics, wind-streak and flock
 * renderers, each uploading it itself — so reversing depth meant remapping six call sites across
 * five files and then finding a seventh, which is how three attempts at it went.
 *
 * Narrowing the parameter to the three fields those paths actually read is what lets the frame hand
 * them a *corrected* matrix instead of the camera's own. A real `Camera` satisfies it structurally,
 * so no caller outside changed, and the correction now lives in one place on this backend too.
 *
 * **Derived from `Camera` rather than restated.** Written out by hand, the day a field changes type
 * this drifts and the mismatch shows up as geometry in the wrong place; picked off the class, it
 * cannot.
 */
export type FrameView = Pick<Camera, 'position' | 'view' | 'viewProjection'>;
