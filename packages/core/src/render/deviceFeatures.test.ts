import { expect, test } from 'vitest';
import { probeCapabilities } from './deviceFeatures.ts';

function device(features: readonly string[] = [], limits: Record<string, number> = {}) {
  return { features: new Set(features), limits };
}

test('a device exposing nothing optional reports every optional capability false', () => {
  const caps = probeCapabilities(device(), 'webgpu');
  expect(caps.shaderF16).toBe(false);
  expect(caps.subgroups).toBe(false);
  expect(caps.timestampQuery).toBe(false);
  expect(caps.compressedAstc).toBe(false);
});

test('each compressed family is reported on its own, because a device may have exactly one', () => {
  const caps = probeCapabilities(device(['texture-compression-astc']), 'webgpu');
  expect(caps.compressedAstc).toBe(true);
  expect(caps.compressedBc).toBe(false);
  expect(caps.compressedEtc2).toBe(false);
});

test('an absent limit reports zero rather than undefined, so arithmetic on it is safe', () => {
  const caps = probeCapabilities(device(), 'webgpu');
  expect(caps.maxStorageBufferBytes).toBe(0);
  expect(caps.maxStorageBufferBytes * 2).toBe(0);
});

test('a reported limit comes through unchanged', () => {
  const caps = probeCapabilities(device([], { maxStorageBufferBindingSize: 134217728 }), 'webgpu');
  expect(caps.maxStorageBufferBytes).toBe(134217728);
});

test('indirect follows the backend, not a device feature', () => {
  expect(probeCapabilities(device(), 'webgpu').indirect).toBe(true);
  expect(probeCapabilities(device(), 'webgl2').indirect).toBe(false);
});

test('a WebGL2 device that somehow reported half precision still reports it', () => {
  const caps = probeCapabilities(device(['shader-f16']), 'webgl2');
  expect(caps.shaderF16).toBe(true);
  expect(caps.indirect).toBe(false);
});
