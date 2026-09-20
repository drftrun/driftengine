/**
 * What this device can do, asked once, in one place.
 *
 * **Not `gpuCapability.ts`, which answers a different question.** That module identifies the
 * *part* — a renderer string, matched against families known to struggle — so that a consumer can
 * choose a quality profile. This one reads the optional features and limits a device actually
 * reports. A weak part may support half precision and a strong one may not; neither answer
 * predicts the other.
 *
 * **One place, because the alternative is each subsystem asking the device itself.** Every
 * capability below has more than one consumer waiting for it, and a feature string spelled two
 * ways in two subsystems is a capability that is present in one and absent in the other on the
 * same machine.
 *
 * **Takes the device's shape as a parameter rather than reaching for a global**, which is the
 * rule `AGENTS.md` applies to persistence applied here — and is what lets every branch below be
 * asserted without a graphics device.
 */
import { indirectSupport } from './backend/api.ts';

/** The subset of a device this needs. A real `GPUDevice` satisfies it. */
export interface DeviceShape {
  readonly features: { has(name: string): boolean };
  readonly limits: Readonly<Record<string, number | undefined>>;
}

export interface GpuCapabilities {
  /** Half-precision arithmetic in shaders. */
  readonly shaderF16: boolean;
  /** Subgroup operations, which make a compute reduction far cheaper where present. */
  readonly subgroups: boolean;
  /** Timestamp queries. Absent by default in more browsers than people expect. */
  readonly timestampQuery: boolean;
  /** Whether this backend can be driven from buffers the GPU wrote. See `indirectSupport`. */
  readonly indirect: boolean;
  /**
   * The three compressed families, reported separately.
   *
   * **Separately, because a device may have exactly one.** Desktop parts carry block compression,
   * mobile carries one of the other two, and a single `compressed: boolean` would be true on
   * every device and useful on none.
   */
  readonly compressedBc: boolean;
  readonly compressedEtc2: boolean;
  readonly compressedAstc: boolean;
  /** Limits, with an absent one reported as 0 so arithmetic on it is safe. */
  readonly maxStorageBufferBytes: number;
  readonly maxComputeWorkgroupStorageBytes: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
}

function limit(device: DeviceShape, name: string): number {
  /*
   * Zero rather than undefined for a limit the device does not report. A consumer sizing a buffer
   * against `undefined` gets NaN and allocates nothing while believing it allocated something;
   * against 0 it gets a refusal it can see.
   */
  return device.limits[name] ?? 0;
}

export function probeCapabilities(
  device: DeviceShape,
  backend: 'webgl2' | 'webgpu',
): GpuCapabilities {
  return {
    shaderF16: device.features.has('shader-f16'),
    subgroups: device.features.has('subgroups'),
    timestampQuery: device.features.has('timestamp-query'),
    indirect: indirectSupport(backend),
    compressedBc: device.features.has('texture-compression-bc'),
    compressedEtc2: device.features.has('texture-compression-etc2'),
    compressedAstc: device.features.has('texture-compression-astc'),
    maxStorageBufferBytes: limit(device, 'maxStorageBufferBindingSize'),
    maxComputeWorkgroupStorageBytes: limit(device, 'maxComputeWorkgroupStorageSize'),
    maxComputeInvocationsPerWorkgroup: limit(device, 'maxComputeInvocationsPerWorkgroup'),
  };
}
