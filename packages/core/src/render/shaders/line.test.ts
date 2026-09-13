import { expect, test } from 'vitest';
import { LINE_FRAG, LINE_VERT } from './line.ts';

/*
 * The expansion is what makes this a line renderer rather than a call to gl.LINES: a
 * segment becomes a quad across the line of sight, so a width means something. Native line
 * primitives cap at one pixel on nearly every WebGL2 driver and WebGPU has no line width at
 * all, which is why the only portable wide line is a triangle.
 */
test('the vertex stage expands across the segment and the view', () => {
  expect(LINE_VERT).toContain('cross(dir, view)');
});

/* A model matrix, unlike the arc shader, which takes world-space paths only. A line is
   attached to something that moves; an arc is a path through the world. */
test('the vertex stage places its endpoints through a model matrix', () => {
  expect(LINE_VERT).toContain('uModel');
});

/*
 * The edge is antialiased against the screen-space derivative for the same reason
 * `SDF_TEXT_FRAG` does it: one shader has to be legible at every width and distance, and a
 * constant band is tuned for one and wrong at the rest.
 */
test('the edge is antialiased against the screen-space derivative', () => {
  expect(LINE_FRAG).toContain('fwidth');
});

/* Fogged, which is the other half of the difference from an arc: a drawn line is a thing in
   the world and recedes into the same air everything else does. `bolt.ts` includes the same
   FOG_GLSL and deliberately does not call it, because light arriving is not a surface. */
test('the fragment stage mixes toward the medium over distance', () => {
  expect(LINE_FRAG).toContain('mediumFog(');
  expect(LINE_FRAG).toContain('mediumColor()');
});
