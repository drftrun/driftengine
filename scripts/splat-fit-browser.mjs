/**
 * What a splat fit's step costs in Chrome, on this machine's GPU — the browser half of Task 12's
 * measurement, beside `splat-fit-budget.ts` on the native host.
 *
 * **The same code as the native host's**: `splatFitCost.ts`, bundled by esbuild with the engine's
 * source condition and served from a loopback server of its own — a secure context, which is what
 * `navigator.gpu` needs — and run in a page Chrome opens through `browser.mjs`, whose guard refuses
 * a software rasteriser. No dev server is started, so none is disturbed.
 *
 * **A development tool, never CI.** It needs a real GPU, like every other measurement in this wave.
 *
 *     node scripts/splat-fit-browser.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/* The measurement as one module the page imports, its device helpers bundled in with it. */
const scratch = mkdtempSync(path.join(tmpdir(), 'splat-fit-'));
const bundle = path.join(scratch, 'splatFitCost.js');
execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
  path.join(ROOT, 'scripts', 'splatFitEntry.ts'),
  '--bundle',
  '--format=esm',
  '--platform=browser',
  '--conditions=drift-source',
  `--outfile=${bundle}`,
  '--log-level=warning',
]);
const code = readFileSync(bundle);
rmSync(scratch, { recursive: true, force: true });

const PAGE = `<!doctype html><meta charset="utf-8"><title>splat fit cost</title><body></body>`;
const server = createServer((request, response) => {
  if ((request.url ?? '/') === '/splatFitCost.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(code);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;

const browser = await launch();
try {
  /* The cloud is settled on the CPU first, which takes seconds — past the protocol's default. */
  const client = await connect(await browser.port, { timeoutMs: 900_000 });
  console.log(`renderer: ${await requireHardwareGpu(client)}`);
  const tab = await client.page(`${origin}/`, 320, 240);
  const result = await tab.eval(
    `(async () => {
      const { runSplatFitCost } = await import('/splatFitCost.js');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      const info = adapter.info ?? {};
      const { shape, results } = await runSplatFitCost(navigator.gpu);
      return JSON.stringify({
        adapter: [info.vendor, info.architecture, info.description].filter(Boolean).join(' '),
        shape,
        results,
      });
    })()`,
  );
  const { adapter, shape, results } = JSON.parse(result);
  console.log(`Chrome, WebGPU: ${adapter}`);
  console.log(`a fitted room at ${shape.width}x${shape.height}, tiles of ${shape.tile}`);
  for (const { label, ms, clock } of results) {
    console.log(`  ${label.padEnd(46)} ${ms.toFixed(2).padStart(9)} ms  (${clock})`);
  }
  await tab.close();
  await client.close?.();
} finally {
  await browser.close();
  server.close();
}
