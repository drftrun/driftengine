import { describe, expect, it, vi } from 'vitest';

import { createDepthBindGroupLayout, SHADOW_FORMAT } from './depthPass.ts';
import { DEPTH_BINDINGS } from '../../shaders/generated/depth.wgsl.ts';

/** A device that records the descriptors it is handed, so a layout can be read back. */
function recordingDevice() {
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const device = {
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
      layouts.push(descriptor);
      return { label: descriptor.label ?? 'layout' };
    }),
  };
  return { device: device as unknown as GPUDevice, layouts };
}

describe('the depth pass bind group layout', () => {
  /**
   * **The peel binds the static map here, and the static map is a depth format.**
   *
   * `texture: {}` defaults to `sampleType: 'float'` and `sampler: {}` to `type: 'filtering'`,
   * which a `depth32float` view cannot satisfy. The device says so in as many words —
   * *"None of the supported sample types (UnfilterableFloat|Depth) ... match the expected
   * sample types (Float)"* — and it says it by returning an **invalid bind group rather than
   * throwing**, so the peel pass records nothing, the peel map keeps whatever undefined
   * contents it was created with, and the frame still presents. Three ports of the peel were
   * measured and reverted against that silence before anybody asked the device.
   *
   * `flatPass.ts` already gets this right for every name ending in `ShadowMap`, and
   * `uPreviousShadowMap` is one of them.
   */
  it('declares the previous shadow map unfilterable, because it is a depth texture', () => {
    const { device, layouts } = recordingDevice();
    createDepthBindGroupLayout(device);

    const entries = [...(layouts[0]?.entries ?? [])];
    const previous = DEPTH_BINDINGS.DEPTH_FRAG.textures.uPreviousShadowMap;
    const texture = entries.find((entry) => entry.binding === previous.texture);
    const sampler = entries.find((entry) => entry.binding === previous.sampler);

    expect(SHADOW_FORMAT).toBe('depth32float');
    expect(texture?.texture?.sampleType).toBe('unfilterable-float');
    expect(sampler?.sampler?.type).toBe('non-filtering');
  });
});
