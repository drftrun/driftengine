/**
 * Do the pixels agree with the layout, and does pointing at a button change it?
 *
 * **`demo/dev/ui.html` publishes both halves and this compares them.** The page lays a bar of three
 * buttons out with `layoutUiTree`, draws it with `drawUiTree`, and then reads the frame back and
 * finds the bounding box of each button's own colour. A pipeline that lays a button out correctly
 * and draws it somewhere else — or at the right place in the wrong size — passes every unit test in
 * the package and fails here.
 *
 * **Nothing in the page states the bar's size.** It is `fit` around three fixed buttons, a gap and
 * a padding, so the width asserted below is the layout engine's own arithmetic arriving on screen.
 *
 * **The control is the pointer.** The middle button paints itself from its own `hovered` and
 * `pressed` flags, so routing is a colour in the frame rather than the router's own return value
 * read back. A router that never set a flag leaves the same green in all three runs.
 *
 * The whole page draws on the pass's white slot and uses no sheet, which is what says a solid
 * rectangle needs no texture of the caller's.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `sprite-check.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5217 &
 *     node scripts/ui-check.mjs --base=http://localhost:5217
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * What the layout must come to, in CSS pixels: left, top, width, height.
 *
 * Three 60-wide buttons, two 10 gaps and 10 of padding a side is 220; 40 tall plus 10 a side is 60.
 * Centred across a 1280 viewport and pushed to the bottom of a 720 one. Written out rather than
 * derived, because a check that computed it the way the engine does would agree with any answer.
 */
const BAR = [530, 660, 220, 60];
const LEFT = [540, 670, 60, 40];
/** How far a drawn edge may sit from the one the layout asked for, in CSS pixels. */
const EDGE = 1.5;
/** A background and nothing else on each of four nodes. */
const QUADS = 4;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, point) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/ui.html?backend=${backend}&point=${point}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const read = async (name) => await page.eval(`globalThis.__${name}`);
    const measured = {
      layout: await read('layout'),
      barBox: await read('barBox'),
      blueBox: await read('blueBox'),
      middle: String(await read('middle')),
      over: String(await read('over')),
      quads: Number(await read('quads')),
      digest: String(await read('digest')),
      complaints: page.complaints().filter((line) => !isNoise(line)),
    };
    await page.close?.();
    return measured;
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5217').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const near = (a, b) => a.every((n, i) => Math.abs(n - b[i]) <= EDGE);
const show = (box) => box.map((n) => n.toFixed(1)).join(', ');

const measured = {};
/** Whether each backend drew the tree where layout put it, which the parity claims rest on. */
const painted = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const off = await shoot(base, backend, 'off');
  const over = await shoot(base, backend, 'over');
  const down = await shoot(base, backend, 'down');
  measured[backend] = { off, over, down };

  console.log(`      laid out : ${off.layout.map(show).join('  |  ')}`);
  console.log(`      drawn bar: ${show(off.barBox)}`);
  console.log(`      drawn L  : ${show(off.blueBox)}`);
  console.log(`      middle   : ${off.middle} off, ${over.middle} over, ${down.middle} down`);
  console.log(`      ${off.quads} quads · ${off.digest}`);

  const complaints = [...off.complaints, ...over.complaints, ...down.complaints];
  check(
    `${backend}: draws in all three states without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame has a tree in it at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the tree drew its four backgrounds`,
    off.quads === QUADS,
    `${off.quads} quads`,
  );

  /* The layout engine's own arithmetic, against a figure written out by hand. */
  check(
    `${backend}: a bar sized by its contents comes to what its contents come to`,
    near(off.layout[0], BAR),
    `${show(off.layout[0])} against ${show(BAR)}`,
  );

  /* And the pixels agree with it, which is the assertion no unit test can make. */
  const drewTree = near(off.barBox, BAR) && near(off.blueBox, LEFT);
  painted[backend] = drewTree;
  check(
    `${backend}: the drawn bar is the laid-out bar`,
    near(off.barBox, BAR),
    `${show(off.barBox)} against ${show(BAR)}`,
  );
  check(
    `${backend}: and so is a button inside it`,
    near(off.blueBox, LEFT) && near(off.layout[1], LEFT),
    `drawn ${show(off.blueBox)}, laid out ${show(off.layout[1])}, wanted ${show(LEFT)}`,
  );

  /* The control and the claim: pointing at a button is visible in the frame, twice over. */
  check(
    `${backend}: hovering and pressing each change what is drawn`,
    off.middle === 'green' && over.middle === 'yellow' && down.middle === 'red',
    `${off.middle} / ${over.middle} / ${down.middle}`,
  );
  check(
    `${backend}: and the hit test named the button rather than the bar`,
    over.over === 'middle' && off.over === 'none',
    `${over.over} over, ${off.over} off`,
  );
}

/*
 * **The two backends draw the same tree.** Layout runs once on the CPU and both are handed the same
 * instances, so a difference is one of them drawing them wrongly.
 *
 * **Each has to have drawn the tree before they are asked to agree about it.** Measured 2026-09-04
 * with `scripts/claimAudit.sh`: zeroing the sprite shader's output left eleven of this script's
 * seventeen claims green, and all three of these were among them, because two blank frames have the
 * same digest three times over. The rest of the survivors are layout and hit-testing, which run on
 * the CPU and are right to.
 */
const bothPainted = painted.webgl2 === true && painted.webgpu === true;
for (const state of ['off', 'over', 'down']) {
  check(
    `the backends agree, byte for byte, with the pointer ${state}`,
    bothPainted && measured.webgl2[state].digest === measured.webgpu[state].digest,
    `webgl2 ${measured.webgl2[state].digest} · webgpu ${measured.webgpu[state].digest}`,
  );
}

process.exit(failed === 0 ? 0 : 1);
