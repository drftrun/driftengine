import type { Gizmo, SceneNode } from '@driftengine/core';
import type { EditorHost } from '@driftengine/editor';
import type { CapabilityDefinition, OpaqueType } from 'driftscript';
import { defineCapability } from 'driftscript';

export const EDITOR_MODULE = 'drift/editor';

/**
 * `drift/editor` — the transform tool, driven from a script that never ships.
 *
 * `Gizmo` in `@driftengine/core` answers what a ray is over and what a drag does to a transform;
 * this is the surface a tool script drives it through.
 *
 * **`editor` is an `Effect` outside `DETERMINISTIC_EFFECTS`, and belongs there.** A gizmo is a view
 * of a transform being edited by a person, so a `@deterministic` system has no business touching
 * one. The annotation refusing it is the property `@editor` exists to pair with.
 *
 * **A name is unique across the module, not per type.** Two opaque types make that easy to forget:
 * a module is one namespace and one implementation map, so `mode` cannot mean the gizmo's mode to a
 * `Gizmo` and the session's to an `Editor`. They are `gizmoMode` and `mode`.
 *
 * **Two opaque types.** `Gizmo` is the transform tool; `Editor` is `@driftengine/editor`'s
 * `EditorHost` — the selection, the tree and the play state. Both reach a script through `uses`,
 * the way a `Terrain` and a `NavGraph` do, so this module needs nothing from the host and is
 * registered unconditionally.
 *
 * ## Nothing here picks, and nothing edits a field by name
 *
 * A pick needs a ray, a ray needs a camera and a pointer, and both belong to the application. The
 * host runs `hover`, `beginDrag` and `updateDrag`; a script reads what they found and says what
 * kind of tool it is. That is what an editor script contains: a key that switches to rotation, a
 * modifier that switches to local space, and a read of where the thing ended up.
 *
 * The same argument one level along: an inspector row is addressed by its index in a list the host
 * built this frame, and a script wanting to write `Health.current` on a selection would be doing
 * entity work `drift/ecs` already does properly, with a component handle and a checked field.
 *
 * ## Three capabilities where an argument would have done, deliberately
 *
 * `translateMode`, `rotateMode` and `scaleMode` rather than `setMode(gizmo, mode)`. The language has
 * no enum, so the argument would be a string or a number, and an unrecognised one leaves exactly two
 * options — change nothing, the silent no-op `host.ts` rules out, or throw inside a frame, which
 * `AGENTS.md` rules out. Three names make the invalid call impossible to write, and the checker
 * rather than a runtime branch is what refuses it. `space` is the same argument again.
 *
 * The *readers* are strings because a reader is total: there is no invalid value to answer.
 */
export const EDITOR_TYPES: readonly OpaqueType[] = [
  {
    module: EDITOR_MODULE,
    name: 'Gizmo',
    doc: 'A transform tool: what the pointer is over, and the transform a drag is editing.',
  },
  {
    module: EDITOR_MODULE,
    name: 'Editor',
    doc: 'An editing session: what is selected, the tree of what exists, and whether the world is playing.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: EDITOR_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects: ['editor'],
    /*
     * **False on every one of them, reads included.** `editor` is outside
     * `DETERMINISTIC_EFFECTS`, and it should be: what a gizmo holds is a person's pointer part way
     * through moving something, so a system that read it would produce a different simulation on
     * replay. This is the effect `@editor` was designed to pair with.
     */
    deterministic: false,
    doc,
    implementation: `${EDITOR_MODULE}.${name}`,
  });

const OF = [{ name: 'gizmo', type: 'Gizmo' }] as const;
const ON = [{ name: 'editor', type: 'Editor' }] as const;

/*
 * **`f32` rather than `float`, and the language is right to insist.** `float` is width-polymorphic
 * and takes its width from a `float` parameter; none of these has one, so nothing would fix it.
 * A transform is stored as `Float32Array`, so `f32` is what the number actually is rather than a
 * width chosen to satisfy a checker. `bindings/terrain.ts` records the same finding.
 */
export const EDITOR_CAPABILITIES: readonly CapabilityDefinition[] = [
  define('translateMode', OF, 'void', 'Make this an arrow gizmo, which moves what it is on.'),
  define('rotateMode', OF, 'void', 'Make this a ring gizmo, which turns what it is on.'),
  define(
    'scaleMode',
    OF,
    'void',
    'Make this a scale gizmo. Scale is always in the object’s own axes, whatever the space says, because a non-uniform scale along a world axis would shear it.',
  ),
  define(
    'gizmoMode',
    OF,
    'String',
    'Which of the three the gizmo is: "translate", "rotate" or "scale".',
  ),

  define('worldSpace', OF, 'void', 'Point the handles along the world axes.'),
  define('localSpace', OF, 'void', 'Point the handles along the object’s own axes.'),
  define('space', OF, 'String', 'Which the handles are pointing along: "world" or "local".'),

  define(
    'size',
    OF,
    'f32',
    'How big the gizmo is in metres. The host keeps this the same on screen as the camera moves.',
  ),
  define(
    'setSize',
    [...OF, { name: 'metres', type: 'f32' }],
    'void',
    'Set how big the gizmo is in metres. Non-positive draws nothing and picks nothing rather than failing.',
  ),

  /*
   * **A name rather than a number, and total.** The handles are integer constants in TypeScript, and
   * a script comparing against a magic number is a script that breaks silently the day a handle is
   * added in the middle. `"none"` is a real answer rather than a missing one.
   */
  define(
    'hovered',
    OF,
    'String',
    'What the pointer is over, as a name: "none", or one of "translate.x", "translate.yz", "rotate.y", "scale.uniform" and their siblings.',
  ),
  define('dragging', OF, 'bool', 'Whether a drag is running.'),
  define(
    'dragAngle',
    OF,
    'f32',
    'How far a rotation drag has turned, in radians, signed and past a full turn if it went that far. Zero when the drag is not a rotation. This is what to snap or clamp; the rotation itself cannot tell a three-quarter turn from a quarter turn back.',
  ),

  define('positionX', OF, 'f32', 'Where the thing being edited is, along x.'),
  define('positionY', OF, 'f32', 'The same, along y.'),
  define('positionZ', OF, 'f32', 'The same, along z.'),
  define(
    'setPosition',
    [...OF, { name: 'x', type: 'f32' }, { name: 'y', type: 'f32' }, { name: 'z', type: 'f32' }],
    'void',
    'Put the gizmo, and the transform it is editing, somewhere. A drag that is running is not interrupted, so do this between drags.',
  ),

  define('scaleX', OF, 'f32', 'How much the thing being edited is scaled, along x.'),
  define('scaleY', OF, 'f32', 'The same, along y.'),
  define('scaleZ', OF, 'f32', 'The same, along z.'),

  /*
   * **Four reads of a quaternion rather than three Euler angles.** Euler angles would be friendlier
   * to read and would be a different rotation depending on the order they are recomposed in, which
   * is a wrong answer a script author cannot see. `drift/physics` reports a body's orientation the
   * same way, so a script moving one onto the other passes four numbers through unchanged.
   */
  define('rotationX', OF, 'f32', 'The orientation being edited, as a quaternion: x.'),
  define('rotationY', OF, 'f32', 'The same: y.'),
  define('rotationZ', OF, 'f32', 'The same: z.'),
  define('rotationW', OF, 'f32', 'The same: w. Identity is (0, 0, 0, 1).'),

  /*
   * **The session, from `@driftengine/editor`.** Everything above drives one tool; everything below
   * drives the editor around it — which is what an `@editor` script is actually for.
   */
  define('mode', ON, 'String', 'What the editor is doing: "edit", "play" or "paused".'),
  define(
    'playing',
    ON,
    'bool',
    'Whether the world is advancing. False while paused and while editing.',
  ),
  define(
    'play',
    ON,
    'bool',
    'Start playing, taking a snapshot of the world first so `stop` can put it back. Resuming from paused does not re-snapshot. False when no world is bound to snapshot.',
  ),
  define('pause', ON, 'void', 'Hold the world where it is. The frame keeps drawing.'),
  define(
    'step',
    ON,
    'void',
    'Advance exactly one fixed tick, then hold. Does nothing while editing, where there is nothing to step.',
  ),
  define(
    'stop',
    ON,
    'bool',
    'Leave play and put the world back as it was. Every entity handle changes, so a selection is re-found by its place in the snapshot and one that play created is dropped. False when there was nothing to put back.',
  ),

  define('rowCount', ON, 'i32', 'How many rows the tree showed at its last rebuild.'),
  define(
    'rebuildTree',
    [...ON, { name: 'root', type: 'Node' }],
    'void',
    'Walk a node and everything under it into rows, honouring which branches are collapsed.',
  ),
  define(
    'rowName',
    [...ON, { name: 'row', type: 'i32' }],
    'String',
    'What the node on a row is called, or "" for a row that does not exist.',
  ),
  define(
    'rowDepth',
    [...ON, { name: 'row', type: 'i32' }],
    'i32',
    'How deep a row sits, with the root at zero. Minus one for a row that does not exist.',
  ),
  define(
    'rowExpanded',
    [...ON, { name: 'row', type: 'i32' }],
    'bool',
    'Whether a row is showing its children. Meaningless for a row with none.',
  ),
  define(
    'toggleRow',
    [...ON, { name: 'row', type: 'i32' }],
    'void',
    'Open a closed row or close an open one. Call `rebuildTree` afterwards to see it.',
  ),
  define(
    'selectRow',
    [...ON, { name: 'row', type: 'i32' }],
    'void',
    'Select the node on a row, which points the gizmo at it. A row that does not exist selects nothing.',
  ),
  define('selectedRow', ON, 'i32', 'Which row is selected, or minus one.'),

  define('fieldCount', ON, 'i32', 'How many fields the inspector is showing.'),
  define(
    'fieldLabel',
    [...ON, { name: 'field', type: 'i32' }],
    'String',
    'A field\u2019s name as it was declared, or "" for a field that does not exist.',
  ),
  define(
    'fieldGroup',
    [...ON, { name: 'field', type: 'i32' }],
    'String',
    'What a field belongs to: a component\u2019s name, or "transform" for a node.',
  ),
  define(
    'fieldKind',
    [...ON, { name: 'field', type: 'i32' }],
    'String',
    'How to show a field: "number", "integer", "boolean", "text", "entity" or "enum". Taken from the declared type, because a read cannot tell them apart.',
  ),
  define(
    'fieldNumber',
    [...ON, { name: 'field', type: 'i32' }],
    'f32',
    'A field\u2019s value as a number. Zero for a field that is not one, and for one that does not exist.',
  ),
  define(
    'setFieldNumber',
    [...ON, { name: 'field', type: 'i32' }, { name: 'value', type: 'f32' }],
    'bool',
    'Write a number into a field. False where the field does not exist or will not take one.',
  ),
];

/**
 * Handle constants as the names a script reads, in the order the constants run.
 *
 * A table rather than a `switch`, so adding a handle is one line here and the reader stays total.
 */
const HANDLE_NAMES: readonly string[] = [
  'none',
  'translate.x',
  'translate.y',
  'translate.z',
  'translate.yz',
  'translate.zx',
  'translate.xy',
  'rotate.x',
  'rotate.y',
  'rotate.z',
  'scale.x',
  'scale.y',
  'scale.z',
  'scale.uniform',
];

/**
 * **No services, and that is the shape rather than an omission.**
 *
 * Every capability here takes the gizmo it is asking about, so the module needs nothing from the
 * host to answer — a `Gizmo` reaches a script the way a `Terrain` and a `NavGraph` do, as a resource
 * handed in through `uses`. So this is registered unconditionally, and a script that never receives
 * one simply never calls it.
 */
export function editorImplementation(): Record<string, unknown> {
  return {
    translateMode: (gizmo: Gizmo) => {
      gizmo.mode = 'translate';
    },
    rotateMode: (gizmo: Gizmo) => {
      gizmo.mode = 'rotate';
    },
    scaleMode: (gizmo: Gizmo) => {
      gizmo.mode = 'scale';
    },
    gizmoMode: (gizmo: Gizmo) => gizmo.mode,

    worldSpace: (gizmo: Gizmo) => {
      gizmo.space = 'world';
    },
    localSpace: (gizmo: Gizmo) => {
      gizmo.space = 'local';
    },
    space: (gizmo: Gizmo) => gizmo.space,

    size: (gizmo: Gizmo) => gizmo.size,
    setSize: (gizmo: Gizmo, metres: number) => {
      gizmo.size = metres;
    },

    hovered: (gizmo: Gizmo) => HANDLE_NAMES[gizmo.hovered] ?? 'none',
    dragging: (gizmo: Gizmo) => gizmo.dragging,
    dragAngle: (gizmo: Gizmo) => gizmo.dragAngle,

    positionX: (gizmo: Gizmo) => gizmo.position[0] ?? 0,
    positionY: (gizmo: Gizmo) => gizmo.position[1] ?? 0,
    positionZ: (gizmo: Gizmo) => gizmo.position[2] ?? 0,
    setPosition: (gizmo: Gizmo, x: number, y: number, z: number) => {
      gizmo.position[0] = x;
      gizmo.position[1] = y;
      gizmo.position[2] = z;
    },

    scaleX: (gizmo: Gizmo) => gizmo.scale[0] ?? 1,
    scaleY: (gizmo: Gizmo) => gizmo.scale[1] ?? 1,
    scaleZ: (gizmo: Gizmo) => gizmo.scale[2] ?? 1,

    rotationX: (gizmo: Gizmo) => gizmo.rotation[0] ?? 0,
    rotationY: (gizmo: Gizmo) => gizmo.rotation[1] ?? 0,
    rotationZ: (gizmo: Gizmo) => gizmo.rotation[2] ?? 0,
    rotationW: (gizmo: Gizmo) => gizmo.rotation[3] ?? 1,

    mode: (editor: EditorHost) => editor.mode,
    playing: (editor: EditorHost) => editor.mode === 'play',
    play: (editor: EditorHost) => editor.play(),
    pause: (editor: EditorHost) => {
      editor.pause();
    },
    step: (editor: EditorHost) => {
      editor.step();
    },
    stop: (editor: EditorHost) => editor.stop(),

    rowCount: (editor: EditorHost) => editor.tree.rows.length,
    rebuildTree: (editor: EditorHost, root: SceneNode) => {
      editor.tree.rebuild(root);
    },
    /* Every row reader answers a defined value for a row that does not exist, because the language
       has no optional to answer with and a frame loop is the worst place to learn that. */
    rowName: (editor: EditorHost, row: number) => editor.tree.rows[row]?.name ?? '',
    rowDepth: (editor: EditorHost, row: number) => editor.tree.rows[row]?.depth ?? -1,
    rowExpanded: (editor: EditorHost, row: number) => editor.tree.rows[row]?.expanded ?? false,
    toggleRow: (editor: EditorHost, row: number) => {
      const at = editor.tree.rows[row];
      if (at !== undefined) editor.tree.toggle(at.node);
    },
    selectRow: (editor: EditorHost, row: number) => {
      editor.select(editor.tree.rows[row]?.node ?? null);
    },
    selectedRow: (editor: EditorHost) =>
      editor.tree.selected === null ? -1 : editor.tree.rowOf(editor.tree.selected),

    fieldCount: (editor: EditorHost) => editor.inspector.fields.length,
    fieldLabel: (editor: EditorHost, field: number) => editor.inspector.fields[field]?.label ?? '',
    fieldGroup: (editor: EditorHost, field: number) => editor.inspector.fields[field]?.group ?? '',
    fieldKind: (editor: EditorHost, field: number) => editor.inspector.fields[field]?.kind ?? '',
    fieldNumber: (editor: EditorHost, field: number) => {
      const value = editor.inspector.fields[field]?.value;
      return typeof value === 'number' ? value : 0;
    },
    setFieldNumber: (editor: EditorHost, field: number, value: number) =>
      editor.inspector.set(field, value),
  };
}
