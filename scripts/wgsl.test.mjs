import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { compileToWgsl, hasNaga } from './wgsl/compile.mjs';
import { stageOf } from './wgsl/stage.mjs';
import {
  hoistDefines,
  hoistUniformBlock,
  mapLocations,
  raiseVersion,
  renameBuiltins,
  requestSamplerlessExtension,
  separateSamplers,
  transform,
} from './wgsl/transform.mjs';

/*
 * The transform layer, one test per rule, each named for the compiler error it answers.
 *
 * These are the rules that get GLSL ES 3.00 into SPIR-V, and every one of them exists
 * because glslang refused the corpus without it. The errors are quoted in the test names
 * so that a future reader can tell a rule that is load-bearing from a rule that is taste:
 * delete any of these and a real shader stops compiling. The evidence is in
 * the WGSL toolchain design.
 */

test('raiseVersion: "ES shaders for SPIR-V require version 310 or higher"', () => {
  assert.equal(raiseVersion('#version 300 es\nvoid main() {}'), '#version 310 es\nvoid main() {}');
});

test('raiseVersion leaves a shader that is already 310 alone', () => {
  assert.equal(raiseVersion('#version 310 es\n'), '#version 310 es\n');
});

test('renameBuiltins: "\'gl_VertexID\' : undeclared identifier (Did you mean gl_VertexIndex?)"', () => {
  assert.equal(renameBuiltins('int i = gl_VertexID;'), 'int i = gl_VertexIndex;');
  assert.equal(renameBuiltins('int i = gl_InstanceID;'), 'int i = gl_InstanceIndex;');
});

test('mapLocations: "SPIR-V requires location for user input/output"', () => {
  const out = mapLocations('#version 310 es\nin vec2 vUv;\nin float vSeed;\nout vec4 outColor;\n');
  assert.match(out, /layout\(location=0\) in vec2 vUv;/);
  assert.match(out, /layout\(location=1\) in float vSeed;/);
  /* Inputs and outputs number independently, because they are separate location spaces. */
  assert.match(out, /layout\(location=0\) out vec4 outColor;/);
});

test('mapLocations does not renumber a location the source already pinned', () => {
  const out = mapLocations('#version 310 es\nlayout(location=3) in vec2 vUv;\n');
  assert.match(out, /layout\(location=3\) in vec2 vUv;/);
  assert.doesNotMatch(out, /location=0/);
});

test('hoistUniformBlock: "non-opaque uniforms outside a block"', () => {
  const { source } = hoistUniformBlock(
    '#version 310 es\nprecision highp float;\nuniform mat4 uViewProj;\nuniform float uTime;\n',
  );
  assert.match(source, /layout\(binding=0\) uniform Uniforms \{/);
  assert.match(source, /mat4 uViewProj;/);
  assert.match(source, /float uTime;/);
  /* Anonymous, so members stay in global scope and no reference in the body is rewritten. */
  assert.match(source, /\};/);
  assert.doesNotMatch(source, /\} u;/);
});

test('hoistUniformBlock leaves opaque samplers outside the block, where they are legal', () => {
  const { source } = hoistUniformBlock(
    '#version 310 es\nprecision highp float;\nuniform sampler2D uAlbedo;\nuniform float uTime;\n',
  );
  assert.match(source, /uniform (highp )?sampler2D uAlbedo;/);
  assert.doesNotMatch(source, /Uniforms \{[\s\S]*sampler2D/);
});

test('hoistUniformBlock reports the binding it assigned, because the renderer needs it', () => {
  const { bindings } = hoistUniformBlock(
    '#version 310 es\nprecision highp float;\nuniform float uTime;\n',
  );
  assert.equal(bindings.uniforms, 0);
});

test('hoistUniformBlock reports no binding when a shader has no loose uniforms to hoist', () => {
  const { bindings } = hoistUniformBlock(
    '#version 310 es\nprecision highp float;\nvoid main() {}\n',
  );
  assert.equal(bindings.uniforms, null);
});

/*
 * The only rule here whose error came from a device rather than a compiler on this machine.
 * WebKit refuses a uniform array that strides by less than sixteen and Dawn does not, so this
 * one shipped in 1.0.0 and rendered a black screen on every iPhone until somebody looked.
 */
test('padNarrowArrays: "arrays in the uniform address space must have a stride multiple of 16 bytes"', () => {
  const { source, bindings } = hoistUniformBlock(
    '#version 310 es\nprecision highp float;\n' +
      'uniform float uLightRadius[4];\nuniform int uShadowIndex[4];\n' +
      'void main() { float r = uLightRadius[i]; int s = uShadowIndex[0]; }\n',
  );
  assert.match(source, /vec4 uLightRadius\[4\];/);
  assert.match(source, /ivec4 uShadowIndex\[4\];/);
  /* Every read goes through a component, or the body would be reading a vector as a scalar. */
  assert.match(source, /float r = uLightRadius\[i\]\.x;/);
  assert.match(source, /int s = uShadowIndex\[0\]\.x;/);
  /* And the CPU side is told the same sixteen, which is the half that used to disagree. */
  assert.equal(bindings.fields['uLightRadius'].stride, 16);
});

test('padNarrowArrays widens a vec2 array too, keeping both of its components', () => {
  const { source } = hoistUniformBlock(
    '#version 310 es\nuniform vec2 uScroll[2];\nvoid main() { vec2 s = uScroll[k]; }\n',
  );
  assert.match(source, /vec4 uScroll\[2\];/);
  assert.match(source, /vec2 s = uScroll\[k\]\.xy;/);
});

/* A `vec3` already strides by sixteen, so widening it would only waste a quarter of the block. */
test('padNarrowArrays leaves an array that already satisfies the rule alone', () => {
  const { source } = hoistUniformBlock(
    '#version 310 es\nuniform vec3 uLightPos[4];\nvoid main() { vec3 p = uLightPos[i]; }\n',
  );
  assert.match(source, /vec3 uLightPos\[4\];/);
  assert.match(source, /vec3 p = uLightPos\[i\];/);
});

/*
 * A subscript inside a subscript is why the brackets are matched rather than caught by a regex
 * for the next `]`, which would put the component in the middle of the expression.
 */
test('padNarrowArrays matches brackets, so a nested subscript lands the component at the end', () => {
  const { source } = hoistUniformBlock(
    '#version 310 es\nuniform float uWeight[4];\nvoid main() { float w = uWeight[order[i]]; }\n',
  );
  assert.match(source, /float w = uWeight\[order\[i\]\]\.x;/);
});

test('hoistDefines: "\'MAX_LIGHTS\' : undeclared identifier"', () => {
  /* The define sits below the first uniform, which is exactly flat's shape. */
  const input =
    '#version 310 es\nprecision highp float;\nuniform float uTime;\n#define MAX_LIGHTS 8\nuniform vec3 uLightPos[MAX_LIGHTS];\n';
  const out = hoistDefines(input);
  assert.ok(
    out.indexOf('#define MAX_LIGHTS') < out.indexOf('uniform float uTime'),
    'the define has to precede the uniform that will be hoisted into a block above it',
  );
});

test('separateSamplers: WGSL has no combined image sampler, so neither may the input', () => {
  const { source } = separateSamplers(
    'uniform sampler2D uAlbedo;\nvoid main() { outColor = texture(uAlbedo, vUv); }',
  );
  assert.match(source, /uniform highp texture2D uAlbedo_t;/);
  assert.match(source, /uniform highp sampler uAlbedo_s;/);
  assert.match(source, /texture\(sampler2D\(uAlbedo_t, uAlbedo_s\), vUv\)/);
});

test('separateSamplers leaves texelFetch taking the texture alone, as WGSL does', () => {
  const { source } = separateSamplers(
    'uniform sampler2D uMap;\nvoid main() { v = texelFetch(uMap, p, 0); }',
  );
  assert.match(source, /texelFetch\(uMap_t, p, 0\)/);
});

/*
 * A device's sampler ceiling is per shader stage, this project's adapter offers exactly
 * sixteen, and the widest permutation of `flat` declared seventeen — so the environment probe
 * stood down on hardware that could have mirrored the room. The fifteen shadow bindings were
 * already one object on both sides, so declaring them once costs nothing and frees the room.
 */
test('separateSamplers gives a marked group one sampler and leaves the rest alone', () => {
  const input = [
    'uniform sampler2D uAlbedo;',
    'uniform highp sampler2D uStaticShadowMap;  // wgsl:share shadow',
    'uniform highp samplerCube uPointShadow0;  // wgsl:share shadow',
    'uniform highp samplerCube uEnvironment;',
    'void main() { a = texture(uAlbedo, v) + texture(uStaticShadowMap, v)' +
      ' + texture(uPointShadow0, d) + texture(uEnvironment, d); }',
  ].join('\n');
  const { source, bindings } = separateSamplers(input, 32);

  /* One declaration for the group, and both members construct against it. */
  assert.equal((source.match(/uniform highp sampler uShared_shadow_s;/g) ?? []).length, 1);
  assert.match(source, /texture\(sampler2D\(uStaticShadowMap_t, uShared_shadow_s\), v\)/);
  assert.match(source, /texture\(samplerCube\(uPointShadow0_t, uShared_shadow_s\), d\)/);
  assert.equal(
    bindings.textures.uStaticShadowMap.sampler,
    bindings.textures.uPointShadow0.sampler,
    'both members must report the one binding, since that is what the layout declares',
  );

  /*
   * And the two that were not marked keep their own. `uEnvironment` is the reason the marker
   * is on the declaration rather than matched on a name: it is a colour cube whose mip chain
   * is its roughness, so it needs a filtering sampler and cannot share a non-filtering one.
   */
  assert.match(source, /uniform highp sampler uAlbedo_s;/);
  assert.match(source, /uniform highp sampler uEnvironment_s;/);
  assert.notEqual(bindings.textures.uEnvironment.sampler, bindings.textures.uPointShadow0.sampler);
  assert.notEqual(bindings.textures.uAlbedo.sampler, bindings.textures.uPointShadow0.sampler);

  /* Four textures and three samplers, which is the whole point of the exercise. */
  const samplers = new Set(Object.values(bindings.textures).map((t) => t.sampler));
  assert.equal(Object.keys(bindings.textures).length, 4);
  assert.equal(samplers.size, 3);
});

/*
 * The case that costs a whole extra rule: Vulkan GLSL answers a constructed sampler passed
 * as a call argument with "sampler constructor must appear at point of use", so the split
 * has to reach through the signature. Exactly one function in this corpus takes one.
 */
test('requestSamplerlessExtension: "\'texelFetch\' : required extension not requested: GL_EXT_samplerless_texture_functions"', () => {
  /*
   * A consequence of splitting the combined sampler, not of anything the author wrote: in ES 3.00
   * `texelFetch` takes a `sampler2D` and needs nothing, and after the split it takes a bare
   * texture, which is what this extension governs.
   */
  const out = requestSamplerlessExtension(
    '#version 310 es\nvoid main() { v = texelFetch(uMap_t, p, 0); }',
  );
  assert.match(
    out,
    /^#version 310 es\n#extension GL_EXT_samplerless_texture_functions : require\n/,
  );
});

test('requestSamplerlessExtension leaves a shader with no samplerless fetch alone', () => {
  /* A line claiming a dependency the shader does not have is one a later reader deletes. */
  const plain = '#version 310 es\nvoid main() { v = texture(sampler2D(uMap_t, uMap_s), uv); }';
  assert.equal(requestSamplerlessExtension(plain), plain);
});

test('requestSamplerlessExtension requests it once, not once per fetch', () => {
  const twice = requestSamplerlessExtension(
    requestSamplerlessExtension('#version 310 es\nvoid main() { v = texelFetch(uMap_t, p, 0); }'),
  );
  assert.equal(twice.match(/GL_EXT_samplerless_texture_functions/g)?.length, 1);
});

test('separateSamplers splits an integer sampler, which the froxel table is read through', () => {
  /*
   * `usampler2D` contains `sampler2D` one character in, so a table without it does not merely
   * skip the declaration — a scan that fails at the `u` advances and matches the tail, and the
   * split comes out named after a type the texture does not have. This asserts the whole name is
   * consumed and that the texture type is the unsigned one.
   */
  const { source, bindings } = separateSamplers(
    'uniform highp usampler2D uClusterTable;\nvoid main() { uvec4 v = texelFetch(uClusterTable, p, 0); }',
  );
  assert.match(source, /uniform highp utexture2D uClusterTable_t;/);
  assert.match(source, /texelFetch\(uClusterTable_t,/);
  assert.equal(bindings.textures.uClusterTable.type, 'usampler2D');
  /* No `usampler2D(` constructor anywhere: an integer texture is never filtered. */
  assert.ok(!source.includes('usampler2D('));
});

test('separateSamplers lets an integer texture share a sampler it never uses', () => {
  /*
   * The froxel table is only ever `texelFetch`ed, so the sampler its declaration would otherwise
   * bring is dead weight against a per-stage ceiling this project's adapter sets at sixteen. It
   * joins an existing group instead, which is the same mechanism the fifteen shadow bindings use.
   */
  const input = [
    'uniform highp sampler2D uStaticShadowMap;  // wgsl:share shadow',
    'uniform highp usampler2D uClusterTable;  // wgsl:share shadow',
  ].join('\n');
  const { source, bindings } = separateSamplers(input, 32);
  assert.equal(bindings.textures.uClusterTable.sampler, bindings.textures.uStaticShadowMap.sampler);
  /* One shared sampler declared, and no second one for the table. */
  assert.equal(source.match(/uniform highp sampler /g)?.length, 1);
});

test('separateSamplers splits a function parameter of sampler type into two', () => {
  const input = [
    'uniform highp samplerCube uPointShadow0;',
    'float pointShadow(highp samplerCube map, vec3 dir) { return texture(map, dir).r; }',
    'void main() { o = pointShadow(uPointShadow0, d); }',
  ].join('\n');
  const { source } = separateSamplers(input);
  assert.match(
    source,
    /float pointShadow\(highp textureCube map_t, highp sampler map_s, vec3 dir\)/,
  );
  /* Inside the body the constructor is at the point of use, which is where it is legal. */
  assert.match(source, /texture\(samplerCube\(map_t, map_s\), dir\)/);
  /* At the call site the two objects pass through rather than being recombined. */
  assert.match(source, /pointShadow\(uPointShadow0_t, uPointShadow0_s, d\)/);
});

/*
 * The type the directional cascade collapses onto, and the reason it is a separate rule.
 *
 * `SAMPLER_TYPES` is an alternation matched left to right, and `sampler2D` is a prefix of
 * `sampler2DArray`: an entry appended to the end of that object never matches, because the
 * regex settles on `sampler2D` and then fails on the `A` where it wanted whitespace. The
 * declaration is then left alone entirely, which is not an error — it is a combined sampler
 * surviving into SPIR-V, and Tint answering "WGSL does not support combined image-samplers"
 * three steps later with nothing pointing back here.
 */
test('separateSamplers splits a sampler2DArray, whose name has sampler2D as a prefix', () => {
  const input = [
    'uniform highp sampler2DArray uDirectionalShadowMaps;',
    'void main() { d = textureLod(uDirectionalShadowMaps, vec3(vUv, 1.0), 0.0).r; }',
  ].join('\n');
  const { source, bindings } = separateSamplers(input);
  assert.match(source, /uniform highp texture2DArray uDirectionalShadowMaps_t;/);
  assert.match(source, /uniform highp sampler uDirectionalShadowMaps_s;/);
  /* The constructor names the combined type, which for an array texture is sampler2DArray. */
  assert.match(
    source,
    /textureLod\(sampler2DArray\(uDirectionalShadowMaps_t, uDirectionalShadowMaps_s\), vec3\(vUv, 1\.0\), 0\.0\)/,
  );
  assert.equal(bindings.textures.uDirectionalShadowMaps.type, 'sampler2DArray');
});

/*
 * The generator's contract, which needs the two tools present. `depth.ts` is the target
 * because it is the smallest module with a sampler in it, and these run the real toolchain
 * rather than a stub: a freshness check that never compiled anything would pass while the
 * committed WGSL rotted, which is the exact failure this whole mechanism exists to prevent.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP = hasNaga() ? false : 'naga is not installed (cargo install naga-cli --locked)';

test('--check passes on a clean tree', { skip: SKIP }, () => {
  execFileSync(
    'npx',
    ['tsx', '--conditions=drift-source', 'scripts/wgsl.ts', '--check', '--only=depth.ts'],
    { stdio: 'pipe' },
  );
});

/*
 * **The guard that guarded nothing, and the shape of the failure.**
 *
 * `flat.ts` became `flat/index.ts`, and the generator's discovery filtered `readdirSync` on
 * `.ts` — so the largest shader in the engine silently stopped being generated. `--check` kept
 * passing, because a file nothing generates is never reported stale, and the committed
 * `flat.wgsl.ts` sat holding the pre-split source: twelve `samplerCube` declarations, a
 * `uPointShadowIndex` that no longer existed, and no way to notice from either side.
 *
 * A test that only asserted "`--check` passes on a clean tree" cannot catch that, and one that
 * checked the source file exists cannot either — it did exist. The only assertion that would
 * have fired is this one: dirty the generated file and require `--check` to *fail*, on the
 * shader whose source is a directory.
 */
/**
 * A throwaway shader root, so a drift test never edits a tracked file.
 *
 * **Both tests below used to dirty the real generated file and restore it in a `finally`.** That
 * makes them mutate the repository while they run: two invocations at once race — one restores
 * while the other is still checking, and the check then passes when it must not — and a crash
 * between the write and the restore leaves a drifted file in the tree. Reproduced with three
 * concurrent runs of `npm run test:scripts`: two of the three failed, and the tree was left
 * carrying `/* drift *\/` in two committed files.
 *
 * So the drift happens in a copy under `mkdtemp`, and `--root=` points the generator at it. The
 * copy is a whole shader directory rather than one file because the generator discovers what to
 * build by reading the directory.
 */
function throwawayRoot(shader) {
  const dir = mkdtempSync(join(tmpdir(), 'wgsl-drift-'));
  const from = join(ROOT, 'packages/core/src/render/shaders');
  /*
   * **Symlinked rather than copied, because a shader's imports reach outside its own directory.**
   * `flat/index.ts` wants `../conditionals` and `../../renderQuality`, so a copy under `/tmp`
   * resolves neither. Node resolves a symlink to its real path before it resolves that module's
   * imports — `--preserve-symlinks` is off by default — so the generator reads the real source
   * and writes into this directory's own `generated/`, which is the whole of what has to be
   * throwaway.
   */
  if (statSync(join(from, shader)).isDirectory()) {
    /*
     * A real directory with symlinked contents, not a symlinked directory: the generator's
     * discovery asks `entry.isDirectory()`, which is false for a symlink, so a linked directory
     * is skipped and nothing is generated at all — which this test would then read as the drift
     * going unnoticed. Found that way.
     */
    mkdirSync(join(dir, shader));
    for (const entry of readdirSync(join(from, shader))) {
      symlinkSync(join(from, shader, entry), join(dir, shader, entry));
    }
  } else {
    symlinkSync(join(from, shader), join(dir, shader));
  }
  mkdirSync(join(dir, 'generated'), { recursive: true });
  return dir;
}

/** The stem the generator names a shader's output by: `flat/index.ts` writes `flat.wgsl.ts`. */
function generatedPath(root, shader) {
  const stem = shader.replace(/\/index\.ts$/, '').replace(/\.ts$/, '');
  return join(root, 'generated', `${stem}.wgsl.ts`);
}

function expectsDriftToFail(shader, only, message) {
  const root = throwawayRoot(shader);
  try {
    /* Generate once so the copy has a clean, current output to drift away from. */
    execFileSync(
      'npx',
      ['tsx', '--conditions=drift-source', 'scripts/wgsl.ts', `--root=${root}`, `--only=${only}`],
      {
        stdio: 'pipe',
      },
    );
    const generated = generatedPath(root, shader);
    execFileSync(
      'npx',
      [
        'tsx',
        '--conditions=drift-source',
        'scripts/wgsl.ts',
        '--check',
        `--root=${root}`,
        `--only=${only}`,
      ],
      {
        stdio: 'pipe',
      },
    );
    writeFileSync(generated, `${readFileSync(generated, 'utf8')}\n/* drift */\n`);
    assert.throws(
      () =>
        execFileSync(
          'npx',
          [
            'tsx',
            '--conditions=drift-source',
            'scripts/wgsl.ts',
            '--check',
            `--root=${root}`,
            `--only=${only}`,
          ],
          {
            stdio: 'pipe',
          },
        ),
      message,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/*
 * **The guard that guarded nothing, and the shape of the failure.**
 *
 * `flat.ts` became `flat/index.ts`, and the generator's discovery filtered `readdirSync` on
 * `.ts` — so the largest shader in the engine silently stopped being generated. `--check` kept
 * passing, because a file nothing generates is never reported stale, and the committed
 * `flat.wgsl.ts` sat holding the pre-split source: twelve `samplerCube` declarations, a
 * `uPointShadowIndex` that no longer existed, and no way to notice from either side.
 *
 * A test that only asserted "`--check` passes on a clean tree" cannot catch that, and one that
 * checked the source file exists cannot either — it did exist. The only assertion that would
 * have fired is this one: dirty the generated file and require `--check` to *fail*, on the
 * shader whose source is a directory.
 */
test('--check covers a shader whose source is a directory', { skip: SKIP }, () => {
  expectsDriftToFail(
    'flat',
    'flat',
    'flat/ is not being generated at all, so nothing can report it stale',
  );
});

test('--check fails when a generated file has drifted', { skip: SKIP }, () => {
  expectsDriftToFail('depth.ts', 'depth.ts');
});

test('an explicit-level fetch stays explicit through the toolchain', { skip: SKIP }, async () => {
  const source = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'in float vFlag;',
    'out vec4 outColor;',
    'uniform sampler2D uMap;',
    'void main() {',
    '  vec4 c = vec4(0.0);',
    '  if (vFlag > 0.5) { c = textureLod(uMap, vUv, 0.0); }',
    '  outColor = c;',
    '}',
  ].join('\n');

  const { wgsl } = await compileToWgsl(source, 'fragment', 'textureLod-rule');
  assert.match(wgsl, /textureSampleLevel/);
  assert.doesNotMatch(
    wgsl,
    /textureSample\(/,
    'an implicit-derivative sample appeared where the GLSL asked for an explicit level',
  );
});

/*
 * The whole point of the array type, checked against the real toolchain rather than at the
 * string layer.
 *
 * A layer index is a `float` in the GLSL coordinate and an `i32` argument in WGSL, and that
 * conversion is glslang's and naga's to make, not this file's. If either of them declined it
 * the transform tests above would still pass and the generated shader would not compile, so
 * the claim "the translator learns an array texture" is only true if it is checked here.
 */
test('a sampler2DArray reaches WGSL as an array texture', { skip: SKIP }, async () => {
  const source = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'in float vFlag;',
    'out vec4 outColor;',
    'uniform highp sampler2DArray uCascades;',
    'void main() {',
    '  float d = 0.0;',
    '  if (vFlag > 0.5) { d = textureLod(uCascades, vec3(vUv, 1.0), 0.0).r; }',
    '  outColor = vec4(d);',
    '}',
  ].join('\n');

  const { wgsl } = await compileToWgsl(source, 'fragment', 'sampler2DArray');
  assert.match(wgsl, /texture_2d_array<f32>/);
  /* Still explicit-level, by the same rule the test above pins for the plain 2D case. */
  assert.match(wgsl, /textureSampleLevel/);
  assert.doesNotMatch(wgsl, /textureSample\(/);
});

/*
 * The two stages of one pipeline must not both land on binding 0.
 *
 * They are compiled separately, so each was given `@group(0) @binding(0)` for its own
 * uniform block — and those blocks hold different structs. A pipeline binding both is asking
 * for one buffer to be two things at once, and no bind group layout can satisfy it. Found
 * when the flat pipeline was first assembled in Task 9, which is late; this is the test that
 * would have found it in Task 2.
 */
test('the two stages get disjoint binding ranges', () => {
  const glsl =
    '#version 300 es\nprecision highp float;\nuniform mat4 uViewProj;\nuniform sampler2D uMap;\nvoid main() {}';
  const vertex = transform(glsl, 'vertex');
  const fragment = transform(glsl, 'fragment');

  assert.notEqual(vertex.bindings.uniforms, fragment.bindings.uniforms);
  assert.notEqual(
    vertex.bindings.textures['uMap'].texture,
    fragment.bindings.textures['uMap'].texture,
  );
  assert.match(
    vertex.source,
    new RegExp(`layout\\(binding=${vertex.bindings.uniforms}\\) uniform Uniforms`),
  );
  assert.match(
    fragment.source,
    new RegExp(`layout\\(binding=${fragment.bindings.uniforms}\\) uniform Uniforms`),
  );
});

test('transform runs every rule and reports the bindings once', () => {
  /* The stage is named, because it decides the binding range and there is no safe default. */
  const { source, bindings } = transform(
    '#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 outColor;\nuniform float uTime;\nuniform sampler2D uAlbedo;\nvoid main() { outColor = texture(uAlbedo, vUv) * uTime; }',
    'vertex',
  );
  assert.match(source, /#version 310 es/);
  assert.match(source, /layout\(location=0\) in vec2 vUv;/);
  assert.match(source, /layout\(binding=0\) uniform Uniforms \{/);
  assert.match(source, /texture2D uAlbedo_t/);
  assert.equal(bindings.uniforms, 0);
  assert.ok(Object.hasOwn(bindings.textures, 'uAlbedo'));
});

/**
 * The stage a shader export is, which decides which compiler stage it is handed to.
 *
 * Every permuted shader before skinning was a fragment shader, so the pattern only ever had to
 * match SCREAMING_CASE constants: a permutation is a camelCase function by the convention
 * `flatFrag` set. `flatVert` matched neither arm and would have been compiled as a fragment
 * shader, silently, failing later at pipeline creation with a message about the stage rather
 * than about the name.
 */
test('a camelCase permuted vertex shader is classified as one', () => {
  assert.equal(stageOf('flatVert'), 'vertex');
  assert.equal(stageOf('FLAT_VERT'), 'vertex');
  assert.equal(stageOf('flatFrag'), 'fragment');
  assert.equal(stageOf('SPLAT_FRAG'), 'fragment');
});
