/**
 * Every sampler GLSL ES 3.00 gives no default precision to declares one.
 *
 * **Written after a `sampler3D` shipped without one and compiled on exactly one backend.** The
 * colour grade's lookup table was declared `uniform sampler3D uGradeLut;`, which is what every
 * other sampler in this corpus looks like — and WebGL2 answered
 * `ERROR: 0:140: 'sampler3D' : No precision specified`, while the generated WGSL was correct the
 * whole time. It compiled, generated, validated, and failed at runtime on **the backend with
 * nothing beneath it**.
 *
 * **The rule is a fact about the language rather than about a driver.** ES 3.00 §4.5.4 gives
 * default precisions for `sampler2D` and `samplerCube` and for **nothing else**, so `sampler3D`,
 * `sampler2DArray`, `sampler2DShadow` and every integer sampler must say. This corpus happened to
 * use only the two that have defaults until now, which is why the trap had never been sprung and
 * why nothing was watching for it.
 *
 * **The same shape as `unpackUnorm4x8` in the splat shader**, recorded there: a 3.10 builtin that
 * passes generation because `scripts/wgsl.ts` raises the version before handing the source to
 * glslang. In both, the generator is a *weaker* check than the browser, and only somebody driving
 * the page can tell.
 *
 * Here rather than beside the shaders because it is a fact about the *repository* — it walks the
 * corpus — which is what `scripts/*.test.mjs` is for, and because `src/` is typechecked without
 * Node's types and may not read a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SHADERS = path.resolve(
  import.meta.dirname,
  '..',
  'packages',
  'core',
  'src',
  'render',
  'shaders',
);

/**
 * Sampler types with no default precision in either stage.
 *
 * `sampler2D` and `samplerCube` are deliberately absent: they have defaults, and demanding a
 * qualifier on them would fail the whole corpus for no reason. Adding a type here is how one new
 * to this engine gets covered before it is used rather than after it fails on a device.
 */
const NEEDS_PRECISION = [
  'sampler3D',
  'sampler2DArray',
  'sampler2DShadow',
  'isampler2D',
  'isampler3D',
  'isampler2DArray',
  'usampler2D',
  'usampler3D',
  'usampler2DArray',
];

/** Every hand-authored shader module: `shaders/` recursively, minus the generated tree and tests. */
function shaderSources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === '__snapshots__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) shaderSources(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function declarations() {
  const found = [];
  for (const file of shaderSources(SHADERS)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const type of NEEDS_PRECISION) {
          const declared = new RegExp(`\\buniform\\s+(\\w+\\s+)?${type}\\b`).exec(line);
          if (declared === null) continue;
          found.push({
            where: `${path.basename(file)}:${index + 1}`,
            line: line.trim(),
            qualifier: declared[1]?.trim() ?? '',
          });
        }
      });
  }
  return found;
}

test('every sampler with no default precision declares one', () => {
  const offenders = declarations()
    .filter((d) => !['highp', 'mediump', 'lowp'].includes(d.qualifier))
    .map((d) => `${d.where}: ${d.line}`);
  assert.deepEqual(
    offenders,
    [],
    `a sampler with no default precision and none declared:\n${offenders.join('\n')}`,
  );
});

/**
 * And the corpus genuinely contains some, so the guard above is not vacuous.
 *
 * A test that passes because it found nothing to check is a test that would go on passing through
 * the change it exists to catch — which is the shape this repository has recorded several
 * sentinels failing in.
 */
test('the corpus has samplers for that rule to be about', () => {
  assert.ok(declarations().length > 0, 'no sampler needing an explicit precision was found at all');
});
