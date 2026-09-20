import { describe, expect, test } from 'vitest';
import {
  a11yTree,
  applyComposition,
  createTextModel,
  type A11yNode,
  type UiNode,
} from '@driftengine/ui2d';

import { createBrowserA11yHost } from './a11yHost.ts';
import { createFakeClipboard, createFakeDocument, type FakeElement } from './fakeDom.ts';
import { createBrowserTextHost, type CompositionUpdate } from './textHost.ts';

describe('the hidden field a composition goes into', () => {
  test('is placed at the field rectangle when one is focused', () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    const field = host.field as FakeElement;

    /* Off-screen until something is focused, so it cannot catch a stray click. */
    expect(field.style.left).toBe('-9999px');
    expect(field.focused).toBe(false);

    host.focusField(120.4, 64.6, 220, 18);
    expect(field.style.left).toBe('120px');
    expect(field.style.top).toBe('65px');
    expect(field.style.width).toBe('220px');
    expect(field.style.height).toBe('18px');
    expect(field.focused).toBe(true);
  });

  test('never collapses to nothing, which is a field a browser will not compose into', () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    host.focusField(10, 10, 0, 0);
    expect((host.field as FakeElement).style.width).toBe('1px');
    expect((host.field as FakeElement).style.height).toBe('1px');
  });

  test('goes away and off-screen when the field blurs', () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    host.focusField(50, 50, 100, 20);
    host.blurField();
    const field = host.field as FakeElement;
    expect(field.focused).toBe(false);
    expect(field.style.left).toBe('-9999px');
  });

  test('is parented so the browser will actually place a composition window over it', () => {
    const doc = createFakeDocument();
    createBrowserTextHost({ document: doc, clipboard: null });
    expect(doc.body.kids.length).toBe(1);
    expect((doc.body.kids[0] as FakeElement).tag).toBe('textarea');
  });
});

describe('composition updates', () => {
  test('arrive in the order the browser sent them', () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    const field = host.field as FakeElement;

    field.emit('compositionupdate', { data: 'に' });
    field.emit('compositionupdate', { data: 'にほ' });
    field.emit('compositionupdate', { data: 'にほん' });
    field.emit('compositionend', { data: '日本' });

    const out: CompositionUpdate[] = [];
    expect(host.drainCompositions(out)).toBe(4);
    expect(out.map((update) => update.text)).toEqual(['に', 'にほ', 'にほん', '日本']);
    expect(out.map((update) => update.done)).toEqual([false, false, false, true]);
    /* Drained, so the next frame does not apply the same composition again. */
    expect(host.drainCompositions(out)).toBe(0);
  });

  test('fold into a model as one word rather than five', () => {
    /*
     * The seam's own promise, driven end to end: `applyComposition` replaces what the previous
     * update of this composition put there, so five keystrokes make one word — and `done` clears
     * the range, without which the next keystroke overwrites what was just committed.
     */
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    const field = host.field as FakeElement;
    const model = createTextModel('go: ');
    model.caret = model.text.length;
    model.anchor = model.caret;

    for (const data of ['に', 'にほ', 'にほん']) field.emit('compositionupdate', { data });
    field.emit('compositionend', { data: '日本' });

    const out: CompositionUpdate[] = [];
    host.drainCompositions(out);
    for (const update of out) applyComposition(model, update);

    expect(model.text).toBe('go: 日本');
    expect(model.composeFrom).toBe(-1);
  });

  test('ignores a composition start, which carries no text', () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    (host.field as FakeElement).emit('compositionstart', { data: '' });
    const out: CompositionUpdate[] = [];
    expect(host.drainCompositions(out)).toBe(0);
  });

  test('stops listening once disposed', () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    const field = host.field as FakeElement;
    host.dispose();
    field.emit('compositionupdate', { data: 'x' });
    const out: CompositionUpdate[] = [];
    expect(host.drainCompositions(out)).toBe(0);
    expect(field.removed).toBe(true);
  });
});

describe('the clipboard', () => {
  test('resolves to a string', async () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({
      document: doc,
      clipboard: createFakeClipboard({ text: 'pasted' }),
    });
    expect(await host.readClipboard()).toBe('pasted');
    await host.writeClipboard('copied');
    expect(await host.readClipboard()).toBe('copied');
  });

  test('answers empty when permission is refused, rather than taking the editor down', async () => {
    /*
     * **The case that matters and the one a browser produces first.** Reading the clipboard is a
     * permission and a refusal arrives as a rejected promise, often before anybody has been asked
     * anything. An editor that let it escape would lose the frame on a paste — and
     * `createNullTextHost` already promises an empty string, so a host that behaves differently
     * when it is present is worse than no host.
     */
    const doc = createFakeDocument();
    const host = createBrowserTextHost({
      document: doc,
      clipboard: createFakeClipboard({ refuse: true }),
    });
    await expect(host.readClipboard()).resolves.toBe('');
    await expect(host.writeClipboard('anything')).resolves.toBeUndefined();
  });

  test('answers empty when there is no clipboard at all', async () => {
    const doc = createFakeDocument();
    const host = createBrowserTextHost({ document: doc, clipboard: null });
    expect(await host.readClipboard()).toBe('');
    await expect(host.writeClipboard('x')).resolves.toBeUndefined();
  });
});

/** A UI tree with something for every role `a11yTree` derives. */
function panel(): UiNode {
  const button = (label: string, x: number): UiNode =>
    ({
      rect: { x, y: 40, w: 90, h: 24 },
      children: [],
      text: label,
      focusable: true,
      interactive: true,
      hidden: false,
      clip: false,
      contentSpanX: 0,
      contentSpanY: 0,
      focused: false,
    }) as unknown as UiNode;
  return {
    rect: { x: 0, y: 0, w: 400, h: 200 },
    children: [button('Open', 10), button('Save', 110), button('Close', 210)],
    text: 'Toolbar',
    focusable: false,
    interactive: true,
    hidden: false,
    clip: false,
    contentSpanX: 0,
    contentSpanY: 0,
    focused: false,
  } as unknown as UiNode;
}

describe('the accessibility tree a reader walks', () => {
  test('publishes one element per entry, with the role, label and rectangle', () => {
    const doc = createFakeDocument();
    const host = createBrowserA11yHost({ document: doc });
    const nodes: A11yNode[] = [];
    const count = a11yTree(panel(), nodes);
    expect(count).toBeGreaterThan(1);

    host.publish(nodes, count);
    expect(host.published.length).toBe(count);
    for (let at = 0; at < count; at += 1) {
      const node = nodes[at] as A11yNode;
      const element = host.published[at] as FakeElement;
      expect(element.attributes.get('role')).toBe(node.role);
      expect(element.attributes.get('aria-label')).toBe(node.label);
      expect(element.style.left).toBe(`${String(Math.round(node.x))}px`);
      expect(element.style.width).toBe(`${String(Math.round(node.w))}px`);
    }
  });

  test('keeps its elements when the tree shrinks, so a reader keeps its place', () => {
    /*
     * Rebuilding the children on every publish moves focus off whatever the reader was on, every
     * frame the tree changes at all. The tail is hidden rather than removed.
     */
    const doc = createFakeDocument();
    const host = createBrowserA11yHost({ document: doc });
    const nodes: A11yNode[] = [];
    const full = a11yTree(panel(), nodes);
    host.publish(nodes, full);
    const before = [...host.published];

    host.publish(nodes, full - 2);
    expect(host.published.length).toBe(full);
    expect(host.published[0]).toBe(before[0]);
    const tail = host.published[full - 1] as FakeElement;
    expect(tail.attributes.get('aria-hidden')).toBe('true');
    expect(tail.attributes.get('role')).toBe('presentation');
    /* And the ones still in the tree are not hidden. */
    expect((host.published[0] as FakeElement).attributes.get('aria-hidden')).toBe('false');
  });

  test('gives the focused entry the only reachable tab stop', () => {
    const doc = createFakeDocument();
    const host = createBrowserA11yHost({ document: doc });
    const nodes: A11yNode[] = [
      { role: 'button', label: 'One', x: 0, y: 0, w: 10, h: 10, focused: false },
      { role: 'button', label: 'Two', x: 20, y: 0, w: 10, h: 10, focused: true },
    ];
    host.publish(nodes, 2);
    expect((host.published[0] as FakeElement).attributes.get('tabindex')).toBe('-1');
    expect((host.published[1] as FakeElement).attributes.get('tabindex')).toBe('0');
    expect((host.published[1] as FakeElement).focused).toBe(true);
  });

  test('lays its container over the canvas without catching the pointer', () => {
    const doc = createFakeDocument();
    const host = createBrowserA11yHost({ document: doc });
    expect(host.root.style.pointerEvents).toBe('none');
    expect((host.root as FakeElement).attributes.get('role')).toBe('application');
    host.dispose();
    expect((host.root as FakeElement).removed).toBe(true);
  });
});
