import { describe, expect, it } from 'vitest';

import { Renderer } from './webgl2/renderer.ts';
import type { FrameTimer } from './timer.ts';
import type { RendererApi } from './api.ts';

/*
 * The surface both backends are checked against.
 *
 * **The value of this file is almost entirely in whether it compiles.** The plan this came
 * from proposed `Renderer extends RendererApi ? true : false` over a type derived from
 * `Renderer`, which is true by construction and can never fail — it would pass while the
 * surface was wrong in any way. What is asserted here instead is the one thing the
 * derivation does *not* give for free: that the WebGL-shaped members which cannot cross to
 * WebGPU have been widened, and that a backend holding no GL object can still satisfy it.
 */

/** Fails to compile when its argument is not exactly `true`. */
type Assert<T extends true> = T;

/*
 * Not a tautology, because `RendererApi` overrides `gpuTimer`: this holds only while
 * `GpuTimer` is assignable to `FrameTimer`, and stops holding the moment the timer grows a
 * member the WebGPU side cannot answer.
 */
type WebGl2SatisfiesTheSurface = Assert<Renderer extends RendererApi ? true : false>;

/**
 * The timer on the shared surface must be satisfiable with no WebGL object anywhere.
 *
 * Written out in full rather than cast, so that widening `FrameTimer` fails here and makes
 * somebody decide whether the new member is answerable by a backend that has no queries.
 */
const backendNeutralTimer: RendererApi['gpuTimer'] = {
  available: false,
  sampling: false,
  beginFrame: () => false,
  endFrame: () => {},
  begin: () => {},
  end: () => {},
  poll: () => null,
  lastFrameMs: () => null,
  dispose: () => {},
};

/**
 * The two members `ResolutionGovernor` drives, pinned to the *public* surface.
 *
 * **`RendererApi` carries both today, and nothing said so.** It is derived with `Omit` over
 * `keyof Renderer`, so a public member is on the surface by accident of not being in the omit
 * list — which is a fine way to build the type and a poor way to make a promise. Adding either
 * name to that list, or making either `private` while refactoring, would take the governor off
 * the public surface with no test anywhere going red.
 *
 * **Reported from outside 2026-08-28 as already broken**, which is the reason this exists rather
 * than a hypothetical. A consumer read the omit list, concluded neither member was reachable, and
 * shipped a structural runtime check that returns `null` when they are absent — eight lines and an
 * `unknown` standing in for a compile-time fact. Both members type-check straight off
 * `createRenderer(...).renderer`, in that consumer's own project and under its own stricter
 * `exactOptionalPropertyTypes`; the workaround was never needed. What was missing was not the
 * capability but the *assertion*, so a reader had no way to tell a deliberate part of the surface
 * from an accident of the derivation.
 *
 * Written as a value rather than as `Assert<...>`, so a failure names the member that moved
 * instead of reporting that `true` is not `true`.
 */
const governorDrives: {
  readonly resolutionScale: number;
  applyResolutionScale(scale: number): void;
} = {} as RendererApi;

describe('the renderer surface', () => {
  it('carries the two members the resolution governor needs', () => {
    /*
     * The compile-time half is `governorDrives` above. This half is the one a reader can act on:
     * both backends implement them, so a governor mounted on either drives a real density.
     */
    expect(Renderer.prototype).toHaveProperty('applyResolutionScale');
    expect(Object.getOwnPropertyDescriptor(Renderer.prototype, 'resolutionScale')?.get).toBeTypeOf(
      'function',
    );
    expect(governorDrives).toBeDefined();
  });

  it('is satisfied by the WebGL2 renderer', () => {
    const proof: WebGl2SatisfiesTheSurface = true;
    expect(proof).toBe(true);
  });

  /*
   * `gpuTimer` is the one member that cannot survive the derivation as-is: `GpuTimer` is
   * built on `WebGLQuery` and an extension most mobile browsers do not have. If this
   * compiles, a WebGPU renderer can report timing without pretending to own a GL query.
   */
  it('takes a frame timer that owns no GL object', () => {
    const timer: FrameTimer = backendNeutralTimer;
    expect(timer.available).toBe(false);
    expect(timer.lastFrameMs()).toBeNull();
  });

  /*
   * A runtime check over the names, which is what catches a rename that the type system
   * would happily follow across both backends at once.
   */
  it('names the methods a backend has to implement', () => {
    const required = ['beginFrame', 'endFrame', 'drawMesh', 'drawSky', 'createMesh', 'dispose'];
    for (const method of required) {
      expect(typeof (Renderer.prototype as unknown as Record<string, unknown>)[method]).toBe(
        'function',
      );
    }
  });
});

/**
 * The snap a caller needs to draw a bitmap glyph on whole device pixels, pinned to the surface.
 *
 * **A consumer cannot compute this itself, which is why it is here rather than left to arithmetic.**
 * `deviceSnappedCellSize` is exported and takes the ratio as two widths, but the second of them is
 * the renderer's own drawing buffer, and `RendererApi` carries `cssWidth` and `cssHeight` and
 * nothing about device pixels. So a consumer laying out text — which is a pure function over CSS
 * pixels in every game on this engine — had to thread a canvas down through its interface layer to
 * reach a number the renderer was already holding.
 *
 * It matters that the caller does the snapping rather than the draw: 4.1.4 imposed it, the
 * measurement could not see it, and every centred line in every consumer went off centre at once.
 * Snapped here and used for measuring, laying out and drawing, the picture and the arithmetic
 * cannot disagree.
 *
 * Pinned as a value for the reason `governorDrives` above gives: derived with `Omit`, a public
 * member is on the surface by accident of not being in the omit list, and a promise wants an
 * assertion that names the member when it moves.
 */
const snapsTextCells: {
  snapTextCellSize(cellSize: number, viewportWidth: number): number;
} = {} as RendererApi;

describe('the shared surface', () => {
  it('lets a caller snap a text cell to whole device pixels', () => {
    /*
     * The compile-time half is `snapsTextCells` above. This half is what a reader can act on, and
     * it asserts the prototype for the reason the governor's does: the derivation forces the
     * second backend to declare the member, and only this says the first one answers it.
     */
    expect(Renderer.prototype).toHaveProperty('snapTextCellSize');
    expect(snapsTextCells).toBeDefined();
  });
});
