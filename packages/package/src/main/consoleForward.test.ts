import { describe, expect, it } from 'vitest';

import { consoleLine, forwardsConsole } from './consoleForward.ts';

/**
 * Both shapes are taken from the Electron each was measured against, argument for argument.
 *
 * The newer one was captured by running the pinned Electron and logging every argument a listener
 * received: five of them, the first an object carrying `level: 'error'` and `message`, followed by
 * the deprecated positional level, message, line and source.
 *
 * **The older one is fully positional, and its own typings say it is not.** `electron.d.ts` at
 * 33.4.11 declares `(event, messageDetails)` with the details as an object; a probe against that
 * binary receives `(event, 3, 'the line', 1, 'the source')`, with nothing on the event. Reading the
 * typings is what produced a first version of this module that handled two object shapes and
 * forwarded nothing at all on the runtime it was written to rescue — so the positional case below
 * is the one that matters, and the object-second case is kept only because the typings promise it.
 */
describe('reading a console line off either event shape', () => {
  it('reads the newer shape, where the first argument carries a string level', () => {
    const line = consoleLine(
      { level: 'error', message: 'hello from the renderer' },
      3,
      'hello from the renderer',
    );
    expect(line).toEqual({ level: 'error', message: 'hello from the renderer' });
  });

  /** The shape a probe against Electron 33.4.11 actually received, argument for argument. */
  it('reads the older shape, which is positional and carries nothing on its event', () => {
    const line = consoleLine({}, 3, 'hello from the renderer');
    expect(line).toEqual({ level: 'error', message: 'hello from the renderer' });
  });

  /** 0 to 3 is verbose, info, warning, error, and the middle of that range is the one worth naming. */
  it('numbers the older levels the way that event numbers them', () => {
    expect(consoleLine({}, 2, 'a warning')?.level).toBe('warning');
    expect(consoleLine({}, 0, 'chatter')?.level).toBe('verbose');
    expect(consoleLine({}, 1, 'info')?.level).toBe('info');
  });

  /** And the shape those typings promise, kept because keeping it costs one branch. */
  it('still reads a details object in the second position', () => {
    expect(consoleLine({}, { level: 3, message: 'from an object' }, undefined)).toEqual({
      level: 'error',
      message: 'from an object',
    });
  });

  /*
   * The newer event passes its deprecated positional arguments too, so both readings are available
   * at once and they must agree. The object wins, because it is the one that is not deprecated.
   */
  it('prefers the object when a newer event also passes the positional arguments', () => {
    expect(
      consoleLine({ level: 'warning', message: 'from the object' }, 3, 'from the position'),
    ).toEqual({ level: 'warning', message: 'from the object' });
  });

  it('takes the positional message when an object carried a level without one', () => {
    expect(consoleLine({ level: 'warning' }, 2, 'from the third argument')).toEqual({
      level: 'warning',
      message: 'from the third argument',
    });
  });

  /** Anything else is not a line, and must not be forwarded as one with an invented level. */
  it('answers nothing when neither argument carries a level', () => {
    expect(consoleLine({}, {}, undefined)).toBe(null);
    expect(consoleLine(undefined, undefined, undefined)).toBe(null);
    expect(consoleLine({ level: 'shouting' }, {}, 'x')).toBe(null);
    expect(consoleLine({ level: 9 }, {}, 'x')).toBe(null);
  });
});

describe('what is worth forwarding', () => {
  it('forwards an error from a shipped build, which is what a bug report can quote', () => {
    expect(forwardsConsole('error', false)).toBe(true);
  });

  it('keeps warnings out of a shipped build and in a development one', () => {
    expect(forwardsConsole('warning', false)).toBe(false);
    expect(forwardsConsole('warning', true)).toBe(true);
  });

  it('never forwards the levels a game logs per frame', () => {
    for (const development of [true, false]) {
      expect(forwardsConsole('info', development)).toBe(false);
      expect(forwardsConsole('verbose', development)).toBe(false);
      expect(forwardsConsole('debug', development)).toBe(false);
    }
  });
});
