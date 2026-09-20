/**
 * What a splat fit's step costs on the native host: Dawn, through `@kmamal/gpu`, with the device's
 * own timestamps. `splat-fit-browser.mjs` runs the same `splatFitCost.ts` in Chrome.
 *
 * **A development tool, never CI**, like every other measurement in this wave: it needs a real GPU,
 * and `npm run test:scripts` runs on machines that have none.
 *
 *     npx tsx --conditions=drift-source scripts/splat-fit-budget.ts
 */
import gpu from '@kmamal/gpu';

import { openDevice, sustained } from '../tools/capture-weights/modelCost.ts';
import { measureSplatFit, SPLAT_FIT_SHAPE } from './splatFitCost.ts';

const instance = gpu.create([]);
const adapter = await instance.requestAdapter({ powerPreference: 'high-performance' });
const info = (
  adapter as unknown as { info?: { vendor?: string; device?: string; description?: string } } | null
)?.info;
console.log(
  `native host, Dawn: ${info?.vendor ?? ''} ${info?.device ?? ''} — ${info?.description ?? ''}`,
);
console.log(
  `a fitted room at ${SPLAT_FIT_SHAPE.width}x${SPLAT_FIT_SHAPE.height}, ` +
    `tiles of ${SPLAT_FIT_SHAPE.tile}`,
);
for (const { label, ms, clock } of await measureSplatFit(instance as unknown as GPU, {
  openDevice,
  sustained,
})) {
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(2).padStart(9)} ms  (${clock})`);
}
