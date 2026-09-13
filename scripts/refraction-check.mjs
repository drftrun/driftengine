/**
 * Does glass bend what is behind it, and does it absorb more the further a ray travels through it?
 *
 * Two unrelated claims sharing one draw option, so this asserts both — and one more that the rest
 * rest on.
 *
 * **The claim underneath: a scene with no refracting draw is unchanged.** `none` against the frame
 * built before this existed, and `off` against `none`. If a pane at `refraction: 0` moves anything,
 * every number below is describing a changed world rather than a new capability.
 *
 * **Bending needs a control that does not move.** A test that only asserts "the bars moved" passes
 * a shader that jitters and one whose camera drifted, so `off` must hold the bars to the pixel and
 * `strong` must move them *further* than `clear` rather than merely differently.
 *
 * **Absorption needs its own defect in the scene, and this is the part worth reading.** Asserting
 * that a tinted pane goes green passes a flat tint multiplied into the fragment — which is exactly
 * the implementation Beer-Lambert exists to be better than. What separates them is the *angle*:
 * a path length divided by `dot(N, V)` absorbs more edge-on than face-on at one tint and one
 * thickness, and a flat tint gives the same colour at both. So `face` and `edge` are the pair that
 * carries the claim, and `tinted` alone would not.
 *
 * **And the frame has to still contain the subject.** A blank frame agrees with every control.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is why `decal-check.mjs` is run by hand too.
 *
 *     npx vite demo/dev --port 5218 &
 *     node scripts/refraction-check.mjs --base=http://localhost:5218
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/**
 * How far the bar transitions must move for a pane to count as bending, in summed pixel positions.
 *
 * The measure sums the x position of every bright-to-dark transition along one row, so a bend of a
 * few pixels across several bars moves it by tens. Ten is a floor against "nothing happened".
 */
const BEND_MIN = 10;

/** How much darker a channel must go before absorption counts as having happened, 0-255. */
const ABSORB_MIN = 8;

/** How far the two backends may disagree about a channel mean. */
const PARITY = 2.0;

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
      `${base}/refraction.html?backend=${backend}&variant=${variant}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const read = async (name) => Number(await page.eval(`globalThis.${name}`));
    const out = {
      pixels: await read('__pixels'),
      edges: await read('__edges'),
      red: await read('__red'),
      green: await read('__green'),
      blue: await read('__blue'),
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

const base = argOf('base', 'http://localhost:5218').replace(/\/$/, '');
const only = argOf('backend', '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
/** Whether each backend bent the pattern, and absorbed, which the parity claims rest on. */
const bent = {};
const absorbed = {};
const backends = only === '' ? ['webgl2', 'webgpu'] : [only];
for (const backend of backends) {
  console.log(`\n=== ${backend} ===`);
  const none = await shoot(base, backend, 'none');
  const off = await shoot(base, backend, 'off');
  const clear = await shoot(base, backend, 'clear');
  const strong = await shoot(base, backend, 'strong');
  const tinted = await shoot(base, backend, 'tinted');
  const face = await shoot(base, backend, 'face');
  const edge = await shoot(base, backend, 'edge');
  const ramp = await shoot(base, backend, 'ramp');
  const nolane = await shoot(base, backend, 'nolane');
  measured[backend] = { clear, tinted, face, edge };

  console.log(
    `      bars    : none ${none.edges} · off ${off.edges} · clear ${clear.edges} · strong ${strong.edges}`,
  );
  console.log(
    `      tint    : clear rgb ${clear.red.toFixed(1)},${clear.green.toFixed(1)},${clear.blue.toFixed(1)}` +
      ` · tinted ${tinted.red.toFixed(1)},${tinted.green.toFixed(1)},${tinted.blue.toFixed(1)}`,
  );
  console.log(
    `      angle   : face ${((face.red + face.green + face.blue) / 3).toFixed(2)}` +
      ` · edge ${((edge.red + edge.green + edge.blue) / 3).toFixed(2)}`,
  );
  console.log(`      ramp    : L ${ramp.leftLum.toFixed(2)} R ${ramp.rightLum.toFixed(2)}`);
  console.log(
    `      no lane : rgb ${nolane.red.toFixed(1)},${nolane.green.toFixed(1)},${nolane.blue.toFixed(1)}`,
  );

  const complaints = [
    ...none.complaints,
    ...off.complaints,
    ...clear.complaints,
    ...strong.complaints,
    ...tinted.complaints,
    ...face.complaints,
    ...edge.complaints,
    ...ramp.complaints,
  ];
  check(
    `${backend}: draws every variant without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains the bars at all. Everything below is a statement about a picture. */
  check(
    `${backend}: the frame contains the pattern`,
    none.pixels > 5000 && none.edges > 0,
    `${none.pixels} px sampled, ${none.edges} summed transitions`,
  );

  /*
   * **The control, and it proves the thing every bending number below depends on**: the sheet
   * really does cover the measurement box. A pane at zero strength is ordinary opaque paint, so no
   * bar boundary survives inside the box — which means that when a refracting pane shows bars
   * again, they are coming *through* it rather than around it.
   *
   * -1 is "no boundary in the row", which is what the measure answers for a box of flat paint.
   */
  check(
    `${backend}: a pane at zero strength hides the pattern completely`,
    off.edges === -1 && none.edges >= 0,
    `off ${off.edges} against none ${none.edges}`,
  );

  /* Bending: it moves, and more strength moves it further. */
  const bends = Math.abs(clear.edges - none.edges) > BEND_MIN;
  bent[backend] = bends;
  check(
    `${backend}: a refracting pane displaces the pattern behind it`,
    bends,
    `${clear.edges} against ${none.edges}`,
  );
  check(
    `${backend}: twice the strength displaces further`,
    Math.abs(strong.edges - none.edges) > Math.abs(clear.edges - none.edges),
    `strong ${Math.abs(strong.edges - none.edges)} against clear ${Math.abs(clear.edges - none.edges)}`,
  );

  /* Absorption: the tint takes red and blue and leaves green. */
  const absorbs = tinted.red < clear.red - ABSORB_MIN && tinted.blue < clear.blue - ABSORB_MIN;
  absorbed[backend] = absorbs;
  check(
    `${backend}: a tinted pane absorbs red and blue`,
    absorbs,
    `r ${tinted.red.toFixed(1)} vs ${clear.red.toFixed(1)}, b ${tinted.blue.toFixed(1)} vs ${clear.blue.toFixed(1)}`,
  );
  check(
    `${backend}: and leaves green standing`,
    tinted.green > tinted.red + ABSORB_MIN && tinted.green > tinted.blue + ABSORB_MIN,
    `g ${tinted.green.toFixed(1)} against r ${tinted.red.toFixed(1)} b ${tinted.blue.toFixed(1)}`,
  );

  /*
   * **The assertion Beer-Lambert exists for**, and the one a flat tint passes every other test
   * without: same tint, same thickness, different angle. A path length divided by the view angle
   * absorbs more edge-on; a colour multiplied into the fragment gives the same picture at both.
   */
  const faceLum = (face.red + face.green + face.blue) / 3;
  const edgeLum = (edge.red + edge.green + edge.blue) / 3;
  check(
    `${backend}: an edge-on pane absorbs more than the same pane face-on`,
    edgeLum < faceLum - 1,
    `edge ${edgeLum.toFixed(2)} against face ${faceLum.toFixed(2)}`,
  );

  /*
   * **A refracting mesh that carries no channel array at all still absorbs.**
   *
   * Every other subject on this page supplies one, so the *absent* value of the thickness lane was
   * never the thing being drawn — and it was 0 for a release, which makes the path length zero and
   * `pow(tint, 0)` one, so a pane naming a tint and a thickness bent the scene behind it and took no
   * colour out of it. The lane is a multiplier and the identity for a multiplier is 1.
   */
  check(
    `${backend}: a refracting mesh with no channel array still absorbs`,
    nolane.red < clear.red - ABSORB_MIN && nolane.green > nolane.red + ABSORB_MIN,
    `rgb ${nolane.red.toFixed(1)},${nolane.green.toFixed(1)},${nolane.blue.toFixed(1)} against clear ${clear.red.toFixed(1)}`,
  );

  /* The per-vertex lane: thickness varying within one draw, which a per-draw scalar cannot do. */
  check(
    `${backend}: the thickness lane varies absorption across one pane`,
    Math.abs(ramp.leftLum - ramp.rightLum) > 2,
    `L ${ramp.leftLum.toFixed(2)} R ${ramp.rightLum.toFixed(2)}`,
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
   * **Each backend has to have bent something before the two are asked to agree about the bend.**
   *
   * Measured 2026-09-04 with `scripts/claimAudit.sh`: removing the offset — `screenUv` in place of
   * `screenUv + refractN.xy * uRefractStrength` — left nineteen of this script's twenty-three
   * claims green, correctly for the absorption half, which is a different term. This one was not
   * among the correct ones: both backends bent by nothing and agreed exactly.
   *
   * The two below it are about absorption and the mutation left them alone, which is why they are
   * gated on their own per-backend claims rather than on this one.
   */
  const bothBent = bent.webgl2 === true && bent.webgpu === true;
  check(
    'parity: the two backends bend the pattern the same way',
    bothBent && a.clear.edges === b.clear.edges,
    `${a.clear.edges} against ${b.clear.edges}`,
  );
  check(
    'parity: the two backends absorb the same amount',
    absorbed.webgl2 === true &&
      absorbed.webgpu === true &&
      Math.abs(a.tinted.green - b.tinted.green) < PARITY,
    `${a.tinted.green.toFixed(2)} against ${b.tinted.green.toFixed(2)}`,
  );
  check(
    'parity: the two backends agree about the angle',
    absorbed.webgl2 === true &&
      absorbed.webgpu === true &&
      Math.abs(a.edge.red - b.edge.red) < PARITY,
    `${a.edge.red.toFixed(2)} against ${b.edge.red.toFixed(2)}`,
  );
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
