import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { summarise, groupFor, parseDeclarations, publishedPackages } from './docs-api.mjs';

/**
 * The leak control, and the reason this file is worth more than the generator.
 *
 * Comments in this repository are long by policy: they carry the measurement, the
 * rejected approach, and the bug that produced a constant. That is the design, and
 * while the engine is closed the design is exactly what does not ship. The
 * interface does. So a summary is the first paragraph and nothing after it, and
 * every way a comment can run on is a way that rule can fail quietly.
 */
test('a summary is the first paragraph and nothing after it', () => {
  const doc = [
    'Hold a frame budget by moving the drawing-buffer scale.',
    '',
    'This is the safety net the GPU-budget design asks for, measured at 17.5 ms.',
    'It must never reach a public page.',
  ].join('\n');
  assert.equal(summarise(doc), 'Hold a frame budget by moving the drawing-buffer scale.');
});

test('a paragraph wrapped over several lines is joined, not truncated', () => {
  const doc =
    'Release the drawing context and\neverything this renderer created on it.\n\nThe long reasoning.';
  assert.equal(
    summarise(doc),
    'Release the drawing context and everything this renderer created on it.',
  );
});

test('a one-paragraph comment survives whole', () => {
  assert.equal(
    summarise('Whether the keystroke belongs to a text field.'),
    'Whether the keystroke belongs to a text field.',
  );
});

test('an empty or missing comment is an empty summary, never a crash', () => {
  assert.equal(summarise(''), '');
  assert.equal(summarise(undefined), '');
  assert.equal(summarise('   \n\n  '), '');
});

/**
 * A blank first line is the shape that would defeat a naive "take until the first
 * blank" rule and ship the essay instead of the summary.
 */
test('leading blank lines do not hand back the second paragraph', () => {
  const doc = '\n\nThe short line.\n\nThe long reasoning that must not ship.';
  assert.equal(summarise(doc), 'The short line.');
});

test('an area comes from the source path, and the barrel itself is core', () => {
  assert.equal(groupFor('src/render/renderer.ts'), 'render');
  assert.equal(groupFor('src/physics/collide.ts'), 'physics');
  assert.equal(groupFor('src/audio/rhythm/beatMap.ts'), 'audio');
  assert.equal(groupFor('src/index.ts'), 'core');
  assert.equal(groupFor('/abs/path/engine/src/geometry/ribbon.ts'), 'geometry');
});

test('every package with a barrel is documented, and core comes first', () => {
  /*
   * **The assertion the reference did not have, and the reason it described a fraction of the
   * engine under a heading saying "everything a game can reach".** `buildApi` read
   * `packages/core/src/index.ts` and nothing else for as long as there had been more than one
   * package to read, and nothing failed: the symbol count it printed was a true count of what it
   * had looked at. Reading the directory rather than a list means a package added to the workspace
   * is documented by existing.
   */
  const packages = publishedPackages(path.resolve(import.meta.dirname, '..'));

  assert.equal(packages[0], 'core', 'core leads, because it is the surface that is always there');
  assert.ok(
    packages.length > 1,
    `only ${packages.length} package has a barrel, which cannot be right for this repository`,
  );
  for (const name of ['assets', 'audio', 'drft', 'splats']) {
    assert.ok(packages.includes(name), `${name} publishes a barrel and is not in the reference`);
  }
  assert.equal(new Set(packages).size, packages.length, 'no package listed twice');
});

/**
 * An interface and a type alias are declarations, and `tsc` emits them without `declare`.
 *
 * **The scanner required `export declare ` and so could never match either**, which made two of
 * the nine keywords in its own alternation dead branches — and `parseDeclarations` documents the
 * interface case in as many words: *"For an interface or a class that yields the head alone."* It
 * yielded the head of a class and nothing at all for an interface.
 *
 * `declare` marks something that exists at run time and has no body here. An interface and a type
 * alias are erased, so there is nothing to declare and TypeScript emits `export interface X` and
 * `export type Y` bare, against `export declare class Z` beside them. Confirmed by emitting this
 * repository's own declarations and reading them rather than by reasoning about the emitter.
 *
 * What it cost is a public surface documented at values only. `Camera`, `CharacterController` and
 * `DebugLines` were in the published reference; `RendererApi`, `Vec3`, `SurfaceMaterial`,
 * `ControllerOptions`, `MeshHandle`, `GroundProbe`, `ShadowCasters` and `ShadowCasterSink` were
 * not — so a consumer looking up the interface they are being asked to implement found no entry
 * for it. That is what made 3.48.1's missing export hard to notice from the outside: the name was
 * absent from the reference either way.
 */
test('an interface and a type alias are found, not only the things with `declare`', () => {
  const source = [
    '/** What a shadow-caster enumeration may hand to a depth pass. */',
    'export interface ShadowCasterSink {',
    '    mesh(mesh: MeshHandle, model: ReadonlyMat4): void;',
    '}',
    '/** The material a caster draw may carry. */',
    'export type SceneCasterMaterial = SurfaceMaterial<SurfaceTextureHandle> | null;',
    '/** Segments a physics world can be drawn as. */',
    'export declare class DebugLines {',
    '    clear(): void;',
    '}',
    '/** A budget line. */',
    'export declare const MAX_DRAWS_PER_FRAME: number;',
  ].join('\n');

  const found = parseDeclarations(source);
  assert.deepEqual(
    [...found.keys()].sort(),
    ['DebugLines', 'MAX_DRAWS_PER_FRAME', 'SceneCasterMaterial', 'ShadowCasterSink'],
    'every top-level export is a declaration, whether or not it survives to run time',
  );

  assert.equal(found.get('ShadowCasterSink').kind, 'interface');
  assert.equal(found.get('SceneCasterMaterial').kind, 'type');
  assert.equal(
    found.get('ShadowCasterSink').signature,
    'interface ShadowCasterSink',
    'the head alone, which is what the reference lists',
  );
  assert.equal(
    found.get('SceneCasterMaterial').signature,
    'type SceneCasterMaterial = SurfaceMaterial<SurfaceTextureHandle> | null',
  );
  assert.equal(found.get('SceneCasterMaterial').summary, 'The material a caster draw may carry.');
});

/** A re-export block is not a declaration, which making `declare` optional must not change. */
test('a re-export block is still not mistaken for a declaration', () => {
  const source = [
    "export type { ShadowCasterSink, ShadowCasters } from './render/shadowCasters';",
    "export { DebugLines } from './render/debugLines';",
  ].join('\n');
  assert.deepEqual([...parseDeclarations(source).keys()], []);
});
