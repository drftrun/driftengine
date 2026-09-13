/**
 * Does the gizmo stay the same size as the camera pulls back, light up under the pointer, and drag
 * along the one axis it was grabbed by?
 *
 * Three unrelated claims sharing one object, so this asserts each against a control that must fail
 * where the claim succeeds.
 *
 * **Size needs a control that does shrink.** A test that measures only the gizmo across two camera
 * distances passes a build that ignores distance entirely and draws a fixed world size — and passes
 * one that draws nothing, because zero equals zero. The white quad is one metre of world at the same
 * distance, so between `near` and `far` it must shrink by four while the gizmo holds.
 *
 * **The highlight needs its opposite.** Asserting that lit pixels appear under the pointer passes a
 * gizmo that is permanently yellow, so `nohover` — the same frame with the pointer on the background
 * — has to hold none.
 *
 * **The drags are the arithmetic seen through a real camera.** `gizmo.test.ts` already covers every
 * one of them against hand-built rays; what these add is the half no unit test reaches, that a
 * canvas pixel becomes the ray the gizmo wanted. `dragnone` is their control: the same pointer
 * motion begun where there is no handle must move nothing at all.
 *
 * **And the frame has to still contain the subject.** A blank frame agrees with every control.
 *
 * **Every assertion here was checked by breaking what it covers**, which is the only way to know a
 * check has teeth. Replacing the screen-constant scale with a fixed world size failed the size hold;
 * making a hovered handle keep its own colour group failed the highlight at 0 lit pixels; removing
 * the angle unwrap failed the turn at exactly -1.5708 against 4.7124; and moving the target along
 * the ray's own delta instead of along the axis failed the constraint at y and z of 8.28e-1. The
 * first of those also found a hole and closed it: the far gizmo went to 0x0 while the near one held,
 * so the pair disagreed and it failed — but a change that made *both* vanish would have compared
 * 0x0 against 0x0 and passed, which is why the subject assertion now covers both distances.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is why `refraction-check.mjs` is run by hand too.
 *
 *     npx vite demo/dev --port 5218 &
 *     node scripts/gizmo-check.mjs --base=http://localhost:5218
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/** How many screen pixels `gizmo.ts` asks for. The size claim is about this number. */
const ASKED_PIXELS = 120;

/**
 * How far the measured box may sit from the pixels asked for, as a fraction.
 *
 * The box is the extent of *drawn* geometry, which is not the whole span the size names: an arm
 * reaches the full size along its own axis and the three arms are foreshortened by the view, so the
 * bounding box is smaller than twice the size and depends on the projection. What matters is that it
 * is the same at both distances, which is what `HOLD` covers; this is only a floor against a gizmo
 * that has collapsed or exploded.
 */
const SPAN = 0.7;

/** How far the two distances' gizmo boxes may differ, in pixels. Screen-constant means this is small. */
const HOLD = 4;

/** How far the two backends may disagree about a pixel count, as a fraction. */
const PARITY = 0.06;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, variant) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/gizmo.html?backend=${backend}&variant=${variant}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const read = async (name) => Number(await page.eval(`globalThis.${name}`));
    const out = {
      pixels: await read('__pixels'),
      boxW: await read('__boxW'),
      boxH: await read('__boxH'),
      controlW: await read('__controlW'),
      lit: await read('__lit'),
      posX: await read('__posX'),
      posY: await read('__posY'),
      posZ: await read('__posZ'),
      sclX: await read('__sclX'),
      sclY: await read('__sclY'),
      angle: await read('__angle'),
      size: await read('__size'),
      started: Boolean(await page.eval('globalThis.__started')),
      digest: String(await page.eval('globalThis.__digest')),
      complaints: page.complaints().filter((line) => !isNoise(line)),
    };
    await page.close?.();
    return out;
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5218').replace(/\/$/, '');
const only = argOf('backend', '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
/** Whether each backend put a gizmo on screen, which the cross-backend claims rest on. */
const drawn = {};
const backends = only === '' ? ['webgl2', 'webgpu'] : [only];
for (const backend of backends) {
  console.log(`\n=== ${backend} ===`);
  const near = await shoot(base, backend, 'near');
  const far = await shoot(base, backend, 'far');
  const hover = await shoot(base, backend, 'hover');
  const nohover = await shoot(base, backend, 'nohover');
  const rotate = await shoot(base, backend, 'rotate');
  const scale = await shoot(base, backend, 'scale');
  const dragx = await shoot(base, backend, 'dragx');
  const dragnone = await shoot(base, backend, 'dragnone');
  const dragturn = await shoot(base, backend, 'dragturn');
  const dragscale = await shoot(base, backend, 'dragscale');
  measured[backend] = { near, far, hover, rotate, scale };

  console.log(
    `      size    : near box ${near.boxW}x${near.boxH} · far box ${far.boxW}x${far.boxH}`,
  );
  console.log(`      control : near ${near.controlW} px · far ${far.controlW} px`);
  console.log(`      lit     : hover ${hover.lit} · nohover ${nohover.lit}`);
  console.log(
    `      modes   : translate ${near.pixels} · rotate ${rotate.pixels} · scale ${scale.pixels}`,
  );
  console.log(
    `      drag    : x ${dragx.posX.toFixed(4)},${dragx.posY.toFixed(4)},${dragx.posZ.toFixed(4)}` +
      ` · none ${dragnone.posX.toFixed(4)} · turn ${dragturn.angle.toFixed(4)}` +
      ` · scale ${dragscale.sclX.toFixed(4)},${dragscale.sclY.toFixed(4)}`,
  );

  const complaints = [
    ...near.complaints,
    ...far.complaints,
    ...hover.complaints,
    ...nohover.complaints,
    ...rotate.complaints,
    ...scale.complaints,
    ...dragx.complaints,
    ...dragnone.complaints,
    ...dragturn.complaints,
    ...dragscale.complaints,
  ];
  check(
    `${backend}: draws every variant without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /*
   * **The frame contains the gizmo at all, and at both distances.** Everything below is a
   * statement about a picture, and a blank one agrees with every control.
   *
   * **The second half was added after a mutation test, and the second half was added after a mutation test.** Breaking the
   * screen-constant scale left the far gizmo at 0x0 and the near one at 128x128, which failed — but
   * a change that made *both* vanish would have left `0x0` against `0x0`, and "the same size at both
   * distances" would have passed on a blank pair of frames.
   */
  const drewGizmo =
    near.pixels > 500 && near.boxW > 0 && near.boxH > 0 && far.pixels > 500 && far.boxW > 0;
  drawn[backend] = drewGizmo;
  check(
    `${backend}: the frame contains the gizmo, at both distances`,
    drewGizmo,
    `near ${near.pixels} px box ${near.boxW}x${near.boxH}, far ${far.pixels} px box ${far.boxW}x${far.boxH}`,
  );
  check(
    `${backend}: and it contains the control beside it`,
    near.controlW > 10 && far.controlW > 2,
    `near ${near.controlW} px, far ${far.controlW} px`,
  );

  /* The control moves, which is what makes the gizmo holding still mean something. */
  const shrink = far.controlW === 0 ? 0 : near.controlW / far.controlW;
  check(
    `${backend}: four times the distance shrinks an ordinary object by four`,
    Math.abs(shrink - 4) < 0.35,
    `${near.controlW} to ${far.controlW} px, a factor of ${shrink.toFixed(2)}`,
  );

  /* The claim. */
  check(
    `${backend}: the gizmo is the same size at both distances`,
    Math.abs(near.boxW - far.boxW) <= HOLD && Math.abs(near.boxH - far.boxH) <= HOLD,
    `${near.boxW}x${near.boxH} against ${far.boxW}x${far.boxH}`,
  );
  check(
    `${backend}: and it is about the size it was asked for`,
    near.boxW > ASKED_PIXELS * SPAN && near.boxW < ASKED_PIXELS * (2 + SPAN),
    `${near.boxW} px across for ${ASKED_PIXELS} asked`,
  );

  /* The highlight, and its opposite. */
  check(`${backend}: a pointer on the x arm lights it`, hover.lit > 40, `${hover.lit} lit pixels`);
  check(
    `${backend}: a pointer on the background lights nothing`,
    nohover.lit === 0,
    `${nohover.lit} lit pixels`,
  );

  /* Each mode draws its own thing rather than the same thing three times. */
  check(
    `${backend}: rotate draws rings and translate does not`,
    rotate.pixels > 0 && rotate.digest !== near.digest,
    `${rotate.pixels} px, digest ${rotate.digest} against ${near.digest}`,
  );
  check(
    `${backend}: scale draws its own geometry too`,
    scale.pixels > 0 && scale.digest !== near.digest && scale.digest !== rotate.digest,
    `${scale.pixels} px, digest ${scale.digest}`,
  );

  /*
   * The drag, through a real camera. One gizmo length along the arm, asked for as the pixel that
   * world point lands on — so this fails if `rayThrough` and `project` disagree, which no unit test
   * against hand-built rays can see.
   */
  check(
    `${backend}: a drag along the x arm moves the target one gizmo length along x`,
    Math.abs(dragx.posX - dragx.size) < dragx.size * 0.02,
    `${dragx.posX.toFixed(4)} for a size of ${dragx.size.toFixed(4)}`,
  );
  check(
    `${backend}: and moves it in neither of the other two`,
    Math.abs(dragx.posY) < 1e-4 && Math.abs(dragx.posZ) < 1e-4,
    `y ${dragx.posY.toExponential(2)}, z ${dragx.posZ.toExponential(2)}`,
  );
  check(
    `${backend}: the same drag begun off the handle starts nothing and moves nothing`,
    !dragnone.started && dragnone.posX === 0 && dragnone.posY === 0 && dragnone.posZ === 0,
    `started ${dragnone.started}, at ${dragnone.posX},${dragnone.posY},${dragnone.posZ}`,
  );

  /* Three quarters of a turn crosses the seam once, which is the unwrap's whole job. */
  check(
    `${backend}: a three-quarter turn accumulates three quarters of a turn`,
    Math.abs(dragturn.angle - Math.PI * 1.5) < 0.02,
    `${dragturn.angle.toFixed(4)} against ${(Math.PI * 1.5).toFixed(4)}`,
  );

  check(
    `${backend}: an arm dragged one gizmo length outward doubles that axis and no other`,
    Math.abs(dragscale.sclX - 2) < 0.05 && Math.abs(dragscale.sclY - 1) < 1e-6,
    `x ${dragscale.sclX.toFixed(4)}, y ${dragscale.sclY.toFixed(4)}`,
  );
}

if (backends.length === 2) {
  console.log('\n=== both ===');
  const [a, b] = [measured['webgl2'], measured['webgpu']];

  /*
   * **Both backends have to have drawn a gizmo before they are asked to agree about one.**
   *
   * Measured 2026-09-04 with `scripts/claimAudit.sh`: fixing the screen-space scale to one
   * distance left twenty-nine of this script's thirty-five claims green and all five of these were
   * among them. With the gate they fail, because the same mutation takes the far gizmo out of the
   * frame and the premise stops holding.
   *
   * **What it cannot catch is two backends wrong in the same way while both still drawing.** That
   * is the per-backend claim's job, and asking a cross-backend claim to know the right answer would
   * make it a second copy of one.
   *
   * The zero case below used to read as agreement — `Math.max(one, two) === 0 ? 0 : ...` gives a
   * spread of 0, which passes — and now reads as what it is.
   */
  const bothDrew = drawn.webgl2 === true && drawn.webgpu === true;
  for (const variant of ['near', 'far', 'hover', 'rotate', 'scale']) {
    const one = a[variant].pixels;
    const two = b[variant].pixels;
    const largest = Math.max(one, two);
    const spread = largest === 0 ? Number.POSITIVE_INFINITY : Math.abs(one - two) / largest;
    check(
      `both backends draw the same amount of ${variant}`,
      bothDrew && spread < PARITY,
      `webgl2 ${one} px against webgpu ${two} px, ${(spread * 100).toFixed(1)}% apart`,
    );
  }
}

console.log(failed === 0 ? '\nall assertions passed' : `\n${failed} assertion(s) failed`);
process.exit(failed === 0 ? 0 : 1);
