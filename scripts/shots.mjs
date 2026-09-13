/**
 * Photograph held frames, and compare two runs of them.
 *
 *     npm run demo                                    # in one terminal
 *     node scripts/shots.mjs capture before           # every scene, at a held frame
 *     ...change one thing, and restart the dev server...
 *     node scripts/shots.mjs capture after
 *     node scripts/shots.mjs diff before after
 *
 * **The two-capture gate is the only way this repository knows whether a rendering change did
 * what it says.** A test cannot see a picture, and a pair of screenshots taken at the same
 * wall-clock offset is not a comparison: measured here, two captures of one build differed in
 * 736,190 pixels of 921,600, because a frame stall had moved the camera. `?hold=N` is what makes
 * the two comparable, and with it two runs of one build differ in zero pixels.
 *
 * Options, all with defaults that suit the engine's own harness:
 *
 *     --base=http://localhost:5173   where the harness is served
 *     --scenes=0,1,2                 which indices to walk, default every published one
 *     --hold=420                     which frame to freeze on
 *     --size=1280x720                the drawing buffer to ask for
 *     --query=&bloom=0.5&hdr=1       appended to every URL, for a quality option under test
 *     --out=shots                    where the PNGs go
 *     --region=0,92,1280,678         the part of the frame `diff` looks at
 *     --delta=16                     how far a pixel must move before `diff` counts it
 *
 * **A consumer with its own page passes `--base` and `--scenes=0` and gets the same gate**, since
 * nothing here knows what a scene is beyond a number in a query string. The pieces underneath are
 * `browser.mjs`, `cdp.mjs`, `png.mjs` and `frames.mjs`, each usable on its own.
 */
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, requireHardwareGpu } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';
import { readPng } from '../packages/core/scripts/png.mjs';
import { compare, formatComparison, speckle } from '../packages/core/scripts/frames.mjs';
import { heldClockScript } from '../packages/core/scripts/heldClock.mjs';

/**
 * The engine's own published scenes, by the index `?scene=` takes.
 *
 * **This is `demo/index.ts`'s `SCENES` in its own order, and it went one out of step.**
 * `voxelSandbox` was added at the front of that list and never here, so every index below named
 * the scene before it: a capture labelled `storm-sea` was a picture of the wind field, and
 * `--scenes=4` selected the scene that list calls `wind-field`. A before-and-after diff still
 * compared like with like — the same index both times — which is why nothing failed and why the
 * captures on disk have been misnamed since the sandbox landed.
 *
 * `scripts/frames.test.mjs` asserts the two lists agree now, so the next scene added to either one
 * fails rather than silently renaming six captures.
 */
export const DEFAULT_SCENES = [
  'voxel-sandbox',
  'gilded-chamber',
  'showroom',
  'night-court',
  'wind-field',
  'storm-sea',
  'collapse',
  'day-clock',
];

/**
 * The capture's name on disk, with the backend in it when there is one.
 *
 * **Two captures that share a name overwrite each other, and a diff of a backend against
 * itself always passes.** That is the whole failure `--backend` exists to prevent: a green
 * parity run that compared WebGL2 with WebGL2 and said nothing was wrong.
 */
export function captureLabel(label, backend) {
  return backend === null || backend === undefined ? label : `${label}-${backend}`;
}

/**
 * Put `backend=` into the query the page is opened with, which is what the engine's own
 * `forcedBackend` reads. Joined rather than replaced, so `--query=` still works beside it.
 */
export function withBackend(query, backend) {
  if (backend === null || backend === undefined) return query;
  return query === '' ? `?backend=${backend}` : `${query}&backend=${backend}`;
}

/**
 * Join a query onto a URL that may already have one.
 *
 * The engine's own scene paths are `/?scene=0&hold=420`, so appending a query that opens
 * with `?` produces two of them and a page that loads without its parameters. That failed
 * silently as a timeout waiting for a frame that never held, which reads exactly like a
 * broken renderer.
 */
export function joinQuery(url, query) {
  if (query === '') return url;
  if (!url.includes('?')) return `${url}${query.startsWith('?') ? query : `?${query}`}`;
  return `${url}${query.startsWith('?') ? `&${query.slice(1)}` : query}`;
}

export function parseArgs(argv) {
  const flags = new Map();
  const loose = [];
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    /* A bare `--inject` is a flag set to true. Without this branch it fell through to the
       positional arguments and the option it named was silently off, which presents as a run
       that waits for a condition it was never going to reach. */
    if (match === null) loose.push(arg);
    else flags.set(match[1], match[2] ?? '1');
  }
  const size = (flags.get('size') ?? '1280x720').split('x').map(Number);
  const region = flags.get('region')?.split(',').map(Number);
  return {
    command: loose[0] ?? 'help',
    labels: loose.slice(1),
    base: flags.get('base') ?? 'http://localhost:5173',
    width: size[0] ?? 1280,
    height: size[1] ?? 720,
    query: flags.get('query') ?? '',
    /**
     * Which backend the page is told to use, or null to let it decide.
     *
     * Null rather than a default, because "whatever the browser chose" is a distinct and
     * useful capture from either backend named explicitly, and conflating them would hide
     * the case where selection itself is wrong.
     */
    backend: flags.get('backend') ?? null,
    out: flags.get('out') ?? 'shots',
    /*
     * A consumer's page is not `?scene=N`, so `--urls=name=path,name=path` is the general form
     * and `--scenes=` is the shorthand for this repository's own harness. Without the general
     * form every consumer writes a wrapper to do nothing but build URLs, which is most of what
     * the wrappers this replaced were.
     */
    urls:
      flags.get('urls') === undefined
        ? undefined
        : flags
            .get('urls')
            .split(',')
            .map((pair) => {
              const at = pair.indexOf('=');
              return at === -1
                ? { name: pair, path: pair }
                : { name: pair.slice(0, at), path: pair.slice(at + 1) };
            }),
    ready: flags.get('ready'),
    /* When the injected clock takes over. A game is ready long after its page is. */
    start: flags.get('start'),
    hold: flags.get('hold') === undefined ? 420 : Number(flags.get('hold')),
    /* Freeze the page from outside rather than asking it to freeze itself. */
    inject: flags.get('inject') === '1',
    scenes:
      flags.get('scenes') === undefined
        ? DEFAULT_SCENES.map((name, index) => ({ index, name }))
        : flags
            .get('scenes')
            .split(',')
            .map((value) => ({
              index: Number(value),
              name: DEFAULT_SCENES[Number(value)] ?? `scene${value}`,
            })),
    region:
      region === undefined
        ? undefined
        : { x0: region[0], y0: region[1], x1: region[2], y1: region[3] },
    speckle: flags.get('speckle') !== undefined,
    /*
     * The luminance delta a pixel has to exceed before `diff` counts it as changed.
     *
     * **The default of 1 counts a difference nobody can see, and every parity figure in the
     * ledger is read at 16.** Two backends rasterising the same edge disagree by a unit or two
     * across every silhouette in the frame, so an indistinguishable pair scored 38% wrong and
     * the number had to be recomputed by hand. Two sessions each wrote a throwaway script to
     * do it; this flag is so there is not a third.
     */
    delta: flags.get('delta') === undefined ? undefined : Number(flags.get('delta')),
  };
}

/**
 * The condition a capture waits on, evaluated in the page.
 *
 * The held-frame badge alone is not enough: a scene that streams a model reaches its frame count
 * long before the model is on screen, because the hold advances the clock a frame per turn of the
 * task queue and a fetch resolves on the same queue. So this waits for the badge *and* for the
 * harness to be reporting draws, and `settled` then leaves a further pause for the frames between
 * the two.
 */
/**
 * When a page that freezes itself has actually finished freezing.
 *
 * **`window.__heldFrame` and not the badge.** This read the badge's text, and the badge is added
 * the moment the hold is *asked for* — so the condition was true immediately and the screenshot
 * was taken after the 2.5-second settle at whatever frame the page had reached. The pump yields
 * to the task queue between frames, so a hold under roughly six hundred finished inside that
 * window by luck and anything larger did not: at `hold=2250` two backends photographed 11:20 and
 * 11:23 of `dayClock`'s ninety-second day, and the difference reads as a rendering fault.
 *
 * The injected clock in `heldClock.mjs` already signalled completion this way. Both do now, so
 * the two paths agree about what "held" means.
 */
const READY = (hold) =>
  `window.__heldFrame >= ${hold} &&` +
  `/[1-9]\\d* draws/.test(document.getElementById('stats')?.textContent ?? '')`;

async function capture(options) {
  const given = options.labels[0];
  if (given === undefined) throw new Error('capture needs a label: shots.mjs capture before');
  const label = captureLabel(given, options.backend);
  const query = withBackend(options.query, options.backend);
  mkdirSync(options.out, { recursive: true });

  /*
   * Either the page freezes itself, or it is frozen from outside. `--inject` is what a consumer
   * uses: a game has no `?hold=` and should not grow one, since a dev-only clock patch in an
   * entry point is harness code on the path to production.
   */
  const beforeLoad = options.inject
    ? heldClockScript(options.hold, { startWhen: options.start ?? 'true' })
    : undefined;
  const targets =
    options.urls ??
    options.scenes.map((scene) => ({
      name: scene.name,
      path: `/?scene=${scene.index}&hold=${options.hold}`,
    }));
  /*
   * Both conditions, and they answer different questions: the first is that the clock has
   * finished counting, the second is anything else the page has to be true for the picture to be
   * worth taking. A consumer usually needs both.
   */
  const ready = [options.inject ? 'window.__heldFrame > 0' : READY(options.hold), options.ready]
    .filter((part) => part !== undefined)
    .join(' && ');

  const browser = await launch();
  const client = await connect(browser.port);
  try {
    const asked = options.backend === null ? 'page default' : `?backend=${options.backend}`;
    console.log(`renderer: ${await requireHardwareGpu(client)} · ${asked} · label ${label}`);
    for (const target of targets) {
      const url = joinQuery(`${options.base}${target.path}`, query);
      const page = await client.page(url, options.width, options.height, { beforeLoad });
      try {
        await page.settled(ready, { settleMs: 2500 });
        const file = path.join(options.out, `${label}-${target.name}.png`);
        await page.screenshot(file);
        const stats = await page.eval(`document.getElementById('stats')?.textContent ?? ''`);
        console.log(`${target.name.padEnd(16)} ${stats}`);
        /* Said rather than swallowed. A warning during a capture is usually the answer to
           whatever the capture was taken to investigate. */
        for (const line of page.complaints()) {
          if (!/favicon|404/.test(line)) console.log(`   ${line}`);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    client.close();
    await browser.close();
  }
}

function diff(options) {
  const [one, two] = options.labels;
  if (one === undefined || two === undefined) {
    throw new Error('diff needs two labels: shots.mjs diff before after');
  }
  let worstChange = 0;
  const names = (options.urls ?? options.scenes).map((target) => target.name);
  for (const name of names) {
    const a = path.join(options.out, `${one}-${name}.png`);
    const b = path.join(options.out, `${two}-${name}.png`);
    if (!existsSync(a) || !existsSync(b)) {
      console.log(`${name}: missing a capture, skipped`);
      continue;
    }
    const first = readPng(a);
    const second = readPng(b);
    const result = compare(first, second, {
      region: options.region,
      ...(options.delta === undefined ? {} : { tolerance: options.delta }),
    });
    worstChange = Math.max(worstChange, result.changed);
    console.log(`\n${name}`);
    console.log(formatComparison(result));
    if (options.speckle) {
      for (const threshold of [12, 25]) {
        const before = speckle(first, { threshold, region: options.region });
        const after = speckle(second, { threshold, region: options.region });
        console.log(`  speckle > ${threshold}: ${before} to ${after}`);
      }
    }
  }
  /*
   * A last line that says the thing the run was for. An effect that defaults to off has one
   * claim to make and it is this one, so it is stated rather than left to be read off a table.
   */
  console.log(
    `\n${worstChange === 0 ? 'identical' : `worst scene changed ${worstChange} pixels`}` +
      (options.region === undefined
        ? ' (whole frame, including any readout drawn over it)'
        : ' inside the region'),
  );
}

/*
 * Only dispatch when run as a program. `shots.test.mjs` imports `parseArgs` and the two
 * label helpers, and an unguarded dispatch would print usage into the middle of the TAP
 * stream on every import.
 */
const runDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

const options = runDirectly ? parseArgs(process.argv.slice(2)) : { command: 'none' };
if (options.command === 'none') {
  /* imported, not run */
} else if (options.command === 'capture') await capture(options);
else if (options.command === 'diff') diff(options);
else {
  console.log(
    'usage:\n' +
      '  node scripts/shots.mjs capture <label> [--base= --scenes= --hold= --size= --query= --out= --backend=]\n' +
      '    --backend=webgl2|webgpu forces one path and puts it in the label, so a parity\n' +
      '    diff cannot silently compare a backend with itself.\n' +
      '  node scripts/shots.mjs diff <label> <label> [--scenes= --out= --region= --delta= --speckle]\n' +
      '    --delta=16 is the threshold every parity figure in the ledger is read at; the\n' +
      '    default of 1 counts differences nobody can see.\n\n' +
      'Against a page that is not this harness, name the URLs and how to freeze it:\n' +
      '  --urls=menu=/,world=/?day=7 --inject --start="window.yourGame !== undefined"\n\n' +
      'Restart the dev server between the two captures. Vite has served a cached transform of an\n' +
      'edited module here, and three before-and-after pairs were captured from one build.',
  );
}
