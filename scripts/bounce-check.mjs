#!/usr/bin/env node
/**
 * Whether indirect light lights a room, and what colour the light is.
 *
 * **Every gate the feature has passed so far says something other than this.** Parity scripts say
 * two copies of an expression agree; the scene captures say the eighteen published frames are
 * unchanged with the flag *off*. Neither is a picture being lit, and Wave 4A's own recorded failure
 * is a phantom surface that passed 111,907 parity samples and was found by looking.
 *
 * `demo/dev/bounce.html` builds a closed room with one red wall facing the sun and a white wall
 * facing away from it, reads the far wall's mean channels, and reports the frame it settles on.
 * This runs it twice — the flag off and on — and compares.
 *
 * **The colour is the claim and the brightness is not.** Anything that raised the ambient would
 * make the far wall brighter, and would make it brighter *grey*. What only a bounce can do is carry
 * the red wall's hue onto a white wall the sun never reaches, so the assertion is on the red-over-
 * blue ratio rising, with the brightness reported beside it rather than asserted on.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `ghost-check.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5199 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/bounce-check.mjs --base=http://localhost:5199
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5199').replace(/\/$/, '');

async function read(indirect, seed = '1') {
  const browser = await launch();
  const client = await connect(browser.port);
  /*
   * **`gputiming=1`, because without it the device is never asked for `timestamp-query`** and the
   * refresh cost comes back unmeasured. `gpuTimer.ts`'s rule: zero is a claim and unmeasured is
   * not zero, so the page reports -1 and this prints "unmeasured" rather than a number.
   */
  const page = await client.page(
    `${base}/bounce.html?backend=webgpu&indirect=${indirect}&seed=${seed}&gputiming=1`,
    1280,
    720,
  );
  await page.settled('globalThis.__bounceCheck', { settleMs: 500, timeoutMs: 240000 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__bounceCheck)'));
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

const runs = {};
for (const indirect of ['0', '1']) {
  const { result, complaints } = await read(indirect);
  if (result.error !== null) {
    console.error(`indirect=${indirect}: ${result.error}`);
    process.exit(1);
  }
  for (const line of complaints) console.error(`  page said: ${line}`);
  runs[indirect] = result;
  const wall = result.wall;
  const re = result.repainted;
  console.log(
    `indirect=${indirect}  ${result.backend}` +
      `  red room: far wall ${wall.r.toFixed(1)}/${wall.g.toFixed(1)}/${wall.b.toFixed(1)}` +
      ` (red over blue ${result.ratio.toFixed(3)})` +
      `  repainted blue: ${re.r.toFixed(1)}/${re.g.toFixed(1)}/${re.b.toFixed(1)}` +
      ` (blue over red ${result.followed.toFixed(3)})` +
      `  settled at frame ${result.settledAt}`,
  );
}

const off = runs['0'];
const on = runs['1'];

/*
 * **The control is not what this page was written expecting, and that is the finding.**
 *
 * With `indirectLight` off the far wall is *already* red — 43.2/13.3/12.6 at a ratio of 3.4 when
 * this was first run. The rasterised probe bake captures the whole room from each probe, so its
 * irradiance level already carries the red wall's light onto a wall the sun never reaches. The
 * engine has bounced light for as long as it has had a probe grid; what Wave 4A set out to do was
 * bounce it *without* rasterising six faces per probe, not to bounce it for the first time.
 *
 * So the comparison this makes is traced against rasterised, and the hard assertions below are the
 * invariants a bounce must obey either way. The quality comparison is printed rather than asserted,
 * because a threshold picked to pass is worth nothing and the number is what the record needs.
 */
const brighter = on.wall.r - off.wall.r;
const redder = on.ratio - off.ratio;
console.log(
  `traced against rasterised: red ${off.wall.r.toFixed(1)} to ${on.wall.r.toFixed(1)} ` +
    `(${brighter >= 0 ? '+' : ''}${brighter.toFixed(1)}), ` +
    `ratio ${off.ratio.toFixed(3)} to ${on.ratio.toFixed(3)} ` +
    `(${redder >= 0 ? '+' : ''}${redder.toFixed(3)})`,
);

/*
 * **The one that decides what the feature is, and it passes.**
 *
 * A rasterised bake is already a correct one-bounce solution for a room that never changes. What it
 * cannot do is follow: six face draws a probe is a hitch, so a scene whose light changes either
 * pays it or keeps the light it had. The red wall is repainted blue halfway through, and only a
 * grid still being computed puts blue on the far wall afterwards.
 */
check(
  'the traced grid follows a wall that changes colour',
  on.followed > off.followed * 1.5,
  `blue over red, rasterised ${off.followed.toFixed(3)} against traced ${on.followed.toFixed(3)}`,
);

/* And the sanity a bounce obeys: reflected light is darker than what reflected it. */
check(
  'the traced wall is no brighter than the wall it bounced off',
  on.wall.r <= on.source.r,
  `${on.wall.r.toFixed(1)} against ${on.source.r.toFixed(1)}`,
);

/*
 * **The energy gap is reported and not asserted on, and what it reports has changed.**
 *
 * It was a thirty-fifth of the rasterised grid's light. It is now **0.666** of it, because Task 9
 * of the indirect-light plan counted rather than argued: `scripts/bake-census.mjs` found 98.9% of
 * every probe's rays leaving a *closed* room, which said the composed field was empty rather than
 * the trace dim. The page's slabs were sampled `n` cubed over boxes that are not cubes, so each was
 * read at its own corner; `assertCubicVoxels` refuses that shape now.
 *
 * **The remaining third is not attributed and is not claimed as correct**, but it is the size a
 * disagreement can honestly be: the rasterised bake lights a room the sun does not reach, because
 * this profile has directional shadows off and it draws the sun on every face whose normal points
 * at it. A threshold picked to pass would hide whichever of the two is wrong.
 */
console.log(
  `energy: traced ${on.wall.r.toFixed(1)} against rasterised ${off.wall.r.toFixed(1)} ` +
    `(${(on.wall.r / Math.max(1e-6, off.wall.r)).toFixed(3)} of it)`,
);
console.log(
  `convergence: ${
    on.settledAt >= 0
      ? `settled at frame ${on.settledAt} of ${on.frames}`
      : `never still to a level over ${on.frames} frames, which a stochastic estimator at three ` +
        `levels of signal would not be`
  }`,
);
/*
 * **The two figures the capability row quotes**, printed here because this is the page that pays
 * them. The latency is what the feature is sold on — a rasterised bake's is unbounded, since it
 * never follows at all — and the refresh is `PROBES_PER_FRAME` probes, not a whole grid.
 */
console.log(
  `latency: the far wall made nine tenths of its change to blue in ` +
    `${on.followedIn < 0 ? 'no measurable time, having not changed' : `${on.followedIn} frames`}` +
    `, against the rasterised grid which never changes at all`,
);
console.log(
  `refresh: ${on.bakeMs < 0 ? 'unmeasured' : `${on.bakeMs.toFixed(3)} ms`} a frame on the device, ` +
    `for the probes one frame refreshes`,
);

/*
 * **And the run that answers the wave's own criterion: a room with nothing baked in it.**
 *
 * `?seed=0` skips `bakeProbeGrid` entirely, so no rasterised capture exists anywhere in the chain
 * and every joule on the far wall was computed by the trace. It used to come back at a uniform 209
 * of 255 — recorded as undefined memory, and in fact the one-texel **white** stand-in `uEnvironment`
 * resolves to while the grid is unbaked, held by a flat bind group built before the trace had
 * filled anything. The fix is one rebuild when the last layer lands, and the two runs now agree.
 *
 * Asserted rather than reported, because "indirect light in a scene with no baked lighting" is the
 * wave's exit criterion in its own words and a criterion nothing checks is a claim.
 */
const unseeded = (await read('1', '0')).result;
if (unseeded.error !== null) {
  console.error(`unseeded: ${unseeded.error}`);
  process.exit(1);
}
console.log(
  `unseeded   ${unseeded.backend}  far wall ${unseeded.wall.r.toFixed(1)}/` +
    `${unseeded.wall.g.toFixed(1)}/${unseeded.wall.b.toFixed(1)}` +
    ` (red over blue ${unseeded.ratio.toFixed(3)})` +
    `  repainted blue over red ${unseeded.followed.toFixed(3)}`,
);
check(
  'a grid nothing rasterised lights the room, and lights it the same',
  unseeded.seeded === false && Math.abs(unseeded.wall.r - on.wall.r) <= 1,
  `seeded ${on.wall.r.toFixed(1)} against unseeded ${unseeded.wall.r.toFixed(1)}`,
);
check(
  'and follows the wall that changed colour without one either',
  unseeded.followed > off.followed * 1.5,
  `blue over red, rasterised ${off.followed.toFixed(3)} against unseeded ${unseeded.followed.toFixed(3)}`,
);

process.exit(failed === 0 ? 0 : 1);
