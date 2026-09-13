/**
 * Shader modules, built once per source per device.
 *
 * **A module used to be created inside every pipeline descriptor**, which reads as free and is
 * not: `createShaderModule` parses and validates the WGSL, and a descriptor is built on every
 * `PipelineCache` miss. The flat shader is the worst case and the common one. A consumer that
 * creates two dozen meshes gets a pipeline per distinct vertex layout, times a blended twin,
 * times every target the mesh can land on, and each of those parsed the same large source
 * again. On a workstation that is invisible. On a phone it is seconds of the main thread,
 * before a single frame, which is a black and unresponsive page rather than a slow one.
 *
 * Keyed by the source text rather than by the label, because the source is what decides what a
 * module *is* — two passes that compile the same WGSL under different labels want one module,
 * and a label is a debugging string that must never change the object graph. Modules are
 * immutable once created and safe to share between pipelines, which is the whole reason this
 * can be a cache rather than a pool.
 *
 * `WeakMap` on the device, so nothing here outlives the device it belongs to: a lost context
 * builds a new device, which starts empty and cannot be handed a module belonging to the dead
 * one. That also means this needs no `dispose` and no wiring into anybody's teardown.
 */
const byDevice = new WeakMap<GPUDevice, Map<string, GPUShaderModule>>();

/**
 * The module for this source, compiling it on the first ask only.
 *
 * A drop-in for `device.createShaderModule(descriptor)`, and deliberately the same shape so a
 * call site reads the same after the change as before it.
 */
export function shaderModule(
  device: GPUDevice,
  descriptor: GPUShaderModuleDescriptor,
): GPUShaderModule {
  let modules = byDevice.get(device);
  if (modules === undefined) {
    modules = new Map<string, GPUShaderModule>();
    byDevice.set(device, modules);
  }
  const existing = modules.get(descriptor.code);
  if (existing !== undefined) return existing;
  const built = device.createShaderModule(descriptor);
  modules.set(descriptor.code, built);
  return built;
}

/** How many distinct sources this device has compiled. Read by tests and diagnostics. */
export function shaderModuleCount(device: GPUDevice): number {
  return byDevice.get(device)?.size ?? 0;
}
