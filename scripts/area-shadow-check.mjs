/**
 * Does a rectangular area light occlude, and is its penumbra the rectangle's shape?
 *
 * **Two claims, and only the first is what "shadows from an area light" usually means.** That a
 * rectangle occludes at all is measurable against its own control: the same frame with
 * `castsShadow` off, sampled where the caster's shadow must land and at the mirror of that point
 * through the emitter — same emitter, same distance, same falloff, caster or no caster. That its
 * penumbra has a *shape* is the claim a round filter cannot make, and it is measured by turning the
 * emitter a quarter turn: a three-metre strip lying along X and the same strip lying along Z light
 * the floor identically and must blur their shadows across different axes.
 *
 * **A wide emitter and nine small ones are not the same picture, which is the report this closes.**
 * Nine bulbs on a cable give nine hard shadows that pile up darker where they cross; one rectangle
 * gives one shadow with a wide penumbra. So the strip case is the one to read, not the panel.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server and a real GPU, which is the same reason `shots.mjs` is run by hand.
 *
 *     (setsid npx vite demo/dev --port 5202 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 9
 *     node scripts/area-shadow-check.mjs --base=http://localhost:5202
 *
 * **Both backends, every run, and WebGL2 printed first** — the 2026-08-23 rule: three defects
 * shipped on the WebGPU path because every capture passed `?backend=webgl2`, and each drew a
 * plausible picture. The two are a control for each other and the comparison is free.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { readPng } from '../packages/core/scripts/png.mjs';
import { compare } from '../packages/core/scripts/frames.mjs';

const CSS_WIDTH = 1280;
const CSS_HEIGHT = 720;
/**
 * The radius of a sample patch, in CSS pixels.
 *
 * Small enough to sit inside a shadow a metre wide at this camera, large enough that a single
 * dithered tap cannot decide the answer — the filter rotates its pattern per fragment, so a
 * one-pixel sample of a penumbra is a coin toss rather than a measurement.
 */
const PATCH_RADIUS = 14;
/** The first row the page's readout occupies. Everything above it is the scene. */
const READOUT_TOP = 660;

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** Mean luminance over a disc where the page said something would be. */
function patch(image, at) {
  const scale = image.width / CSS_WIDTH;
  const cx = at.x * scale;
  const cy = at.y * scale;
  const r = PATCH_RADIUS * scale;
  let total = 0;
  let count = 0;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * image.channels;
      total +=
        0.2126 * image.pixels[i] + 0.7152 * image.pixels[i + 1] + 0.0722 * image.pixels[i + 2];
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

/**
 * How wide a shadow's edge is, in metres, along one of the lines the page publishes.
 *
 * **The 25-to-75-per-cent transition width, and the metric matters more than it looks.** Three
 * simpler ones were tried on this frame and each measured something else:
 *
 * - **A frame diff between the two orientations** counted the emitter's own panel mesh rotating,
 *   4,115 pixels of it, against a backend-to-backend floor of 122.
 * - **The steepest luminance step per pixel** is proportional to contrast as well as to sharpness,
 *   and a rectangle lying along Z lights this spot twice as brightly as one lying along X — so the
 *   softer edge measured *steeper*, 0.6 against 0.48, purely on having further to fall.
 * - **Either metric over the wrong window** measures floor with no edge in it. The page's `axis`
 *   line runs through a post whose umbra is three metres long, and the default window on the X line
 *   sat entirely outside the mover's shadow: 0.13 against 0.71, from a frame whose two directions
 *   are 3 to 1 the other way.
 *
 * A width in metres is contrast-free by construction: it is where the profile crosses a quarter and
 * three quarters of its own range, so a brighter edge and a dimmer one of the same sharpness measure
 * the same. Lightly smoothed first, because the filter dithers its tap pattern per fragment and a
 * raw profile's steepest step is the dither.
 *
 * The window brackets one edge and nothing else. The mover is a box 0.6 by 1.1 by 0.6 at z=1.4, and
 * the emitter's centre is 3 m up, so its top face projects by `3 / (3 - 1.1)`: the shadow's right
 * edge lands at x=0.47 and its far edge at z=2.68. Both windows are those numbers with room either
 * side, and both start inside the umbra so the walk crosses the edge outward.
 */
function transitionWidth(image, axis, from, to) {
  const scale = image.width / CSS_WIDTH;
  const column = (sx, sy) => {
    let total = 0;
    let count = 0;
    for (let dy = -3; dy <= 3; dy++) {
      const x = Math.round(sx * scale);
      const y = Math.round(sy * scale) + dy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * image.channels;
      total +=
        0.2126 * image.pixels[i] + 0.7152 * image.pixels[i + 1] + 0.0722 * image.pixels[i + 2];
      count++;
    }
    return count === 0 ? null : total / count;
  };

  /* Every pixel along the polyline, carrying the world coordinate it stands at. */
  const raw = [];
  for (let n = 0; n + 1 < axis.length; n++) {
    const a = axis[n];
    const b = axis[n + 1];
    if (b.x < from || a.x > to) continue;
    const steps = Math.max(1, Math.round(Math.hypot(b.sx - a.sx, b.sy - a.sy) * scale));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const world = a.x + (b.x - a.x) * t;
      if (world < from || world > to) continue;
      const value = column(a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t);
      if (value !== null) raw.push({ world, value });
    }
  }
  if (raw.length < 8) return Number.POSITIVE_INFINITY;

  /* A three-pixel boxcar: enough to average the dither, short enough to keep a sharp edge sharp. */
  const smooth = raw.map((sample, n) => {
    const window = raw.slice(Math.max(0, n - 1), Math.min(raw.length, n + 2));
    return {
      world: sample.world,
      value: window.reduce((total, one) => total + one.value, 0) / window.length,
    };
  });

  const low = Math.min(...smooth.map((one) => one.value));
  const high = Math.max(...smooth.map((one) => one.value));
  if (high - low < 1) return Number.POSITIVE_INFINITY;
  const quarter = low + (high - low) * 0.25;
  const threeQuarters = low + (high - low) * 0.75;
  const first = smooth.find((one) => one.value >= quarter);
  const last = smooth.find((one) => one.value >= threeQuarters);
  if (first === undefined || last === undefined) return Number.POSITIVE_INFINITY;
  return Math.abs(last.world - first.world);
}

/**
 * Load one configuration, hold it still, and bring back the frame and the page's own numbers.
 *
 * The page stops moving at its hold frame and keeps calling `updatePointShadows`, which is the
 * distinction its own comment draws: a page that freezes the renderer has frozen the shadow system
 * mid-stride, and every figure taken afterwards is about that frozen state.
 */
async function read(base, backend, query, shot) {
  const browser = await launch();
  const client = await connect(browser.port);
  const page = await client.page(
    `${base}/pointshadow.html?backend=${backend}&${query}`,
    CSS_WIDTH,
    CSS_HEIGHT,
  );
  await page.settled('globalThis.__points', { settleMs: 2500 });
  const points = JSON.parse(await page.eval('JSON.stringify(globalThis.__points)'));
  await page.screenshot(shot);
  const complaints = page.complaints().filter((line) => !line.includes('404'));
  await page.close?.();
  await browser.close?.();
  return { points, complaints, image: readPng(shot) };
}

const base = argOf('base', 'http://localhost:5202').replace(/\/$/, '');
const out = mkdtempSync(path.join(tmpdir(), 'areashadow-'));

let failed = 0;
/** Whether each backend drew a softened edge, which the cross-backend claim rests on. */
const softened = {};

function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

/* A strip, which is the reported shape: metres long and a few centimetres tall. */
const STRIP = 'area=1&areaw=3&areah=0.05';
/* The same strip turned a quarter turn, by swapping which axis is the long one. */
const TURNED = 'area=1&areaw=0.05&areah=3';
/* And a panel, where both axes are within a factor of three. */
const PANEL = 'area=1&areaw=1.6&areah=0.5';
/*
 * A panel over a floor smooth enough to reflect it, which is the only configuration on this page
 * that exercises an area light's *specular* half at all. See `buildFloor` in `pointshadow.ts`: the
 * floor is matte otherwise, so `vSpecular` is zero and the term is skipped entirely.
 */
const GLOSS = 'area=1&areaw=1.6&areah=0.5&areacast=0&areagloss=0.35&areadim=0.12';
/* The same floor and the same light, roughened until there is no highlight left to find. */
const GLOSS_ROUGH = 'area=1&areaw=1.6&areah=0.5&areacast=0&areagloss=0.9&areadim=0.12';
/*
 * **The mover as the only caster, for the penumbra measurement alone.**
 *
 * The page's post is 1.8 m tall under an emitter 3 m up, so its umbra covers the floor from x≈1.7
 * to x≈5.2 — and the fixture box sits 0.6 m under the emitter, which throws a shadow 3.5 m across.
 * Either one lying over the sample line is measuring a different shadow's interior, which is how a
 * penumbra 9 to 1 anisotropic first measured as 1.80 against 1.87.
 */
const ONLY_MOVER = 'post=0&fixture=0';
/**
 * The world spans each measured edge falls in, derived from the mover rather than chosen.
 *
 * The box is 0.6 by 1.1 by 0.6 at z=1.4 and the emitter's centre is 3 m up, so its top face
 * projects by `3 / (3 - 1.1)` = 1.579: the shadow's right edge lands at `0.3 * 1.579` = 0.47 and its
 * far edge at `1.7 * 1.579` = 2.68. Each window starts inside the umbra and ends on open floor.
 */
const X_EDGE = [0.2, 1.5];
const Z_EDGE = [2.0, 3.4];

try {
  /* WebGL2 first: it is the backend consumers run and the reference for correctness. */
  for (const backend of ['webgl2', 'webgpu']) {
    console.log(`\n=== ${backend} ===\n`);
    const casting = await read(base, backend, STRIP, path.join(out, `${backend}-cast.png`));
    const control = await read(
      base,
      backend,
      `${STRIP}&areacast=0`,
      path.join(out, `${backend}-nocast.png`),
    );

    check(
      'the page ran without complaint',
      casting.complaints.length === 0 && control.complaints.length === 0,
      [...casting.complaints, ...control.complaints].join(' | ') || 'clean',
    );

    /*
     * **The layers, before any pixel.** A rectangle that was never offered a layer and one whose
     * bake never landed produce the identical picture, and only one of them is a bug in the shadow
     * path — the same distinction this page publishes `shadowCount` for.
     */
    check(
      'the rectangle holds a static layer and a live one',
      casting.points.areaLayer >= 0 && casting.points.areaLiveLayer >= 0,
      `static ${casting.points.areaLayer}, live ${casting.points.areaLiveLayer}`,
    );
    check(
      'and holds neither when it declines to cast',
      control.points.areaLayer < 0 && control.points.areaLiveLayer < 0,
      `static ${control.points.areaLayer}, live ${control.points.areaLiveLayer}`,
    );

    /*
     * The post is the *static* layer's caster and the mover is the *live* layer's. Both must
     * darken, because the two layers compose by multiplication and either being absent leaves a
     * caster casting nothing — which is precisely the defect the point-light pair shipped with for
     * every frame this engine had ever rendered.
     */
    for (const [name, shadowAt, controlAt] of [
      ['the still post', 'areaPostShadow', 'areaPostControl'],
      ['the mover', 'areaMoverShadow', 'areaMoverControl'],
    ]) {
      const shadow = patch(casting.image, casting.points[shadowAt]);
      const beside = patch(casting.image, casting.points[controlAt]);
      const wasShadow = patch(control.image, control.points[shadowAt]);
      check(
        `${name} darkens the ground under it`,
        shadow < beside * 0.85,
        `${shadow.toFixed(1)} in shadow against ${beside.toFixed(1)} at its mirror`,
      );
      check(
        `and that ground was lit before the rectangle cast`,
        wasShadow > shadow * 1.15,
        `${wasShadow.toFixed(1)} with casting off against ${shadow.toFixed(1)} with it on`,
      );
    }

    /*
     * **The shape of the penumbra, measured across the shadow's own edge.**
     *
     * A strip lying along X and the same strip lying along Z subtend nearly the same solid angle
     * from every point of the floor, so they light it almost identically and blur their shadows
     * across different axes. Walking the floor line the page publishes, the edge of the post's
     * shadow is therefore *soft* for the strip along X and *sharp* for the strip along Z — and a
     * round filter would give the two the same edge whatever the emitter's shape.
     *
     * **A frame diff was tried first and it measured the wrong thing.** Turning the strip a quarter
     * turn changed 4,115 pixels of 1,689,600, which reads as a signal against a backend-to-backend
     * floor of 122 — but the page draws the emitter as a panel of the same extents, so most of
     * those pixels were the panel's own silhouette rotating. An instrument that photographs the
     * emitter cannot report on its penumbra. This walks the floor instead, where the emitter is not.
     */
    /*
     * **The same line, two emitters, which is the comparison with no bias left in it.**
     *
     * Comparing the X line against the Z line inside one frame cannot work: the camera looks along
     * Z, so a metre of world runs about seventy pixels across the screen and about thirty into it,
     * and the two lines would differ by that alone. Holding the *line* fixed and turning the
     * emitter removes it — same pixels, same perspective, same contrast band, and the only thing
     * that moved is which axis of the rectangle is three metres long.
     */
    const alone = await read(
      base,
      backend,
      `${STRIP}&${ONLY_MOVER}`,
      path.join(out, `${backend}-alone.png`),
    );
    const turned = await read(
      base,
      backend,
      `${TURNED}&${ONLY_MOVER}`,
      path.join(out, `${backend}-turned.png`),
    );

    const alongX = transitionWidth(alone.image, alone.points.areaAxisX, ...X_EDGE);
    const acrossX = transitionWidth(turned.image, turned.points.areaAxisX, ...X_EDGE);
    const softensX = alongX > acrossX * 1.8;
    check(
      'the strip softens the shadow edge along its own length',
      softensX,
      `edge ${alongX.toFixed(3)} m wide with the strip along x against ` +
        `${acrossX.toFixed(3)} m with it across`,
    );

    const alongZ = transitionWidth(turned.image, turned.points.areaAxisZ, ...Z_EDGE);
    const acrossZ = transitionWidth(alone.image, alone.points.areaAxisZ, ...Z_EDGE);
    const softensZ = alongZ > acrossZ * 1.8;
    softened[backend] = softensX && softensZ;
    check(
      'and turning it a quarter turn moves the softening to the other axis',
      softensZ,
      `edge ${alongZ.toFixed(3)} m wide with the strip along z against ` +
        `${acrossZ.toFixed(3)} m with it across`,
    );

    /* A panel too, so the default shape is exercised and not only the extreme one. */
    /*
     * **The specular half, which had no instrument until 2026-09-04 and shipped wrong because of it.**
     *
     * The term that stood here returned 0.000233 against an integral of 0.9207 on a smooth surface,
     * measured offline by `scripts/areaSpecular.mjs` — a highlight that is simply absent. Nothing on
     * this page could see that: its floor is matte, so every capture passed with the term deleted.
     *
     * The claim is the one a person makes looking at the frame: where the rectangle's reflection
     * lands is brighter than floor at the same distance from the emitter that is not on the
     * reflection, and roughening the floor takes that difference away. The control shares the
     * emitter, the distance and the falloff, exactly as the shadow controls above do.
     */
    const gloss = await read(base, backend, GLOSS, path.join(out, `${backend}-gloss.png`));
    const glossRough = await read(
      base,
      backend,
      GLOSS_ROUGH,
      path.join(out, `${backend}-gloss-rough.png`),
    );

    const smoothHighlight = patch(gloss.image, gloss.points.areaGloss);
    const smoothControl = patch(gloss.image, gloss.points.areaGlossControl);
    const roughHighlight = patch(glossRough.image, glossRough.points.areaGloss);
    const roughControl = patch(glossRough.image, glossRough.points.areaGlossControl);

    /**
     * **A band, because a threshold is not a check.**
     *
     * `smoothHighlight > smoothControl * 1.2` was the first writing of this, and multiplying the
     * whole term by 0.02 — a fiftyfold error, larger than the defect this replaced — still passed
     * it at a contrast of 2.42. The emitter is dimmed by `?areadim=` for the same reason: at full
     * brightness the highlight clips at 255 and a clipped sample cannot tell a correct term from
     * one twice too bright.
     *
     * 11.7 measured on both backends, 2026-09-04. The band is roughly a third either way, which is
     * wide enough for a different GPU's filtering and narrow enough that the term cannot be halved
     * or doubled inside it.
     */
    const contrast = smoothHighlight / Math.max(smoothControl, 1e-6);
    check(
      'a smooth floor carries the rectangle as a highlight, at about the brightness it should',
      contrast > 8 && contrast < 16,
      `${smoothHighlight.toFixed(1)} where the reflection lands against ${smoothControl.toFixed(1)} ` +
        `off it, a contrast of ${contrast.toFixed(2)} against a band of 8 to 16`,
    );
    check(
      'and roughening the same floor takes the highlight away',
      roughHighlight < roughControl * 1.2,
      `${roughHighlight.toFixed(1)} against ${roughControl.toFixed(1)} on the rough floor`,
    );
    check(
      'so the highlight is the surface and not the geometry',
      contrast > (roughHighlight / Math.max(roughControl, 1e-6)) * 4,
      `contrast ${contrast.toFixed(2)} smooth ` +
        `against ${(roughHighlight / Math.max(roughControl, 1e-6)).toFixed(2)} rough`,
    );

    const panel = await read(base, backend, PANEL, path.join(out, `${backend}-panel.png`));
    const panelShadow = patch(panel.image, panel.points.areaPostShadow);
    const panelBeside = patch(panel.image, panel.points.areaPostControl);
    check(
      'a panel occludes as well as a strip',
      panelShadow < panelBeside * 0.85,
      `${panelShadow.toFixed(1)} against ${panelBeside.toFixed(1)}`,
    );
  }

  /*
   * **And the two backends against each other, which is the control neither provides alone.**
   * Counted past a delta of 8 rather than exactly: `AGENTS.md` says a count including 1/255 reports
   * an indistinguishable frame as 38% wrong, and the filter dithers per fragment.
   */
  const one = readPng(path.join(out, 'webgl2-cast.png'));
  const two = readPng(path.join(out, 'webgpu-cast.png'));
  const across = compare(one, two, {
    region: { x0: 0, y0: 0, x1: one.width, y1: READOUT_TOP * 2 },
    tolerance: 8,
  });

  /*
   * **Each backend has to have drawn a shadow with structure in it before the two are asked to
   * agree about one.**
   *
   * Measured 2026-09-04 with `scripts/claimAudit.sh`: deleting the area light's diffuse term left
   * eleven of this script's twenty-seven claims green and this was one of them, because two
   * unshadowed frames match each other exactly. A regression that hits both backends is the one
   * failure a cross-backend claim is uniquely able to catch, and it was the one it could not see.
   *
   * The premise is the pair of softening claims above rather than a pixel count invented here:
   * an edge that is wider along the strip than across it cannot be produced by an absent light,
   * and reusing them means the two cannot drift apart.
   */
  console.log('\n=== both backends ===\n');
  check(
    'the two backends draw the same area shadow',
    softened.webgl2 === true && softened.webgpu === true && across.changed < across.pixels / 100,
    `${across.changed} of ${across.pixels} pixels differ past a delta of 8`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
