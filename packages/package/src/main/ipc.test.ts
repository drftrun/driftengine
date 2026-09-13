import { describe, expect, it, vi } from 'vitest';

/**
 * The two handlers that answer one question, held to answering it the same way.
 *
 * **Reported from outside 2026-08-28: asking whether a window could be resized meant resizing it.**
 * `false` from `setSize` was the only signal, so a settings screen that wanted to decide whether to
 * draw a resolution control had to call the mutator to find out. The reporter's workaround was a
 * no-op probe at boot — `setSize(...size())` — and they named its fragility themselves: it depends
 * on two calls continuing to address the same property, and nothing checked that.
 *
 * `drift:canSetSize` replaces the probe, and this replaces the thing nobody was checking. The
 * hazard moved rather than disappearing: a question and a refusal are two handlers now, and a pair
 * that drifted would give a game a greyed control that works or a live one that does nothing. They
 * are one function in `ipc.ts`; these drive both against the same window and assert they agree.
 */
const handlers = new Map<
  string,
  (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
>();

vi.mock('electron', () => ({
  ipcMain: {
    on: (
      channel: string,
      handler: (event: { returnValue?: unknown }, ...args: unknown[]) => void,
    ) => {
      handlers.set(channel, handler);
    },
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler as never);
    },
  },
  /* Named because `installIpc` imports them; nothing below reaches one. */
  BrowserWindow: {},
  app: { getPath: () => '/tmp', quit: () => undefined, on: () => undefined },
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ id: 0 }), getAllDisplays: () => [] },
}));

const { installIpc } = await import('./ipc.ts');

/** A window that is only as much of one as these two handlers touch. */
const windowLike = (options: { fullscreen: boolean }) => {
  const sized: number[] = [];
  return {
    window: {
      isFullScreen: () => options.fullscreen,
      setContentSize: (width: number, height: number) => void sized.push(width, height),
      getContentSize: () => [1280, 720],
    },
    sized,
  };
};

const ask = (channel: string, ...args: unknown[]): unknown => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  const event: { returnValue?: unknown } = {};
  const returned = handler(event, ...args);
  return event.returnValue ?? returned;
};

describe('whether a resize would work, and the resize itself', () => {
  it('agree while the window is ordinary', async () => {
    const { window, sized } = windowLike({ fullscreen: false });
    installIpc({}, () => window as never);
    expect(ask('drift:canSetSize')).toBe(true);
    expect(await ask('drift:setSize', 1920, 1080)).toBe(true);
    expect(sized).toEqual([1920, 1080]);
  });

  /**
   * **The case the pair exists for.** A shell refuses a resize while its window is covering a
   * display, because Chromium never takes an exclusive fullscreen and resizing out from under a
   * fullscreen state would silently leave it. A question that answered `true` there would grey
   * nothing and offer a control that does nothing.
   */
  it('agree while the window is covering a display, and nothing is resized', async () => {
    const { window, sized } = windowLike({ fullscreen: true });
    installIpc({}, () => window as never);
    expect(ask('drift:canSetSize')).toBe(false);
    expect(await ask('drift:setSize', 1920, 1080)).toBe(false);
    expect(sized, 'the refusal did not resize it on the way to refusing').toEqual([]);
  });

  it('agree when there is no window at all', async () => {
    installIpc({}, () => null);
    expect(ask('drift:canSetSize')).toBe(false);
    expect(await ask('drift:setSize', 1920, 1080)).toBe(false);
  });

  it('asks without touching the window', () => {
    const { window, sized } = windowLike({ fullscreen: false });
    installIpc({}, () => window as never);
    ask('drift:canSetSize');
    expect(sized).toEqual([]);
  });
});
