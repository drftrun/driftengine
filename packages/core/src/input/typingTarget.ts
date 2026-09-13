/**
 * Whether the keystroke belongs to a text field rather than to the game.
 *
 * An input layer that swallows keys while somebody is typing is a text field that
 * silently drops characters. A consumer found this the hard way: it asks for
 * `Space`, `KeyE` and the arrows to be `preventDefault`ed — reasonably, since Space
 * scrolls the page and the arrows move it — and a player writing a bug report could
 * not type a space, an `e`, or move the caret.
 *
 * Game-agnostic and deliberately conservative: it asks what the event is *for*, not
 * what the game wants. A consumer that genuinely wants keys while a field has focus
 * can read `keys` directly; nothing here stops that.
 */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * `INPUT` covers buttons and checkboxes too, which do not take text — but a Space on a
 * focused button is the browser's own "press it", so leaving those alone is right for
 * the same reason.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  const element = target as Partial<HTMLElement> & { tagName?: string };
  if (typeof element.tagName === 'string' && TYPING_TAGS.has(element.tagName)) return true;
  return element.isContentEditable === true;
}
