/**
 * Does a mark stay on a surface that changes under it?
 *
 * **That is the whole of what the drawn half of decals is for**, and it is the one thing the
 * static half cannot do. `projectDecal` clips the receiving surface's own triangles to a projector
 * box, which is exact and free every frame afterwards and is decided once, against the mesh as it
 * stood. `demo/dev/decals.html` puts both marks on one floor and then raises the floor.
 *
 * **The control is the clipped mark**, and it is what stops this being vacuous: it has to be on
 * the floor before the deformation and gone after it. If it survived, there would be nothing for
 * the drawn mark to be for, and "the drawn one survived" would be a statement about a scene that
 * never changed.
 *
 * **And the frame has to still contain a floor.** That assertion is here because its absence let a
 * bug pass on the row before this one: a WebGPU path resolved to an almost black frame and was
 * perfectly order-independent, because it was blank. A check for "the mark is still there" and
 * nothing else calls an empty scene a success.
 *
 * **The projector overhangs the floor's edge**, so its scissor rectangle covers pixels showing no
 * surface at all. A pass that painted its rectangle rather than what the depth buffer holds would
 * tint the background, and the sky count against the unmarked frame is what asserts it does not.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `oit-check.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5214 &
 *     node scripts/decal-check.mjs --base=http://localhost:5214
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * What is left of the clipped mark once the floor has risen through it, as a fraction.
 *
 * The floor only ever rises, so every triangle of a mark clipped from the flat one ends up inside
 * the new surface and the count should be zero. Five per cent is slack for the seam at the very
 * edge of the box, not a tolerance the claim needs.
 */
const LOST = 0.05;

/**
 * How much of the drawn mark must survive the same deformation.
 *
 * Not all of it, and the missing part is geometry rather than error: a risen floor is nearer the
 * camera, so the same patch of world covers a slightly larger part of the screen, and the wave's
 * slope turns some of it away from the projector. Eighty per cent is far below either.
 */
const KEPT = 0.8;

/** How far the two backends may disagree about how much of the floor a mark covers. */
const PARITY = 0.02;

/**
 * The floor a parity claim needs under it before agreement means anything.
 *
 * **Two backends agreeing on nothing is not two backends agreeing.** Measured 2026-09-04 by
 * deleting the projected mark — `fragColor = vec4(1.0)` in `decalProject.ts`, one line — which
 * leaves both backends marking zero pixels at the same place, so `|0 - 0| <= 0 * PARITY` holds and
 * all four claims at the foot of this file passed. Eighteen of this script's twenty-two claims
 * survived that deletion; most are smoke claims, negative controls and the clipped path the
 * mutation does not touch, and are right to. These four were not.
 *
 * It is the same floor the positive claims above use, so a regression that hits both backends now
 * fails here too — which is the one failure a cross-backend claim is uniquely able to catch and was
 * the one it could not see.
 */
const MIN_MARKED = 1000;

/**
 * How far apart the two backends may put the middle of the mark, in pixels.
 *
 * **This is the half that says *where*.** Each backend turns a depth back into a world position
 * through its own framebuffer convention, and one built with the other's constant lands the mark
 * mirrored about the middle of the frame. Measured, by doing exactly that on WebGPU: the covered
 * area went from 77,522 px to 85,494 and the centre from 738.3,368.1 to 737.8,379.5, while every
 * per-backend assertion stayed green — because a mark in the wrong place is still a mark on a
 * floor. Two pixels against an eleven-pixel error is the margin this is set with.
 */
const CENTRE_PARITY = 2;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, mark, phase, query = '') {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/decals.html?backend=${backend}&mark=${mark}&phase=${phase}&frames=3${query}`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const marked = Number(await page.eval('globalThis.__marked'));
    const surface = Number(await page.eval('globalThis.__surface'));
    const sky = Number(await page.eval('globalThis.__sky'));
    const centreX = Number(await page.eval('globalThis.__centreX'));
    const centreY = Number(await page.eval('globalThis.__centreY'));
    const digest = String(await page.eval('globalThis.__digest'));
    const complaints = page.complaints().filter((line) => !isNoise(line));
    await page.close?.();
    return { marked, surface, sky, centreX, centreY, digest, complaints };
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5214').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const bare = await shoot(base, backend, 'none', 'flat');
  const staticFlat = await shoot(base, backend, 'static', 'flat');
  const staticWave = await shoot(base, backend, 'static', 'wave');
  const drawnFlat = await shoot(base, backend, 'drawn', 'flat');
  const drawnWave = await shoot(base, backend, 'drawn', 'wave');
  /* The same mark with the off-screen target switched off, which is what the documented refusal
     claims: no depth to read, so no mark, and the console says so once. */
  const noTarget = await shoot(base, backend, 'drawn', 'flat', '&fx=0');
  measured[backend] = { drawnFlat, drawnWave };

  console.log(`      unmarked: ${bare.marked} marked · ${bare.surface} floor · ${bare.sky} sky`);
  console.log(`      clipped : ${staticFlat.marked} flat -> ${staticWave.marked} risen`);
  console.log(`      drawn   : ${drawnFlat.marked} flat -> ${drawnWave.marked} risen`);
  console.log(
    `      centre  : ${drawnFlat.centreX.toFixed(1)},${drawnFlat.centreY.toFixed(1)} -> ` +
      `${drawnWave.centreX.toFixed(1)},${drawnWave.centreY.toFixed(1)}`,
  );
  console.log(`      digests : ${drawnFlat.digest} / ${drawnWave.digest}`);

  console.log(`      no target: ${noTarget.marked} marked · ${noTarget.surface} floor`);

  /* `noTarget` is left out on purpose: its whole subject is a warning, and it is asserted below
     rather than counted as a fault here. */
  const complaints = [
    ...bare.complaints,
    ...staticFlat.complaints,
    ...staticWave.complaints,
    ...drawnFlat.complaints,
    ...drawnWave.complaints,
  ];
  check(
    `${backend}: draws every case without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains a floor at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the unmarked frame draws a floor`,
    bare.surface > 10000 && bare.marked === 0,
    `${bare.surface} px of floor and ${bare.marked} px marked`,
  );

  /* The control, both halves of it. */
  check(
    `${backend}: the clipped mark is on the floor it was clipped from`,
    staticFlat.marked > MIN_MARKED,
    `${staticFlat.marked} px marked`,
  );
  check(
    `${backend}: the clipped mark is lost when the floor rises through it`,
    staticWave.marked < staticFlat.marked * LOST,
    `${staticWave.marked} px left of ${staticFlat.marked}`,
  );

  check(
    `${backend}: the drawn mark is on the same floor`,
    drawnFlat.marked > MIN_MARKED,
    `${drawnFlat.marked} px marked`,
  );

  /* The claim. */
  check(
    `${backend}: the drawn mark survives the floor rising`,
    drawnWave.marked > drawnFlat.marked * KEPT,
    `${drawnWave.marked} px of ${drawnFlat.marked}`,
  );

  /*
   * **The documented refusal, asserted rather than trusted.** A mark is read out of the scene
   * target's depth, so a profile with no off-screen target has nothing to read: the renderer says
   * so once and draws the scene unmarked. Without this the refusal is a sentence in a comment.
   */
  check(
    `${backend}: no off-screen target means no mark, and the scene is otherwise untouched`,
    noTarget.marked === 0 && noTarget.surface > 10000,
    `${noTarget.marked} px marked and ${noTarget.surface} px of floor`,
  );
  /*
   * **And it says so, which is the half that was missing on one backend.** WebGPU never opens a
   * composite for a profile with no screen effects, so `runDecals` was never reached and the marks
   * were dropped in silence while WebGL2 explained itself. One backend explaining and the other
   * not is the disagreement the parity rule exists to prevent; the first run of this file is what
   * found it.
   */
  check(
    `${backend}: and it says so on the console rather than dropping the marks in silence`,
    noTarget.complaints.some((line) => line.includes('marks submitted to drawDecal are dropped')),
    noTarget.complaints.length === 0 ? 'said nothing' : noTarget.complaints[0].slice(0, 90),
  );

  /* And it lands on the surface rather than on its own rectangle. */
  check(
    `${backend}: the drawn mark never leaves the surface`,
    drawnFlat.sky === bare.sky,
    `${drawnFlat.sky} px of background against the unmarked frame's ${bare.sky}`,
  );
}

/*
 * **The two backends mark the same amount of floor**, which is the parity rule. They reach it by
 * different mechanics — one binds a texture unit and scissors per draw, the other writes a block
 * per mark and binds by dynamic offset — and each reconstructs a world position through its own
 * framebuffer convention, which is where a mirrored mark would show up as a count that does not
 * agree.
 */
for (const [name, a, b] of [
  ['flat', measured.webgl2.drawnFlat, measured.webgpu.drawnFlat],
  ['risen', measured.webgl2.drawnWave, measured.webgpu.drawnWave],
]) {
  const bothMarked = a.marked > MIN_MARKED && b.marked > MIN_MARKED;
  check(
    `the backends mark the same floor (${name})`,
    bothMarked && Math.abs(a.marked - b.marked) <= a.marked * PARITY,
    `webgl2 ${a.marked} px · webgpu ${b.marked} px`,
  );
  check(
    `the backends put the mark in the same place (${name})`,
    bothMarked &&
      Math.abs(a.centreX - b.centreX) <= CENTRE_PARITY &&
      Math.abs(a.centreY - b.centreY) <= CENTRE_PARITY,
    `webgl2 ${a.centreX.toFixed(1)},${a.centreY.toFixed(1)} · ` +
      `webgpu ${b.centreX.toFixed(1)},${b.centreY.toFixed(1)}`,
  );
}

process.exit(failed === 0 ? 0 : 1);
