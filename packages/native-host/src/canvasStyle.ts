/**
 * A canvas's `style`, which a page writes to as it would a browser's: the cursor is the window's,
 * and anything else is kept and read back, meaning nothing without a layout.
 *
 * **A page sets a cursor on the canvas it draws in** — `grab` over a view it can drag, `pointer`
 * over a button, `none` in a first-person game — and a canvas with no `style` answered each with a
 * `TypeError` inside the page's handler. CSS names more cursors than SDL has, so each is the nearest
 * of SDL's twelve: `grab` and `grabbing` are its hand, as is `pointer`, since SDL has no open palm.
 * A cursor with fallbacks, `url(hand.png) 4 4, crosshair`, is its last keyword; an image cursor is
 * not drawn.
 */

/** SDL's system cursor for a CSS keyword, or null for `none`, which hides it. */
const SDL_CURSOR: Readonly<Record<string, string | null>> = {
  auto: 'arrow',
  default: 'arrow',
  pointer: 'hand',
  grab: 'hand',
  grabbing: 'hand',
  text: 'ibeam',
  'vertical-text': 'ibeam',
  wait: 'wait',
  progress: 'waitarrow',
  crosshair: 'crosshair',
  move: 'sizeall',
  'all-scroll': 'sizeall',
  'not-allowed': 'no',
  'no-drop': 'no',
  'ew-resize': 'sizewe',
  'col-resize': 'sizewe',
  'e-resize': 'sizewe',
  'w-resize': 'sizewe',
  'ns-resize': 'sizens',
  'row-resize': 'sizens',
  'n-resize': 'sizens',
  's-resize': 'sizens',
  'nwse-resize': 'sizenwse',
  'nw-resize': 'sizenwse',
  'se-resize': 'sizenwse',
  'nesw-resize': 'sizenesw',
  'ne-resize': 'sizenesw',
  'sw-resize': 'sizenesw',
  none: null,
};

/** The SDL cursor a CSS `cursor` value asks for: null to hide it, the arrow for one SDL lacks. */
export function sdlCursor(css: string): string | null {
  const keyword = css.split(',').at(-1)?.trim().toLowerCase() ?? '';
  const cursor = SDL_CURSOR[keyword];
  return cursor === undefined ? 'arrow' : cursor;
}

const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export class CanvasStyle {
  [property: string]: unknown;
  #cursor = '';
  readonly #onCursor: (css: string) => void;

  constructor(onCursor: (css: string) => void) {
    this.#onCursor = onCursor;
  }

  get cursor(): string {
    return this.#cursor;
  }

  set cursor(css: string) {
    this.#cursor = css;
    this.#onCursor(css);
  }

  setProperty(name: string, value: string): void {
    this[camel(name)] = value;
  }

  getPropertyValue(name: string): string {
    const value = this[camel(name)];
    return typeof value === 'string' ? value : '';
  }

  removeProperty(name: string): string {
    const was = this.getPropertyValue(name);
    if (camel(name) === 'cursor') this.cursor = '';
    else delete this[camel(name)];
    return was;
  }
}
