/**
 * Do two levels of detail meet without a hole between them?
 *
 * **A crack in terrain is a hole through to the sky, and `demo/dev/terrain.html` is arranged so that
 * is literally what it is.** Four patches cover one heightfield — two at full detail, two at a
 * quarter of it — the clear colour is magenta, and nothing else in the scene is. A ray that finds a
 * gap between the fine edge and the coarse one passes under the coarse patch, whose underside is
 * culled, and leaves the world.
 *
 * **Sky is magenta too, so the count is taken per column below its own horizon.** Each column finds
 * the first ground pixel from the top; everything empty after that is somewhere the world should
 * have been. A window chosen by hand would have to be re-chosen every time the camera moved, and
 * would be the kind of constant nobody can check.
 *
 * **The control is the same scene with the matching switched off**, and it is what stops this being
 * vacuous: a field flat enough to have no cracks either way would prove nothing about matching.
 *
 * **And the frame has to still contain terrain.** That assertion is here because its absence let a
 * bug pass two tracks ago: a WebGPU path resolved to an almost black frame and was perfectly
 * order-independent, because it was blank. A check for "no holes" and nothing else calls an empty
 * world a success — an empty world has no holes in it either.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `ssr-check.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5216 &
 *     node scripts/terrain-check.mjs --base=http://localhost:5216
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/** How much of the frame must be terrain for the scene to be the one this is measuring. */
const GROUND_FLOOR = 500_000;
/** How many holes the unmatched seam must show for the control to mean anything. */
const CRACK_FLOOR = 1_000;
/** How far the two backends may disagree about how many, in pixels. */
const PARITY = 4;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, stitch) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/terrain.html?backend=${backend}&stitch=${stitch}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const cracks = Number(await page.eval('globalThis.__cracks'));
    const ground = Number(await page.eval('globalThis.__ground'));
    const digest = String(await page.eval('globalThis.__digest'));
    const complaints = page.complaints().filter((line) => !isNoise(line));
    await page.close?.();
    return { cracks, ground, digest, complaints };
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5216').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
/** Whether each backend found a hole at the unmatched seam, which the claims below rest on. */
const cracksSeen = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const cracked = await shoot(base, backend, '0');
  const matched = await shoot(base, backend, '1');
  measured[backend] = { cracked, matched };

  console.log(
    `      unmatched: ${cracked.cracks} through · ${cracked.ground} ground · ${cracked.digest}`,
  );
  console.log(
    `      matched  : ${matched.cracks} through · ${matched.ground} ground · ${matched.digest}`,
  );

  const complaints = [...cracked.complaints, ...matched.complaints];
  check(
    `${backend}: draws both ways without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains a world at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the frame is terrain rather than an empty one`,
    matched.ground > GROUND_FLOOR,
    `${matched.ground} px of ground`,
  );

  /*
   * The control. Without it the assertion below is a statement about a field with no seam in it.
   *
   * **It is a value now rather than only a claim**, because that sentence was true and nothing
   * acted on it. Measured 2026-09-04 with `scripts/claimAudit.sh`: making `heightAt` return zero
   * flattens the world, so there is no seam to mismatch and no hole to find, and eight of this
   * script's twelve claims stayed green — among them "a matched seam has no hole at all", which a
   * flat plane satisfies exactly, and both cross-backend claims.
   */
  const seamShows = cracked.cracks > CRACK_FLOOR;
  cracksSeen[backend] = seamShows;
  check(
    `${backend}: an unmatched seam is a hole through to the sky`,
    seamShows,
    `${cracked.cracks} px through the world`,
  );

  /* The claim, and it is exact rather than a tolerance: a matched edge is the same polyline. */
  check(
    `${backend}: a matched seam has no hole at all`,
    seamShows && matched.cracks === 0,
    `${matched.cracks} px through the world`,
  );

  /* And the holes were filled by terrain rather than by the camera moving. */
  check(
    `${backend}: what was a hole is now ground`,
    matched.ground > cracked.ground,
    `${matched.ground} px against ${cracked.ground} unmatched`,
  );
}

/*
 * **The two backends draw the same world.** They agree on a count of nothing trivially — which is
 * why both claims below now require each backend to have found a seam at all first, after a
 * flattened field left them green. What makes this worth asserting is the frame itself, which is
 * byte-identical: the geometry is built once on the CPU and handed to two renderers, so anything
 * that differed would be one of them drawing it wrongly rather than the terrain being ambiguous.
 */
const bothSawSeams = cracksSeen.webgl2 === true && cracksSeen.webgpu === true;
check(
  'the backends agree, byte for byte, on the matched world',
  bothSawSeams && measured.webgl2.matched.digest === measured.webgpu.matched.digest,
  `webgl2 ${measured.webgl2.matched.digest} · webgpu ${measured.webgpu.matched.digest}`,
);
check(
  'and on how much of it the unmatched seam lets through',
  bothSawSeams &&
    Math.abs(measured.webgl2.cracked.cracks - measured.webgpu.cracked.cracks) <= PARITY,
  `webgl2 ${measured.webgl2.cracked.cracks} px · webgpu ${measured.webgpu.cracked.cracks} px`,
);

process.exit(failed === 0 ? 0 : 1);
