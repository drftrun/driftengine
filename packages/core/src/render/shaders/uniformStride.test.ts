import { expect, test } from 'vitest';

/**
 * No array in a uniform block strides by less than sixteen bytes, in any generated shader.
 *
 * **The bug.** WGSL requires a sixteen-byte element stride for arrays in the *uniform*
 * address space. The toolchain emitted `array<f32, 10>` and `array<i32, 10>`, which stride
 * by four. Dawn accepts that — every desktop browser, measured: all sixteen `flat`
 * permutations compile with the validation scope clean and not one warning. WebKit enforces
 * the rule, so on iOS every one of those modules failed to compile with:
 *
 *     arrays in the uniform address space must have a stride multiple of 16 bytes,
 *     but has a stride of 4 bytes
 *
 * `flat` is the mesh shader and no permutation of it survived, so every geometry pipeline
 * in the frame was invalid, `setPipeline` invalidated the pass, and the command buffer was
 * dropped whole. The sky went with it. What a person saw was a completely black view on
 * every consumer, in both iOS browsers, while the engine's own caption read
 * `webgpu · 60 fps · 13 draws` over it — so every frame-rate and draw-count reading taken
 * during the investigation was consistent with a renderer in perfect health.
 *
 * **Why a test rather than care.** The stride is chosen three layers down, by what naga
 * emits for a SPIR-V array, and neither the generator nor Dawn nor any test in this repo
 * had an opinion about it. `scripts/wgsl/layout.mjs` had *deliberately* un-rounded the CPU
 * side to sixteen to match, on a measurement of Dawn that was correct and one browser wide.
 * Nothing in the pipeline could have caught it, and the only machine that disagreed was one
 * nobody had opened the page on.
 *
 * So this asserts the language's rule against the committed output, which is the artefact
 * that actually reaches a device. It reads the generated modules rather than re-deriving a
 * layout, because a test that recomputes what the generator computes agrees with the
 * generator by construction and proves nothing.
 */

/*
 * Every generated module as text, so a shader added later is covered without being listed
 * here. Read raw rather than imported: this checks the committed artefact, which is the thing
 * a device compiles.
 */
const GENERATED: Record<string, string> = import.meta.glob('./generated/*.wgsl.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * What WGSL aligns each type to. A type's alignment is its array element stride, and the
 * uniform address space rounds that up to sixteen — which is exactly the rule under test,
 * so the raw alignment is what is tabulated and the rounding is left to the assertion.
 */
const ALIGNMENT: Readonly<Record<string, number>> = {
  f32: 4,
  i32: 4,
  u32: 4,
  f16: 2,
  'vec2<f32>': 8,
  'vec2<i32>': 8,
  'vec2<u32>': 8,
  'vec2<f16>': 4,
  'vec3<f32>': 16,
  'vec3<i32>': 16,
  'vec3<u32>': 16,
  'vec4<f32>': 16,
  'vec4<i32>': 16,
  'vec4<u32>': 16,
  'mat2x2<f32>': 8,
  'mat3x3<f32>': 16,
  'mat4x4<f32>': 16,
};

interface Offender {
  readonly shader: string;
  readonly field: string;
  readonly type: string;
  readonly stride: number;
}

/** Every array a uniform block declares, with the stride WGSL gives its elements. */
function uniformArrays(shader: string, wgsl: string): Offender[] {
  /*
   * Only structs that a `var<uniform>` actually names. The same struct shape in the storage
   * space is legal at any stride, and flagging it would be a false alarm rather than a find.
   */
  const uniformTypes = new Set(
    [...wgsl.matchAll(/var<uniform>\s*\w+\s*:\s*(\w+)\s*;/g)].map((match) => match[1] as string),
  );

  const found: Offender[] = [];
  for (const struct of wgsl.matchAll(/struct\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    if (!uniformTypes.has(struct[1] as string)) continue;
    for (const member of (struct[2] as string).matchAll(
      /(\w+)\s*:\s*array<\s*([\w<>]+)\s*,\s*\d+\s*>/g,
    )) {
      const type = member[2] as string;
      const alignment = ALIGNMENT[type];
      /* An unlisted type is a gap in this table, and silence would be the wrong answer. */
      expect(alignment, `${shader}: no alignment recorded for ${type}`).toBeDefined();
      found.push({ shader, field: member[1] as string, type, stride: alignment as number });
    }
  }
  return found;
}

/**
 * The WGSL out of one generated module's text.
 *
 * The generator writes every shader with `JSON.stringify`, so each one is a JSON string
 * literal and parsing it back is exact rather than a guess at the escaping.
 *
 * Two shapes carry a shader: `export const NAME_WGSL = "…"` for a plain one and
 * `  "variant": "…"` for a permutation. The bindings object matches the second shape too, so
 * a value is kept only if it reads like WGSL.
 */
function shadersIn(file: string, text: string): { name: string; wgsl: string }[] {
  const out: { name: string; wgsl: string }[] = [];
  const starts = [
    ...text.matchAll(/export const (\w+) = "/g),
    ...text.matchAll(/^\s*"([^"]+)": "/gm),
  ];

  for (const start of starts) {
    /* Walk the literal honouring escapes, so a `\"` inside a shader does not end it early. */
    let at = (start.index ?? 0) + start[0].length;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    const wgsl: unknown = JSON.parse(text.slice((start.index ?? 0) + start[0].length - 1, at + 1));
    if (typeof wgsl !== 'string') continue;
    if (!wgsl.includes('struct ') && !wgsl.includes('fn main')) continue;
    out.push({ name: `${file} ${start[1] as string}`, wgsl });
  }
  return out;
}

/** Every WGSL string the engine can hand to `createShaderModule`, named for the message. */
function everyShader(): { name: string; wgsl: string }[] {
  return Object.entries(GENERATED).flatMap(([file, text]) => shadersIn(file, text));
}

test('the generated shaders are there to be read at all', () => {
  const shaders = everyShader();
  /*
   * The guard on the guard. A glob that matched nothing, or modules that stopped exporting
   * strings, would make every assertion below pass over an empty list — which is the one
   * failure mode a test like this has, and it is silent.
   */
  expect(shaders.length).toBeGreaterThan(40);
  expect(shaders.some(({ wgsl }) => wgsl.includes('var<uniform>'))).toBe(true);
});

test('no uniform array strides by less than sixteen bytes, which WebKit rejects', () => {
  const offenders = everyShader()
    .flatMap(({ name, wgsl }) => uniformArrays(name, wgsl))
    .filter((one) => one.stride < 16);

  expect(
    offenders.map((one) => `${one.shader}: ${one.field}: array<${one.type}> strides ${one.stride}`),
  ).toEqual([]);
});
