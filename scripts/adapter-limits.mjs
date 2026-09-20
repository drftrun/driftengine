/**
 * The two limits a gpu-driven buffer meets, as this machine's adapter reports them.
 *
 *     node scripts/adapter-limits.mjs [--base=http://localhost:5202]
 *
 * A buffer bound whole has to be both creatable (`maxBufferSize`) and bindable
 * (`maxStorageBufferBindingSize`), and `select.ts` asks the adapter for all it offers of both, so
 * what the adapter says is what the device has. It needs a secure context: a blank page has no
 * `navigator.gpu`, so it reads them from the dev server's page.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server
 * and a real GPU.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const hit = process.argv.find((a) => a.startsWith('--base='));
const base = (hit === undefined ? 'http://localhost:5202' : hit.slice(7)).replace(/\/$/, '');
const browser = await launch();
const client = await connect(browser.port);
const page = await client.page(`${base}/`, 640, 360);
const limits = await page.eval(`(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  return {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
})()`);
console.log(JSON.stringify(limits));
await page.close?.();
await browser.close?.();
process.exit(0);
