import { describe, expect, it, vi } from 'vitest';

import { shaderModule, shaderModuleCount } from './shaderModules.ts';

/*
 * A module used to be created inside every pipeline descriptor, so the same WGSL was parsed
 * and validated once per pipeline that named it. The flat shader is the case that hurts: a
 * pipeline per distinct vertex layout, times a blended twin, times every target a mesh can
 * land on, each re-parsing the largest source in the engine. Invisible on a workstation,
 * seconds of blocked main thread on a phone.
 */
describe('the shader module cache', () => {
  const fakeDevice = (): { device: GPUDevice; createShaderModule: ReturnType<typeof vi.fn> } => {
    const createShaderModule = vi.fn((d: GPUShaderModuleDescriptor) => ({ label: d.label }));
    return { device: { createShaderModule } as unknown as GPUDevice, createShaderModule };
  };

  it('compiles one source once and returns the same module after', () => {
    const { device, createShaderModule } = fakeDevice();

    const a = shaderModule(device, { label: 'flat.vert', code: 'CODE' });
    const b = shaderModule(device, { label: 'flat.vert', code: 'CODE' });

    expect(a).toBe(b);
    expect(createShaderModule).toHaveBeenCalledTimes(1);
  });

  /*
   * Keyed by source, not by label. Two passes compiling the same WGSL under different labels
   * want one module: a label is a debugging string and must never change the object graph.
   */
  it('shares a module between two labels naming the same source', () => {
    const { device, createShaderModule } = fakeDevice();

    const particle = shaderModule(device, { label: 'particle.vert', code: 'SHARED' });
    const plume = shaderModule(device, { label: 'plume.vert', code: 'SHARED' });

    expect(particle).toBe(plume);
    expect(createShaderModule).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct sources apart', () => {
    const { device, createShaderModule } = fakeDevice();

    const vert = shaderModule(device, { label: 'flat.vert', code: 'VERT' });
    const frag = shaderModule(device, { label: 'flat.frag', code: 'FRAG' });

    expect(vert).not.toBe(frag);
    expect(createShaderModule).toHaveBeenCalledTimes(2);
    expect(shaderModuleCount(device)).toBe(2);
  });

  /*
   * A lost context builds a new device, and a module belongs to the device that made it.
   * Handing the new one a module from the dead one is the failure this must not have.
   */
  it('never hands one device a module belonging to another', () => {
    const first = fakeDevice();
    const second = fakeDevice();

    const a = shaderModule(first.device, { label: 'sky.vert', code: 'CODE' });
    const b = shaderModule(second.device, { label: 'sky.vert', code: 'CODE' });

    expect(a).not.toBe(b);
    expect(first.createShaderModule).toHaveBeenCalledTimes(1);
    expect(second.createShaderModule).toHaveBeenCalledTimes(1);
    expect(shaderModuleCount(second.device)).toBe(1);
  });

  it('reports nothing for a device that has compiled nothing', () => {
    expect(shaderModuleCount(fakeDevice().device)).toBe(0);
  });
});
