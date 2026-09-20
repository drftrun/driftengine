/**
 * What each converted model costs in Chrome, on this machine's GPU — the browser half of Task
 * 5's measurement, beside `modelbudget.ts` on the native host.
 *
 * **The same code as the native host's**: `modelCost.ts`, bundled by esbuild with the engine's
 * source condition, served with the converted files from a loopback server of its own — a secure
 * context, which is what `navigator.gpu` needs — and run in a page Chrome opens through
 * `browser.mjs`, whose guard refuses a software rasteriser. No dev server is started, so none is
 * disturbed.
 *
 *     npx tsx --conditions=drift-source tools/capture-weights/build.ts depth-anything-3-small
 *     node tools/capture-weights/browserbudget.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch, requireHardwareGpu } from '../../packages/core/scripts/browser.mjs';
import { connect } from '../../packages/core/scripts/cdp.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const MODELS = ['depth-anything-3-small', 'depth-anything-2-small', 'mobilesam'].filter((name) =>
  existsSync(path.join(ROOT, 'models', 'capture', `${name}.drft`)),
);

/* The measurement as one module the page imports. */
const scratch = mkdtempSync(path.join(tmpdir(), 'browserbudget-'));
const bundle = path.join(scratch, 'modelCost.js');
execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
  path.join(ROOT, 'tools', 'capture-weights', 'modelCost.ts'),
  '--bundle',
  '--format=esm',
  '--platform=browser',
  '--conditions=drift-source',
  `--outfile=${bundle}`,
  '--log-level=warning',
]);
const code = readFileSync(bundle);
rmSync(scratch, { recursive: true, force: true });

const PAGE = `<!doctype html><meta charset="utf-8"><title>model cost</title><body></body>`;
const server = createServer((request, response) => {
  const url = request.url ?? '/';
  if (url === '/modelCost.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(code);
    return;
  }
  const model = /^\/([a-z0-9-]+)\.drft$/.exec(url)?.[1];
  if (model !== undefined && MODELS.includes(model)) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(readFileSync(path.join(ROOT, 'models', 'capture', `${model}.drft`)));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;

const browser = await launch();
try {
  /* A whole model is timed for seconds at a time, past the protocol's ten-second default. */
  const client = await connect(await browser.port, { timeoutMs: 900_000 });
  console.log(`renderer: ${await requireHardwareGpu(client)}`);
  const tab = await client.page(`${origin}/`, 320, 240);
  const result = await tab.eval(
    `(async () => {
      const { measureModels } = await import('/modelCost.js');
      const files = new Map();
      for (const name of ${JSON.stringify(MODELS)}) {
        files.set(name, await (await fetch('/' + name + '.drft')).arrayBuffer());
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      const info = adapter.info ?? {};
      const results = await measureModels(navigator.gpu, files);
      return JSON.stringify({ adapter: [info.vendor, info.architecture, info.description].filter(Boolean).join(' '), results });
    })()`,
  );
  const { adapter, results } = JSON.parse(result);
  console.log(`Chrome, WebGPU: ${adapter}`);
  for (const { label, ms, clock } of results) {
    console.log(`  ${label.padEnd(52)} ${ms.toFixed(2).padStart(8)} ms  (${clock})`);
  }
  await tab.close();
  await client.close?.();
} finally {
  await browser.close();
  server.close();
}
