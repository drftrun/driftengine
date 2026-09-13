/**
 * Does the frame stop depending on which translucent surface was submitted first?
 *
 * **The claim is exact, so what is compared is exact.** `demo/dev/oit.html` draws two panes that
 * intersect — each in front of the other over part of the screen, so no back-to-front order exists
 * and no sort can find one — and publishes a digest of its own canvas. The same scene is drawn with
 * the panes submitted in both orders and the two digests must be equal, byte for byte, rather than
 * within a tolerance somebody chose.
 *
 * **The control is the same pair with the effect off**, and it is what stops this being vacuous: if
 * those two frames were already identical the scene would not be order-dependent and the pair with
 * it on would prove nothing. Both halves are asserted.
 *
 * **And the picture has to still contain the panes.** That assertion exists because its absence let
 * a bug pass: the WebGPU path once resolved to an almost black frame — 2,332 lit pixels against
 * 160,436 — and it was perfectly order-independent, because it was blank. A check for "the two
 * frames agree" and nothing else calls that a success.
 *
 * The digest comes from the page rather than from a screenshot for a reason that also cost a
 * detour: the two runs differ in their own caption, which reads `order ab` against `order ba`, and
 * comparing screenshots reported 120 differing pixels in a sixteen-by-eleven patch at the bottom
 * left while the render had been identical for some time.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5213 &
 *     node scripts/oit-check.mjs --base=http://localhost:5213
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * How close the resolved frame must stay to the sorted one in coverage.
 *
 * Weighted blending changes the *colours* where layers overlap and must not change which pixels
 * are covered at all: the panes are the same geometry either way. Five per cent is far tighter
 * than the failure this guards against, which took coverage to under two per cent of the control.
 */
const COVERAGE_TOLERANCE = 0.05;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, oit, order) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/oit.html?backend=${backend}&oit=${oit}&order=${order}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const digest = String(await page.eval('globalThis.__digest'));
    const lit = Number(await page.eval('globalThis.__lit'));
    const complaints = page.complaints().filter((line) => !isNoise(line));
    await page.close?.();
    return { digest, lit, complaints };
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5213').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
/** Whether each backend resolved a frame with the panes still in it. */
const panesDrawn = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const sortedAb = await shoot(base, backend, '0', 'ab');
  const sortedBa = await shoot(base, backend, '0', 'ba');
  const oitAb = await shoot(base, backend, '1', 'ab');
  const oitBa = await shoot(base, backend, '1', 'ba');
  measured[backend] = { sortedAb, oitAb };

  console.log(`      sorted: ${sortedAb.digest} / ${sortedBa.digest} · ${sortedAb.lit} px lit`);
  console.log(`      oit   : ${oitAb.digest} / ${oitBa.digest} · ${oitAb.lit} px lit`);

  const complaints = [
    ...sortedAb.complaints,
    ...sortedBa.complaints,
    ...oitAb.complaints,
    ...oitBa.complaints,
  ];
  check(
    `${backend}: draws both ways without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The control. Without this the assertion below is a statement about a scene nothing reorders. */
  check(
    `${backend}: sorted blending does depend on submission order`,
    sortedAb.digest !== sortedBa.digest,
    `${sortedAb.digest} against ${sortedBa.digest}`,
  );

  /*
   * And it is the *scene* that is order-independent, rather than an empty frame.
   *
   * **That sentence was here as a comment over a claim nothing depended on.** Measured 2026-09-04
   * with `scripts/claimAudit.sh`: zeroing the weighted output left seven of this script's nine
   * claims green, including the order-independence claim above and the cross-backend claim below,
   * because two blank frames have the same digest. It is the exact failure `ssr-check.mjs`'s header
   * records as having shipped once — *"a WebGPU path resolved to an almost black frame and was
   * perfectly order-independent, because it was blank"* — and this script had the guard for it
   * written down and inert.
   */
  const drawsPanes = Math.abs(oitAb.lit - sortedAb.lit) <= sortedAb.lit * COVERAGE_TOLERANCE;
  panesDrawn[backend] = drawsPanes;

  check(
    `${backend}: the resolved frame does not depend on submission order`,
    drawsPanes && oitAb.digest === oitBa.digest,
    `${oitAb.digest} against ${oitBa.digest}`,
  );

  check(
    `${backend}: the resolved frame still draws the panes`,
    drawsPanes,
    `${oitAb.lit} px lit against the sorted frame's ${sortedAb.lit}`,
  );
}

/*
 * **The two backends resolve to the same picture**, which is the parity rule: they reach it by
 * different mechanics — one rebinds a texture unit and toggles blend state per pass, the other
 * bakes a pipeline per buffer — so agreeing byte for byte is evidence rather than a coincidence.
 */
check(
  'the backends resolve to the same frame',
  panesDrawn.webgl2 === true &&
    panesDrawn.webgpu === true &&
    measured.webgl2.oitAb.digest === measured.webgpu.oitAb.digest,
  `webgl2 ${measured.webgl2.oitAb.digest} · webgpu ${measured.webgpu.oitAb.digest}`,
);

process.exit(failed === 0 ? 0 : 1);
