import { EventEmitter } from 'node:events';

import { describe, expect, test } from 'vitest';

import { applyComposition, createTextModel } from '@driftengine/ui2d';
import { createNativeTextHost } from './textHost.ts';
import type { CompositionUpdate } from './textHost.ts';

/**
 * **What this file is for: typing into an editor field on a host with no text input element.** The
 * editor takes its text services as a `TextHost` and applies what arrives with `applyComposition`,
 * the same on every host. SDL hands the host committed text — a key, or what an input method
 * finished composing — so each arrives as a finished composition, applied on the editor's frame
 * rather than inside SDL's event. The clipboard is SDL's.
 */

function setUp() {
  const window = new EventEmitter();
  let clip = 'from elsewhere';
  const clipboard = {
    get text() {
      return clip;
    },
    setText(text: string) {
      clip = text;
    },
  };
  const host = createNativeTextHost(window, clipboard);
  return { window, host, clip: () => clip };
}

describe('text on the native host', () => {
  test('WHAT IS TYPED INTO A FOCUSED FIELD ARRIVES AS FINISHED TEXT, in order, on the editor’s frame', () => {
    const { window, host } = setUp();
    host.focusField(10, 20, 200, 18);
    window.emit('textInput', { text: 'dé' });
    window.emit('textInput', { text: '日本' });
    const updates: CompositionUpdate[] = [];
    expect(host.drainCompositions(updates)).toBe(2);
    const model = createTextModel('');
    for (const update of updates) applyComposition(model, update);
    expect(model.text).toBe('dé日本');
    /* Drained once: the next frame has nothing to fold in. */
    expect(host.drainCompositions(updates)).toBe(0);
  });

  test('TEXT TYPED WITH NO FIELD FOCUSED IS NOT THE EDITOR’S', () => {
    const { window, host } = setUp();
    window.emit('textInput', { text: 'lost' });
    host.focusField(0, 0, 10, 10);
    host.blurField();
    window.emit('textInput', { text: 'also lost' });
    expect(host.drainCompositions([])).toBe(0);
  });

  test('THE CLIPBOARD IS THE DESKTOP’S', async () => {
    const { host, clip } = setUp();
    expect(await host.readClipboard()).toBe('from elsewhere');
    await host.writeClipboard('copied');
    expect(clip()).toBe('copied');
  });
});
