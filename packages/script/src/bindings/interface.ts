import type { SpriteBatch, UiInput, UiNode } from '@driftengine/ui2d';
import {
  createUiInput,
  drawUiTree,
  layoutUiTree,
  routeUiKey,
  routeUiPointer,
  setUiFocus,
  uiNodeNamed,
} from '@driftengine/ui2d';
import type { CapabilityDefinition, Effect, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const INTERFACE_MODULE = 'drift/ui';

/**
 * `drift/ui` — a retained interface tree, addressed by the names its nodes were given.
 *
 * **The linker has refused this module by name since the language shipped**, saying it waits on
 * Track F. It does not any more.
 *
 * **`drift/2d` is the other half of this track**, and it declares `SpriteBatch` — which `draw`
 * takes. It was uncallable when it was first written: a module's namespace was the last segment of
 * its path, so a call would have been `2d.sprite(...)`, and `2d` is a number followed by an
 * identifier. DriftScript 1.11.0 answered it at the import, and `sprites.ts` carries the story.
 *
 * ## Names rather than node values, and the reason is the type system
 *
 * Every capability here takes the tree and a name. The alternative — a `UiNode` opaque a script
 * holds — needs a lookup that can fail, and the language has no optional to answer with: a
 * `uiChild` that returned the root when a name was absent would be a silent wrong answer inside a
 * frame loop. Names are total. `has` asks whether one exists, every reader answers a defined value
 * for a name that does not, and a script reads the way it reads: `if ui.hovered(tree, "start")`.
 *
 * It also matches what a tree is for. A host builds the tree, gives its nodes names, and hands the
 * root to a script through `uses` — the way a `Terrain` and a `NavGraph` arrive. The script does not
 * construct interfaces; it drives one.
 *
 * ## The effects, and the line between two of them
 *
 * **A layout, a draw and a change to a node are `scene.write`** — the language's own effect for a
 * thing that draws, and outside `DETERMINISTIC_EFFECTS` for the right reason: an interface is view
 * state, and a `@deterministic` system has no business moving it.
 *
 * **Reading a laid-out box is `scene.read`** and is inside the boundary, because a rect is state
 * the layout already produced.
 *
 * **But `hovered`, `pressed`, `focused` and `activated` are `input.read`**, and that is the one
 * distinction worth stopping on. Those flags live on the tree and are read like any other field —
 * so declaring them `scene.read` would type-check and would be a lie, because what they carry is
 * where the pointer is. `input.read` is outside `DETERMINISTIC_EFFECTS`, so a `@deterministic`
 * system cannot ask whether the mouse is over a button, which is exactly right and is the property
 * the annotation exists to guarantee.
 */
export const INTERFACE_TYPES: readonly OpaqueType[] = [
  {
    module: INTERFACE_MODULE,
    name: 'UiTree',
    doc: 'The root of a retained interface tree. Its nodes are addressed by the names they were built with.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: readonly Effect[],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: INTERFACE_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects: [...effects],
    deterministic: effects.every((effect) => effect === 'scene.read'),
    doc,
    implementation: `${INTERFACE_MODULE}.${name}`,
  });

const NAMED = [
  { name: 'tree', type: 'UiTree' },
  { name: 'name', type: 'String' },
] as const;

export const INTERFACE_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'layout',
    [
      { name: 'tree', type: 'UiTree' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'w', type: 'f32' },
      { name: 'h', type: 'f32' },
    ],
    'void',
    ['scene.write'],
    'Lay the tree out into a box. The box is what is available: a tree sized by its contents comes to what its contents come to.',
  ),
  define(
    'draw',
    [
      { name: 'tree', type: 'UiTree' },
      { name: 'batch', type: 'SpriteBatch' },
      { name: 'white', type: 'i32' },
    ],
    'i32',
    ['scene.write'],
    "Put the tree in a batch and answer how many quads that was. `white` is the sprite pass's own white slot, which is what a background is drawn on.",
  ),
  define(
    'has',
    NAMED,
    'bool',
    ['scene.read'],
    'Whether the tree holds a node of this name. Every reader below answers a defined value without it, so this is for a script that wants to know rather than one that would crash.',
  ),
  define(
    'left',
    NAMED,
    'f32',
    ['scene.read'],
    'Where a node ended up, along x. Zero for a name the tree does not hold.',
  ),
  define('top', NAMED, 'f32', ['scene.read'], 'The same, along y.'),
  define('width', NAMED, 'f32', ['scene.read'], 'How wide a node ended up.'),
  define('height', NAMED, 'f32', ['scene.read'], 'How tall a node ended up.'),
  define(
    'visible',
    NAMED,
    'bool',
    ['scene.read'],
    'Whether a node is shown. A hidden node is out of the layout and out of the hit test, not merely invisible.',
  ),
  define(
    'show',
    [...NAMED, { name: 'visible', type: 'bool' }],
    'void',
    ['scene.write'],
    'Show or hide a node and everything under it.',
  ),
  define(
    'setText',
    [...NAMED, { name: 'text', type: 'String' }],
    'void',
    ['scene.write'],
    "Change what a node says. What draws it is the caller's: this package draws quads, and core already draws two kinds of text.",
  ),
  define(
    'tint',
    [
      ...NAMED,
      { name: 'r', type: 'f32' },
      { name: 'g', type: 'f32' },
      { name: 'b', type: 'f32' },
      { name: 'a', type: 'f32' },
    ],
    'void',
    ['scene.write'],
    "Change a node's background colour. A node with no background gets one.",
  ),
  define('hovered', NAMED, 'bool', ['input.read'], 'Whether the pointer is over a node.'),
  define(
    'pressed',
    NAMED,
    'bool',
    ['input.read'],
    'Whether the pointer went down on a node and has not come up.',
  ),
  define('focused', NAMED, 'bool', ['input.read'], 'Whether a node has the keyboard.'),
  /*
   * **`point` answers whether anything was activated and `activated` asks which**, rather than one
   * call returning a name. The language has no optional to answer a miss with, and a two-call shape
   * is what `drift/behavior`'s `doing` already uses for the same reason: ask by the name you have.
   */
  define(
    'point',
    [
      { name: 'tree', type: 'UiTree' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'down', type: 'bool' },
    ],
    'bool',
    ['input.read', 'scene.write'],
    'Route the pointer, and answer whether this call activated anything. An activation is a press and a release on the same node, so somebody who pressed the wrong button can slide off it.',
  ),
  define(
    'activated',
    NAMED,
    'bool',
    ['input.read'],
    'Whether the last `point` activated this node. Read it in the same step that called `point`; the next one clears it.',
  ),
  define(
    'key',
    [
      { name: 'tree', type: 'UiTree' },
      { name: 'key', type: 'String' },
      { name: 'shift', type: 'bool' },
    ],
    'bool',
    ['input.read', 'scene.write'],
    'Route a key, and answer whether it activated what has focus. Tab moves focus, Enter and space activate, and everything else is reported unhandled so the caller can have it.',
  ),
  define(
    'focus',
    NAMED,
    'void',
    ['scene.write'],
    'Give a node the keyboard. A name the tree does not hold focuses nothing.',
  ),
];

/**
 * **The router's state is kept here, per tree, which is the shape `drift/navigation` set.**
 *
 * A `UiInput` is hover, press and focus between one call and the next, and a script has nowhere to
 * put one — the same position a script routing an agent was in before `navigation.path` started
 * keeping a route per agent. So the host keeps one per tree, in a map keyed weakly so a tree going
 * away takes its router with it.
 *
 * **No services**, for the reason `drift/terrain` gives: every capability takes the tree it acts on,
 * so this is registered unconditionally and a script that never receives one never calls it.
 */
export function interfaceImplementation(): Record<string, unknown> {
  const routers = new WeakMap<UiNode, UiInput>();
  /* What the last `point` or `key` activated, so `activated` can be asked by name. */
  const activations = new WeakMap<UiNode, UiNode | null>();

  const routerOf = (tree: UiNode): UiInput => {
    let input = routers.get(tree);
    if (input === undefined) {
      input = createUiInput();
      routers.set(tree, input);
    }
    return input;
  };

  const nodeOf = (tree: UiNode, name: string): UiNode | null => uiNodeNamed(tree, name);

  return {
    layout: (tree: UiNode, x: number, y: number, w: number, h: number) => {
      layoutUiTree(tree, x, y, w, h);
    },
    draw: (tree: UiNode, batch: SpriteBatch, white: number) => drawUiTree(batch, tree, white, null),
    has: (tree: UiNode, name: string) => nodeOf(tree, name) !== null,
    left: (tree: UiNode, name: string) => nodeOf(tree, name)?.rect.x ?? 0,
    top: (tree: UiNode, name: string) => nodeOf(tree, name)?.rect.y ?? 0,
    width: (tree: UiNode, name: string) => nodeOf(tree, name)?.rect.w ?? 0,
    height: (tree: UiNode, name: string) => nodeOf(tree, name)?.rect.h ?? 0,
    visible: (tree: UiNode, name: string) => {
      const node = nodeOf(tree, name);
      return node !== null && !node.hidden;
    },
    show: (tree: UiNode, name: string, visible: boolean) => {
      const node = nodeOf(tree, name);
      if (node !== null) node.hidden = !visible;
    },
    setText: (tree: UiNode, name: string, text: string) => {
      const node = nodeOf(tree, name);
      if (node !== null) node.text = text;
    },
    tint: (tree: UiNode, name: string, r: number, g: number, b: number, a: number) => {
      const node = nodeOf(tree, name);
      if (node === null) return;
      /* A node with no background gets one, which is the only allocation in this module and
         happens once per node rather than per frame. */
      if (node.background === null) node.background = new Float32Array(4);
      node.background[0] = r;
      node.background[1] = g;
      node.background[2] = b;
      node.background[3] = a;
    },
    hovered: (tree: UiNode, name: string) => nodeOf(tree, name)?.hovered === true,
    pressed: (tree: UiNode, name: string) => nodeOf(tree, name)?.pressed === true,
    focused: (tree: UiNode, name: string) => {
      const node = nodeOf(tree, name);
      return node !== null && routerOf(tree).focused === node;
    },
    point: (tree: UiNode, x: number, y: number, down: boolean) => {
      const hit = routeUiPointer(routerOf(tree), tree, x, y, down);
      activations.set(tree, hit);
      return hit !== null;
    },
    activated: (tree: UiNode, name: string) => {
      const node = nodeOf(tree, name);
      return node !== null && activations.get(tree) === node;
    },
    key: (tree: UiNode, key: string, shift: boolean) => {
      const hit = routeUiKey(routerOf(tree), tree, key, shift);
      activations.set(tree, hit);
      return hit !== null;
    },
    focus: (tree: UiNode, name: string) => {
      setUiFocus(routerOf(tree), nodeOf(tree, name));
    },
  };
}
