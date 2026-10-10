/**
 * The cloth solver's layouts and one compute pipeline an entry point of `shaders/clothSolve.wgsl.ts`,
 * built once a device and shared by every set of garments on it.
 */
import { CLOTH_SOLVE_WGSL } from './shaders/clothSolve.wgsl.ts';
import { shaderModule } from './shaderModules.ts';

const COMPUTE = 0x4;

export const CLOTH_ENTRIES = [
  'clothPose',
  'clothRest',
  'clothBegin',
  'clothPredict',
  'clothDistance',
  'clothBending',
  'clothTether',
  'clothLimit',
  'clothFinish',
  'clothBlend',
  'clothPublish',
] as const;
export type ClothEntry = (typeof CLOTH_ENTRIES)[number];

export interface ClothKernels {
  readonly layout: GPUBindGroupLayout;
  readonly outputLayout: GPUBindGroupLayout;
  readonly pipelines: Readonly<Record<ClothEntry, GPUComputePipeline>>;
}

const kernelsByDevice = new WeakMap<GPUDevice, ClothKernels>();

export function clothKernelsFor(device: GPUDevice): ClothKernels {
  const held = kernelsByDevice.get(device);
  if (held !== undefined) return held;
  const uniform = (binding: number, dynamic: boolean): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: COMPUTE,
    buffer: { type: 'uniform', hasDynamicOffset: dynamic },
  });
  const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: COMPUTE,
    buffer: { type },
  });
  /* Seven storage buffers of the eight a stage is granted: the shader's header says why so few. */
  const layout = device.createBindGroupLayout({
    label: 'cloth.solve',
    entries: [
      uniform(0, false),
      uniform(1, true),
      uniform(2, true),
      storage(3, 'storage'),
      storage(4, 'storage'),
      storage(5, 'read-only-storage'),
      storage(6, 'read-only-storage'),
      storage(7, 'storage'),
      storage(8, 'read-only-storage'),
      storage(9, 'read-only-storage'),
    ],
  });
  const outputLayout = device.createBindGroupLayout({
    label: 'cloth.publish',
    entries: [
      {
        binding: 0,
        visibility: COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba32float' },
      },
    ],
  });
  const module = shaderModule(device, { label: 'cloth.solve', code: CLOTH_SOLVE_WGSL });
  const solve = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const publish = device.createPipelineLayout({ bindGroupLayouts: [layout, outputLayout] });
  const pipelines = {} as Record<ClothEntry, GPUComputePipeline>;
  for (const entry of CLOTH_ENTRIES) {
    pipelines[entry] = device.createComputePipeline({
      label: `cloth.${entry}`,
      layout: entry === 'clothPublish' ? publish : solve,
      compute: { module, entryPoint: entry },
    });
  }
  const kernels = { layout, outputLayout, pipelines };
  kernelsByDevice.set(device, kernels);
  return kernels;
}
