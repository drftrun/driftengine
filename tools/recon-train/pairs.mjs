/**
 * Matched pairs for reconstruction's learned tier: a frame the analytic tier reconstructed, and the
 * native frame of the same moment.
 *
 * **Captured at the frame, not after it.** Each page runs a published scene to frame N on the held
 * clock and then stops (`&holdstop=1`), so the reconstructed picture carries the history the N
 * frames before it built, motion included. A held page that kept redrawing would converge on one
 * still state before the shutter opened, and teach the network nothing about motion — which is
 * why `ghost-check.mjs` reads the same mean delta at every hold.
 *
 * **The reference is what the scene draws without reconstruction, at its own sample count, and the
 * input is the reconstruction that stands in for it** — which runs at one sample, because the engine
 * turns reconstruction off wherever a scene is multisampled. A reference at one sample would be an
 * aliased picture, and a network trained toward it would learn to put the aliasing back. Both are
 * WebGPU, at one size, from one server, cropped to the canvas with the harness's readouts hidden, and
 * written outside git.
 *
 *     (setsid npx vite demo/dev --port 5250 --strictPort > /tmp/vite.log 2>&1 < /dev/null &)
 *     node tools/recon-train/pairs.mjs --base=http://localhost:5250 [--ratio=1.5] [--holds=90,180]
 *
 * Needs a real GPU: `requireHardwareGpu` refuses a software rasteriser, whose frames are not this
 * engine's.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, requireHardwareGpu } from '../../packages/core/scripts/browser.mjs';
import { connect } from '../../packages/core/scripts/cdp.mjs';
import { crop, decodePng, encodePng, rgbaOf } from '../../packages/core/scripts/png.mjs';
import { DEFAULT_SCENES } from '../../scripts/shots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5250').replace(/\/$/, '');
const ratio = argOf('ratio', '1.5');
const holds = argOf('holds', '90,180,300,420,600').split(',').map(Number);
const scenes = argOf('scenes', DEFAULT_SCENES.join(',')).split(',');
const out = argOf('out', join(HERE, '.data', 'pairs'));

const READY = `window.__heldFrame >= HOLD && /[1-9]\\d* draws/.test(document.getElementById('stats')?.textContent ?? '')`;

async function frame(client, scene, hold, reconstructed) {
  const index = DEFAULT_SCENES.indexOf(scene);
  const recon = reconstructed ? `&recon=${ratio}&samples=1` : '';
  const page = await client.page(
    `${base}/?scene=${index}&hold=${hold}&holdstop=1&backend=webgpu${recon}`,
    1280,
    720,
  );
  try {
    await page.settled(READY.replace('HOLD', String(hold)), { settleMs: 1500 });
    /* Hidden with no frame after it: the clock has stopped, and the compositor redraws the page
       from the canvas as it stands. */
    await page.eval(
      `for (const id of ['stats', 'scrub', 'error']) { const node = document.getElementById(id); if (node) node.style.display = 'none'; } true`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rect = await page.eval(`(() => {
      const canvas = document.getElementById('canvas');
      const box = canvas.getBoundingClientRect();
      return { x: Math.round(box.left), y: Math.round(box.top), width: canvas.width, height: canvas.height };
    })()`);
    const visible = Math.min(rect.height, 720 - rect.y);
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    return crop(rgbaOf(decodePng(Buffer.from(shot.data, 'base64'))), {
      ...rect,
      height: visible,
    });
  } finally {
    await page.close();
  }
}

mkdirSync(out, { recursive: true });
const browser = await launch();
try {
  const client = await connect(browser.port);
  console.log(`renderer: ${await requireHardwareGpu(client)}`);
  for (const scene of scenes) {
    for (const hold of holds) {
      const input = await frame(client, scene, hold, true);
      const reference = await frame(client, scene, hold, false);
      if (input.width !== reference.width || input.height !== reference.height) {
        throw new Error(`${scene} at ${hold}: the two halves are different sizes`);
      }
      const stem = join(out, `${scene}-${hold}`);
      writeFileSync(`${stem}-recon.png`, encodePng(input.width, input.height, input.rgba));
      writeFileSync(
        `${stem}-native.png`,
        encodePng(reference.width, reference.height, reference.rgba),
      );
      let changed = 0;
      for (let i = 0; i < input.rgba.length; i += 4) {
        if (
          input.rgba[i] !== reference.rgba[i] ||
          input.rgba[i + 1] !== reference.rgba[i + 1] ||
          input.rgba[i + 2] !== reference.rgba[i + 2]
        ) {
          changed += 1;
        }
      }
      console.log(
        `${scene.padEnd(16)} frame ${String(hold).padStart(4)}  ${input.width}x${input.height}, ` +
          `${changed} pixels differ from native`,
      );
    }
  }
} finally {
  await browser.close();
}
