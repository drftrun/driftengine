/**
 * Does the tree draw what it holds, does a click select, does an edit move the thing, and does stop
 * put the world back?
 *
 * Four unrelated claims sharing one package, so this asserts each against a control that must fail
 * where the claim succeeds.
 *
 * **Collapsing needs the open tree beside it.** A test that only counts rows in one frame passes a
 * build that draws a fixed number, so `tree` and `collapsed` are a pair: the same hierarchy, one
 * branch closed, and fewer rows drawn as well as fewer rows held. The pixel count is what makes it a
 * statement about drawing rather than about an array.
 *
 * **Selection needs its opposite.** Asserting that a highlighted row appears passes a panel that is
 * permanently orange, so `noselect` — the same frame with the pointer on the panel's own background
 * — has to hold none, select nothing, and leave the gizmo where it was.
 *
 * **An edit needs a control that does not move.** `edit` writes `position.x` through the inspector
 * and `noedit` is the identical frame without the write; the rightmost cube pixel must differ. A
 * test asserting only that the write returned true passes an inspector that writes into an array the
 * world matrix never reads, which is the exact defect `setPosition` exists to prevent.
 *
 * **And stop needs play beside it**, or "the world holds what it started with" passes a play mode
 * that never changed anything.
 *
 * **The frame has to still contain the subject.** A blank frame agrees with every control.
 *
 * **Every assertion here was checked by breaking what it covers**, and one of those runs changed the
 * page rather than confirming it. Ignoring collapse when flattening failed the collapse pair at 3
 * rows against 3; making `rowIndexOf` answer -1 failed selection three ways at once, including the
 * gizmo; and dropping the clear from `stop` failed the restore at **4 live entities and health0 still
 * 999**, which is the duplication the host's design exists to prevent, measured.
 *
 * **The fourth found a hole and closed it.** Replacing `setPosition` with a raw
 * `node.position[axis] = value` — a write that never invalidates the world matrix — left this check
 * *green*, because the edit used to be applied during setup, before any world matrix had been
 * computed: the first `updateWorld` picked up a raw write as readily as a proper one. The edit now
 * lands after a frame has drawn, so only an invalidation can move the cube, and the same mutation
 * fails at 669 against 669. `inspector.test.ts` had it covered all along, because it calls
 * `updateWorld` before writing — which is why a check with a control and a unit test with a
 * precondition are not the same instrument.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is why `gizmo-check.mjs` is run by hand too.
 *
 *     npx vite demo/dev --port 5218 &
 *     node scripts/editor-check.mjs --base=http://localhost:5218
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

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
      `${base}/editor.html?backend=${backend}&variant=${variant}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const read = async (name) => Number(await page.eval(`globalThis.${name}`));
    const out = {
      rows: await read('__rows'),
      rowPixels: await read('__rowPixels'),
      selectedPixels: await read('__selectedPixels'),
      subjectRight: await read('__subjectRight'),
      selectedRow: await read('__selectedRow'),
      fields: await read('__fields'),
      gizmoX: await read('__gizmoX'),
      live: await read('__live'),
      health0: await read('__health0'),
      mode: String(await page.eval('globalThis.__mode')),
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
/** Whether each backend drew the panel and the subject, which the cross-backend claims rest on. */
const drawn = {};
const backends = only === '' ? ['webgl2', 'webgpu'] : [only];
for (const backend of backends) {
  console.log(`\n=== ${backend} ===`);
  const tree = await shoot(base, backend, 'tree');
  const collapsed = await shoot(base, backend, 'collapsed');
  const select = await shoot(base, backend, 'select');
  const noselect = await shoot(base, backend, 'noselect');
  const edit = await shoot(base, backend, 'edit');
  const noedit = await shoot(base, backend, 'noedit');
  const play = await shoot(base, backend, 'play');
  const stopped = await shoot(base, backend, 'stopped');
  measured[backend] = { tree, collapsed, select, edit };

  console.log(
    `      tree    : ${tree.rows} rows, ${tree.rowPixels} px · collapsed ${collapsed.rows} rows, ${collapsed.rowPixels} px`,
  );
  console.log(
    `      select  : row ${select.selectedRow}, ${select.selectedPixels} lit, gizmo x ${select.gizmoX.toFixed(3)}`,
  );
  console.log(
    `      control : row ${noselect.selectedRow}, ${noselect.selectedPixels} lit, gizmo x ${noselect.gizmoX.toFixed(3)}`,
  );
  console.log(
    `      edit    : rightmost cube ${edit.subjectRight} · noedit ${noedit.subjectRight}`,
  );
  console.log(
    `      play    : ${play.live} live, health0 ${play.health0} · stopped ${stopped.live} live, health0 ${stopped.health0}`,
  );

  const complaints = [
    ...tree.complaints,
    ...collapsed.complaints,
    ...select.complaints,
    ...noselect.complaints,
    ...edit.complaints,
    ...noedit.complaints,
    ...play.complaints,
    ...stopped.complaints,
  ];
  check(
    `${backend}: draws every variant without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains the panel and the cubes at all. Everything below is about a picture. */
  const drewPanel = tree.rowPixels > 500 && tree.subjectRight > 0;
  drawn[backend] = drewPanel;
  check(
    `${backend}: the frame contains the panel and the subject`,
    drewPanel,
    `${tree.rowPixels} row px, rightmost cube at ${tree.subjectRight}`,
  );

  /* The tree draws what it holds, and collapsing takes a branch off the screen. */
  check(`${backend}: the hierarchy is three rows`, tree.rows === 3, `${tree.rows} rows`);
  check(
    `${backend}: collapsing a branch holds fewer rows and draws fewer`,
    collapsed.rows === 2 && collapsed.rowPixels < tree.rowPixels,
    `${collapsed.rows} rows and ${collapsed.rowPixels} px against ${tree.rows} and ${tree.rowPixels}`,
  );

  /* Selection: a click on a row, and its opposite. */
  check(
    `${backend}: a pointer on a row selects it`,
    select.selectedRow === 2,
    `row ${select.selectedRow}`,
  );
  check(
    `${backend}: and the selected row is drawn as selected`,
    select.selectedPixels > 200,
    `${select.selectedPixels} lit pixels`,
  );
  check(
    `${backend}: and the gizmo moved onto what was selected`,
    Math.abs(select.gizmoX - 1.6) < 1e-4,
    `gizmo x ${select.gizmoX.toFixed(4)}`,
  );
  check(
    `${backend}: a pointer on the panel background selects nothing and lights nothing`,
    noselect.selectedRow === -1 && noselect.selectedPixels === 0,
    `row ${noselect.selectedRow}, ${noselect.selectedPixels} lit`,
  );

  /*
   * The inspector moved the thing rather than a number. A write into `node.position` that never
   * reached `markMoved` would leave `worldMatrix` where it was and this is the assertion that sees
   * it, because the cube is drawn from that matrix.
   */
  check(
    `${backend}: an inspector edit moves the subject's pixels`,
    edit.subjectRight > noedit.subjectRight + 20,
    `rightmost cube ${edit.subjectRight} against ${noedit.subjectRight}`,
  );
  check(
    `${backend}: and the inspector was showing a transform to edit`,
    noedit.fields === 10,
    `${noedit.fields} fields`,
  );

  /* Play changed the world; stop put it back. Neither claim means anything without the other. */
  check(
    `${backend}: play leaves what it changed`,
    play.live === 2 && play.health0 === 999,
    `${play.live} live, health0 ${play.health0}`,
  );
  check(
    `${backend}: stop restores the count and the value`,
    stopped.live === 2 && stopped.health0 === 10,
    `${stopped.live} live, health0 ${stopped.health0}`,
  );
  check(
    `${backend}: and the editor is back in edit mode`,
    stopped.mode === 'edit' && play.mode === 'play',
    `stopped ${stopped.mode}, playing ${play.mode}`,
  );
}

if (backends.length === 2) {
  console.log('\n=== both ===');
  const [a, b] = [measured['webgl2'], measured['webgpu']];

  /*
   * **Both backends have to have drawn the panel before they are asked to agree about it.**
   *
   * **What this gate catches is the blank frame, and it is worth being exact about what it does
   * not.** The zero case below used to read as agreement: `Math.max(one, two) === 0 ? 0` gives a
   * spread of 0, so two backends drawing nothing at all agreed perfectly. That is fixed here and in
   * `gizmo-check.mjs`, where the same construction stood.
   *
   * It does **not** catch two backends that are wrong in the same way while still drawing. Measured
   * 2026-09-04 with `scripts/claimAudit.sh`: making a collapsed branch stay expanded left
   * twenty-nine of this script's thirty-one claims green, including these, and the premise below
   * held throughout because the panel was still drawn. Only the per-backend claim above caught it,
   * which is the correct division of labour — a cross-backend claim compares two implementations
   * and cannot be asked to know what the right answer is.
   */
  const bothDrew = drawn.webgl2 === true && drawn.webgpu === true;
  for (const variant of ['tree', 'collapsed', 'select', 'edit']) {
    const one = a[variant].rowPixels;
    const two = b[variant].rowPixels;
    const largest = Math.max(one, two);
    const spread = largest === 0 ? Number.POSITIVE_INFINITY : Math.abs(one - two) / largest;
    check(
      `both backends draw the same amount of ${variant}`,
      bothDrew && spread < PARITY,
      `webgl2 ${one} px against webgpu ${two} px, ${(spread * 100).toFixed(1)}% apart`,
    );
  }
  check(
    'both backends put the subject in the same place',
    bothDrew && Math.abs(a.edit.subjectRight - b.edit.subjectRight) <= 2,
    `webgl2 ${a.edit.subjectRight} against webgpu ${b.edit.subjectRight}`,
  );
}

console.log(failed === 0 ? '\nall assertions passed' : `\n${failed} assertion(s) failed`);
process.exit(failed === 0 ? 0 : 1);
