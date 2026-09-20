/**
 * The editor's text services on this host: `@driftengine/ui2d`'s `TextHost`, over SDL.
 *
 * **Committed text, as a finished composition.** SDL delivers `textInput` — a key's character, or
 * what an input method finished composing — and each one reaches the editor through the same
 * `applyComposition` the browser host feeds, marked done. Queued, not applied, because it arrives on
 * SDL's schedule and the editor applies text on its own frame, as the browser host's queue does
 * (`editor/src/host/browser/textHost.ts`). Text arriving with no field focused is not the editor's.
 *
 * **The clipboard is SDL's**, which is the desktop's.
 *
 * What it gives up, both of them `@kmamal/sdl` 0.11's: it reports no composition in progress
 * (`textEditing`), so an input method shows its unfinished text in its own window rather than in
 * the field; and it cannot place that window, so `focusField`'s rectangle is kept and not used.
 */

import type { TextHost } from '@driftengine/ui2d';

/** One update, in the shape `applyComposition` takes. */
export interface CompositionUpdate {
  text: string;
  done: boolean;
}

/** What this reads of the SDL window. */
export interface TextWindow {
  on(type: 'textInput', listener: (event: { text: string }) => void): unknown;
}

/** SDL's clipboard. */
export interface TextClipboard {
  readonly text: string;
  setText(text: string): void;
}

export interface NativeTextHost extends TextHost {
  /** Take the text that has arrived, oldest first, and clear the queue. */
  drainCompositions(out: CompositionUpdate[]): number;
}

export function createNativeTextHost(window: TextWindow, clipboard: TextClipboard): NativeTextHost {
  const pending: CompositionUpdate[] = [];
  let focused = false;
  window.on('textInput', ({ text }) => {
    if (focused) pending.push({ text, done: true });
  });
  return {
    focusField() {
      focused = true;
    },
    blurField() {
      focused = false;
    },
    readClipboard: () => Promise.resolve(clipboard.text),
    writeClipboard(text) {
      clipboard.setText(text);
      return Promise.resolve();
    },
    drainCompositions(out) {
      out.length = 0;
      for (const update of pending) out.push(update);
      pending.length = 0;
      return out.length;
    },
  };
}
