/**
 * What each converted model costs on the native host: Dawn, through `@kmamal/gpu`, with the
 * device's own timestamps. `browserbudget.mjs` runs the same `modelCost.ts` in Chrome.
 *
 *     npx tsx --conditions=drift-source tools/capture-weights/build.ts depth-anything-3-small
 *     npx tsx --conditions=drift-source tools/capture-weights/modelbudget.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import gpu from '@kmamal/gpu';

import { measureModels } from './modelCost.ts';

const folder = path.join(new URL('../..', import.meta.url).pathname, 'models', 'capture');
const files = new Map<string, ArrayBuffer>();
for (const name of [
  'depth-anything-3-small',
  'depth-anything-2-small',
  'mobilesam',
  'sam-2.1-tiny',
  'owlv2-base-patch16',
]) {
  const file = path.join(folder, `${name}.drft`);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    files.set(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
}
const instance = gpu.create([]);
const adapter = await instance.requestAdapter({ powerPreference: 'high-performance' });
const info = (
  adapter as unknown as { info?: { vendor?: string; device?: string; description?: string } } | null
)?.info;
console.log(
  `native host, Dawn: ${info?.vendor ?? ''} ${info?.device ?? ''} — ${info?.description ?? ''}`,
);
for (const { label, ms, clock } of await measureModels(instance as unknown as GPU, files)) {
  console.log(`  ${label.padEnd(52)} ${ms.toFixed(2).padStart(8)} ms  (${clock})`);
}
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(0);
