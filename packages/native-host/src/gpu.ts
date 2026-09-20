/**
 * `navigator.gpu` for a host with no browser: Dawn's instance, answering as the browser does.
 *
 * **The engine is not told it is on a host.** Its WebGPU backend asks `navigator.gpu` for an
 * adapter and for the format a canvas prefers, and nothing else; this answers both from Dawn, the
 * implementation inside Chrome, so the device the engine gets is the one it would have been given
 * in a browser on the same machine.
 */

import { adaptDevice } from './device.ts';

/**
 * The format a canvas prefers, answered as Chrome answers it on this machine.
 *
 * **The engine builds every pipeline that writes the frame against this answer**, and Dawn's own
 * instance says `bgra8unorm` where Chrome says `rgba8unorm`. The host owns the texture the frame
 * lands in, so it can answer either; it answers the browser's, and the two hosts build the same
 * pipelines. What it gives up: on a machine where Chrome prefers `bgra8unorm` the two hosts
 * differ in channel order, which is the same picture and a different pipeline key.
 */
export const PREFERRED_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** What this needs from Dawn's instance: the adapter request, and nothing it says about canvases. */
export interface DawnInstance {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat?(): GPUTextureFormat;
  readonly wgslLanguageFeatures?: WGSLLanguageFeatures;
}

/**
 * The adapter the engine is handed, whose devices come out adapted: see `device.ts`. A proxy rather
 * than a patch, because the adapter is the binding's object and its other members are read as they
 * are.
 */
function hostAdapter(adapter: GPUAdapter): GPUAdapter {
  return new Proxy(adapter, {
    get(target, key) {
      if (key === 'requestDevice') {
        return async (descriptor?: GPUDeviceDescriptor) =>
          adaptDevice(await target.requestDevice(descriptor));
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** The object a host installs as `navigator.gpu`. */
export function nativeGpu(instance: DawnInstance): GPU {
  const gpu = {
    requestAdapter: async (options?: GPURequestAdapterOptions) => {
      const adapter = await instance.requestAdapter(options);
      return adapter === null ? null : hostAdapter(adapter);
    },
    getPreferredCanvasFormat: (): GPUTextureFormat => PREFERRED_FORMAT,
    wgslLanguageFeatures: instance.wgslLanguageFeatures ?? new Set<string>(),
  };
  return gpu as unknown as GPU;
}
