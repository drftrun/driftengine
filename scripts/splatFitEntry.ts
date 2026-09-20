/**
 * The page's one entry point into the measurement: the cost module with its device helpers bound.
 *
 * **It exists so the browser and the native host share `splatFitCost.ts` and nothing else.** That
 * module takes `openDevice` and `sustained` rather than importing them, because
 * `tools/capture-weights/modelCost.ts` is where those live and a measurement module that reached
 * into the weights tooling for them would tie the two together for one function each.
 */
import { openDevice, sustained } from '../tools/capture-weights/modelCost.ts';

import { measureSplatFit, SPLAT_FIT_SHAPE, type SplatFitCost } from './splatFitCost.ts';

export async function runSplatFitCost(
  gpu: GPU,
): Promise<{ shape: typeof SPLAT_FIT_SHAPE; results: SplatFitCost[] }> {
  return { shape: SPLAT_FIT_SHAPE, results: await measureSplatFit(gpu, { openDevice, sustained }) };
}
