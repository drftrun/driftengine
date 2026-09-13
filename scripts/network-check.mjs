/**
 * Do two peers end up in the same world, does a prediction converge, and is a remote body smooth?
 *
 * Four unrelated claims sharing one package, so this asserts each against a control that must fail
 * where the claim succeeds.
 *
 * **Convergence needs the failing link beside it.** A lockstep pair that agrees proves nothing on
 * its own: two peers running no simulation at all agree perfectly. `nolockstep` is the same link
 * with one input per packet instead of four, which loses an input for good — an input is only
 * useful for the tick it names, so asking again and waiting a round trip delivers it too late. The
 * pair must *not* agree there.
 *
 * **Prediction needs its opposite.** Asserting that a client is near the authority passes a client
 * that simply is the authority, so `nopredict` — the same client waiting for state instead of
 * predicting — has to lag by the link and stay lagging.
 *
 * **Interpolation needs a number rather than an impression.** A body drawn at the newest
 * authoritative state holds still for two ticks and jumps three ticks' worth; interpolated, it moves
 * a third as far each tick. The largest step between consecutive drawn positions is that difference,
 * measured.
 *
 * **And the frame has to still contain the subject.** A blank frame agrees with every control, which
 * is why the pixel count is asserted before anything else.
 *
 * **The fixture arm is a second engine for free.** `fixture.test.ts` commits the conformance
 * digests measured under Node; this runs the same two arms in the browser and asserts they match.
 * Two JavaScript runtimes agreeing bit for bit is a weaker claim than two machines, and it is the
 * strongest one available without leaving this desk — `scripts/exactness-cross.mjs` is the other
 * half, and it needs a second machine.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is why `gizmo-check.mjs` and `editor-check.mjs` are run by hand
 * too.
 *
 *     npx vite demo/dev --port 5218 &
 *     node scripts/network-check.mjs --base=http://localhost:5218
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/** How far the two backends may disagree about a pixel count, as a fraction. */
const PARITY = 0.06;

/** The digests `packages/network/src/fixture.test.ts` committed, measured under Node. */
const FIXTURE_FLOAT = '880e84f536aadca5';
const FIXTURE_FIXED = '33e6de2f06b34870';

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
      `${base}/network.html?backend=${backend}&variant=${variant}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1500 });
    const read = async (name) => Number(await page.eval(`globalThis.${name}`));
    const out = {
      leftValue: await read('__leftValue'),
      rightValue: await read('__rightValue'),
      leftCentroid: await read('__leftCentroid'),
      rightCentroid: await read('__rightCentroid'),
      subjectPixels: await read('__subjectPixels'),
      replays: await read('__replays'),
      corrections: await read('__corrections'),
      maxStep: await read('__maxStep'),
      floatDigest: String(await page.eval('globalThis.__floatDigest')),
      fixedDigest: String(await page.eval('globalThis.__fixedDigest')),
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
/** Whether each backend drew both peers, which the cross-backend claims rest on. */
const drawn = {};
const backends = only === '' ? ['webgl2', 'webgpu'] : [only];
for (const backend of backends) {
  console.log(`\n=== ${backend} ===`);
  const lockstep = await shoot(base, backend, 'lockstep');
  const nolockstep = await shoot(base, backend, 'nolockstep');
  const predict = await shoot(base, backend, 'predict');
  const nopredict = await shoot(base, backend, 'nopredict');
  const smooth = await shoot(base, backend, 'smooth');
  const nosmooth = await shoot(base, backend, 'nosmooth');
  const fixture = await shoot(base, backend, 'fixture');
  measured[backend] = { lockstep, predict, fixture };

  console.log(
    `      lockstep : a ${lockstep.leftValue.toFixed(4)} b ${lockstep.rightValue.toFixed(4)} · ${lockstep.replays} replays · centroids ${lockstep.leftCentroid.toFixed(1)}/${lockstep.rightCentroid.toFixed(1)}`,
  );
  console.log(
    `      control  : a ${nolockstep.leftValue.toFixed(4)} b ${nolockstep.rightValue.toFixed(4)}`,
  );
  console.log(
    `      predict  : client ${predict.leftValue.toFixed(4)} host ${predict.rightValue.toFixed(4)} · ${predict.corrections} corrections`,
  );
  console.log(
    `      control  : client ${nopredict.leftValue.toFixed(4)} host ${nopredict.rightValue.toFixed(4)}`,
  );
  console.log(
    `      smooth   : largest step ${smooth.maxStep.toFixed(5)} · control ${nosmooth.maxStep.toFixed(5)}`,
  );
  console.log(`      fixture  : float ${fixture.floatDigest} fixed ${fixture.fixedDigest}`);

  const complaints = [
    ...lockstep.complaints,
    ...nolockstep.complaints,
    ...predict.complaints,
    ...nopredict.complaints,
    ...smooth.complaints,
    ...nosmooth.complaints,
    ...fixture.complaints,
  ];
  check(
    `${backend}: draws every variant without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains both subjects at all. Everything below is about a picture. */
  const drewPeers =
    lockstep.subjectPixels > 2000 && lockstep.leftCentroid > 0 && lockstep.rightCentroid > 0;
  drawn[backend] = drewPeers;
  check(
    `${backend}: the frame contains both peers`,
    drewPeers,
    `${lockstep.subjectPixels} px, centroids at ${lockstep.leftCentroid.toFixed(1)} and ${lockstep.rightCentroid.toFixed(1)}`,
  );

  /* Two peers over a link losing 15% of its traffic end in the same world. */
  check(
    `${backend}: a lockstep pair converges over an impaired link`,
    Math.abs(lockstep.leftValue - lockstep.rightValue) < 1e-9,
    `a ${lockstep.leftValue} against b ${lockstep.rightValue}`,
  );
  check(
    `${backend}: and their cubes are drawn in the same place`,
    Math.abs(lockstep.leftCentroid - lockstep.rightCentroid) < 2,
    `centroids ${lockstep.leftCentroid.toFixed(2)} and ${lockstep.rightCentroid.toFixed(2)}`,
  );
  check(
    `${backend}: the same link without redundancy does not converge`,
    Math.abs(nolockstep.leftValue - nolockstep.rightValue) > 1e-6,
    `a ${nolockstep.leftValue} against b ${nolockstep.rightValue}`,
  );
  check(
    `${backend}: and the link was bad enough to have needed correcting`,
    lockstep.replays > 0,
    `${lockstep.replays} replays`,
  );

  /* A predicting client stays with its own input; the control waits for the authority. */
  const predictedGap = Math.abs(predict.rightValue - predict.leftValue);
  const waitingGap = Math.abs(nopredict.rightValue - nopredict.leftValue);
  check(
    `${backend}: a predicting client tracks the authority closely`,
    predictedGap < waitingGap,
    `${predictedGap.toFixed(4)} against ${waitingGap.toFixed(4)} with prediction off`,
  );
  check(
    `${backend}: and it corrected rather than coasting`,
    predict.corrections > 10,
    `${predict.corrections} corrections`,
  );
  check(
    `${backend}: the two clients are drawn in different places`,
    Math.abs(predict.leftCentroid - nopredict.leftCentroid) > 2,
    `predicted at ${predict.leftCentroid.toFixed(1)}, waiting at ${nopredict.leftCentroid.toFixed(1)}`,
  );

  /* Interpolation, as the largest step between consecutive drawn positions. */
  check(
    `${backend}: an interpolated body moves in smaller steps than one drawn at the newest state`,
    smooth.maxStep * 2 < nosmooth.maxStep,
    `${smooth.maxStep.toFixed(5)} against ${nosmooth.maxStep.toFixed(5)}`,
  );
  check(
    `${backend}: and it is moving at all`,
    smooth.maxStep > 0,
    `largest step ${smooth.maxStep.toFixed(5)}`,
  );

  /* The conformance fixture, run in a browser, against the digests Node committed. */
  check(
    `${backend}: the floating arm agrees with the digest measured under Node`,
    fixture.floatDigest === FIXTURE_FLOAT,
    `${fixture.floatDigest} against ${FIXTURE_FLOAT}`,
  );
  check(
    `${backend}: the fixed-point arm agrees too`,
    fixture.fixedDigest === FIXTURE_FIXED,
    `${fixture.fixedDigest} against ${FIXTURE_FIXED}`,
  );
  check(
    `${backend}: and the two arms disagree with each other, as two arithmetics should`,
    fixture.floatDigest !== fixture.fixedDigest,
    `${fixture.floatDigest} against ${fixture.fixedDigest}`,
  );
}

if (backends.length === 2) {
  console.log('\n=== both ===');
  const [a, b] = [measured['webgl2'], measured['webgpu']];

  /*
   * **Both backends have to have drawn the peers before they are asked to agree about them.**
   *
   * The spread below read `Math.max(one, two) === 0 ? 0`, which passes: two backends drawing
   * nothing agreed perfectly. Corrected here and in `gizmo-check.mjs` and `editor-check.mjs`,
   * where the same construction stood, after `scripts/claimAudit.sh` found it on 2026-09-04.
   *
   * It does not catch two backends wrong in the same way while both still drawing — that is the
   * per-backend claims' job, and a cross-backend claim cannot be asked to know the right answer.
   */
  const bothDrew = drawn.webgl2 === true && drawn.webgpu === true;
  check(
    'both backends put the peers in the same place',
    bothDrew &&
      Math.abs(a.lockstep.leftCentroid - b.lockstep.leftCentroid) <= 2 &&
      Math.abs(a.lockstep.rightCentroid - b.lockstep.rightCentroid) <= 2,
    `webgl2 ${a.lockstep.leftCentroid.toFixed(1)}/${a.lockstep.rightCentroid.toFixed(1)} against webgpu ${b.lockstep.leftCentroid.toFixed(1)}/${b.lockstep.rightCentroid.toFixed(1)}`,
  );
  const one = a.lockstep.subjectPixels;
  const two = b.lockstep.subjectPixels;
  const largest = Math.max(one, two);
  const spread = largest === 0 ? Number.POSITIVE_INFINITY : Math.abs(one - two) / largest;
  check(
    'both backends draw the same amount of subject',
    bothDrew && spread < PARITY,
    `webgl2 ${one} px against webgpu ${two} px, ${(spread * 100).toFixed(1)}% apart`,
  );
  /* The simulation is arithmetic and does not touch a GPU, so this must be exact rather than close. */
  check(
    'both backends simulate identically, because a simulation is not a picture',
    a.lockstep.leftValue === b.lockstep.leftValue &&
      a.fixture.fixedDigest === b.fixture.fixedDigest,
    `${a.lockstep.leftValue} against ${b.lockstep.leftValue}`,
  );
}

console.log(failed === 0 ? '\nall assertions passed' : `\n${failed} assertion(s) failed`);
process.exit(failed === 0 ? 0 : 1);
