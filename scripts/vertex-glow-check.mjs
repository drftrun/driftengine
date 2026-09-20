/**
 * Does a vertex's own glow reach the frame on the second pipeline, and match the first?
 *
 * **The voxel sandbox's block light lives there**, and without it every torch goes out at night on
 * the port. `vertexLayout.test.ts` pins where both shaders read it; this is the driver saying what
 * they make of it. `demo/dev/vertexGlow.html` draws one quad three times — the second pipeline
 * opaque, the second pipeline blended, the forward path — with its glow rising from nothing at the
 * left edge to one at the right, and nothing else lighting the frame.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up: it needs a dev server
 * and a real GPU, like `depth-share-check.mjs`.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/vertex-glow-check.mjs --base=http://localhost:5202
 *
 * **The control is the same page with the glow at zero**, where all three rows must be black.
 * Without it a row that rose would be equally well explained by a light the page forgot to put out.
 *
 * **And the emissive map, since 2026-09-18**: `?map=1` has every vertex glowing at one and the map
 * doing the rising, a ramp from black to white read by both of the second pipeline's shaders and by
 * the forward path's own emissive map; `?map=1&ramp=0` is a black map, where every vertex still
 * glows and nothing may — which is a wall between a city's lit windows.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function read(base, glow, extra = '') {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/vertexGlow.html?backend=webgpu&glow=${glow}${extra}`,
    1280,
    720,
  );
  await page.settled('globalThis.__vertexGlow', { settleMs: 1500 });
  const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__vertexGlow)'));
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { result, complaints };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const dark = await read(base, 0);
const lit = await read(base, 1);
const mapped = await read(base, 1, '&map=1');
const blackMap = await read(base, 1, '&map=1&ramp=0');
const complaints = [
  ...dark.complaints,
  ...lit.complaints,
  ...mapped.complaints,
  ...blackMap.complaints,
];
check(
  'both pages ran without complaint',
  complaints.length === 0,
  complaints.join(' | ') || 'clean',
);
const pages = [dark, lit, mapped, blackMap];
check(
  'no page reported an error',
  pages.every((page) => page.result.error === null),
  pages.map((page) => page.result.error ?? 'none').join(' / '),
);
check(
  'every page drew on WebGPU',
  pages.every((page) => page.result.backend === 'webgpu'),
  pages.map((page) => page.result.backend).join(', '),
);

const show = (row) => row.map((value) => value.toFixed(1).padStart(6)).join('');
for (const [label, result] of [
  ['glow 0', dark.result],
  ['glow 1', lit.result],
  ['map', mapped.result],
  ['black map', blackMap.result],
]) {
  for (const name of ['opaque', 'blended', 'forward']) {
    console.log(`      ${label}  ${name.padEnd(8)}${show(result.rows[name])}`);
  }
}
console.log('');

/* One level of 255 either way is the tone curve rounding the same light twice. */
const BLACK = 1;
for (const name of ['opaque', 'blended', 'forward']) {
  const row = dark.result.rows[name];
  check(
    `the control: with no glow the ${name} quad is black`,
    row.every((value) => value <= BLACK),
    `brightest ${Math.max(...row).toFixed(1)}`,
  );
}

for (const name of ['opaque', 'blended', 'forward']) {
  const row = lit.result.rows[name];
  const rising = row.every((value, at) => at === 0 || value > (row[at - 1] ?? 0));
  check(
    `the ${name} quad's glow rises from left to right`,
    rising && (row[row.length - 1] ?? 0) > 40,
    show(row),
  );
}

/*
 * **Agree, not just rise.** The two pipelines share `litColour`'s arithmetic by parity, and with
 * nothing else in the frame the glow is the whole of it: albedo times glow times gain times night.
 * Measured on 2026-09-18 at one level of 255 worst, on both comparisons — the forward path's
 * interpolated varying against the compute pass's barycentric weights, rounded once each. Two
 * allows that rounding on either side and nothing more.
 */
const AGREE = 2;
const gap = (a, b) => Math.max(...a.map((value, at) => Math.abs(value - (b[at] ?? 0))));
check(
  'the second pipeline agrees with the first',
  gap(lit.result.rows.opaque, lit.result.rows.forward) <= AGREE,
  `worst ${gap(lit.result.rows.opaque, lit.result.rows.forward).toFixed(2)} levels`,
);
check(
  'and its blended raster agrees with its shading pass',
  gap(lit.result.rows.blended, lit.result.rows.opaque) <= AGREE,
  `worst ${gap(lit.result.rows.blended, lit.result.rows.opaque).toFixed(2)} levels`,
);

/*
 * **The emissive map.** Every vertex glows at one on all three rows, so what rises is the map: the
 * second pipeline's shading pass and blended raster each decode it, and the forward path samples
 * its own. The rows must rise and agree as the vertex rows do; and through a black map they must
 * stay black, because a map modulates a glow and a wall's texel of zero is what keeps a wall dark.
 */
for (const name of ['opaque', 'blended', 'forward']) {
  const row = mapped.result.rows[name];
  const rising = row.every((value, at) => at === 0 || value > (row[at - 1] ?? 0));
  check(
    `the ${name} quad's glow rises across its emissive map`,
    rising && (row[row.length - 1] ?? 0) > 40,
    show(row),
  );
  check(
    `and through a black map the ${name} quad glows nowhere`,
    blackMap.result.rows[name].every((value) => value <= BLACK),
    `brightest ${Math.max(...blackMap.result.rows[name]).toFixed(1)}`,
  );
}
check(
  'the second pipeline\u2019s map agrees with the forward path\u2019s',
  gap(mapped.result.rows.opaque, mapped.result.rows.forward) <= AGREE,
  `worst ${gap(mapped.result.rows.opaque, mapped.result.rows.forward).toFixed(2)} levels`,
);
check(
  'and its blended raster reads the map as its shading pass does',
  gap(mapped.result.rows.blended, mapped.result.rows.opaque) <= AGREE,
  `worst ${gap(mapped.result.rows.blended, mapped.result.rows.opaque).toFixed(2)} levels`,
);

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
