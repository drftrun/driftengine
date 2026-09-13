import { expect, test } from 'vitest';
import { addUiChild, createSpriteBatch, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';

import { INTERFACE_CAPABILITIES, INTERFACE_MODULE, interfaceImplementation } from './interface.ts';

/** A bar of two named buttons, the shape a host builds and hands a script through `uses`. */
function tree(): UiNode {
  const root = createUiNode({ direction: 'row', width: 100, height: 40, gap: 10, name: 'bar' });
  addUiChild(
    root,
    createUiNode({ width: 20, height: 20, interactive: true, focusable: true, name: 'start' }),
  );
  addUiChild(
    root,
    createUiNode({ width: 20, height: 20, interactive: true, focusable: true, name: 'quit' }),
  );
  return root;
}

type Api = Record<string, (...args: never[]) => unknown>;
const api = (): Api => interfaceImplementation() as Api;

const call = <T>(fns: Api, name: string, ...args: unknown[]): T =>
  (fns[name] as (...a: unknown[]) => T)(...args);

test('every capability the module declares has an implementation behind it', () => {
  /*
   * **The failure this catches is silent.** A capability registered with no implementation resolves
   * to nothing at the call — the script compiles, the linker is satisfied, and the function returns
   * undefined at run time. Named rather than counted, so a rename fails here rather than passing on
   * a matching total.
   */
  const implemented = new Set(Object.keys(interfaceImplementation()));
  for (const capability of INTERFACE_CAPABILITIES) {
    expect(implemented.has(capability.name)).toBe(true);
  }
  expect(INTERFACE_CAPABILITIES.length).toBeGreaterThan(0);
});

/*
 * The distinction the module turns on. `hovered` and `pressed` are fields on the tree and read like
 * any other, so `scene.read` would type-check — and would be a lie, because what they carry is
 * where the pointer is. Declared `input.read`, they are outside `DETERMINISTIC_EFFECTS`, so a
 * `@deterministic` system cannot ask whether the mouse is over a button.
 */
test('what the pointer touches is an input read, not a scene read', () => {
  const byName = new Map(INTERFACE_CAPABILITIES.map((c) => [c.name, c]));
  for (const name of ['hovered', 'pressed', 'focused', 'activated']) {
    expect(byName.get(name)?.effects).toEqual(['input.read']);
    expect(byName.get(name)?.deterministic).toBe(false);
  }
  for (const name of ['left', 'top', 'width', 'height', 'has', 'visible']) {
    expect(byName.get(name)?.effects).toEqual(['scene.read']);
    expect(byName.get(name)?.deterministic).toBe(true);
  }
  for (const name of ['layout', 'draw', 'show', 'setText', 'tint', 'focus']) {
    expect(byName.get(name)?.effects).toEqual(['scene.write']);
    expect(byName.get(name)?.deterministic).toBe(false);
  }
  for (const capability of INTERFACE_CAPABILITIES) {
    expect(capability.module).toBe(INTERFACE_MODULE);
  }
});

test('lays a tree out and answers where a node ended up', () => {
  const fns = api();
  const root = tree();
  call(fns, 'layout', root, 0, 0, 100, 40);
  expect(call<number>(fns, 'left', root, 'quit')).toBe(30);
  expect(call<number>(fns, 'top', root, 'quit')).toBe(0);
  expect(call<number>(fns, 'width', root, 'quit')).toBe(20);
  expect(call<number>(fns, 'height', root, 'quit')).toBe(20);
});

/*
 * Names are total because the language has no optional to answer a miss with. A reader that threw,
 * or answered `undefined`, would do it inside a frame loop.
 */
test('a name the tree does not hold reads as zero rather than throwing', () => {
  const fns = api();
  const root = tree();
  call(fns, 'layout', root, 0, 0, 100, 40);
  expect(call<boolean>(fns, 'has', root, 'quit')).toBe(true);
  expect(call<boolean>(fns, 'has', root, 'nowhere')).toBe(false);
  expect(call<number>(fns, 'left', root, 'nowhere')).toBe(0);
  expect(call<boolean>(fns, 'visible', root, 'nowhere')).toBe(false);
});

test('shows and hides a node, and a hidden one leaves the layout', () => {
  const fns = api();
  const root = tree();
  call(fns, 'show', root, 'start', false);
  call(fns, 'layout', root, 0, 0, 100, 40);
  expect(call<boolean>(fns, 'visible', root, 'start')).toBe(false);
  // `quit` is now the first thing in the row rather than the second.
  expect(call<number>(fns, 'left', root, 'quit')).toBe(0);
});

test('changes text and a background colour', () => {
  const fns = api();
  const root = tree();
  call(fns, 'setText', root, 'start', 'Play');
  call(fns, 'tint', root, 'start', 0.25, 0.5, 0.75, 1);
  const node = root.children[0] as UiNode;
  expect(node.text).toBe('Play');
  expect(Array.from(node.background ?? [])).toEqual([0.25, 0.5, 0.75, 1]);
});

test('draws the tree into a batch and answers how many quads that was', () => {
  const fns = api();
  const root = tree();
  call(fns, 'tint', root, 'start', 1, 1, 1, 1);
  call(fns, 'tint', root, 'quit', 1, 1, 1, 1);
  call(fns, 'layout', root, 0, 0, 100, 40);
  const batch = createSpriteBatch(16);
  expect(call<number>(fns, 'draw', root, batch, 4)).toBe(2);
  expect(batch.count).toBe(2);
});

test('routes a pointer, and a press and a release on one node activate it', () => {
  const fns = api();
  const root = tree();
  call(fns, 'layout', root, 0, 0, 100, 40);
  call(fns, 'point', root, 10, 10, false);
  expect(call<boolean>(fns, 'hovered', root, 'start')).toBe(true);
  expect(call<boolean>(fns, 'hovered', root, 'quit')).toBe(false);

  call(fns, 'point', root, 10, 10, true);
  expect(call<boolean>(fns, 'pressed', root, 'start')).toBe(true);
  expect(call<boolean>(fns, 'point', root, 10, 10, false)).toBe(true);
  expect(call<boolean>(fns, 'activated', root, 'start')).toBe(true);
  expect(call<boolean>(fns, 'activated', root, 'quit')).toBe(false);
});

test('a release somewhere else activates nothing', () => {
  const fns = api();
  const root = tree();
  call(fns, 'layout', root, 0, 0, 100, 40);
  call(fns, 'point', root, 10, 10, true);
  expect(call<boolean>(fns, 'point', root, 40, 10, false)).toBe(false);
  expect(call<boolean>(fns, 'activated', root, 'start')).toBe(false);
});

test('routes keys: tab moves focus, enter activates, anything else is unhandled', () => {
  const fns = api();
  const root = tree();
  call(fns, 'layout', root, 0, 0, 100, 40);
  expect(call<boolean>(fns, 'key', root, 'Tab', false)).toBe(false);
  expect(call<boolean>(fns, 'focused', root, 'start')).toBe(true);
  expect(call<boolean>(fns, 'key', root, 'Enter', false)).toBe(true);
  expect(call<boolean>(fns, 'activated', root, 'start')).toBe(true);
  expect(call<boolean>(fns, 'key', root, 'q', false)).toBe(false);
});

test('focuses a node by name, and a name it does not have focuses nothing', () => {
  const fns = api();
  const root = tree();
  call(fns, 'focus', root, 'quit');
  expect(call<boolean>(fns, 'focused', root, 'quit')).toBe(true);
  call(fns, 'focus', root, 'nowhere');
  expect(call<boolean>(fns, 'focused', root, 'quit')).toBe(false);
});

/*
 * A `UiInput` is hover, press and focus between one call and the next, and a script has nowhere to
 * put one — the position `drift/navigation` was in before it kept a route per agent. Two trees must
 * not share a router, or pointing at one would move the other's focus.
 */
test('two trees keep their own routers', () => {
  const fns = api();
  const one = tree();
  const other = tree();
  call(fns, 'layout', one, 0, 0, 100, 40);
  call(fns, 'layout', other, 0, 0, 100, 40);
  call(fns, 'focus', one, 'start');
  expect(call<boolean>(fns, 'focused', one, 'start')).toBe(true);
  expect(call<boolean>(fns, 'focused', other, 'start')).toBe(false);
});
