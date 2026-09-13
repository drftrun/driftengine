/**
 * Does a sprite land where it was put, the right way up, from the sheet it named?
 *
 * **`demo/dev/sprites.html` draws four sprites from two two-by-two sheets, every texel a different
 * colour.** A sprite covers a rectangle the page names, and the four quadrants of that rectangle
 * must hold the four texels in the right corners. That is the assertion a mirrored frame fails and
 * a bounding box cannot: a mirror preserves every count, every area and every box, and moves
 * exactly which corner is which — the same reason `panel.ts` in core carries a comment about
 * landing upside down, and the same failure this pass would have had without its clip correction.
 *
 * **The two sheets arrive as different source types**, a `<canvas>` and an `ImageBitmap`, because
 * WebGL2 ignores `UNPACK_FLIP_Y_WEBGL` for one and honours it for the other. A pipeline checked
 * with one of them is half checked, which is written down in `surfaceTexture.ts` because it shipped
 * once.
 *
 * **The control is submission order.** A 2D layer has no depth: the order sprites were submitted in
 * *is* the layering, so the same two sprites are drawn both ways round and the overlap has to
 * change colour. Without that pair the ordering claim would be a sentence in a comment.
 *
 * **And the frame has to still contain sprites.** An empty frame passes "nothing is in the wrong
 * corner" — the assertion that let a bug through two tracks ago.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `terrain-check.mjs` is run by hand.
 *
 *     npx vite demo/dev --port 5217 &
 *     node scripts/sprite-check.mjs --base=http://localhost:5217
 */
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;

/** The texels of each sheet, in the order `sprites.ts` paints them: TL, TR, BL, BR. */
const SHEET_A = ['red', 'green', 'blue', 'white'];
const SHEET_B = ['yellow', 'cyan', 'magenta', 'red'];
/** Where the page says sprite B goes, in CSS pixels: left, top, right, bottom. */
const B_BOX = [600, 60, 800, 180];
/** How far a measured edge may sit from the one asked for, in CSS pixels. */
const EDGE = 1.5;
/** Four sprites of 200x120 and two more: well over this, and nowhere near a full frame. */
const COVERED_FLOOR = 50_000;
/** The tilemap's top row, one cell per frame of its sheet, in the order the page fills them. */
const TOP_ROW = ['red', 'green', 'blue', 'white'];
/** Half of an eight-by-four map is what the view it is handed reaches. */
const TILES_IN_VIEW = 16;

function isNoise(line) {
  return (
    line.includes('404') || line.includes('A valid external Instance reference no longer exists')
  );
}

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function shoot(base, backend, order) {
  const browser = await launch();
  try {
    const client = await connect(browser.port);
    /* Before anything is measured: a software rasteriser's figures are not this machine's. */
    await requireHardwareGpu(client);
    const page = await client.page(
      `${base}/sprites.html?backend=${backend}&order=${order}&frames=3`,
      CSS_WIDTH,
      CSS_HEIGHT,
    );
    await page.settled('globalThis.__drawn', { settleMs: 1000 });
    const read = async (name) => await page.eval(`globalThis.__${name}`);
    const measured = {
      quadA: await read('quadA'),
      quadB: await read('quadB'),
      box: await read('box'),
      overlap: String(await read('overlap')),
      tiles: await read('tiles'),
      beyondView: String(await read('beyondView')),
      tilesDrawn: Number(await read('tilesDrawn')),
      covered: Number(await read('covered')),
      runs: Number(await read('runs')),
      dropped: Number(await read('dropped')),
      digest: String(await read('digest')),
      complaints: page.complaints().filter((line) => !isNoise(line)),
    };
    await page.close?.();
    return measured;
  } finally {
    await browser.close?.();
  }
}

const base = argOf('base', 'http://localhost:5217').replace(/\/$/, '');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const measured = {};
/** Whether each backend put sprites on screen at all, which the claims below rest on. */
const covered = {};
for (const backend of ['webgl2', 'webgpu']) {
  console.log(`\n=== ${backend} ===`);
  const over = await shoot(base, backend, '1');
  const under = await shoot(base, backend, '0');
  measured[backend] = { over, under };

  console.log(`      sheet A  : ${over.quadA.join(',')}`);
  console.log(`      sheet B  : ${over.quadB.join(',')}`);
  console.log(`      box      : ${over.box.map((n) => n.toFixed(1)).join(', ')}`);
  console.log(`      overlap  : ${over.overlap} over, ${under.overlap} under`);
  console.log(`      tiles    : ${over.tilesDrawn} drawn, top row ${over.tiles.join(',')}`);
  console.log(`      ${over.covered} px · ${over.runs} runs · ${over.digest}`);

  const complaints = [...over.complaints, ...under.complaints];
  check(
    `${backend}: draws both ways without a validation error`,
    complaints.length === 0,
    complaints.length === 0 ? 'clean' : complaints.slice(0, 2).join(' | '),
  );

  /* The frame contains sprites at all. Everything below is a statement about a picture. */
  /*
   * **The premise every pixel claim below rests on, held as a value so they can rest on it.**
   *
   * Measured 2026-09-04 with `scripts/claimAudit.sh`: zeroing the sprite shader's output left ten
   * of this script's twenty-two claims green. Four are about the batch rather than the picture and
   * are right to; the rest were "beyond the view is black", which an empty frame satisfies
   * everywhere, and both cross-backend claims, which cannot tell two frames that agree from two
   * frames that are both blank.
   */
  const drewSprites = over.covered > COVERED_FLOOR;
  covered[backend] = drewSprites;
  check(
    `${backend}: the frame has sprites in it rather than being empty`,
    drewSprites,
    `${over.covered} px covered`,
  );
  check(`${backend}: nothing was dropped for want of room`, over.dropped === 0, `${over.dropped}`);

  /*
   * The chiral assertion. A mirror about either axis, a transposed affine or a flipped texture all
   * pass every count above and fail exactly this.
   */
  check(
    `${backend}: the canvas sheet's texels land in the right corners`,
    over.quadA.join(',') === SHEET_A.join(','),
    `${over.quadA.join(',')} against ${SHEET_A.join(',')}`,
  );
  check(
    `${backend}: and so do the bitmap sheet's, which upload by a different path`,
    over.quadB.join(',') === SHEET_B.join(','),
    `${over.quadB.join(',')} against ${SHEET_B.join(',')}`,
  );

  /* A sprite covers the rectangle it was given, to within a pixel of the edge. */
  const edges = over.box.map((n, i) => Math.abs(n - B_BOX[i]));
  check(
    `${backend}: a sprite covers the CSS rectangle it was given`,
    edges.every((d) => d <= EDGE),
    `off by ${edges.map((d) => d.toFixed(2)).join(', ')} px`,
  );

  /* One run per texture change, in submission order — the batching claim, from the frame itself. */
  check(
    `${backend}: every texture change is a run, and going back is a new one`,
    over.runs === 5,
    `${over.runs} runs`,
  );

  /*
   * The tilemap, read off the frame. Four different frames of one sheet along the top row, so this
   * says the map asked for the frame it meant *and* that the frame addressed the texel it meant.
   */
  check(
    `${backend}: a tilemap draws the frame each cell names`,
    over.tiles.join(',') === TOP_ROW.join(','),
    `${over.tiles.join(',')} against ${TOP_ROW.join(',')}`,
  );
  /* And the cull is in the picture: the half of the map outside the view is not drawn. */
  check(
    `${backend}: the tiles outside the view are not drawn`,
    drewSprites && over.tilesDrawn === TILES_IN_VIEW && over.beyondView === 'black',
    `${over.tilesDrawn} drawn, beyond the view is ${over.beyondView}`,
  );

  /* The control and the claim together: order is the layering, and reversing it is visible. */
  check(
    `${backend}: the sprite submitted last is the one on top`,
    over.overlap === 'yellow' && under.overlap === 'white',
    `${over.overlap} over, ${under.overlap} under`,
  );
}

/*
 * **The two backends draw the same frame.** The instance data is built once on the CPU and handed
 * to two renderers, so a difference is one of them drawing it wrongly rather than the picture being
 * ambiguous.
 */
const bothDrew = covered.webgl2 === true && covered.webgpu === true;
check(
  'the backends agree, byte for byte, on the frame',
  bothDrew && measured.webgl2.over.digest === measured.webgpu.over.digest,
  `webgl2 ${measured.webgl2.over.digest} · webgpu ${measured.webgpu.over.digest}`,
);
check(
  'and on the other order too',
  bothDrew && measured.webgl2.under.digest === measured.webgpu.under.digest,
  `webgl2 ${measured.webgl2.under.digest} · webgpu ${measured.webgpu.under.digest}`,
);

process.exit(failed === 0 ? 0 : 1);
