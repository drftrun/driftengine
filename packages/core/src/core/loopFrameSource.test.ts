import { describe, expect, it, vi } from 'vitest';
import { startLoop } from './loop.ts';
import type { FrameSource } from './loop.ts';

/**
 * Who asks for the next frame, and what that frame carries.
 *
 * **A session runs on the headset's clock and the window does not.** An immersive session produces
 * frames through `session.requestAnimationFrame` at whatever rate its display runs, and the
 * callback carries the object every pose is read from. A loop that kept calling the window's
 * version inside a session would draw at the page's rate into a display that wanted something
 * else.
 *
 * The frame is carried through `render` untouched, and this file asserts that it arrives rather
 * than what is in it: core has no business naming an `XRFrame`, and a test that reached inside one
 * would be this package learning a type it deliberately does not import.
 */

/** A source under the test's control, so a frame happens when the test says so and never otherwise. */
function manualSource(): FrameSource & {
  fire(timeMs: number, frame?: unknown): void;
  pending: number;
  cancelled: number[];
} {
  let next: ((timeMs: number, frame?: unknown) => void) | null = null;
  let handle = 0;
  const cancelled: number[] = [];
  return {
    pending: 0,
    cancelled,
    requestAnimationFrame(callback) {
      next = callback;
      return ++handle;
    },
    cancelAnimationFrame(id) {
      cancelled.push(id);
      next = null;
    },
    fire(timeMs, frame) {
      const callback = next;
      next = null;
      callback?.(timeMs, frame);
    },
  };
}

/*
 * `simulate` and not `fixedUpdate`, which the first draft of this file wrote and vitest accepted:
 * types are stripped at run time, so six cases passed while `npm run typecheck` was red on all six.
 * That is the split `feedback_build_each_consumer_on_release` names, inside one repository.
 */
const hooks = () => ({ simulate: vi.fn(), render: vi.fn() });

describe('a loop driven by something other than the window', () => {
  it('asks the supplied source for frames and never the window', () => {
    /* Stubbed rather than spied: this environment has no `requestAnimationFrame` at all, which is
       also why `loop.test.ts` stubs it. A spy would fail on the absence and say nothing about the
       claim. */
    const windowRaf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', windowRaf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const source = manualSource();
    const request = vi.spyOn(source, 'requestAnimationFrame');

    const stop = startLoop(hooks(), { frameSource: source });
    expect(request).toHaveBeenCalled();
    expect(windowRaf).not.toHaveBeenCalled();

    stop();
    vi.unstubAllGlobals();
  });

  /**
   * **The frame reaches `render` unread.** It is the only route a package outside core has to the
   * poses in it, and core hands it on without looking, which is what `frame?: unknown` is saying.
   */
  it('carries whatever the source delivered through to render', () => {
    const source = manualSource();
    const h = hooks();
    const stop = startLoop(h, { frameSource: source });

    const delivered = { views: ['left', 'right'] };
    source.fire(16, delivered);

    expect(h.render).toHaveBeenCalled();
    const call = h.render.mock.calls.at(-1);
    expect(call?.[3]).toBe(delivered);
    stop();
  });

  /** Under the window there is no frame, and `undefined` is the honest answer rather than a stub. */
  it('passes undefined when the source delivers nothing', () => {
    const source = manualSource();
    const h = hooks();
    const stop = startLoop(h, { frameSource: source });

    source.fire(16);

    expect(h.render.mock.calls.at(-1)?.[3]).toBeUndefined();
    stop();
  });

  it('keeps asking the source, frame after frame', () => {
    const source = manualSource();
    const request = vi.spyOn(source, 'requestAnimationFrame');
    const h = hooks();
    const stop = startLoop(h, { frameSource: source });

    const before = request.mock.calls.length;
    source.fire(16, { n: 1 });
    source.fire(32, { n: 2 });
    source.fire(48, { n: 3 });

    expect(request.mock.calls.length).toBe(before + 3);
    expect(h.render.mock.calls.at(-1)?.[3]).toEqual({ n: 3 });
    stop();
  });

  /** Stopping has to cancel through the same source, or a session keeps a dead loop alive. */
  it('cancels through the source it was given', () => {
    const source = manualSource();
    const stop = startLoop(hooks(), { frameSource: source });
    stop();
    expect(source.cancelled.length).toBe(1);
  });

  /**
   * **A source that supplies the frames supplies the timebase, and the loop may not mix in another.**
   *
   * `last` used to be seeded with `performance.now()` — a process uptime in Node, a page age in a
   * browser — while every frame's `now` arrives from the source. For the window the two share an
   * origin and nothing is wrong. For anything else they do not: the synthetic session in
   * `@driftengine/xr` delivers `advance(16)`, and subtracting a process uptime from sixteen gives a
   * hugely negative first delta. The accumulator goes negative with it and **the simulation stops
   * ticking entirely** until it climbs back to zero, which is one stalled frame for every sixteen
   * milliseconds the process had been alive.
   *
   * Stubbed at 100_000 because vitest's real `performance.now()` is a few seconds at most and the
   * bug would then hide behind `maxFrameTime`. A browser tab open for two minutes reaches this.
   */
  it('takes its timebase from the source rather than the process clock', () => {
    vi.stubGlobal('performance', { now: () => 100_000 });
    const source = manualSource();
    const h = hooks();
    const stop = startLoop(h, { frameSource: source });

    /* A session that has just started, counting from its own zero. */
    source.fire(16);
    source.fire(32);
    source.fire(48);

    expect(h.simulate, 'three frames of a session must simulate').toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
  });

  /** And the first frame of such a source advances nothing, because nothing has elapsed yet. */
  it('treats the first frame from a source as zero elapsed', () => {
    vi.stubGlobal('performance', { now: () => 100_000 });
    const source = manualSource();
    const h = hooks();
    const stop = startLoop(h, { frameSource: source });

    source.fire(5_000);
    expect(h.simulate, 'the session was not running before its first frame').not.toHaveBeenCalled();

    source.fire(5_020);
    expect(h.simulate, 'and twenty milliseconds later it is').toHaveBeenCalledTimes(1);
    stop();
    vi.unstubAllGlobals();
  });

  /**
   * **The control, and the reason this option is optional.** Every existing caller passes no source
   * and must keep using the window, so a default that quietly changed the frame driver would be a
   * change to every game that never asked for one.
   */
  it('uses the window when no source is given', () => {
    const windowRaf = vi.fn(() => 7);
    const windowCancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', windowRaf);
    vi.stubGlobal('cancelAnimationFrame', windowCancel);

    const stop = startLoop(hooks());
    expect(windowRaf).toHaveBeenCalled();
    stop();
    expect(windowCancel).toHaveBeenCalledWith(7);

    vi.unstubAllGlobals();
  });
});
