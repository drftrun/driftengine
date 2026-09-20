/**
 * A device for running networks, opened from whichever `GPU` the caller has.
 *
 * **The `GPU` is a parameter**, so a browser's `navigator.gpu` and the native host's Dawn are the
 * caller's choice, and nothing here reaches for a global. **Half precision is decided here, once**:
 * asked for on an adapter without `shader-f16`, it is refused with the way out named, rather than
 * failing to compile at the first graph far from the choice that caused it.
 *
 * The storage limits are raised to the adapter's own, because a network's values are large where a
 * frame's are not — a transformer's feed-forward layer at a depth model's resolution is eight
 * megabytes a value. What it gives up is nothing a network wants: those limits are ceilings on
 * single buffers, and the default is a floor every adapter meets rather than what any one offers.
 */

export interface InferenceDevice {
  readonly device: GPUDevice;
  /** Whether weights are stored at half precision; see `schedule.ts`. */
  readonly half: boolean;
}

export async function openInferenceDevice(
  gpu: GPU,
  options: { readonly half: boolean },
): Promise<InferenceDevice> {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) {
    throw new Error('no WebGPU adapter was offered, so there is no device to run a network on');
  }
  if (options.half && !adapter.features.has('shader-f16')) {
    throw new Error(
      'half precision was asked for and this adapter has no shader-f16, so a half-precision ' +
        'weight cannot be read; open the device with { half: false } to store weights at single ' +
        'precision instead',
    );
  }
  const device = await adapter.requestDevice({
    requiredFeatures: options.half ? ['shader-f16'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { device, half: options.half };
}
