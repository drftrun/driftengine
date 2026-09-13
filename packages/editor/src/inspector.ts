/**
 * What is selected, field by field, and how to write one back.
 *
 * **Reflection and nothing else.** A component already describes itself — `ComponentType.schema`
 * carries `{ id, name, type }` per field, and `World.read`/`World.write` take a field by name — so
 * an inspector over an entity is a walk of that schema. It needs no registry, no decorators and no
 * code per component, which is the property that makes it work for a component a `.drs` file
 * declared and this package has never heard of.
 *
 * **A node's transform is the other half**, and it is written back through `setPosition`, `setScale`
 * and `markMoved` rather than into the arrays: writing an array leaves `worldMatrix` stale and the
 * node keeps drawing where it used to be, silently and with a plausible matrix.
 */
import type { SceneNode } from '@driftengine/core';
import type { ComponentType, Entity, World } from '@driftengine/entities';

/**
 * What a field *is*, derived from its declared type rather than from what a read returned.
 *
 * A read cannot tell them apart: `bool` arrives as 0 or 1, an `enum:` discriminant as an integer,
 * and an `Entity` as a number. The declaration can, and it is what a panel needs to know whether to
 * draw a checkbox, a stepper or a menu.
 */
export type FieldKind = 'number' | 'integer' | 'boolean' | 'text' | 'entity' | 'enum';

export interface InspectorField {
  /** What this field belongs to: a component's name, or `transform` for a node. */
  group: string;
  /** The field's own name, as it was declared. */
  label: string;
  /** The declared type, verbatim — `f32`, `enum:Mood`, `Entity`. */
  type: string;
  kind: FieldKind;
  /** For `enum`, the name after the colon. Empty otherwise; this package has no variant list. */
  enumName: string;
  /** Whether the field is an option, which the store spells as an `option:` prefix. */
  optional: boolean;
  /**
   * What the store holds, not a friendlier version of it.
   *
   * **A `bool` column is a `Uint8Array`, so a boolean field reads back as 0 or 1.** `kind` is what
   * tells a panel to draw a checkbox; converting the value here would make this disagree with
   * `world.read` for one type out of thirteen, which is a worse surprise than the number.
   */
  value: unknown;
}

/**
 * `option:f32` is an option of `f32`. Mirrors `optionInner` in the entity store.
 *
 * **A prefix and not a `?` suffix**, which is worth a line because the suffix is the obvious guess
 * and it is wrong: the store's own comment explains that a field type is a *key* compared for
 * equality by a migration, so the option is spelled into the key rather than carried beside it.
 */
function unwrapOption(type: string): { inner: string; optional: boolean } {
  return type.startsWith('option:')
    ? { inner: type.slice('option:'.length), optional: true }
    : { inner: type, optional: false };
}

const INTEGERS = new Set(['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64']);

/**
 * The kind a declared type is inspected as.
 *
 * **An enum is reported as an enum and carries its name**, which is as far as this package can
 * honestly go: the variant list belongs to the module that declared it, and `defineComponent` is
 * handed `enum:Mood` — a name and no variants. A panel that has the list shows the names; one that
 * does not shows the integer, which is what the discriminant is.
 */
export function fieldKindOf(type: string): {
  kind: FieldKind;
  enumName: string;
  optional: boolean;
} {
  const { inner, optional } = unwrapOption(type);
  if (inner.startsWith('enum:')) return { kind: 'enum', enumName: inner.slice(5), optional };
  if (inner === 'bool') return { kind: 'boolean', enumName: '', optional };
  if (inner === 'String') return { kind: 'text', enumName: '', optional };
  if (inner === 'Entity') return { kind: 'entity', enumName: '', optional };
  if (INTEGERS.has(inner)) return { kind: 'integer', enumName: '', optional };
  return { kind: 'number', enumName: '', optional };
}

/** The ten fields a node's transform has, in the order they read. */
const TRANSFORM: readonly (readonly [string, 0 | 1 | 2, 'position' | 'rotation' | 'scale'])[] = [
  ['position.x', 0, 'position'],
  ['position.y', 1, 'position'],
  ['position.z', 2, 'position'],
  ['rotation.x', 0, 'rotation'],
  ['rotation.y', 1, 'rotation'],
  ['rotation.z', 2, 'rotation'],
  ['scale.x', 0, 'scale'],
  ['scale.y', 1, 'scale'],
  ['scale.z', 2, 'scale'],
];

/** A rotation's `w`, which has no axis and so is not in the table above. */
const ROTATION_W = 'rotation.w';

export class Inspector {
  private readonly pool: InspectorField[] = [];
  private readonly live: InspectorField[] = [];

  private node: SceneNode | null = null;
  private world: World | null = null;
  private entity: Entity | null = null;
  private types: readonly ComponentType[] = [];

  /** The fields of whatever is being shown. Reused between calls; copy what you keep. */
  get fields(): readonly InspectorField[] {
    return this.live;
  }

  /** What is being shown: a `SceneNode`, an `Entity`, or nothing. */
  get showing(): 'node' | 'entity' | 'nothing' {
    if (this.node !== null) return 'node';
    return this.entity !== null ? 'entity' : 'nothing';
  }

  showNothing(): void {
    this.node = null;
    this.world = null;
    this.entity = null;
    this.types = [];
    this.live.length = 0;
  }

  showNode(node: SceneNode): void {
    this.showNothing();
    this.node = node;
    this.refresh();
  }

  /**
   * Show an entity's components — every one of `types` it actually has.
   *
   * The types are passed rather than discovered for the reason `serializeWorld` gives: a world holds
   * a store for every type anything ever asked it about, empty ones included, so what to show is a
   * decision rather than everything that happens to exist.
   */
  showEntity(world: World, entity: Entity, types: readonly ComponentType[]): void {
    this.showNothing();
    this.world = world;
    this.entity = entity;
    this.types = types;
    this.refresh();
  }

  /**
   * Re-read the values without rebuilding the list.
   *
   * The list is stable while the selection is and the values are not, so a panel holding a row by
   * index keeps holding the same field across a frame. Rebuilding every frame would also allocate.
   */
  refresh(): void {
    this.live.length = 0;
    if (this.node !== null) {
      this.readTransform(this.node);
      return;
    }
    if (this.world === null || this.entity === null) return;
    for (const type of this.types) {
      if (!this.world.has(this.entity, type)) continue;
      for (const field of type.schema.fields) {
        const { kind, enumName, optional } = fieldKindOf(field.type);
        const at = this.take();
        at.group = type.name;
        at.label = field.name;
        at.type = field.type;
        at.kind = kind;
        at.enumName = enumName;
        at.optional = optional;
        at.value = this.world.read(this.entity, type, field.name);
      }
    }
  }

  /**
   * Write a field back. `false` where the index is not a field, or the value is the wrong shape.
   *
   * **A refusal rather than a throw**, because the caller is a panel inside a frame and a typed box
   * that rejects what was typed into it is an ordinary thing for a panel to have to show.
   */
  set(index: number, value: unknown): boolean {
    const field = this.live[index];
    if (field === undefined) return false;

    if (this.node !== null) return this.writeTransform(this.node, field, value);
    if (this.world === null || this.entity === null) return false;

    const type = this.types.find((candidate) => candidate.name === field.group);
    if (type === undefined) return false;
    if (
      field.kind !== 'text' &&
      field.kind !== 'entity' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return false;
    }
    this.world.write(this.entity, type, field.label, value);
    field.value = this.world.read(this.entity, type, field.label);
    return true;
  }

  private readTransform(node: SceneNode): void {
    for (const [label, axis, part] of TRANSFORM) {
      const at = this.take();
      at.group = 'transform';
      at.label = label;
      at.type = 'f32';
      at.kind = 'number';
      at.enumName = '';
      at.optional = false;
      at.value = node[part][axis] ?? 0;
    }
    const w = this.take();
    w.group = 'transform';
    w.label = ROTATION_W;
    w.type = 'f32';
    w.kind = 'number';
    w.enumName = '';
    w.optional = false;
    w.value = node.rotation[3] ?? 1;
  }

  /**
   * Write one transform field.
   *
   * **Through the setters, and `markMoved` for the rotation**, because writing `position` directly
   * leaves `worldMatrix` describing where the node used to be — with no error, a plausible matrix,
   * and geometry drawn in the wrong place until something else happens to move it.
   */
  private writeTransform(node: SceneNode, field: InspectorField, value: unknown): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const [part, component] = field.label.split('.') as [string, string];
    const axis = component === 'x' ? 0 : component === 'y' ? 1 : component === 'z' ? 2 : 3;

    if (part === 'position') {
      const next = [node.position[0] ?? 0, node.position[1] ?? 0, node.position[2] ?? 0];
      next[axis] = value;
      node.setPosition(next[0] as number, next[1] as number, next[2] as number);
    } else if (part === 'scale') {
      const next = [node.scale[0] ?? 1, node.scale[1] ?? 1, node.scale[2] ?? 1];
      next[axis] = value;
      node.setScale(next[0] as number, next[1] as number, next[2] as number);
    } else {
      node.rotation[axis] = value;
      node.markMoved();
    }
    field.value = value;
    return true;
  }

  private take(): InspectorField {
    const at = this.live.length;
    const existing = this.pool[at];
    if (existing !== undefined) {
      this.live.push(existing);
      return existing;
    }
    const made: InspectorField = {
      group: '',
      label: '',
      type: '',
      kind: 'number',
      enumName: '',
      optional: false,
      value: 0,
    };
    this.pool.push(made);
    this.live.push(made);
    return made;
  }
}
