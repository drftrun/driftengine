import { afterEach, expect, test, vi } from 'vitest';
import { setUniformStrictMode, uniformLocations } from './shader.ts';

/**
 * A uniform written while a different program is bound, which is the failure that poisons
 * every `getError` downstream of it.
 *
 * **The bug this was written from.** A renderer binds its main program once per frame and
 * then interrupts that pass with every other one it has — water, particles, plumes, a
 * flock, bolts, streaks, film, the sky — each binding a program of its own. Any main-pass
 * call issued after one of those interruptions writes a location belonging to a program
 * that has not been current since. WebGL answers `INVALID_OPERATION`, the value never
 * arrives, and the draw that follows runs through whichever program *is* bound, because a
 * draw call takes the program it finds rather than the one whose uniforms were just
 * written. Measured on two demo scenes: a translucent shaft drew through the particle
 * program, and a lighthouse optic drew through the flock program, both every frame.
 *
 * **Why it is worth an instrument rather than a fix alone.** The error is not attached to
 * the call that raised it. It sits in the queue until the next `getError` anywhere in the
 * codebase reads it and concludes that whatever *that* check was testing has failed — which
 * is what happened: a depth-blit guard read this error as a driver refusing to resolve
 * depth and switched camera motion blur off for the session. One misbound uniform in one
 * scene is enough to make every capability check in the engine untrustworthy.
 *
 * No real GL, because what is under test is a rule about which program a location belongs
 * to. The fake reports whichever program it is told is bound, which is the only variable
 * that matters and the one a device cannot be made to vary on demand.
 */
const CURRENT_PROGRAM = 0x8b8d;

const FLAT = { id: 'flat' } as unknown as WebGLProgram;
const WATER = { id: 'water' } as unknown as WebGLProgram;

/** A context whose bound program the test moves, the way an interrupting pass would. */
function fakeGl(
  names: readonly string[],
  bound: { program: WebGLProgram },
): WebGL2RenderingContext {
  return {
    ACTIVE_UNIFORMS: 0x8b86,
    CURRENT_PROGRAM,
    getProgramParameter: () => names.length,
    getActiveUniform: (_program: WebGLProgram, index: number) => {
      const name = names[index];
      return name === undefined ? null : { name, size: 1, type: 0x8b50 };
    },
    getUniformLocation: (_program: WebGLProgram, name: string) =>
      ({ name }) as unknown as WebGLUniformLocation,
    getParameter: (parameter: number) => (parameter === CURRENT_PROGRAM ? bound.program : null),
  } as unknown as WebGL2RenderingContext;
}

afterEach(() => {
  setUniformStrictMode(false);
  vi.restoreAllMocks();
});

test('a lookup made while another program is bound is reported', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const bound = { program: FLAT };
  setUniformStrictMode(true);
  const u = uniformLocations(fakeGl(['uModel'], bound), FLAT, 'flat');

  // Inside the pass that bound it, which is every call this renderer got right.
  expect(u['uModel']).toBeDefined();
  expect(warn, 'the pass that bound the program is not the failure').not.toHaveBeenCalled();

  // Another pass interrupts, and the flat pass carries on writing to its own locations.
  bound.program = WATER;
  expect(u['uModel'], 'the location still resolves — that is what makes it silent').toBeDefined();
  expect(warn).toHaveBeenCalledTimes(1);
  const message = String(warn.mock.calls[0]?.[0]);
  expect(message, 'names the program and the uniform, so it can be found').toContain('flat.uModel');
  expect(message, 'says the error outlives the call, which is the part that costs').toContain(
    'getError',
  );
});

test('it reports once, because this fires every frame', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const bound = { program: WATER };
  setUniformStrictMode(true);
  const u = uniformLocations(fakeGl(['uModel'], bound), FLAT, 'flat');

  for (let frame = 0; frame < 100; frame++) void u['uModel'];
  expect(
    warn,
    'a diagnostic that floods the console is one somebody turns off',
  ).toHaveBeenCalledTimes(1);
});

test('a missing uniform and a misbound one are told apart', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const bound = { program: WATER };
  setUniformStrictMode(true);
  const u = uniformLocations(fakeGl(['uModel'], bound), FLAT, 'flat');

  expect(u['uNotDeclared']).toBeUndefined();
  expect(String(warn.mock.calls[0]?.[0]), 'a name the shader does not have').toContain(
    'has no uniform',
  );

  void u['uModel'];
  expect(warn, 'two distinct faults, two distinct reports').toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[1]?.[0])).toContain('different program is bound');
});

test('nothing is reported with strict mode off, whatever is bound', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const bound = { program: WATER };
  const u = uniformLocations(fakeGl(['uModel'], bound), FLAT, 'flat');

  void u['uModel'];
  void u['uNotDeclared'];
  /*
   * The default, and it has to stay the default: this asks the driver which program is
   * bound on every uniform lookup, which is a debug cost rather than a frame-loop one.
   */
  expect(warn).not.toHaveBeenCalled();
});
