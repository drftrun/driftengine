/**
 * The corpus test is the point of this file.
 *
 * `stripShaderComments` finds template literals with a regex, which is safe for the
 * shader modules and unsafe in general. Rather than argue about that, it runs over every
 * shader module in the repository and checks what came out — which is the only evidence
 * that actually matters, and it re-checks itself against any shader added later.
 *
 * **"Every" was `../render/shaders/*.ts` until 4.8.5**, which is the top level of one
 * directory: 47 of the 130 modules the plugin's default reaches, and not the one the lit
 * shader lives in. A `//` comment there quoting an identifier in backticks lost half its line
 * to the strip and left a backtick in the GLSL, so every consumer building with the plugin
 * shipped a lit shader WebGL2 could not compile, from 4.4.0 on, while this test was green. The
 * glob is now every package's `shaders/` tree, which is what the plugin's default touches.
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
  import.meta.glob('../../../*/src/**/shaders/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).filter(([id]) => !id.endsWith('.test.ts'));

/** The backticks that open and close a template literal: every one not escaped inside one. */
function boundaries(text: string): number {
  return (text.match(/\\[\s\S]|`/g) ?? []).filter((token) => token === '`').length;
}

/** Every template literal in a module that holds GLSL, read with its escapes. */
function glslLiterals(text: string): string[] {
  const markers = ['#version', 'void main', 'uniform ', 'layout('];
  return (text.match(/`(?:[^`\\]|\\[\s\S])*`/g) ?? []).filter((span) =>
    markers.some((marker) => span.includes(marker)),
  );
}

test('every shader module in the repository survives the strip', () => {
  expect(shaderModules.length, 'the corpus is not empty').toBeGreaterThan(100);
  expect(
    shaderModules.some(([id]) => id.includes('/shaders/flat/')),
    'the corpus reaches below the top of a shaders directory',
  ).toBe(true);

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

    /*
     * The TypeScript around the GLSL is untouched — same exports, same literal boundaries.
     * Escaped backticks are not boundaries: a comment quoting an identifier in them leaves
     * with its quotes, and counting those would fail a correct strip.
     */
    expect(boundaries(stripped), `${name}: literal boundaries`).toBe(boundaries(source));

    /*
     * And no backtick is left in the GLSL. The language has none, so the only ones in these
     * literals are the quotes around identifiers in comments, and a strip that leaves one has
     * cut a comment short and handed its tail to the compiler — the 4.4.0 defect.
     */
    for (const literal of glslLiterals(stripped)) {
      expect(literal.includes('\\`'), `${name}: a backtick left in the GLSL`).toBe(false);
    }
    for (const declaration of source.match(/^export const \w+/gm) ?? []) {
      expect(stripped.includes(declaration), `${name}: kept ${declaration}`).toBe(true);
    }

    // Running it twice changes nothing, so a re-transform cannot degrade a shader.
    expect(stripShaderComments(stripped), `${name}: idempotent`).toBe(stripped);
  }
});

test('the corpus actually shrinks, or this is doing nothing', () => {
  /* Over the modules holding GLSL: the generated WGSL beside them has none to strip. */
  const glsl = shaderModules.filter(([, source]) => glslLiterals(source).length > 0);
  const before = glsl.reduce((sum, [, source]) => sum + source.length, 0);
  const after = glsl.reduce((sum, [, source]) => sum + stripShaderComments(source).length, 0);
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

test('A LINE COMMENT QUOTING AN IDENTIFIER LEAVES WHOLE, AND THE CODE AFTER IT STAYS', () => {
  /*
   * The shape that broke WebGL2 for every consumer of the plugin: an escaped backtick inside a
   * GLSL literal was read as the literal's end, the line comment's match ran on through it, and
   * the comment's tail reached the compiler as code.
   */
  const source =
    'export const S = /* glsl */ `#version 300 es\nvoid main() {\n' +
    '  // the \\`name\\` is quoted here\n  float a = 1.0;\n}\n`;\nexport const T = 1;';
  const stripped = stripShaderComments(source);
  expect(stripped).not.toContain('quoted here');
  expect(stripped).not.toContain('\\`');
  expect(stripped).toContain('  float a = 1.0;');
  expect(stripped).toContain('export const T = 1;');
});

test('a block opener inside a line comment opens nothing', () => {
  const source =
    'export const S = `#version 300 es\nvoid main() {\n' +
    '  // see /* here\n  float b = 2.0;\n  /* a real one */ float c = 3.0;\n}`;';
  const stripped = stripShaderComments(source);
  expect(stripped).toContain('float b = 2.0;');
  expect(stripped).toContain('float c = 3.0;');
  expect(stripped).not.toContain('a real one');
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
