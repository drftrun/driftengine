/**
 * Does the acceptance probe accept this machine, and what does asking cost?
 *
 * Drives `demo/dev/backend-probe.html`, which compiles every generated WGSL module the engine
 * ships and draws a known pixel through a real device. Two numbers come back: the draw-and-read
 * check alone, and the same check with all the shaders. **Those two numbers are what decides
 * whether compiling the real set should be `createRenderer`'s default**, which is why this prints
 * them rather than only asserting.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs
 * a dev server and a real GPU, the same reason `ibl-check.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 8
 *     node scripts/probe-check.mjs --base=http://localhost:5202
 *
 * Exits non-zero when the probe refuses this machine or when the page compiled nothing — a glob
 * that reaches no shader is a page that measures nothing and would otherwise pass loudly.
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const BASE = flag('base', 'http://localhost:5202');

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}

const browser = await launch();
const client = await connect(browser.port);
console.log(await requireHardwareGpu(client));
const page = await client.page(`${BASE}/backend-probe.html`, 900, 600);
await page.settled('globalThis.__probeVerdict !== undefined', { settleMs: 100 });

const verdict = await page.eval('globalThis.__probeVerdict');
const cost = await page.eval('globalThis.__probeCost ?? null');

/*
 * **This counts the modules the page *attempted*, and used to say it counted the ones that
 * compiled.** Measured 2026-09-04 with `scripts/claimAudit.sh`'s method: putting an unexpected
 * token into a generated WGSL module left this green at fifty-three modules while the verdict below
 * failed with "a shader did not compile". The count is the premise — a measurement exists and it
 * covers every module — and the verdict is the claim. Naming it for the verdict made two claims
 * look like one and would have sent a reader to the wrong one.
 */
check(
  'the page published a measurement over every shader the engine ships',
  cost !== null && cost.count > 0,
  cost === null ? 'no measurement published' : `${cost.count} modules`,
);
check(
  'the probe accepts this device',
  verdict.ok === true,
  verdict.ok === true ? undefined : verdict.reason,
);

if (cost !== null) {
  console.log(`\ndraw-and-read only:  ${cost.drawMs.toFixed(1)} ms`);
  console.log(`with all ${cost.count} shaders: ${cost.allMs.toFixed(1)} ms`);
}

for (const line of page.logs.filter((l) => /error|exception/i.test(l)).slice(0, 5)) {
  console.log(`  ! ${line.slice(0, 160)}`);
}

await page.close();
client.close();
await browser.close();

process.exit(failures.length > 0 ? 1 : 0);
