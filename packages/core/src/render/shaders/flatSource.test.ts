import { expect, test } from 'vitest';
import { MAX_POINT_LIGHTS } from '../lightBudget.ts';
import { MAX_LIGHTS_PER_CLUSTER } from '../clusteredLights.ts';
import { flatFrag, flatVert } from './flat/index.ts';
import type { FlatShaderOptions } from './flat/index.ts';

/**
 * The generated shader source, pinned.
 *
 * `flatFrag` composes GLSL by concatenation, so a change that reorders a section changes the
 * shader and therefore the picture. A string comparison is a stricter oracle than a captured
 * frame and costs nothing to run, so a refactor of this file can be proven rather than
 * inspected.
 *
 * The sweep is exhaustive because it can be: the option type is four booleans, so sixteen
 * shaders cover every path through the composition. A sampled set would leave whichever
 * section the missing permutation reaches unchecked, which is exactly where a reordering
 * would hide.
 *
 * **Fifteen are pinned by hash and one in full**, which is a size decision rather than a
 * confidence one. They share the great majority of their text, so snapshotting all of
 * them was 1.2 MB of mostly duplication that would rewrite whole on any shader change. A hash
 * detects a change just as surely; what it cannot do is show what moved, so the permutation
 * with every feature on — the superset, containing every section the others can reach — is
 * kept as readable text for that.
 */
const FIELDS = [
  'pointShadows',
  'directionalShadows',
  'environmentProbe',
  'nightEmissive',
] as const satisfies readonly (keyof FlatShaderOptions)[];

function optionsFor(mask: number): FlatShaderOptions {
  const options: Record<string, boolean> = {};
  FIELDS.forEach((field, bit) => {
    options[field] = (mask & (1 << bit)) !== 0;
  });
  return options as unknown as FlatShaderOptions;
}

const ALL_ON = (1 << FIELDS.length) - 1;

/**
 * Clustering is compiled in and branched at run time, and the fixed path is untouched by it.
 *
 * **This is not the inertness `ARCHITECTURE.md` §1 usually asks for, and the reversal is
 * measured.** A fifth permutation flag doubled the generated WGSL — 914 KB to 1,906 KB raw, and
 * 400,728 to 597,638 bytes gzipped, a 49% rise carried by every consumer including those who never
 * enable it. Gzip's window is 32 KB and a permutation is bigger, so near-identical copies do not
 * dedupe. What can still be asserted is the thing that actually protects existing consumers: the
 * fixed arm's arithmetic and its loop bound are exactly what they were.
 */
test('the fixed light path is unchanged by the clustered arm existing beside it', () => {
  const source = flatFrag(optionsFor(ALL_ON));

  /*
   * The bound is the froxel cap since 2026-09-25, and the fixed arm leaves at its own budget: it
   * iterates what it always did, and never indexes a uniform array of `MAX_LIGHTS` past its end.
   */
  expect(source).toContain('#define LIGHT_LOOP_MAX MAX_LIGHTS_PER_CLUSTER');
  expect(source).toContain('if (i >= uLightCount || i >= MAX_LIGHTS) break;');
  expect(
    MAX_LIGHTS_PER_CLUSTER,
    'and the bound never cuts the fixed arm short',
  ).toBeGreaterThanOrEqual(MAX_POINT_LIGHTS);

  /* The fixed arm still reads the uniform slots, unchanged. */
  expect(source).toContain('lightPos = uLightPos[i];');
  expect(source).toContain('lightWeight = uLightWeight[i];');

  /* And the branch is on a uniform, so it is uniform control flow in every fragment. */
  expect(source).toContain('uniform int uClustered;');
  expect(source).toContain('if (uClustered != 0)');
});

/**
 * FNV-1a, written out rather than imported.
 *
 * `node:crypto` would be the obvious choice and is not available: this package's tsconfig
 * sets `"types": []` on purpose, so that adding Node's types for the tools cannot hand
 * `Buffer` and `process` to engine source a consumer bundles for a browser. A dozen lines of
 * arithmetic keeps that rule intact, and a change detector does not need to be cryptographic.
 */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`;
}

/*
 * **The order the clustered arm reads a record in is the performance, so it is asserted.** A plain
 * light costs two texels only while the range test comes before the second and the fixture's three
 * stay inside a branch a whole frame of plain lights never enters; moving either line back reads
 * five texels a light again, and the picture would not change to say so. See `LIGHT_TEXELS`.
 */
test('the clustered arm reads a plain light in two texels, and out of reach in one', () => {
  const source = flatFrag(optionsFor(ALL_ON));
  const start = source.indexOf('uvec4 rec0 = clusterTexel(record);');
  const arm = source.slice(start, source.indexOf('i = slot;', start));
  const second = arm.indexOf('clusterTexel(record + 1)');
  expect(start).toBeGreaterThan(0);
  expect(arm.indexOf('>= lightRadius) continue;')).toBeGreaterThan(0);
  expect(arm.indexOf('>= lightRadius) continue;')).toBeLessThan(second);
  const mode = arm.indexOf('if (uClustered == 2) {');
  const flag = arm.indexOf('if ((rec1.w & LIGHT_FIXTURE_FLAG) != 0u) {');
  expect(mode).toBeGreaterThan(second);
  expect(flag).toBeGreaterThan(mode);
  for (const texel of [2, 3, 4])
    expect(arm.indexOf(`clusterTexel(record + ${texel})`)).toBeGreaterThan(flag);
});

test('a scene with no photometric profile reads no profile', () => {
  const source = flatFrag(optionsFor(ALL_ON));
  const guard = source.indexOf(
    'if (uIesAtlasRows > 1.0) {',
    source.indexOf('float photometric = 1.0;'),
  );
  expect(guard).toBeGreaterThan(0);
  expect(source.indexOf('float iesGain = textureLod(uFixtureAtlas', guard)).toBeGreaterThan(guard);
  expect(source.indexOf('float iesAngle = acos(')).toBeGreaterThan(
    source.indexOf('if (uIesAtlasRows > 1.0) {'),
  );
});

test('the vertex source is stable', () => {
  for (const morphed of [false, true]) {
    for (const skinned of [false, true]) {
      expect(flatVert({ skinned, morphed, instanced: false })).toMatchSnapshot();
    }
  }
});

/*
 * The instanced arm, pinned separately rather than folded into the loop above.
 *
 * There is exactly one of it. Skinned is refused because the joint attributes and the instance
 * matrix want the same two locations, and morphed because a morph weight is per draw and every
 * instance would wear one expression between them — so the cross product has two holes in it and
 * a loop over the other flags would throw rather than pin anything.
 */
test('the instanced vertex source is stable', () => {
  expect(flatVert({ skinned: false, morphed: false, instanced: true })).toMatchSnapshot();
});

test('the two impossible instanced combinations are refused', () => {
  expect(() => flatVert({ skinned: true, morphed: false, instanced: true })).toThrow();
  expect(() => flatVert({ skinned: false, morphed: true, instanced: true })).toThrow();
});

test('the fragment source with every feature on is stable', () => {
  expect(flatFrag(optionsFor(ALL_ON))).toMatchSnapshot();
});

test('all sixteen fragment permutations are stable, by hash', () => {
  const digests: Record<string, string> = {};
  for (let mask = 0; mask <= ALL_ON; mask += 1) {
    const options = optionsFor(mask);
    const label = FIELDS.filter((f) => options[f]).join('+') || 'none';
    digests[label] = digest(flatFrag(options));
  }
  expect(Object.keys(digests).length).toBe(16);
  expect(digests).toMatchSnapshot();
});
