import type { A11yNode } from '@driftengine/ui2d';
import { expect, test } from 'vitest';

import { createBrowserA11yHost } from './a11yHost.ts';
import { createFakeDocument, type FakeElement } from './fakeDom.ts';

/**
 * **A mirror of the interface must not be a second copy of the interface.**
 *
 * The elements this host publishes exist so a screen reader has something to walk; they sit over
 * a canvas that has already drawn everything they describe. The day the panels were docked, the
 * tree went from empty to every row of every panel — and because each element carried its label as
 * ordinary text in an ordinary box, the whole editor appeared twice on screen, the second copy
 * offset by the menu bar. **It had been latent for as long as the host existed** and was invisible
 * only because nothing had a label yet, which is the shape of defect this repository keeps finding:
 * a thing that cannot be wrong until something else starts working.
 */

function hosted() {
  const doc = createFakeDocument();
  const host = createBrowserA11yHost({ document: doc, origin: { x: 0, y: 24 } });
  return { doc, host, root: host.root as FakeElement };
}

function node(label: string, y: number): A11yNode {
  return { role: 'listitem', label, x: 4, y, w: 200, h: 16, focused: false };
}

test('THE MIRROR IS READ, NEVER SEEN', () => {
  const { host } = hosted();
  host.publish([node('crate — open', 20)], 1);

  const element = host.published[0] as FakeElement;
  expect(element).toBeDefined();
  /* The name a reader announces. */
  expect(element.attributes.get('aria-label')).toBe('crate — open');
  /*
   * **Nothing paints.** The label is still the element's text, because a reader without `aria`
   * support falls back to it and that fallback is worth keeping — so what is removed is the ink,
   * not the words. `color: transparent` leaves the element in the accessibility tree, which
   * `display: none` and `visibility: hidden` would not.
   */
  expect(element.textContent).toBe('crate — open');
  expect(host.root.style.color).toBe('transparent');
  expect(host.root.style.userSelect).toBe('none');
});

test('AN ELEMENT SITS WHERE THE THING IT DESCRIBES WAS DRAWN', () => {
  /*
   * **The application's tree starts under the menu bar and the page does not.** A mirror laid out
   * in the application's own space is every element twenty-four pixels above what it describes —
   * which for a screen reader is a focus ring around the wrong row, and for a touch reader is the
   * wrong row entirely.
   */
  const { host } = hosted();
  host.publish([node('crate — open', 20)], 1);
  const element = host.published[0] as FakeElement;
  expect(element.style.top).toBe('44px');
  expect(element.style.left).toBe('4px');
});

test('a tree that shrinks keeps its elements, hidden, so a reader keeps its place', () => {
  const { host } = hosted();
  host.publish([node('one', 0), node('two', 16)], 2);
  host.publish([node('one', 0)], 1);
  expect(host.published.length).toBe(2);
  const dropped = host.published[1] as FakeElement;
  expect(dropped.attributes.get('aria-hidden')).toBe('true');
  expect(dropped.textContent).toBe('');
});
