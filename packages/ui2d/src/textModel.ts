/**
 * A caret, a selection, and the operations that move them.
 *
 * **Pure, and it is pure on purpose.** Every editing defect anybody has met lives here rather than
 * in the platform: a caret inside a character, a right-to-left selection that deletes the wrong
 * end, a backspace that removes half an emoji. Pure, each of those is a test that runs in under a
 * millisecond. Wired to a host, none of them is.
 *
 * **Offsets are into the string and are always on a code-point boundary.** JavaScript strings are
 * UTF-16, so an astral character is two units and a caret between them is a caret inside a
 * character — which renders as a replacement glyph and deletes as a lone surrogate. Every move and
 * every delete steps over the pair.
 *
 * `anchor` is where a selection started and `caret` is where it is now, so `anchor > caret` is an
 * ordinary right-to-left selection rather than an error. `selectionRange` is the only thing that
 * orders them and everything else goes through it.
 */
export interface TextModel {
  text: string;
  /** Where the caret is, as a UTF-16 offset on a code-point boundary. */
  caret: number;
  /** Where the current selection began. Equal to `caret` when nothing is selected. */
  anchor: number;
  /**
   * The range an in-progress composition occupies, or -1 when none is in progress.
   *
   * Written only by `applyComposition` in `textHost.ts`. It lives on the model rather than in the
   * host because the range is a property of the text, and a host that crashed mid-composition
   * would otherwise leave the field permanently convinced it was still composing.
   */
  composeFrom: number;
  composeTo: number;
}

export function createTextModel(text = ''): TextModel {
  return { text, caret: text.length, anchor: text.length, composeFrom: -1, composeTo: -1 };
}

export function selectionRange(model: TextModel): { from: number; to: number } {
  return model.anchor <= model.caret
    ? { from: model.anchor, to: model.caret }
    : { from: model.caret, to: model.anchor };
}

export function selectedText(model: TextModel): string {
  const { from, to } = selectionRange(model);
  return model.text.slice(from, to);
}

/** Whether the unit at `at` is the low half of a surrogate pair, so `at` is mid-character. */
function insidePair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const low = text.charCodeAt(at);
  const high = text.charCodeAt(at - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
}

function stepRight(text: string, at: number): number {
  const next = Math.min(text.length, at + 1);
  return insidePair(text, next) ? Math.min(text.length, next + 1) : next;
}

function stepLeft(text: string, at: number): number {
  const next = Math.max(0, at - 1);
  return insidePair(text, next) ? Math.max(0, next - 1) : next;
}

function replaceSelection(model: TextModel, s: string): void {
  const { from, to } = selectionRange(model);
  model.text = model.text.slice(0, from) + s + model.text.slice(to);
  model.caret = from + s.length;
  model.anchor = model.caret;
}

export function insertText(model: TextModel, s: string): void {
  replaceSelection(model, s);
}

export function deleteBackward(model: TextModel): void {
  if (model.anchor !== model.caret) {
    replaceSelection(model, '');
    return;
  }
  const from = stepLeft(model.text, model.caret);
  model.text = model.text.slice(0, from) + model.text.slice(model.caret);
  model.caret = from;
  model.anchor = from;
}

export function deleteForward(model: TextModel): void {
  if (model.anchor !== model.caret) {
    replaceSelection(model, '');
    return;
  }
  const to = stepRight(model.text, model.caret);
  model.text = model.text.slice(0, model.caret) + model.text.slice(to);
  model.anchor = model.caret;
}

export function moveCaret(model: TextModel, delta: number, select: boolean): void {
  let at = model.caret;
  const steps = Math.abs(delta);
  for (let i = 0; i < steps; i += 1) {
    at = delta > 0 ? stepRight(model.text, at) : stepLeft(model.text, at);
  }
  model.caret = at;
  if (!select) model.anchor = at;
}

export function moveToLineEdge(model: TextModel, forward: boolean, select: boolean): void {
  let at: number;
  if (forward) {
    const found = model.text.indexOf('\n', model.caret);
    at = found === -1 ? model.text.length : found;
  } else {
    const found = model.text.lastIndexOf('\n', Math.max(0, model.caret - 1));
    at = found === -1 ? 0 : found + 1;
  }
  model.caret = at;
  if (!select) model.anchor = at;
}

export function selectAll(model: TextModel): void {
  model.anchor = 0;
  model.caret = model.text.length;
}
