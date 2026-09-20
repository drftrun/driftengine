import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SCENES,
  GPU_DRIVEN_ONLY,
  captureLabel,
  capturable,
  joinQuery,
  parseArgs,
  withBackend,
} from './shots.mjs';

/*
 * The backend has to reach the page and the label, and those are two separate failures.
 *
 * From Task 8 onward every WebGPU change is gated on a pixel diff against WebGL2, so a
 * harness that cannot tell the two apart turns the whole of that phase into eyeballing.
 */

test('a backend reaches the page as a query parameter', () => {
  assert.equal(parseArgs(['capture', 'after', '--backend=webgpu']).backend, 'webgpu');
  assert.equal(parseArgs(['capture', 'after']).backend, null);
});

/*
 * The label carries the backend or two captures overwrite each other, and a diff of one
 * backend against itself is a diff that always passes. That is the failure this whole flag
 * exists to prevent, so it is the one asserted.
 */
test('the backend is part of the capture label', () => {
  assert.equal(captureLabel('after', 'webgpu'), 'after-webgpu');
  assert.equal(captureLabel('after', 'webgl2'), 'after-webgl2');
  assert.equal(captureLabel('after', null), 'after');
});

/*
 * `?backend=` is what `forcedBackend` in the engine reads, so the parameter has to survive
 * being joined to a query the caller may already have supplied.
 */
test('the backend joins a query string that is empty', () => {
  assert.equal(withBackend('', 'webgpu'), '?backend=webgpu');
});

test('the backend joins a query string that already has parameters', () => {
  assert.equal(withBackend('?day=7', 'webgpu'), '?day=7&backend=webgpu');
});

test('a capture with no backend leaves the query untouched', () => {
  assert.equal(withBackend('?day=7', null), '?day=7');
  assert.equal(withBackend('', null), '');
});

/*
 * The engine's scene paths already carry a query, so a second `?` produces a URL whose
 * parameters are all ignored. That failed as a timeout waiting for a frame that never held,
 * which is indistinguishable from a renderer that cannot draw — the worst way to learn it.
 */
test('a query joins a path that already has one', () => {
  assert.equal(
    joinQuery('http://host/?scene=0&hold=420', '?backend=webgpu'),
    'http://host/?scene=0&hold=420&backend=webgpu',
  );
});

test('a query joins a path that has none', () => {
  assert.equal(joinQuery('http://host/', '?backend=webgpu'), 'http://host/?backend=webgpu');
});

/*
 * **And the `?` is the caller's habit rather than the format**, which is the half this pair
 * missed. `--query=samples=1` reads exactly like `--query=?samples=1` to anybody typing it, and
 * the usage text asks for neither spelling; joined without a separator it produced
 * `hold=420samples=1`, so `Number('420samples=1')` was `NaN`, the held frame never arrived and
 * the capture waited two minutes and wrote no file. A sweep of five knobs was run that way and
 * every one of them came back as a missing PNG.
 */
test('a query with no leading question mark still joins with a separator', () => {
  assert.equal(
    joinQuery('http://host/?scene=0&hold=420', 'samples=1'),
    'http://host/?scene=0&hold=420&samples=1',
  );
});

test('an empty query leaves the url alone', () => {
  assert.equal(joinQuery('http://host/?scene=0', ''), 'http://host/?scene=0');
});

/**
 * The scene list here is `demo/index.ts`'s, in its order.
 *
 * **It went one out of step and nothing noticed for as long as the sandbox has existed.**
 * `voxelSandbox` was put at the front of `SCENES` and not here, so every index below it named the
 * scene before it: a capture written to disk as `storm-sea` was a picture of the wind field, and
 * `--scenes=4` selected a different scene from the one its own label named. A before-and-after
 * diff still compared like with like, because it compares one index against the same index, which
 * is exactly why it stayed invisible — the failure is in what the pictures are *called*, and a
 * person reading a filename is the only thing that could have caught it.
 *
 * Read out of the source as text rather than imported, because this is a `.mjs` test and that is a
 * TypeScript module: Node will not strip types under `node_modules`, which is the same constraint
 * `capabilities.json` exists for. The regex is deliberately narrow — a bare identifier on its own
 * line inside the `SCENES` array — and the count is asserted first, so a list that stops matching
 * that shape fails loudly instead of quietly matching nothing.
 */
test('the scene list agrees with the order demo/index.ts publishes', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('../demo/index.ts', import.meta.url)), 'utf8');

  const block = /export const SCENES: readonly DemoScene\[\] = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'demo/index.ts must declare SCENES as an array literal');

  /* A bare identifier on its own line: the entries, not the comments that outnumber them. */
  const names = [...block[1].matchAll(/^\s{2}([a-z][A-Za-z0-9]*),$/gm)].map((m) => m[1]);
  assert.ok(
    names.length >= 7,
    `found ${names.length} scene entries, which is too few to be the list`,
  );

  const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  assert.deepEqual(
    DEFAULT_SCENES,
    names.map(kebab),
    'scripts/shots.mjs names the scenes in a different order from demo/index.ts',
  );
});

/*
 * **A published scene one backend cannot draw.** The city is drawn by the GPU-driven pipeline
 * alone and refuses to mount on WebGL2, as it should; a capture of the published corpus on WebGL2
 * then waited for draws that never came and threw at the end of the run. So the scenes that need
 * the second pipeline are named here, said and skipped on WebGL2 rather than waited on.
 */
test('ON WEBGL2 A CAPTURE SKIPS THE SCENES THE SECOND PIPELINE ALONE DRAWS, and says so', () => {
  const targets = DEFAULT_SCENES.map((name, index) => ({ name, path: `/?scene=${index}` }));
  const onWebgl2 = capturable(targets, 'webgl2');
  assert.deepEqual(
    onWebgl2.skipped.map((target) => target.name),
    GPU_DRIVEN_ONLY,
  );
  assert.equal(onWebgl2.kept.length, DEFAULT_SCENES.length - GPU_DRIVEN_ONLY.length);
  for (const backend of ['webgpu', null]) {
    const all = capturable(targets, backend);
    assert.equal(all.kept.length, DEFAULT_SCENES.length);
    assert.deepEqual(all.skipped, []);
  }
});

test('THE SCENES IT SKIPS ARE THE ONES WHOSE MODULES SAY THEY NEED THE SECOND PIPELINE', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../demo/', import.meta.url));
  const needing = [];
  for (const file of readdirSync(dir).filter((name) => /^[a-zA-Z]+\.ts$/.test(name))) {
    const source = readFileSync(`${dir}${file}`, 'utf8');
    const declared = /\n {2}pipelines: \[([^\]]*)\]/.exec(source);
    const id = /\n {2}id: '([a-z][a-z0-9-]*)'/.exec(source);
    if (declared === null || id === null) continue;
    if (!declared[1].includes("'forward'")) needing.push(id[1]);
  }
  assert.ok(needing.length > 0, 'no scene declares its pipelines; this test has gone stale');
  assert.deepEqual(needing.sort(), [...GPU_DRIVEN_ONLY].sort());
});
