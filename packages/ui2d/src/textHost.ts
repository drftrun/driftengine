/**
 * The platform services text entry needs, taken as a parameter.
 *
 * **Composition — the multi-keystroke entry every language that is not typed one character at a
 * time depends on — is a platform service.** The browser has one, a native host has a different
 * one, and a test has none. `AGENTS.md` requires a capability be taken as a parameter with a
 * browser implementation shipped as the default; this is that rule applied to text, and it is why
 * this package can run under a host with no document object model at all.
 */
import type { TextModel } from './textModel.ts';
import { selectionRange } from './textModel.ts';

export interface TextHost {
  /** Tell the host a field is focused at this rectangle, so it can place a composition window. */
  focusField(x: number, y: number, w: number, h: number): void;
  /** Tell the host nothing is focused. */
  blurField(): void;
  /** Read the clipboard, if the host has one. Asynchronous everywhere one exists. */
  readClipboard(): Promise<string>;
  /** Write the clipboard, if the host has one. */
  writeClipboard(text: string): Promise<void>;
}

/**
 * A host that focuses nothing and whose clipboard is empty.
 *
 * What a test uses, and what a headless build uses. **An empty clipboard rather than a missing
 * one**, so a caller never has to branch on whether it has a host.
 */
export function createNullTextHost(): TextHost {
  return {
    focusField() {},
    blurField() {},
    readClipboard: async () => '',
    writeClipboard: async () => {},
  };
}

/**
 * Fold one composition update into the model.
 *
 * An update replaces whatever the previous update of this composition put there, rather than the
 * whole field — which is what makes a five-keystroke entry produce one word instead of five.
 *
 * **`done` clears the range, and that is the step everyone forgets.** A finished composition that
 * leaves its range set means the *next* keystroke overwrites the text that was just committed,
 * which presents as characters vanishing one word behind the caret.
 */
export function applyComposition(model: TextModel, state: { text: string; done: boolean }): void {
  if (model.composeFrom === -1) {
    const { from, to } = selectionRange(model);
    model.text = model.text.slice(0, from) + state.text + model.text.slice(to);
    model.composeFrom = from;
    model.composeTo = from + state.text.length;
  } else {
    model.text =
      model.text.slice(0, model.composeFrom) + state.text + model.text.slice(model.composeTo);
    model.composeTo = model.composeFrom + state.text.length;
  }
  model.caret = model.composeTo;
  model.anchor = model.caret;
  if (state.done) {
    model.composeFrom = -1;
    model.composeTo = -1;
  }
}
