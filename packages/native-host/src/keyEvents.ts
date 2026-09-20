/**
 * Keys, as a page hears them: `keydown`, `keypress` and `keyup`, each a `KeyboardEvent` carrying
 * the `code`, the `key`, the location and the legacy codes Chrome sends.
 *
 * **A key down waits for its character.** SDL reports a key and the text it typed as two events,
 * the key first, and the text is the layout's answer to what was typed: `!` for shift and 1 on a US
 * board, `é` through a dead key. That is what a browser puts in `key`, and what a `keypress`
 * carries. Both arrive in one drain of SDL's queue, so a key down is held until its text, the next
 * event of any other kind, or the end of that drain, whichever is first — never across a frame.
 *
 * **A `keypress` is sent only for a key that typed something**, and for Enter, which SDL types
 * nothing for and Chrome gives a carriage return; a key down a listener prevented sends none, as in
 * Chrome. Ctrl with a letter types nothing in SDL either, which is Chrome's rule too.
 *
 * What it gives up: a key that composes, through an input method, reports what it composed to the
 * text host alone (`textHost.ts`), and its key down names the key SDL saw; and with Ctrl held, a
 * shifted symbol's `key` is the unshifted one, since no text says otherwise.
 */

import { codeOf, keyLocation, keyOf, legacyKeyCode } from './keyCodes.ts';
import { KeyboardEvent, type ModifierInit } from './uiEvents.ts';

export interface SdlKey {
  readonly scancode: number;
  readonly key: string | null;
  /**
   * Whether this key is an auto-repeat. **A number by SDL's declaration and not always by its
   * behaviour**, so both shapes are accepted and `isRepeat` decides; see its note.
   */
  readonly repeat?: number | boolean;
  readonly shift: number;
  readonly ctrl: number;
  readonly alt: number;
  readonly super: number;
  readonly altgr?: number;
  readonly capslock?: number;
  readonly numlock?: number;
}

/** The modifiers an SDL key event reports, as a browser's event carries them. */
export function modifiersOf(event: SdlKey): ModifierInit {
  return {
    shiftKey: event.shift !== 0,
    ctrlKey: event.ctrl !== 0,
    altKey: event.alt !== 0,
    metaKey: event.super !== 0,
    modifierAltGraph: (event.altgr ?? 0) !== 0,
    modifierCapsLock: (event.capslock ?? 0) !== 0,
    modifierNumLock: (event.numlock ?? 0) !== 0,
  };
}

export class KeyEvents {
  private pending: { readonly event: SdlKey; text: string | null } | null = null;

  /**
   * `target` is where a key goes: the focused element, or the document with nothing focused.
   * `activate` is told of each key down but Escape, a person's gesture as a browser counts one.
   */
  constructor(
    private readonly target: () => EventTarget,
    private readonly activate: () => void = () => undefined,
  ) {}

  down(event: SdlKey): void {
    this.flush();
    this.pending = { event, text: null };
    queueMicrotask(() => this.flush());
  }

  /** A key's character, or a composition's, which is the text host's and not a key's. */
  text(text: string): void {
    const pending = this.pending;
    if (pending === null) return;
    if ([...text].length === 1) pending.text = text;
    this.flush();
  }

  up(event: SdlKey): void {
    this.flush();
    const key = keyOf(event.key, event.scancode, event.shift !== 0);
    this.send('keyup', event, key, 0);
  }

  /** Send the key down being held, and its `keypress` if it typed. */
  flush(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    const { event, text } = pending;
    const key = text ?? keyOf(event.key, event.scancode, event.shift !== 0);
    if (key !== 'Escape') this.activate();
    const down = this.send('keydown', event, key, 0);
    if (down.defaultPrevented) return;
    const typed = text ?? (key === 'Enter' ? '\r' : null);
    if (typed !== null) this.send('keypress', event, key, typed.codePointAt(0) ?? 0);
  }

  private send(type: string, event: SdlKey, key: string, charCode: number): KeyboardEvent {
    const code = codeOf(event.scancode) ?? '';
    const sent = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key,
      code,
      location: keyLocation(code),
      repeat: isRepeat(event.repeat),
      keyCode: charCode !== 0 ? charCode : legacyKeyCode(code, key),
      charCode,
      detail: 0,
      ...modifiersOf(event),
    });
    this.target().dispatchEvent(sent);
    return sent;
  }
}

/**
 * Whether the platform is calling this key a repeat, for either shape it might say it in.
 *
 * **`(repeat ?? 0) !== 0` was inverted for a boolean**, and that is the whole of a bug that made
 * the engine deaf to held keys: `false !== 0` is `true`, so a platform answering `repeat: false`
 * marked *every* press a repeat, and `InputSource` discards a repeat outright so that a held key
 * cannot re-fire a press. Taps handled on the edge — a hotbar digit — kept working, which is what
 * made it so hard to see: the keyboard was plainly delivering keys and the player would not walk.
 *
 * SDL's own types declare a number and this took the declaration at its word. **A number is what it
 * promises and not what it was giving**, which is why this reads the value rather than its type:
 * anything positive, or `true`, is a repeat, and everything else — `0`, `false`, absent — is a
 * first press.
 */
function isRepeat(repeat: number | boolean | undefined): boolean {
  if (typeof repeat === 'boolean') return repeat;
  return typeof repeat === 'number' && repeat > 0;
}
