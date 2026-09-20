/**
 * Every operator's device kernel, by the name `@driftengine/texture`'s operator table uses.
 *
 * **Two tables, one set of names**, because the references and the kernels live in packages that
 * cannot import each other at run time. `kernels.test.ts` holds the two sets equal, since an
 * operator in one and not the other is a graph that validates and then cannot run.
 */
import { DENSE_KERNELS } from './denseKernels.ts';
import type { KernelGenerator } from './kernelKit.ts';
import { SHAPE_KERNELS } from './shapeKernels.ts';
import { SPATIAL_KERNELS } from './spatialKernels.ts';

export type { ElementType, KernelGenerator, KernelRequest, KernelSource } from './kernelKit.ts';

export const DEVICE_KERNELS: ReadonlyMap<string, KernelGenerator> = new Map<
  string,
  KernelGenerator
>([...DENSE_KERNELS, ...SPATIAL_KERNELS, ...SHAPE_KERNELS]);
