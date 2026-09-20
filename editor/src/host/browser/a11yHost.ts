/**
 * The browser's accessibility surface, behind `@driftengine/ui2d`'s seam.
 *
 * **A canvas is one element to a screen reader, and that is the whole problem.** Everything the
 * editor draws is pixels; a reader offered the canvas is offered nothing. `a11yTree` already
 * derives a tree of roles, labels and rectangles from the retained UI, and what this does is
 * mirror that tree into real elements a reader can walk — positioned over the canvas, transparent,
 * and not in anybody's way.
 *
 * **Reconciled rather than rebuilt.** Replacing the children on every publish would move focus
 * away from whatever the reader was on, on every frame the tree changed at all — which presents as
 * a screen reader that keeps losing its place and is the reason this keeps elements and edits them.
 *
 * Same rule as its neighbour: `document` is a parameter with a global fallback, so Wave 5A
 * replaces this directory rather than editing anything above it.
 */
import type { A11yHost, A11yNode } from '@driftengine/ui2d';

import type { HostDocument, HostElement } from './textHost.ts';

export interface BrowserA11yHostOptions {
  readonly document?: HostDocument;
  /**
   * Where the application's tree begins on the page.
   *
   * **The two spaces are not the same one.** The shell lays the application out below the menu
   * bar and hands it a box that starts at its own origin, so a mirror positioned straight from a
   * node's rectangle is every element a menu bar above what it describes — a focus ring around the
   * row above, and for a touch reader the wrong row entirely. Zero where a host draws the tree
   * from the top of the page.
   */
  readonly origin?: { readonly x: number; readonly y: number };
}

export interface BrowserA11yHost extends A11yHost {
  /** The container the mirrored tree lives in. */
  readonly root: HostElement;
  /** The elements currently published, in the order `a11yTree` produced them. */
  readonly published: readonly HostElement[];
  dispose(): void;
}

function globalDocument(): HostDocument {
  const found = (globalThis as { document?: unknown }).document;
  if (found === undefined) throw new Error('createBrowserA11yHost: this is not a browser');
  return found as HostDocument;
}

export function createBrowserA11yHost(options: BrowserA11yHostOptions = {}): BrowserA11yHost {
  const doc = options.document ?? globalDocument();
  const originX = options.origin?.x ?? 0;
  const originY = options.origin?.y ?? 0;
  const root = doc.createElement('div');
  root.setAttribute('role', 'application');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  /* Laid over the canvas and transparent to the pointer: the reader walks it, nobody clicks it. */
  root.style.pointerEvents = 'none';
  /*
   * **Read, never seen.** Every element carries its label as ordinary text in an ordinary box, and
   * over a canvas that has already drawn the same words that is the whole interface a second time.
   * It was invisible for as long as nothing had a label; the day the panels were docked the editor
   * appeared twice, the second copy a menu bar higher than the first.
   *
   * **What this gives up:** the words are still there, so a reader with no `aria` support still
   * finds them and so does a text search of the page — which is why the ink goes rather than the
   * text. `display: none` and `visibility: hidden` would take the elements out of the
   * accessibility tree altogether, which is the one thing they exist to be in.
   */
  root.style.color = 'transparent';
  root.style.userSelect = 'none';
  doc.body.appendChild(root);

  const elements: HostElement[] = [];

  return {
    root,
    published: elements,

    publish(nodes: readonly A11yNode[], count: number): void {
      const wanted = Math.min(count, nodes.length);
      while (elements.length < wanted) {
        const element = doc.createElement('div');
        element.style.position = 'absolute';
        element.style.pointerEvents = 'none';
        root.appendChild(element);
        elements.push(element);
      }
      for (let at = 0; at < wanted; at += 1) {
        const node = nodes[at] as A11yNode;
        const element = elements[at] as HostElement;
        element.setAttribute('role', node.role);
        element.setAttribute('aria-label', node.label);
        /* The reader announces the label; the text content is what a fallback reads. */
        element.textContent = node.label;
        element.style.left = `${String(Math.round(node.x + originX))}px`;
        element.style.top = `${String(Math.round(node.y + originY))}px`;
        element.style.width = `${String(Math.round(node.w))}px`;
        element.style.height = `${String(Math.round(node.h))}px`;
        /*
         * `aria-hidden` rather than removal for the tail, because a tree that shrinks and grows
         * again keeps its elements and therefore keeps whatever focus a reader had on them.
         */
        element.setAttribute('aria-hidden', 'false');
        element.setAttribute('tabindex', node.focused ? '0' : '-1');
        if (node.focused) element.focus();
      }
      for (let at = wanted; at < elements.length; at += 1) {
        const element = elements[at] as HostElement;
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('role', 'presentation');
        element.textContent = '';
      }
    },

    dispose(): void {
      root.remove();
      elements.length = 0;
    },
  };
}
