/**
 * Every generated vertex shader negates `gl_Position.y`, and `CLIP_CORRECTION` exists to cancel it.
 *
 * **This is the fact the WebGPU backend's whole orientation rests on, and until this file nothing
 * checked it.** `naga` adapts a GLSL vertex shader to WebGPU by appending
 * `gl_Position.y = -gl_Position.y` to the entry point, so every module under `generated/` flips
 * the world upside down on its own. `CLIP_CORRECTION`'s negated row flips it back, and the net
 * effect of the pair on a generated shader is the depth remap alone.
 *
 * **The comment on that matrix said something else for months.** It attributed the flip to the
 * framebuffer origins — WebGPU's at the top-left, OpenGL's at the bottom-left — and that is not
 * what either viewport transform does: OpenGL measures its window upward from the bottom and
 * WebGPU measures its framebuffer downward from the top, so clip `y = +1` is the top of the image
 * on both and an uncorrected projection lands the same way up. The explanation was wrong while the
 * code was right, which is the worst combination: it held for every shader the generator produced
 * and broke the first one somebody wrote by hand — the GPU-driven pipeline's raster, whose picture
 * came out an exact vertical mirror of the forward path's and whose winding came out reversed with
 * it. `PassDevice.depthCorrection` is the matrix that case wants.
 *
 * **So this test is what makes the pair honest rather than lucky.** If a generator upgrade stops
 * emitting the negation, every scene on WebGPU turns upside down and this fails first, naming the
 * shader. If one starts emitting it twice, likewise.
 */

import { expect, test } from 'vitest';

/*
 * Every generated module as text, so a shader added later is covered without being listed. Read
 * raw rather than imported, for `uniformStride.test.ts`'s reason: this checks the committed
 * artefact, which is the thing a device compiles.
 */
const GENERATED: Record<string, string> = import.meta.glob('./generated/*.wgsl.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The line `naga` appends. Written out here because it is the thing being pinned. */
const NEGATION = 'gl_Position.y = -(';

/** A module's entry points, by stage, from the attributes the generator emits. */
function stagesOf(source: string): { vertex: number; negations: number } {
  return {
    vertex: (source.match(/@vertex/g) ?? []).length,
    negations: source.split(NEGATION).length - 1,
  };
}

test('the generated corpus is not empty, or everything below passes by matching nothing', () => {
  expect(Object.keys(GENERATED).length).toBeGreaterThan(20);
});

test('EVERY GENERATED VERTEX ENTRY POINT NEGATES gl_Position.y, EXACTLY ONCE', () => {
  /*
   * Once per vertex entry point, not once per module: a module with two of them — a shader
   * permuted over a flag the generator expands — needs both, and a module with none needs none.
   * Counting rather than testing presence is what separates "the generator still does this" from
   * "some shader in this file does it".
   */
  const offenders: string[] = [];
  for (const [name, source] of Object.entries(GENERATED)) {
    const { vertex, negations } = stagesOf(source);
    if (vertex !== negations)
      offenders.push(`${name}: ${vertex} vertex stages, ${negations} flips`);
  }
  expect(offenders).toEqual([]);
});

test('AND AT LEAST ONE MODULE ACTUALLY HAS A VERTEX STAGE, so the count above is not zero to zero', () => {
  let stages = 0;
  for (const source of Object.values(GENERATED)) stages += stagesOf(source).vertex;
  expect(stages).toBeGreaterThan(10);
});
