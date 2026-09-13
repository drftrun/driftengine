/**
 * Does a reflection appear where a caller said the floor reflects, and nowhere else?
 *
 * **The control is built into the scene rather than bolted onto this file.** `demo/dev/ssr.html`
 * stands two identical blocks on one floor — the same mesh, the same colour, the same height, the
 * same distance from the camera — and covers the floor under one of them with a
 * `ReflectiveSurface`. A reflection under the left block and none under the right cannot be the
 * lighting, the geometry or the camera. It is the region, which is what the API claims and the only
 * thing a forward renderer can offer instead of a material.
 *
 * **And the frame has to still contain the blocks.** That assertion is here because its absence let
 * a bug pass two rows ago: a WebGPU path resolved to an almost black frame and was perfectly
 * order-independent, because it was blank. A check for "the reflection is there" and nothing else
 * calls an empty scene a success — so this one also asserts the blocks are untouched, since a pass
 * that repainted them would be reflecting the scene onto the wrong pixels.
 *
 * **The mirror claim is the lift.** Raising the blocks a metre puts their mirror images a metre
 * further under the floor, so the reflection moves *down* the screen — which a tint, a shadow or a
 * fixed decal would not do.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `decal-check.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5215 &
 *     node scripts/ssr-check.mjs --base=http://localhost:5215
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/** How far down the screen the reflection must move when the blocks rise a metre, in pixels. */
const LIFT_SHIFT = 20;
/** How far the two backends may disagree about how much floor a reflection covers. */
const PARITY = 0.01;

/**
 * The floor a parity claim needs under it before agreement means anything.
 *
 * **Two backends agreeing on nothing is not two backends agreeing.** Measured 2026-09-04 by
 * deleting the resolve — `fragColor = vec4(0.0)`, one line — which leaves both reflecting zero
 * pixels at the same place, so `|0 - 0| <= 0 * PARITY` holds and both claims at the foot of this
 * file passed. Fourteen of this script's eighteen claims survived that deletion; twelve of them
 * are smoke claims and negative controls and are right to, and these two were not.
 *
 * So a parity claim now asserts what it is agreeing about as well as that it agrees, against the
 * same floor the positive claim above uses. A regression that hits both backends fails here too,
 * which is the only failure a cross-backend claim is uniquely able to catch and was the one it
 * could not see.
 */
const MIN_REFLECTED = 5000;
/** And about where the middle of it is, in pixels. */
const CENTRE_PARITY = 2;
/** How much of the blocks the effect may repaint. None, within a rounding of the count. */
const BLOCK_TOLERANCE = 0.005;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, query) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/ssr.html?backend=${backend}&frames=3${query}`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const left = Number(await page.eval('globalThis.__reflectedLeft'));
    const right = Number(await page.eval('globalThis.__reflectedRight'));
    const object = Number(await page.eval('globalThis.__object'));
    const u = Number(await page.eval('globalThis.__reflectU'));
    const v = Number(await page.eval('globalThis.__reflectV'));
    const digest = String(await page.eval('globalThis.__digest'));
    const complaints = page.complaints().filter((line) => !isNoise(line));
    await page.close?.();
    return { left, right, object, u, v, digest, complaints };
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5215').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const off = await shoot(base, backend, '&ssr=0');
  const on = await shoot(base, backend, '&ssr=1');
  const lifted = await shoot(base, backend, '&ssr=1&lift=1');
  const noTarget = await shoot(base, backend, '&ssr=1&fx=0');
  /* The same profile with nothing submitted, which is what the refusal is compared against. */
  const noTargetBare = await shoot(base, backend, '&ssr=0&fx=0');
  measured[backend] = { on };

  console.log(`      off    : ${off.left} left · ${off.right} right · ${off.object} block`);
  console.log(
    `      on     : ${on.left} left · ${on.right} right · ${on.object} block · ` +
      `${on.u.toFixed(1)},${on.v.toFixed(1)}`,
  );
  console.log(`      lifted : ${lifted.left} left · ${lifted.v.toFixed(1)} down the screen`);
  console.log(
    `      no fx  : ${noTarget.digest} submitted · ${noTargetBare.digest} not · ` +
      `${noTarget.object} block`,
  );

  const complaints = [...off.complaints, ...on.complaints, ...lifted.complaints];
  check(
    `${backend}: draws every case without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains the scene at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the unreflected frame draws both blocks and no reflection`,
    off.object > 10000 && off.left === 0 && off.right === 0,
    `${off.object} px of block, ${off.left + off.right} px of reflection`,
  );

  /* The claim. */
  check(
    `${backend}: the floor under the declared region reflects`,
    on.left > MIN_REFLECTED,
    `${on.left} px reflected`,
  );

  /*
   * **The control, and it is the whole reason the scene has two blocks.** The right one stands on
   * the same floor, in the same light, at the same height; the only thing it does not have is a
   * reflective region beneath it.
   */
  check(
    `${backend}: the identical block on the undeclared half reflects in nothing`,
    on.right === 0,
    `${on.right} px reflected on the right half`,
  );

  /* And the pass reflects *onto* the floor rather than repainting what it reflects. */
  check(
    `${backend}: the blocks themselves are untouched`,
    Math.abs(on.object - off.object) <= off.object * BLOCK_TOLERANCE,
    `${on.object} px of block against ${off.object} unreflected`,
  );

  /*
   * **A mirror, rather than a stain that happens to be block-shaped.** Raising the blocks a metre
   * puts their images a metre further below the floor, so the reflection moves down the screen. A
   * tint, a shadow or a decal would not move at all.
   */
  check(
    `${backend}: raising the blocks moves their reflections down the screen`,
    lifted.left > 1000 && lifted.v > on.v + LIFT_SHIFT,
    `${on.v.toFixed(1)} to ${lifted.v.toFixed(1)} with ${lifted.left} px still reflected`,
  );

  /*
   * **The documented refusal, asserted rather than trusted.** A march reads the scene target's own
   * colour and depth, so a profile with no off-screen target has nothing to march against.
   */
  /*
   * **Compared against the same profile rather than against the composited one**, and the first
   * version of this check was not: it asserted zero reflected pixels outright, and WebGL2 answered
   * 573. None of them were a reflection — a frame drawn straight to the canvas differs from one
   * resolved through a composite along every silhouette in it, by 330 pixels of block on this
   * scene, which is a fact about `screenEffects` and not about this row. The claim being made here
   * is that submitting a surface to a renderer that cannot march changes *nothing*, and the exact
   * form of that is two identical frames.
   */
  check(
    `${backend}: with no off-screen target, submitting a surface changes nothing at all`,
    noTarget.digest === noTargetBare.digest && noTarget.object > 10000,
    `${noTarget.digest} against ${noTargetBare.digest}, ${noTarget.object} px of block`,
  );
  check(
    `${backend}: and it says so on the console rather than dropping the surfaces in silence`,
    noTarget.complaints.some((line) =>
      line.includes('surfaces submitted to drawReflection are dropped'),
    ),
    noTarget.complaints.length === 0 ? 'said nothing' : noTarget.complaints[0].slice(0, 90),
  );
}

/*
 * **The two backends reflect the same floor, in the same place.** They reach it by different
 * mechanics — one binds a texture unit and scissors per draw, the other writes a block per surface
 * and binds by dynamic offset — and each reconstructs a world position and projects a ray sample
 * back through its own framebuffer convention. A count alone would not separate a mirrored march
 * from a correct one on a scene this symmetric; where that shows is the middle of the reflection.
 */
check(
  'the backends reflect the same amount of floor',
  measured.webgl2.on.left > MIN_REFLECTED &&
    measured.webgpu.on.left > MIN_REFLECTED &&
    Math.abs(measured.webgl2.on.left - measured.webgpu.on.left) <= measured.webgl2.on.left * PARITY,
  `webgl2 ${measured.webgl2.on.left} px · webgpu ${measured.webgpu.on.left} px`,
);
check(
  'the backends put the reflection in the same place',
  measured.webgl2.on.left > MIN_REFLECTED &&
    measured.webgpu.on.left > MIN_REFLECTED &&
    Math.abs(measured.webgl2.on.u - measured.webgpu.on.u) <= CENTRE_PARITY &&
    Math.abs(measured.webgl2.on.v - measured.webgpu.on.v) <= CENTRE_PARITY,
  `webgl2 ${measured.webgl2.on.u.toFixed(1)},${measured.webgl2.on.v.toFixed(1)} · ` +
    `webgpu ${measured.webgpu.on.u.toFixed(1)},${measured.webgpu.on.v.toFixed(1)}`,
);

process.exit(failed === 0 ? 0 : 1);
