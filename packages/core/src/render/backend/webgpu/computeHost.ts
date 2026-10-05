/**
 * What compute a consumer opts into needs from the WebGPU renderer: its device, whether the device
 * is gone, which frame a change made now belongs to, and a place to retire textures the frame being
 * recorded may still read.
 *
 * **Why a door rather than renderer methods.** A skinned cloth's solver is fifteen kilobytes
 * gzipped of compute, WGSL and the CPU solver beneath it, and a renderer method that constructs it
 * is a static reference no bundler can shake — every game would ship a garment solver whether or
 * not it draws a garment. Behind this, `createSkinnedCloth` is a barrel function, and only a game
 * that imports it carries it. **What it gives up**: a function reaching the renderer through a door
 * the public surface does not show; the door stays this narrow so that is all it reaches.
 */
export interface ComputeHost {
  device(): GPUDevice;
  lost(): boolean;
  /** The frame a change made now is drawn in: this one inside a frame, the next between frames. */
  changeFrame(): number;
  retire(textures: readonly GPUTexture[]): void;
}

/** The host of a renderer that has one: the WebGPU backend, and nothing else. */
export function computeHostOf(renderer: object): ComputeHost | null {
  const asked = (renderer as { computeHost?: () => ComputeHost }).computeHost;
  return typeof asked === 'function' ? asked.call(renderer) : null;
}
