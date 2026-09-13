/**
 * Does a per-vertex lane reach the stage it claims to, and does it leave everything else alone?
 *
 * The channel carries three unrelated things in one attribute, so this asserts three unrelated
 * claims — and one more that the other three rest on.
 *
 * **The claim underneath the rest: a mesh that carries no channel is unchanged.** `nochannel`
 * against `neutral` has to agree to the digest, because an absent attribute reads the constant
 * `(0, 1, 1, 0)`. If it does not, this whole change moved every scene that ever shipped, and the
 * three measurements below are describing a different world rather than a new capability.
 *
 * **Sway needs a control that does not move, and a direction.** A test that only asserts "the
 * silhouette moved" passes a shader that jitters, and one that never checks the still control
 * passes a scene where the camera drifted. So `swayoff` must hold to the pixel across the same two
 * clocks, and reversing the wind must move the subject the other way.
 *
 * **The sky lane needs its own defect in the scene.** Asserting that `sky0` is darker than `sky1`
 * passes the very bug being fixed — folding the factor into the vertex colour is also darker. What
 * separates them is what is left: `sky0` keeps its ambient and `skycolor` does not, so the
 * assertion is that `sky0` sits strictly between `skycolor` and `sky1`.
 *
 * **And the frame has to still contain the quad.** That assertion is here because its absence let
 * a bug pass on an earlier row: a WebGPU path resolved to an almost black frame and agreed with
 * every control, because it was blank.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is why `decal-check.mjs` is run by hand too.
 *
 *     npx vite demo/dev --port 5217 &
 *     node scripts/vertex-channel-check.mjs --base=http://localhost:5217
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * How far the swaying quad's centroid must travel between two clocks, in mirror pixels.
 *
 * The mirror is 320 wide and the quad spans about half of it, so a displacement this small is
 * still well under a per-cent of the subject. It is a floor against "nothing happened" rather than
 * a figure the claim depends on.
 */
const SWAY_MIN = 1.0;

/** How still the control has to hold across the same two clocks. Nothing should move it at all. */
const STILL_MAX = 0.02;

/** How far the two backends may disagree about a luminance, on a 0-255 scale. */
const LUM_PARITY = 2.0;

/** How far the two backends may disagree about where the swayed centroid landed, in pixels. */
const CENTROID_PARITY = 1.0;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, variant, query = '') {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/vertexChannel.html?backend=${backend}&variant=${variant}&frames=3${query}`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const read = async (name) => Number(await page.eval(`globalThis.${name}`));
    const out = {
      pixels: await read('__pixels'),
      centroidX: await read('__centroidX'),
      lum: await read('__lum'),
      leftLum: await read('__leftLum'),
      rightLum: await read('__rightLum'),
      digest: String(await page.eval('globalThis.__digest')),
      complaints: page.complaints().filter((line) => !isNoise(line)),
    };
    await page.close?.();
    return out;
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5217').replace(/\/$/, '');
const only = argOf('backend', '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
const backends = only === '' ? ['webgl2', 'webgpu'] : [only];
for (const backend of backends) {
  console.log(`\n=== ${backend} ===`);
  const nochannel = await shoot(base, backend, 'nochannel');
  const neutral = await shoot(base, backend, 'neutral');
  /* Two clocks a known step apart, and the same two for the control. */
  const swayA = await shoot(base, backend, 'sway', '&t=0');
  const swayB = await shoot(base, backend, 'sway', '&t=0.9');
  const stillA = await shoot(base, backend, 'swayoff', '&t=0');
  const stillB = await shoot(base, backend, 'swayoff', '&t=0.9');
  /* The same gust blowing the other way, which a jitter would not follow. */
  const swayBack = await shoot(base, backend, 'sway', '&t=0.9&wx=-1');
  const sky1 = await shoot(base, backend, 'sky1');
  const sky0 = await shoot(base, backend, 'sky0');
  const skycolor = await shoot(base, backend, 'skycolor');
  const alpha = await shoot(base, backend, 'alpha');
  const opaque = await shoot(base, backend, 'opaque');
  measured[backend] = { swayA, swayB, sky0, sky1, alpha };

  console.log(`      absent   : ${nochannel.digest} · neutral ${neutral.digest}`);
  console.log(
    `      sway     : x ${swayA.centroidX.toFixed(2)} -> ${swayB.centroidX.toFixed(2)} ` +
      `· reversed ${swayBack.centroidX.toFixed(2)}`,
  );
  console.log(
    `      control  : x ${stillA.centroidX.toFixed(2)} -> ${stillB.centroidX.toFixed(2)}`,
  );
  console.log(
    `      sky      : sun ${sky1.lum.toFixed(2)} · lane ${sky0.lum.toFixed(2)} ` +
      `· folded into colour ${skycolor.lum.toFixed(2)}`,
  );
  console.log(
    `      alpha    : L ${alpha.leftLum.toFixed(2)} R ${alpha.rightLum.toFixed(2)} ` +
      `· opaque L ${opaque.leftLum.toFixed(2)} R ${opaque.rightLum.toFixed(2)}`,
  );

  const complaints = [
    ...nochannel.complaints,
    ...neutral.complaints,
    ...swayA.complaints,
    ...swayB.complaints,
    ...sky0.complaints,
    ...sky1.complaints,
    ...alpha.complaints,
  ];
  check(
    `${backend}: draws every variant without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains a quad at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the frame contains the subject`,
    nochannel.pixels > 5000,
    `${nochannel.pixels} px of quad`,
  );

  /* The claim the rest rests on. */
  check(
    `${backend}: a mesh carrying no channel is identical to one carrying the neutral lanes`,
    nochannel.digest === neutral.digest,
    `${nochannel.digest} against ${neutral.digest}`,
  );

  /* Sway: it moves, the control does not, and it follows the wind. */
  check(
    `${backend}: the swaying quad moves between two clocks`,
    Math.abs(swayB.centroidX - swayA.centroidX) > SWAY_MIN,
    `${Math.abs(swayB.centroidX - swayA.centroidX).toFixed(3)} px`,
  );
  check(
    `${backend}: the sway = 0 control does not move across the same two`,
    Math.abs(stillB.centroidX - stillA.centroidX) < STILL_MAX,
    `${Math.abs(stillB.centroidX - stillA.centroidX).toFixed(3)} px`,
  );
  check(
    `${backend}: reversing the wind moves the quad the other way`,
    Math.sign(swayBack.centroidX - swayA.centroidX) ===
      -Math.sign(swayB.centroidX - swayA.centroidX) &&
      Math.abs(swayBack.centroidX - swayA.centroidX) > SWAY_MIN,
    `${(swayB.centroidX - swayA.centroidX).toFixed(3)} against ` +
      `${(swayBack.centroidX - swayA.centroidX).toFixed(3)}`,
  );

  /* The sky lane, against the defect it replaces. */
  check(
    `${backend}: the sky lane takes the sun off the quad`,
    sky0.lum < sky1.lum * 0.9,
    `${sky0.lum.toFixed(2)} against ${sky1.lum.toFixed(2)}`,
  );
  check(
    `${backend}: and leaves the ambient the folded-in factor destroys`,
    sky0.lum > skycolor.lum + 1,
    `lane ${sky0.lum.toFixed(2)} against folded ${skycolor.lum.toFixed(2)}`,
  );

  /* Alpha: it varies within one draw, which a per-draw opacity cannot do. */
  check(
    `${backend}: the alpha lane varies across one draw`,
    alpha.rightLum > alpha.leftLum + 1,
    `L ${alpha.leftLum.toFixed(2)} R ${alpha.rightLum.toFixed(2)}`,
  );
  check(
    `${backend}: the opaque control does not`,
    Math.abs(opaque.rightLum - opaque.leftLum) < 1,
    `L ${opaque.leftLum.toFixed(2)} R ${opaque.rightLum.toFixed(2)}`,
  );
}

/*
 * The two backends against each other, which is a control neither can be for itself. A silent
 * no-op, a uniform never uploaded and a pass that never ran all look healthy from inside one
 * backend and disagree across the pair.
 */
if (backends.length === 2) {
  console.log('\n=== parity ===');
  const a = measured['webgl2'];
  const b = measured['webgpu'];

  /*
   * **Each parity claim asserts the lane did something on both backends before it compares them.**
   *
   * Measured 2026-09-04 with `scripts/claimAudit.sh`: neutralising the sky lane in the vertex stage
   * — `vSkyDirect = 1.0` — left twenty-one of this script's twenty-three claims green, and
   * "the two backends agree about the sky lane" was one of them, because both backends then read
   * the same unshaded luminance. Two numbers agreeing on nothing is not two backends agreeing, and
   * a regression that hits both is the one failure a cross-backend claim is uniquely able to catch.
   *
   * The conditions below are the per-backend positive claims above, reused rather than restated, so
   * the two cannot drift apart.
   */
  const sways = (m) => Math.abs(m.swayB.centroidX - m.swayA.centroidX) > SWAY_MIN;
  const skyShades = (m) => m.sky0.lum < m.sky1.lum * 0.9;
  const alphaVaries = (m) => m.alpha.rightLum > m.alpha.leftLum + 1;

  check(
    'parity: the two backends agree about where the wind put the quad',
    sways(a) && sways(b) && Math.abs(a.swayB.centroidX - b.swayB.centroidX) < CENTROID_PARITY,
    `${a.swayB.centroidX.toFixed(2)} against ${b.swayB.centroidX.toFixed(2)}`,
  );
  check(
    'parity: the two backends agree about the sky lane',
    skyShades(a) && skyShades(b) && Math.abs(a.sky0.lum - b.sky0.lum) < LUM_PARITY,
    `${a.sky0.lum.toFixed(2)} against ${b.sky0.lum.toFixed(2)}`,
  );
  check(
    'parity: the two backends agree about the alpha lane',
    alphaVaries(a) && alphaVaries(b) && Math.abs(a.alpha.rightLum - b.alpha.rightLum) < LUM_PARITY,
    `${a.alpha.rightLum.toFixed(2)} against ${b.alpha.rightLum.toFixed(2)}`,
  );
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
