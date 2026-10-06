#!/usr/bin/env node
/**
 * Whether a scene capture leaves the frame it is taken in alone, wherever in the frame it is taken.
 *
 * **`captureScene` is a boundary inside somebody else's frame**: its own encoder, its own pass, the
 * frame's pass set aside and given back. So the one claim worth checking is that a frame which takes
 * a capture and does not show it is the frame that never took one — pixel for pixel — taken first,
 * after the world, or after the reflections and the refraction, with the features that keep state
 * across a frame switched on: a reconstruction, the temporal resolve, screen-space reflections,
 * refraction, and skin spread across the picture with a blended draw inside the capture.
 *
 * `demo/dev/sceneCapture.html?mode=room&screen=0` is the page: the capture is taken and the screen
 * that shows it is not drawn, so nothing of the capture is meant to reach the frame. `capture=0` is
 * the control, and **the floor is the control against itself**: two loads of one page under a held
 * clock, which a temporal resolve need not draw identically, since the harness keeps calling `frame`
 * after the hold. A variant passes at no more changed pixels than that pair, and with no complaint
 * from the device.
 *
 * Found what it was written for on its first run: a capture taken after the frame had drawn anything
 * read the frame's pass before the flush that opened it, gave back none, and every later pass was
 * refused on an encoder still locked by the one left open — a black frame, on WebGPU only.
 *
 * It is not a `*.test.mjs`: it needs a dev server and a real GPU, as `ghost-check.mjs` does.
 *
 *     (setsid npx vite demo/dev --port 5199 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/capture-check.mjs --base=http://localhost:5199
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, rgbaOf } from '../packages/core/scripts/png.mjs';
import { compare } from '../packages/core/scripts/frames.mjs';
import { heldClockScript } from '../packages/core/scripts/heldClock.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5199').replace(/\/$/, '');
const backends = argOf('backends', 'webgpu,webgl2').split(',');
const only = argOf('cases', '');
/* Where a failing pair is written, with a mask of what moved: the frames are the evidence. */
const save = argOf('save', '');
const WIDTH = 1280;
const HEIGHT = 720;
/* Above the stats line, which prints the query and so differs between any two of these pages. */
const REGION = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT - 40 };
/* A level of difference a person could not see, and a held temporal resolve can leave. */
const TOLERANCE = 2;

/** What a frame carries that a capture could disturb. Each runs every order below. */
const CASES = [
  { name: 'plain', query: '' },
  { name: 'refract', query: 'refract=1&recon=1.5' },
  { name: 'particles', query: 'refract=1&instanced=1&recon=1&taa=1&ao=0.5&hdr=1' },
  { name: 'skin', query: 'skin=1&glow=1&skinscatter=screen&hdr=1' },
  {
    name: 'everything',
    query: 'refract=1&instanced=1&skin=1&glow=1&skinscatter=screen&recon=1&taa=1&hdr=1',
  },
];
const ORDERS = ['start', 'world', 'end'];
/* `--case=name:query` runs one combination of your own in place of the list, to isolate a cause. */
const own = argOf('case', '');
if (own !== '') {
  const at = own.indexOf(':');
  CASES.splice(0, CASES.length, { name: own.slice(0, at), query: own.slice(at + 1) });
}

async function shoot(client, backend, query) {
  const url = `${base}/sceneCapture.html?mode=room&screen=0&backend=${backend}&${query}`;
  const page = await client.page(url, WIDTH, HEIGHT, { beforeLoad: heldClockScript(30) });
  try {
    await page.settled('window.__heldFrame > 0', { settleMs: 2500, timeoutMs: 120000 });
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    /* The first few distinct lines: a refused frame repeats its refusal every frame after. */
    const complaints = [
      ...new Set(page.complaints().filter((line) => !/favicon|404/.test(line))),
    ].slice(0, 3);
    return { image: decodePng(Buffer.from(shot.data, 'base64')), complaints };
  } finally {
    await page.close();
  }
}

/** The control, the variant, and a mask: changed pixels white over the control at a quarter. */
function keep(name, control, taken) {
  if (save === '') return;
  mkdirSync(save, { recursive: true });
  const one = rgbaOf(control);
  const two = rgbaOf(taken);
  const mask = new Uint8Array(one.rgba.length);
  for (let at = 0; at < one.rgba.length; at += 4) {
    let d = 0;
    for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(one.rgba[at + c] - two.rgba[at + c]));
    for (let c = 0; c < 3; c += 1) mask[at + c] = d > TOLERANCE ? 255 : one.rgba[at + c] >> 2;
    mask[at + 3] = 255;
  }
  writeFileSync(path.join(save, `${name}-control.png`), encodePng(one.width, one.height, one.rgba));
  writeFileSync(path.join(save, `${name}-taken.png`), encodePng(two.width, two.height, two.rgba));
  writeFileSync(path.join(save, `${name}-moved.png`), encodePng(one.width, one.height, mask));
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed += 1;
}

const browser = await launch();
const client = await connect(browser.port);
try {
  console.log(`renderer: ${await requireHardwareGpu(client)}`);
  for (const backend of backends) {
    for (const { name, query } of CASES) {
      if (only !== '' && !only.split(',').includes(name)) continue;
      for (const at of ORDERS) {
        /*
         * **A control per order**: a frame taking its capture mid-frame binds its own camera again
         * after it, and the control makes the same calls with the capture left out, so the two
         * differ by the capture alone. Three loads of the control give two pairs, and the larger is
         * the floor: a held temporal resolve moves a few hundred edge pixels by a few levels
         * between loads, and one pair has been seen at 311 and then 511.
         */
        const control = await shoot(client, backend, `capture=0&at=${at}&${query}`);
        const twice = await shoot(client, backend, `capture=0&at=${at}&${query}`);
        const thrice = await shoot(client, backend, `capture=0&at=${at}&${query}`);
        const pairs = [twice, thrice].map((other) =>
          compare(control.image, other.image, { region: REGION, tolerance: TOLERANCE }),
        );
        const floor = Math.max(...pairs.map((pair) => pair.changed));
        const floorWorst = Math.max(...pairs.map((pair) => pair.worst));
        /* A control that drew nothing would let every variant through, as a black frame equals a
           black frame: the room has to be on screen before anything is measured against it. */
        const lit = (pairs[0]?.meanLuminance[0] ?? 0) > 20;
        if (!lit || control.complaints.length > 0) {
          check(
            `${backend} ${name} at=${at} control`,
            false,
            `luminance ${(pairs[0]?.meanLuminance[0] ?? 0).toFixed(1)}` +
              (control.complaints.length === 0
                ? ''
                : `\n      ${control.complaints.join('\n      ')}`),
          );
          continue;
        }
        const taken = await shoot(client, backend, `capture=1&at=${at}&${query}`);
        const moved = compare(control.image, taken.image, { region: REGION, tolerance: TOLERANCE });
        /*
         * **Noise moves few pixels a little; every defect this found moved many, or far.** A held
         * temporal resolve's floor has measured anywhere from 56 to 511 edge pixels at a worst of
         * 4 to 13 levels; the defects were a black frame (870,400), skin left unspread (308 at a
         * worst of 7 where the floor was 0) and edges jittered out of step (595 at a worst of 124).
         * So a variant fails past twice the floor's count and its worst together, or past two
         * thousand pixels whatever their size, which is a shift across the whole frame — and
         * **without a temporal resolve, at any pixel at all**: such a frame repeats exactly, so there
         * is no noise for a defect to hide in. Not "where the floor came out zero", which a temporal
         * case does by chance and then fails on its own noise.
         */
        const many = moved.changed > 2 * floor + 100;
        const far = moved.worst > 2 * floorWorst + 8;
        const within = !/\b(recon|taa)=/.test(query)
          ? moved.changed === 0
          : !(many && far) && moved.changed <= Math.max(2 * floor + 100, 2000);
        if (!within) keep(`${backend}-${name}-${at}`, control.image, taken.image);
        check(
          `${backend} ${name} at=${at}`,
          within && taken.complaints.length === 0,
          `${moved.changed} px changed, worst ${moved.worst.toFixed(0)} ` +
            `(floor ${floor} px, worst ${floorWorst.toFixed(0)})` +
            (taken.complaints.length === 0 ? '' : `\n      ${taken.complaints.join('\n      ')}`),
        );
      }
    }
  }
} finally {
  client.close();
  await browser.close();
}
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
