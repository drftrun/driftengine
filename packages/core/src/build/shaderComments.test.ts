/**
 * The corpus test is the point of this file.
 *
 * `stripShaderComments` finds template literals with a regex, which is safe for the
 * shader modules and unsafe in general. Rather than argue about that, it runs over every
 * shader module in the repository and checks what came out — which is the only evidence
 * that actually matters, and it re-checks itself against any shader added later.
 *
 * Sources arrive through `?raw` rather than `node:fs`, as `flat.test.ts` reads the
 * renderer: this repository has no Node typings and does not want them for a test.
 */
import { expect, test } from 'vitest';
import { shaderCommentStripper, stripShaderComments } from './shaderComments.ts';

/*
 * `import.meta.glob` is Vite's, and typing it would mean pulling `vite/client` into a
 * repository with no bundler dependency — so it is declared here, minimally.
 *
 * It also has to be *called* as `import.meta.glob(...)`, spelled out: Vite replaces the
 * call at transform time by matching it in the syntax tree, so binding it to a local
 * first leaves a function that does not exist at run time. The declaration is what keeps
 * the literal call type-checking.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const shaderModules = Object.entries(
  import.meta.glob('../render/shaders/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).filter(([id]) => !id.endsWith('.test.ts'));

test('every shader module in the repository survives the strip', () => {
  expect(shaderModules.length, 'the corpus is not empty').toBeGreaterThan(10);

  for (const [name, source] of shaderModules) {
    const stripped = stripShaderComments(source);

    /*
     * Every value a shader is assembled from is still there, in order. A lost
     * interpolation is the one failure that would compile and be wrong.
     */
    expect(stripped.match(/\$\{[^}]*\}/g) ?? [], `${name}: interpolations`).toEqual(
      source.match(/\$\{[^}]*\}/g) ?? [],
    );

    // The GLSL is still GLSL: nothing gutted a span rather than trimming it.
    for (const marker of ['#version 300 es', 'void main']) {
      if (!source.includes(marker)) continue;
      expect(stripped.includes(marker), `${name}: kept ${marker}`).toBe(true);
    }

    // The TypeScript around the GLSL is untouched — same exports, same backticks.
    expect((stripped.match(/`/g) ?? []).length, `${name}: literal boundaries`).toBe(
      (source.match(/`/g) ?? []).length,
    );
    for (const declaration of source.match(/^export const \w+/gm) ?? []) {
      expect(stripped.includes(declaration), `${name}: kept ${declaration}`).toBe(true);
    }

    // Running it twice changes nothing, so a re-transform cannot degrade a shader.
    expect(stripShaderComments(stripped), `${name}: idempotent`).toBe(stripped);
  }
});

test('the corpus actually shrinks, or this is doing nothing', () => {
  const before = shaderModules.reduce((sum, [, source]) => sum + source.length, 0);
  const after = shaderModules.reduce(
    (sum, [, source]) => sum + stripShaderComments(source).length,
    0,
  );
  // Measured at roughly half. Asserted well under that, so tidying the shaders' comments
  // later does not fail the suite for the crime of being tidier.
  expect(after).toBeLessThan(before * 0.8);
});

test('a comment carrying an interpolation is left alone', () => {
  /*
   * Nothing in the engine writes one. If something ever does, removing it deletes a value
   * the program is built from and the shader compiles anyway — the worst shape a bug can
   * take here, so it is refused rather than handled.
   */
  const source = 'export const S = `uniform int uN; // slots: ${MAX}\nvoid main(){}`;';
  expect(stripShaderComments(source)).toBe(source);
});

test('code outside a GLSL literal is not touched', () => {
  const source = [
    '// A module comment, which esbuild removes anyway.',
    'export const NOT_GLSL = `a plain ${value} message`;',
    'export const S = `#version 300 es\n// gone\nvoid main(){}`;',
  ].join('\n');
  const stripped = stripShaderComments(source);
  expect(stripped).toContain('// A module comment');
  expect(stripped).toContain('`a plain ${value} message`');
  expect(stripped).not.toContain('// gone');
});

test('a block comment leaves a space, so two tokens do not become one', () => {
  const source = 'export const S = `uniform float a;\nvoid main(){ float b = a/*x*/+1.0; }`;';
  expect(stripShaderComments(source)).toContain('a +1.0');
});

test('the plugin only runs on the shader modules, and only in a build', () => {
  const plugin = shaderCommentStripper();
  expect(plugin.apply).toBe('build');
  expect(plugin.enforce).toBe('pre');

  const glsl = 'export const S = `#version 300 es\n// gone\nvoid main(){}`;';
  expect(plugin.transform(glsl, '/x/src/game/level.ts'), 'not a shader module').toBe(null);
  const result = plugin.transform(glsl, '/x/src/render/shaders/flat.ts');
  expect(result === null).toBe(false);
  expect(String(result?.code)).not.toContain('// gone');
  /*
   * No map, and it says so. A transform that removes text without producing one must not
   * claim otherwise, or a later plugin's map points at lines that have moved.
   */
  expect(result?.map).toBe(null);
});

test('a consumer can widen which modules count', () => {
  const plugin = shaderCommentStripper({ include: (id) => id.endsWith('.glsl.ts') });
  const glsl = 'export const S = `#version 300 es\n// gone\nvoid main(){}`;';
  expect(plugin.transform(glsl, '/x/src/render/shaders/flat.ts')).toBe(null);
  expect(String(plugin.transform(glsl, '/x/game/water.glsl.ts')?.code)).not.toContain('// gone');
});
