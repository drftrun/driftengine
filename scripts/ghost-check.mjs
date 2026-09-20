#!/usr/bin/env node
/**
 * What a moving object leaves behind under a reconstruction, and whether the motion pass took it.
 *
 * **No capture in this repository can answer that.** `?hold=N` freezes the scene and the page
 * redraws one state for ever, so an accumulating resolve has converged long before the shutter
 * opens: the one published scene with rigid motion measures a mean delta of 0.93 from its native
 * frame at every hold tried, which is *better* than a still scene and says nothing at all.
 * `demo/dev/ghost.html` draws each position of a crossing twice — once arriving, with a history of
 * where the box was, and once settled — and compares them on the page; this reads the counts.
 *
 * **The control is the point of the arrangement.** With no reconstruction there is no history, so
 * the two frames are the same draw of the same matrices and must agree to the bit. A control that
 * is not zero means the page is measuring its own noise.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `motion-check.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5199 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/ghost-check.mjs --base=http://localhost:5199
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5199').replace(/\/$/, '');
const ratios = argOf('ratios', '0,1.5').split(',');
const motions = argOf('motions', 'slide,spin').split(',');
/* `1` withholds the previous transform, which is the control the motion pass is measured against. */
const withheld = argOf('withheld', '1,0').split(',');

async function read(query) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(`${base}/ghost.html?backend=webgpu&${query}`, 1280, 720);
  await page.settled('globalThis.__ghostCheck', { settleMs: 500, timeoutMs: 180000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__ghostCheck)'));
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  if (!ok) failed += 1;
}

for (const motion of motions) {
  for (const ratio of ratios) {
    /* The control needs no second run: with no reconstruction there is no history to misplace. */
    for (const motion0 of ratio === '0' ? ['1'] : withheld) {
      const stated = motion0 === '1' ? 'camera motion only' : 'with the motion pass';
      const label =
        ratio === '0'
          ? `${motion}, no reconstruction`
          : `${motion}, reconstruction at ${ratio}, ${stated}`;
      const { result, complaints } = await read(
        `recon=${ratio}&motion=${motion}&motion0=${motion0}`,
      );
      if (result.error !== null) {
        check(label, false, result.error);
        continue;
      }
      const total = result.moving.reduce((sum, value) => sum + value, 0);
      const trail = result.trail.reduce((sum, value) => sum + value, 0);
      const worst = Math.max(...result.trail);
      const detail = `${total} px differ, ${trail} trailing, worst step ${worst}, worst channel ${result.worst}`;
      if (ratio === '0') {
        /* An equality rather than a threshold: with no history the two frames are the same draw,
           so anything above zero is this page measuring itself. */
        check(`${label} leaves nothing behind`, total === 0, detail);
      } else {
        console.log(`      ${label}: ${detail}`);
      }
      for (const line of complaints) console.log(`      complaint: ${line}`);
    }
  }
}

process.exitCode = failed > 0 ? 1 : 0;
