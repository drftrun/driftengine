/**
 * What a real browser answers about WebXR, and the refusals almost every visitor gets.
 *
 * **This covers the half a synthetic runtime cannot, and it is a smaller half than it looks.** On a
 * machine with no headset, measured 2026-09-05 in Chrome 151: `navigator.xr` is present,
 * `isSessionSupported('inline')` is true, `requestSession('inline')` succeeds,
 * `requestReferenceSpace('viewer')` succeeds, and `gl.makeXRCompatible()` throws `InvalidStateError`
 * — so there is no base layer and therefore **no `XRFrame` at all**. Everything past the first frame
 * is exercised in `packages/xr/src/session.test.ts` against a synthetic runtime instead.
 *
 * So what is asserted here is what is genuinely reachable: detection, a real session's lifecycle, the
 * classes the specification defines, whether `XRGPUBinding` exists, and **every refusal path**. That
 * last group is not a consolation prize. A consumer's XR button is pressed on machines without
 * headsets far more often than on machines with them, and a refusal that throws, hangs or says
 * nothing is the defect their users will actually meet.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real browser.
 *
 *     (setsid npx vite demo/dev --port 5214 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/xr-check.mjs --base=http://localhost:5214
 *
 * `--enable-experimental-web-platform-features` is passed because that is the flag, isolated from
 * three others that do not do it, which exposes `XRGPUBinding` on this platform. Chrome's own note
 * calls WebGPU in WebXR available for developer testing on Windows and Android.
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5214').replace(/\/$/, '');

const browser = await launch({
  flags: [
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    /* Isolated from --enable-features=WebXRGPUBinding and WebXRIncubations, neither of which
       exposes the constructor on this platform. This one does, on its own. */
    '--enable-experimental-web-platform-features',
  ],
});
const client = await connect(browser.port);
const page = await client.page(`${base}/xr.html`, 640, 480);
await page.settled('globalThis.__xrCheck', { settleMs: 5000 });
const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__xrCheck)'));
const complaints = page.complaints().filter((line) => !line.includes('404'));
await page.close?.();
await browser.close?.();

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

console.log();
console.log(JSON.stringify(result, null, 2), '\n');

check('the page ran without complaint', complaints.length === 0, complaints.join(' | ') || 'clean');
check(
  'the page reported a result rather than an error',
  result.error === undefined,
  result.error ?? 'none',
);

/* The specification is here, whatever the hardware is. A browser missing these has no WebXR at all
   and the engine's detection has to say so rather than fail somewhere later. */
check('this browser has WebXR', result.present === true, String(result.present));
check(
  'XRWebGLLayer exists, which is the path every runtime has had',
  result.hasWebGlLayer === true,
  String(result.hasWebGlLayer),
);
check('XRFrame exists', result.hasFrameClass === true, String(result.hasFrameClass));

/*
 * The experimental half, and the reason the flag is passed. A FAIL is a finding about the browser
 * rather than a defect in the engine: the WebGPU path is built and the constructor is what it needs.
 */
check(
  'XRGPUBinding exists under --enable-experimental-web-platform-features',
  result.hasGpuBinding === true,
  result.hasGpuBinding ? 'present' : 'absent, so a session here can only draw through WebGL2',
);

/*
 * A real session, started and ended. This is the deepest a machine with no headset reaches, and it
 * is genuinely the engine's code path: `enterXr` asks for these spaces in this order.
 */
check(
  'an inline session can be requested and ended',
  result.inlineSession?.requested === true && result.inlineSession?.ended === true,
  result.inlineSession?.why ?? `reference space: ${result.inlineSession?.referenceSpace}`,
);
check(
  'and it granted a reference space',
  typeof result.inlineSession?.referenceSpace === 'string' &&
    result.inlineSession.referenceSpace.length > 0,
  result.inlineSession?.referenceSpace ?? 'none',
);

/*
 * The refusals, which are the common case and the ones a consumer's users meet. Asserted as
 * refusals on purpose: a PASS on `entered` here would mean a headset appeared, which would be news
 * and would also mean this run measured something else entirely.
 */
check(
  'immersive-vr is refused on a machine with no headset',
  result.immersiveVr === false,
  result.immersiveVr
    ? 'a device is attached — this run is not the no-headset case'
    : 'false, as expected',
);
check(
  'entering refuses with a whole sentence rather than throwing',
  result.entered === false &&
    typeof result.enterReason === 'string' &&
    result.enterReason.length > 20,
  result.enterReason || '(empty)',
);
check(
  'and the sentence names what is actually wrong',
  typeof result.enterReason === 'string' && result.enterReason.includes('immersive-vr'),
  result.enterReason?.slice(0, 90) ?? '',
);
check(
  'support reports why, rather than a bare false',
  typeof result.supportReason === 'string' && result.supportReason.length > 20,
  result.supportReason || '(empty)',
);
check(
  'and a context that cannot become XR compatible is named as such',
  result.compatible === false && result.supportReason.includes('XR compatible'),
  `compatible: ${result.compatible}`,
);

console.log(
  '\nNOT RUN  a real immersive session, stereo on hardware, controller input, hand tracking, ' +
    'device performance and the compositor reprojection. This machine has no headset, so none of ' +
    'those is reachable here and none of them is claimed anywhere.',
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
