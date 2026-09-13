import { describe, expect, it, vi } from 'vitest';

import { BrowserFileDialogs } from './files.ts';

describe('BrowserFileDialogs', () => {
  it('answers null when the person cancels', async () => {
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => {
        throw new DOMException('abort', 'AbortError');
      }),
    );
    expect(await new BrowserFileDialogs().openFile(['.drft'])).toBeNull();
    vi.unstubAllGlobals();
  });

  /*
   * A cancel and a missing API are different answers. Returning null for both would make a
   * browser with no picker look like a person who changed their mind, and the editor would
   * show nothing rather than saying why.
   */
  it('reports loudly when the browser has no picker at all', async () => {
    vi.stubGlobal('showOpenFilePicker', undefined);
    await expect(new BrowserFileDialogs().openFile(['.drft'])).rejects.toThrow(/no file picker/i);
    vi.unstubAllGlobals();
  });

  it('hands back the bytes the person chose', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => [
        {
          getFile: async () => ({
            name: 'world.drft',
            arrayBuffer: async () => bytes.buffer,
          }),
        },
      ]),
    );
    const opened = await new BrowserFileDialogs().openFile(['.drft']);
    expect(opened?.name).toBe('world.drft');
    expect([...(opened?.bytes ?? [])]).toEqual([1, 2, 3, 4]);
    vi.unstubAllGlobals();
  });

  it('answers false when a save is cancelled', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => {
        throw new DOMException('abort', 'AbortError');
      }),
    );
    expect(await new BrowserFileDialogs().saveFile('a.drft', new Uint8Array(1))).toBe(false);
    vi.unstubAllGlobals();
  });
});
