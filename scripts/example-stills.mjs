/**
 * A still of every example, for the gallery on the engine's site.
 *
 *     node scripts/example-stills.mjs                                    # every example
 *     node scripts/example-stills.mjs tools water                        # the ones named
 *     node scripts/example-stills.mjs --base=http://localhost:5191 tools # a server already up
 *
 * Starts the examples' own development server unless `--base` names one already running, opens each
 * example at 1280 by 720 on WebGPU in the engine's headless browser, on a real GPU, lets it run,
 * hides the page's own controls and writes `examples/<name>/still.webp` at half that size.
 *
 * **A still is committed beside its example**, so an example that changes how it looks changes its
 * still in the same commit, and the site reads the stills from the same engine checkout it builds
 * the manual from. A browser in a CI runner has no GPU to draw with, which is why this runs here and
 * the site only copies what it finds. `scripts/manual.test.mjs` fails for an example with none.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect, sleep } from '../packages/core/scripts/cdp.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXAMPLES = path.join(ROOT, 'examples');
const WIDTH = 1280;
const HEIGHT = 720;

/** How long an example runs before its still, where the default is too short for what it shows. */
const RUN_MS = { models: 9000, splats: 9000, recording: 7000, 'texture-streaming': 9000 };
const DEFAULT_RUN_MS = 5000;

/** What a still should show that the example's first moments do not. */
const QUERY = { tools: 'open=yes' };

/** The page's own controls: the gallery shows the scene, and its page has the switches. */
const HIDE = '#backend, #home, #controls, #hint, #fps-meter { visibility: hidden !important; }';

export function exampleNames(root = ROOT) {
  const dir = path.join(root, 'examples');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter(
      (entry) =>
        existsSync(path.join(dir, entry.name, 'index.html')) &&
        existsSync(path.join(dir, entry.name, 'main.ts')),
    )
    .map((entry) => entry.name)
    .sort();
}

async function serve() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: EXAMPLES,
    configFile: path.join(EXAMPLES, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port: 0, host: 'localhost' },
  });
  await server.listen();
  const base = (server.resolvedUrls?.local[0] ?? '').replace(/\/$/, '');
  return { base, close: () => server.close() };
}

async function main() {
  const args = process.argv.slice(2);
  const given = args.find((arg) => arg.startsWith('--base='))?.slice('--base='.length);
  const names = args.filter((arg) => !arg.startsWith('--'));
  const all = exampleNames();
  const unknown = names.filter((name) => !all.includes(name));
  if (unknown.length > 0) throw new Error(`no example called ${unknown.join(', ')}`);

  const server = given === undefined ? await serve() : { base: given, close: async () => {} };
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    console.log(`drawing with ${await requireHardwareGpu(client)}`);
    for (const name of names.length > 0 ? names : all) {
      const extra = QUERY[name] === undefined ? '' : `&${QUERY[name]}`;
      const page = await client.page(`${server.base}/${name}/?splash=0${extra}`, WIDTH, HEIGHT);
      try {
        await sleep(RUN_MS[name] ?? DEFAULT_RUN_MS);
        await page.eval(
          `document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(HIDE)} }))`,
        );
        await page.frames(3);
        const shot = await page.call('Page.captureScreenshot', {
          format: 'webp',
          quality: 80,
          clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 0.5 },
        });
        const bytes = Buffer.from(shot.data, 'base64');
        writeFileSync(path.join(EXAMPLES, name, 'still.webp'), bytes);
        const complaints = page.complaints();
        console.log(
          `${name.padEnd(20)} ${(bytes.length / 1024).toFixed(1).padStart(6)} KB${complaints.length === 0 ? '' : `   ${complaints.join(' | ')}`}`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
