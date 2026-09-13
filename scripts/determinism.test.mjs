/**
 * The simulation may only use arithmetic every JavaScript engine rounds identically.
 *
 * The unit tests come first and are not ceremony: a scanner whose regex is broken passes this file
 * silently, which is the test that cannot fail. They are the perturbation, written down.
 *
 * ---
 *
 * ## This walked one package until 2026-09-03, and three documents described it as engine-wide
 *
 * The gate was written for Track B and scanned `packages/physics/src`. Physics has complied ever
 * since, visibly — `joints.ts` writes its angular limits as sines of half angles and says
 * *"`Math.acos` and `Math.atan2` are both on the banned list"*, `shape.ts` takes every length as
 * `Math.sqrt` of a sum of squares, and `ragdoll.ts` spells its defaults as literals rather than
 * `Math.cos(Math.PI / 4)`. Chemistry adopted the same discipline by hand, with §7 of its design
 * keeping transcendentals off the tick and a comment at each site saying so.
 *
 * **Nothing outside physics was checked, and Track J found what that cost.** Running this scanner
 * over every package on 2026-09-03 turned up twenty unexempted calls where the simulation reaches
 * one, and two of them were live defects rather than tidiness:
 *
 * - `packages/script/src/bindings/terrain.ts` returned a slope angle from `Math.acos` **to a
 *   script**. `drift/terrain` ships under `physics.read`, which is inside the language's
 *   `DETERMINISTIC_EFFECTS`, so a `@deterministic` system asking a hillside how steep it was
 *   received an engine-dependent number and the annotation promising reproducibility was a lie.
 * - `packages/terrain/src/heightfield.ts` computed a surface normal with `Math.hypot`, breaking the
 *   rule physics documents at five separate sites, in a query a consumer may call every tick.
 *
 * ## The scope is declared with a reason per entry, and so are the exclusions
 *
 * A scope that is "the packages somebody remembered" drifts, which is how this ended up describing
 * one package for a month. Every root below says why it is in, and the paragraph after the list says
 * why the big remainder of core is out — because an ulp in a spline or a sun angle changes a pixel,
 * and a pixel is not simulation state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { violations } from './determinism.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The roots whose output feeds a tick, each with the reason it is one.
 *
 * **What is deliberately absent, and why.** `packages/core/src/render`, `geometry`, `environment`
 * and `dev` compute what a frame looks like: 92, 57, 21 and 1 calls between them on 2026-09-03, and
 * every one of them is correct, because an ulp of difference in a spline, a sun angle or a debug
 * probe changes a pixel and a pixel is not simulation state. `packages/core/src/input` is outside
 * the boundary by the language's own classification — `hovered` and `pressed` are `input.read` and
 * pointedly not `scene.read` — so a `@deterministic` system cannot read it in the first place.
 * `audio`, `assets`, `splats`, `ui2d`, `media`, `editor`, `drft` and `package` are presentation,
 * import, tooling or authoring.
 *
 * **`packages/core/src/physics` is in, and `ribbonSurface.ts` is the case that made this a walk
 * rather than a list**: it is a spline surface that legitimately uses trigonometry and stayed in
 * core when the collision kernel was extracted. It carries a marker with its reason, which is what
 * the marker is for.
 */
const SIMULATION_ROOTS = [
  ['packages/entities/src', "component storage; a tick's state lives here"],
  ['packages/physics/src', "the collision kernel; this gate's original and only scope"],
  ['packages/ai/src', 'the deterministic policy floor, which runs inside the step'],
  ['packages/terrain/src', 'heights and slopes a tick reads'],
  ['packages/chemistry/src', 'a tick integrates enthalpy'],
  ['packages/network/src', 'rewind and replay; exact or it is nothing'],
  ['packages/script/src', 'capability bindings, which is where a script reaches the engine'],
  ['packages/core/src/core', 'the loop, the seeded generator, the tick trace'],
  ['packages/core/src/math', 'vectors, quaternions, intersection'],
  ['packages/core/src/nav', 'graph search and path following'],
  ['packages/core/src/scene', 'node transforms; a world matrix feeds a query'],
  ['packages/core/src/physics', 'height and ribbon surfaces'],
  ['packages/core/src/behavior', 'behaviour trees run in the step'],
];

function simulationFiles() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
      return [path.relative(ROOT, full)];
    });
  return SIMULATION_ROOTS.flatMap(([root]) => walk(path.join(ROOT, root))).sort();
}

test('the scanner finds a banned call', () => {
  assert.deepEqual(violations('const d = Math.hypot(x, y);'), [{ line: 1, fn: 'hypot' }]);
});

test('the scanner finds every name on the list', () => {
  for (const fn of ['sin', 'cos', 'atan2', 'pow', 'random', 'log2', 'cbrt']) {
    assert.equal(violations(`Math.${fn}(1)`).length, 1, `${fn} was not caught`);
  }
});

test('the scanner allows the exactly-rounded operations', () => {
  assert.deepEqual(violations('const d = Math.sqrt(x * x + y * y);'), []);
  assert.deepEqual(violations('const d = Math.abs(a) + Math.min(b, c) / Math.max(d, e);'), []);
});

test('a name inside a comment is prose, not a call', () => {
  assert.deepEqual(violations('// Math.hypot(x, y) would not be reproducible.'), []);
  assert.deepEqual(violations('/**\n * Math.hypot is banned here.\n */\nconst d = 1;'), []);
});

test('line numbers survive comment removal', () => {
  const source = '/*\n * a block comment\n */\nconst d = Math.pow(x, 2);';
  assert.deepEqual(violations(source), [{ line: 4, fn: 'pow' }]);
});

test('the marker exempts the next line and requires a reason', () => {
  const withReason = '// determinism: build-time — never reaches a tick\nconst d = Math.pow(x, 2);';
  assert.deepEqual(violations(withReason), []);
  const bare = '// determinism: build-time —\nconst d = Math.pow(x, 2);';
  assert.equal(violations(bare).length, 1, 'a marker with no reason must not exempt');
});

test('the marker exempts one line, not the file', () => {
  const source =
    '// determinism: build-time — first only\n' +
    'const a = Math.pow(x, 2);\n' +
    'const b = Math.pow(y, 2);';
  assert.deepEqual(violations(source), [{ line: 3, fn: 'pow' }]);
});

test('the simulation uses only arithmetic every engine rounds identically', () => {
  const offences = [];
  for (const file of simulationFiles()) {
    for (const { line, fn } of violations(readFileSync(path.join(ROOT, file), 'utf8'))) {
      offences.push(`${file}:${line} calls Math.${fn}`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    'ECMAScript does not specify these precisely, so two engines may differ by an ulp:\n  ' +
      offences.join('\n  '),
  );
});

/** Every declared root exists, so a rename cannot silently empty the scope. */
test('every simulation root is a directory that exists', () => {
  const missing = SIMULATION_ROOTS.filter(([root]) => !existsSync(path.join(ROOT, root)));
  assert.deepEqual(
    missing.map(([root]) => root),
    [],
    'a root that no longer exists scans nothing and fails nothing',
  );
});

/** And the scope really is wider than the one package it used to be. */
test('the scope covers more than the collision kernel', () => {
  assert.ok(SIMULATION_ROOTS.length >= 13, `${SIMULATION_ROOTS.length} roots`);
  const files = simulationFiles();
  /* 170 on 2026-09-03, against the 40 the collision kernel alone contributed. A floor rather than
     an equality, because a file added to a scanned package should not fail this. */
  assert.ok(files.length > 120, `${files.length} files scanned`);
  assert.ok(
    files.some((file) => file.startsWith('packages/core/src/nav')),
    'navigation is in the simulation set',
  );
});
