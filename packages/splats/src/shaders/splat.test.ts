import { describe, expect, it } from 'vitest';
import { OUTPUT_TRANSFORM_GLSL } from '@driftengine/core';
import { SPLAT_FRAG, SPLAT_VERT } from './splat.ts';

/*
 * Source-level assertions, on the pattern `flat.test.ts` sets. What they can catch is a property
 * being written out of the shader — the class of change that compiles, validates and draws a
 * plausible picture. What they cannot catch is arithmetic, which is what `demo/dev/splats.html`
 * and the visual gate are for.
 */
describe('the splat program', () => {
  it('premultiplies, which is the one line whose absence looks like an exposure fault', () => {
    /*
     * The pass blends `ONE, ONE_MINUS_SRC_ALPHA` over a target that already holds opaque
     * geometry, so the source has to arrive with its alpha folded in. Emitting straight colour
     * double-counts alpha and makes the cloud too bright at every silhouette, which reads as the
     * scene being over-exposed rather than as a blend mode being wrong.
     */
    expect(SPLAT_FRAG).toContain('fragColor = vec4(colour * alpha, alpha);');
  });

  it('grades itself, because a contributed pass may be the last thing to touch the frame', () => {
    /*
     * `AGENTS.md`, 2026-08-17. With a composite the resolve grades and this must not; without one
     * this is the last pass and must. The gate is the uniform the shared chunk declares, so
     * including the chunk and calling it is the whole of the obligation — and the curve is never
     * copied.
     */
    expect(SPLAT_FRAG).toContain('applyOutputTransform(');
    /*
     * The chunk **verbatim**, which is the only assertion that separates including it from
     * copying it. Checking for the curve's constants cannot: the chunk is inlined into this
     * string, so they are legitimately present either way — which is how this test was wrong on
     * its first writing.
     */
    expect(SPLAT_FRAG, 'the shared chunk, not a copy of the curve').toContain(
      OUTPUT_TRANSFORM_GLSL,
    );
  });

  it('fetches with texelFetch and declares no sampler beyond its own two', () => {
    /*
     * Integer fetches, so no filtering and no float-texture extension is involved and WebGL2 core
     * is enough. `texture(` would also put a filtered sample in this stage, which for packed
     * uint data is meaningless rather than merely slower.
     */
    expect(SPLAT_VERT).toContain('texelFetch(uSplatData');
    expect(SPLAT_VERT).toContain('texelFetch(uSplatOrder');
    expect(SPLAT_VERT, 'no filtered sample anywhere').not.toMatch(/[^l]texture\(/);
    const samplers = [...SPLAT_VERT.matchAll(/uniform\s+highp\s+usampler2D\s+(\w+)/g)].map(
      (m) => m[1],
    );
    expect(samplers.sort()).toEqual(['uSplatData', 'uSplatOrder']);
  });

  it('owns no vertex attribute, so the pass owns no buffer on either backend', () => {
    /*
     * The geometry is `gl_VertexID` arithmetic. An `in` here would mean a vertex buffer, a vertex
     * array on WebGL2 and a layout on WebGPU — three things to keep in step for a quad whose
     * corners are derivable from one integer.
     */
    expect(SPLAT_VERT).toContain('gl_VertexID');
    expect(SPLAT_VERT, 'no vertex attribute').not.toMatch(/^in\s+\w+\s+\w+;/m);
  });

  it('reads the covariance in the order packSplats writes it', () => {
    /*
     * xx xy xz yy yz zz, and the matrix is assembled symmetric from those six. Getting the order
     * wrong builds a valid matrix from the same numbers and draws a plausible, wrong ellipse —
     * which no test of the reader can see and no picture identifies.
     */
    expect(SPLAT_VERT).toContain('c01.x, c01.y, c23.x');
    expect(SPLAT_VERT).toContain('c01.y, c23.y, c45.x');
    expect(SPLAT_VERT).toContain('c23.x, c45.x, c45.y');
  });

  it('adds the low-pass to the variances only, never to the covariance', () => {
    /*
     * The diagonal is variance in pixels squared and the off-diagonal is a correlation; adding to
     * the latter shears the ellipse rather than widening it, which tilts every sub-pixel splat by
     * an amount that grows as it shrinks.
     */
    expect(SPLAT_VERT).toContain('screen[0][0] += 0.3;');
    expect(SPLAT_VERT).toContain('screen[1][1] += 0.3;');
    expect(SPLAT_VERT).not.toContain('screen[0][1] +=');
  });

  it('caps the semi-axes, so one splat cannot cost the whole frame', () => {
    expect(SPLAT_VERT).toContain('512.0');
    expect(SPLAT_VERT).toMatch(/min\(2\.0 \* sqrt\(lambda1\), 512\.0\)/);
  });

  it('degenerates rather than clamping past the end of the order', () => {
    /*
     * Clamping would draw the last splat once per slot past the end, which is a bright speck that
     * moves when the budget changes — and reads as a sorting fault rather than as a bounds one.
     */
    expect(SPLAT_VERT).toContain('if (slot >= uSplatCount)');
  });
});

/**
 * Source-level assertions on view-dependent colour, which is the half of it a picture cannot check.
 *
 * A capture's sheen looks plausible from any one angle whichever sign convention it was evaluated
 * in, so what a capture proves is that the term is *there*; these say it is the right term, applied
 * once, behind a gate that a capture without harmonics never opens.
 */
describe('view-dependent colour', () => {
  it('applies the l=1 band constant and no other, in the reference sign convention', () => {
    /*
     * `−C1·y·c0 + C1·z·c1 − C1·x·c2`. Reproducing that sign pattern from first principles is where
     * a reimplementation goes wrong, and the failure is a sheen on the wrong side of every surface.
     */
    expect(SPLAT_VERT).toContain('const float SH_C1 = 0.4886025119029199;');
    expect(SPLAT_VERT).toContain(
      'return SH_C1 * (-direction.y * c0 + direction.z * c1 - direction.x * c2);',
    );
    /* The band-0 constant belongs to the reader, which folds it into the colour. Not here. */
    expect(SPLAT_VERT, "the DC constant is the reader's").not.toContain('0.28209479177387814');
  });

  it('is gated on a uniform, so a capture without harmonics fetches nothing', () => {
    /*
     * A uniform is provably uniform control flow, so this is not the 2026-08-07 case and no
     * compiler flattens it into paying for both arms. The third texel is fetched *inside* the
     * branch, which is what makes the gate a saving rather than a decoration.
     */
    expect(SPLAT_VERT).toContain('if (uSplatShDegree > 0) {');
    const gate = SPLAT_VERT.indexOf('if (uSplatShDegree > 0) {');
    const fetch = SPLAT_VERT.indexOf('fetchTexel(splat, 2)');
    expect(fetch, 'the third texel is read at all').toBeGreaterThan(0);
    expect(fetch, 'and only behind the gate').toBeGreaterThan(gate);
  });

  it('reads the record width from a uniform rather than assuming two texels', () => {
    /*
     * The width is the *file's* — a `SPLT` block carries its own `wordsPerSplat`. A shader that
     * assumed two would read a three-texel capture's second splat at the first one's covariance,
     * which is a cloud of noise rather than a subtle error.
     */
    expect(SPLAT_VERT).toContain('uniform int uSplatTexels;');
    expect(SPLAT_VERT).toContain('int at = splat * uSplatTexels + which;');
    expect(SPLAT_VERT, 'no hard-coded stride left').not.toContain('uSplatStride * 2');
  });

  it("takes the view direction in the capture's own space, not the world's", () => {
    /*
     * The coefficients were trained in the capture's frame, so a capture turned into a scene by
     * `uModel` must have its direction expressed in that frame. A world-space direction gives a
     * sheen that stays put while the capture turns underneath it — which reads as a lighting bug.
     */
    expect(SPLAT_VERT).toContain('uniform vec3 uSplatCameraLocal;');
    expect(SPLAT_VERT).toContain('normalize(centre - uSplatCameraLocal)');
    /* `centre` is the capture-space position, before `uModel` has been applied to it. */
    expect(SPLAT_VERT.indexOf('normalize(centre - uSplatCameraLocal)')).toBeLessThan(
      SPLAT_VERT.indexOf('vec4 world = uModel * vec4(centre, 1.0);'),
    );
  });

  it('clamps the sum at zero from below and nowhere from above', () => {
    /*
     * A negative radiance is not a colour and the reference implementation clamps in the same
     * place. **Not clamped above**: the composite downstream is where a range is resolved, and
     * clipping here would throw away exactly the highlight this band exists to produce.
     */
    expect(SPLAT_VERT).toContain('vec3(0.0));');
    expect(SPLAT_VERT).not.toContain('clamp(vColor.rgb');
  });
});
