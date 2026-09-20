/**
 * `matchMedia`, answered from what this host knows: a desktop window's pointer, its size and
 * shape, its pixel ratio, and whether it is fullscreen.
 *
 * **The engine asks `(pointer: coarse)`** to choose touch controls and to ask for fullscreen on a
 * first gesture, and a window with no `matchMedia` at all read as a desktop only because the engine
 * guards the call. A consumer may ask anything, so the common features are answered:
 * - `pointer` and `hover` as a desktop's mouse, `fine` and `hover`. `any-pointer` adds `coarse`
 *   once a finger has landed, because SDL cannot say whether a touch screen exists — on the machine
 *   this was written on it listed X11's master pointer, "Virtual core pointer", as one.
 * - `width`, `height` and `orientation` from the window, in either spelling of a range;
 *   `resolution` from its pixel ratio.
 * - `display-mode` as `fullscreen` or `standalone`, the display mode of an app's own window.
 * - Preferences as a person who set none: `prefers-reduced-motion: no-preference`,
 *   `prefers-color-scheme: light`, `prefers-contrast: no-preference`, `forced-colors: none`.
 *
 * A list is live, as a browser's is, and is sent `change` when its answer flips. **A feature this
 * does not know answers false and is named once on the console**, rather than a guess at what a
 * browser would have said.
 *
 * What it gives up: a desktop's colour scheme is not read, so a dark desktop still answers
 * `light`; and a machine with only a touch screen answers as one with a mouse until told
 * otherwise.
 */

import { HostNode } from './domTree.ts';

export interface MediaFacts {
  /** The viewport, in CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly fullscreen: boolean;
  /** Whether a finger has landed, which is the one proof of a touch screen SDL gives. */
  readonly touched: boolean;
}

type Feature = (value: string | null, facts: MediaFacts) => boolean;

const is = (answer: string) => (value: string | null) => value === null || value === answer;
const px = (value: string) => Number.parseFloat(value);
const dppx = (value: string) =>
  value.endsWith('dpi') ? Number.parseFloat(value) / 96 : Number.parseFloat(value);

const FEATURES: Record<string, Feature> = {
  pointer: is('fine'),
  'any-pointer': (v, f) => v === null || v === 'fine' || (v === 'coarse' && f.touched),
  hover: is('hover'),
  'any-hover': is('hover'),
  orientation: (v, f) => v === (f.height >= f.width ? 'portrait' : 'landscape'),
  width: (v, f) => v === null || f.width === px(v),
  'min-width': (v, f) => v !== null && f.width >= px(v),
  'max-width': (v, f) => v !== null && f.width <= px(v),
  height: (v, f) => v === null || f.height === px(v),
  'min-height': (v, f) => v !== null && f.height >= px(v),
  'max-height': (v, f) => v !== null && f.height <= px(v),
  'min-resolution': (v, f) => v !== null && f.pixelRatio >= dppx(v),
  'max-resolution': (v, f) => v !== null && f.pixelRatio <= dppx(v),
  'display-mode': (v, f) => v === (f.fullscreen ? 'fullscreen' : 'standalone'),
  'prefers-reduced-motion': (v) => v === 'no-preference',
  'prefers-color-scheme': (v) => v === 'light',
  'prefers-contrast': (v) => v === 'no-preference',
  'forced-colors': (v) => v === 'none',
  color: () => true,
};

/** `(width >= 600px)` and its kin, the range spelling, as the equivalent `min-` or `max-`. */
function range(condition: string): [string, string] | null {
  const match = /^(width|height)\s*(>=|<=|>|<)\s*(\S+)$/.exec(condition);
  if (match === null) return null;
  const [, name, op, value] = match as unknown as [string, string, string, string];
  const nudge = op === '>' ? 0.001 : op === '<' ? -0.001 : 0;
  const bound = `${px(value) + nudge}px`;
  return [op.startsWith('>') ? `min-${name}` : `max-${name}`, bound];
}

/** `pointer: coarse` as its name and value; a bare `color` has no value. */
function nameAndValue(condition: string): [string, string | null] {
  const colon = condition.indexOf(':');
  if (colon < 0) return [condition, null];
  return [condition.slice(0, colon).trim(), condition.slice(colon + 1).trim()];
}

export class MediaQueryList extends HostNode {
  private last: boolean;
  constructor(
    readonly media: string,
    private readonly answer: () => boolean,
  ) {
    super();
    this.last = answer();
  }
  get matches(): boolean {
    return this.answer();
  }
  /** The legacy pair, still read. */
  addListener(listener: (event: Event) => void): void {
    this.addEventListener('change', listener);
  }
  removeListener(listener: (event: Event) => void): void {
    this.removeEventListener('change', listener);
  }
  /** Tell the list's listeners if its answer has flipped since they were last told. */
  recheck(): void {
    const now = this.answer();
    if (now === this.last) return;
    this.last = now;
    this.dispatchEvent(Object.assign(new Event('change'), { media: this.media, matches: now }));
  }
  static {
    HostNode.handles(MediaQueryList.prototype, ['change']);
  }
}

export interface MediaQueryList {
  onchange: ((event: Event) => unknown) | null;
}

export class MediaQueries {
  private readonly lists: MediaQueryList[] = [];
  private readonly unknown = new Set<string>();

  constructor(private readonly facts: () => MediaFacts) {}

  match(query: string): MediaQueryList {
    const list = new MediaQueryList(query.trim(), () => this.evaluate(query));
    this.lists.push(list);
    return list;
  }

  /** Something a query can read has changed: each list whose answer flipped is told. */
  changed(): void {
    for (const list of this.lists) list.recheck();
  }

  private evaluate(query: string): boolean {
    const facts = this.facts();
    return query.split(',').some((one) => this.single(one.trim().toLowerCase(), facts));
  }

  /** One query of a list: `not` or `only`, a media type, and conditions joined by `and`. */
  private single(query: string, facts: MediaFacts): boolean {
    let rest = query;
    const negated = rest.startsWith('not ');
    if (negated || rest.startsWith('only ')) rest = rest.slice(rest.indexOf(' ') + 1).trim();
    const parts = rest.split(/\s+and\s+/);
    let result = true;
    for (const part of parts) {
      if (part === 'all' || part === 'screen') continue;
      if (!part.startsWith('(') || !part.endsWith(')')) {
        result = false;
        continue;
      }
      if (!this.condition(part.slice(1, -1).trim(), facts)) result = false;
    }
    return negated ? !result : result;
  }

  private condition(condition: string, facts: MediaFacts): boolean {
    const [name, value] = range(condition) ?? nameAndValue(condition);
    const feature = FEATURES[name];
    if (feature === undefined) {
      if (!this.unknown.has(name)) {
        this.unknown.add(name);
        console.warn(
          `[driftengine] the native host does not answer the media feature \`${name}\`; it reads as false`,
        );
      }
      return false;
    }
    return feature(value, facts);
  }
}
