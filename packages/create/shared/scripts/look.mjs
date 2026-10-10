/**
 * `npm run look`: serve this game, photograph it on WebGPU and on WebGL2, and say what was seen.
 *
 * The photographing is the engine's, in `@driftengine/core/scripts/look.mjs`, and it is strict on
 * purpose: a console error or warning, a canvas of one flat colour, or a backend that was asked for
 * and not used all fail it. This file only starts the game for it to look at, on a port nothing
 * else is using, and stops it afterwards.
 *
 * It writes `.driftengine/look/`: `webgpu.png` and `webgl2.png` are what a player sees, and
 * `look.json` is the report printed below, with every console line in it. Open the PNGs. A report
 * can say a frame is not empty; only looking says it is the right frame.
 *
 * Exit codes: 0 looked and found nothing wrong, 1 looked and found a problem, 2 could not look —
 * no Chrome or Edge (set `CHROME_PATH` to one), or no hardware GPU, which it refuses rather than
 * photographing a software rasteriser's guess. `npm run look -- --headed` opens a real browser
 * window instead of a headless one, for a machine whose headless browser cannot reach its GPU.
 *
 * A game that waits for a click before it draws photographs its waiting screen; add whatever query
 * flag the game reads to skip that, and pass it in the address below.
 */
import { formatLook, look } from '@driftengine/core/scripts/look.mjs';
import { createServer } from 'vite';

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
await server.listen();
const url = server.resolvedUrls?.local[0];

try {
  if (url === undefined) throw new Error('the dev server did not report an address');
  const headless = !process.argv.includes('--headed');
  const report = await look({ url, out: '.driftengine/look', headless });
  console.log(formatLook(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(`look could not look: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  await server.close();
}
