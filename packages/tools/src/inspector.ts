/**
 * The components of whatever is selected, generated from the schema.
 *
 * **Schema-driven and not a drawer per type**, which is the decision that decides whether an editor
 * stays maintainable. A drawer per component type means every new component needs editor work, so
 * components stop being added — and it is the one thing reflection makes unnecessary, because a
 * component already describes itself. `fieldKindOf` in `@driftengine/editor` already turns a
 * declared type into what to draw, and this uses it rather than repeating it.
 *
 * **A value several entities disagree about is marked, never guessed at.** Showing the first
 * entity's is how somebody types into a field, sees nothing change, and silently overwrites the
 * other nine.
 *
 * **A type this cannot edit is shown read-only rather than dropped.** A field that is silently not
 * there is a field somebody spends an afternoon looking for.
 */
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import type { UiNode } from '@driftengine/ui2d';
import { fieldKindOf, type FieldKind } from '@driftengine/editor';
import type { Command } from './command.ts';
import { selectedEntities, type Selection } from './selection.ts';
import { createPanelRoot, emptyPanel, type Panel } from './panel.ts';

/**
 * What the inspector needs of a world.
 *
 * **Four reads and three writes**, so a panel can be tested against plain maps — this plan's second
 * constraint — and so the same panel serves `@driftengine/entities`, a `.drs` file's declarations
 * and anything else that can answer these. A caller holding a `World` wraps it in seven lines.
 */
export interface InspectableWorld {
  componentsOf(entity: number): readonly string[];
  schemaOf(component: string): readonly { readonly name: string; readonly type: string }[];
  read(entity: number, component: string, field: string): unknown;
  write(entity: number, component: string, field: string, value: unknown): void;
  hasComponent(entity: number, component: string): boolean;
  addComponent(entity: number, component: string): void;
  removeComponent(entity: number, component: string): void;
}

/** What a row's value is when the selected entities disagree about it. */
export const MIXED = Symbol('mixed');

/** A vector row is three number fields; anything else is one field. */
export type RowKind = FieldKind | 'vector';

export interface InspectorRow {
  readonly component: string;
  /** What the row is called: a field's name, or the prefix the vector's three share. */
  readonly label: string;
  /** The declared type, verbatim. Empty for a vector, which is three of them. */
  readonly type: string;
  readonly kind: RowKind;
  readonly enumName: string;
  /** The schema fields this row writes, in order. One, or three for a vector. */
  readonly fields: readonly string[];
  /** The value, `MIXED` where the selection disagrees. An array of three for a vector. */
  readonly value: unknown;
  readonly editable: boolean;
}

/**
 * The declared types this can edit.
 *
 * **A list rather than `fieldKindOf`'s answer**, because that function's fallback is `number` — it
 * is asked what *kind* a known type is, not whether a type is known, and `MeshHandle` comes back as
 * a number that would then be typed into. The two questions are different and the second one is
 * this file's.
 */
const KNOWN = new Set([
  'f32',
  'f64',
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
  'bool',
  'String',
  'Entity',
]);

export function fieldEditable(type: string): boolean {
  const inner = type.startsWith('option:') ? type.slice('option:'.length) : type;
  return KNOWN.has(inner) || inner.startsWith('enum:');
}

/** `position.x` is the `x` of a vector called `position`. Anything else is its own row. */
function vectorPartOf(name: string): { prefix: string; axis: number } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const axis = 'xyz'.indexOf(name.slice(dot + 1));
  return axis < 0 ? null : { prefix: name.slice(0, dot), axis };
}

/** One value across the selection, or `MIXED`. */
function agreed(
  world: InspectableWorld,
  entities: readonly number[],
  component: string,
  field: string,
): unknown {
  const first = world.read(entities[0] as number, component, field);
  for (let at = 1; at < entities.length; at += 1) {
    if (world.read(entities[at] as number, component, field) !== first) return MIXED;
  }
  return first;
}

/**
 * The rows for a selection: the components every selected entity has, field by field.
 *
 * Components are taken from the first entity and then filtered by the rest, so the order is stable
 * — a row that moved between frames because a set iterated differently is a field somebody clicks
 * and misses.
 */
export function inspectorRows(
  world: InspectableWorld,
  entities: readonly number[],
): InspectorRow[] {
  const first = entities[0];
  if (first === undefined) return [];

  const shared = world
    .componentsOf(first)
    .filter((component) => entities.every((entity) => world.hasComponent(entity, component)));

  const rows: InspectorRow[] = [];
  for (const component of shared) {
    const fields = world.schemaOf(component);
    const vectors = new Map<string, string[]>();

    for (const field of fields) {
      const part = vectorPartOf(field.name);
      if (part === null) continue;
      const slots = vectors.get(part.prefix) ?? ['', '', ''];
      slots[part.axis] = field.name;
      vectors.set(part.prefix, slots);
    }
    /* Two of three is not a vector; it is two fields that happen to be named that way. */
    for (const [prefix, slots] of vectors) {
      if (slots.some((slot) => slot === '')) vectors.delete(prefix);
    }
    const claimed = new Set([...vectors.values()].flat());

    const emitted = new Set<string>();
    for (const field of fields) {
      const part = vectorPartOf(field.name);
      if (part !== null && claimed.has(field.name)) {
        if (emitted.has(part.prefix)) continue;
        emitted.add(part.prefix);
        const slots = vectors.get(part.prefix) as string[];
        rows.push({
          component,
          label: part.prefix,
          type: '',
          kind: 'vector',
          enumName: '',
          fields: slots,
          value: slots.map((slot) => agreed(world, entities, component, slot)),
          editable: fieldEditable(field.type),
        });
        continue;
      }
      const { kind, enumName } = fieldKindOf(field.type);
      rows.push({
        component,
        label: field.name,
        type: field.type,
        kind,
        enumName,
        fields: [field.name],
        value: agreed(world, entities, component, field.name),
        editable: fieldEditable(field.type),
      });
    }
  }
  return rows;
}

/**
 * Write one row's fields across the whole selection, as one entry.
 *
 * **One entry for the whole selection and for all three of a vector's components.** Editing with
 * ten entities selected is one act, and undo that took it back one entity at a time would make the
 * person count. Each entity's own previous value is recorded, so undo does not flatten them onto
 * whatever the first one held.
 */
export function setFieldCommand(
  world: InspectableWorld,
  entities: readonly number[],
  component: string,
  fields: readonly string[],
  values: readonly unknown[],
): Command | null {
  if (entities.length === 0 || fields.length === 0) return null;
  if (!entities.every((entity) => world.hasComponent(entity, component))) return null;

  const before = entities.map((entity) =>
    fields.map((field) => world.read(entity, component, field)),
  );

  return {
    label: `${component}.${stripAxis(fields)}`,
    apply: (): void => {
      for (const entity of entities) {
        fields.forEach((field, at) => world.write(entity, component, field, values[at]));
      }
    },
    revert: (): void => {
      entities.forEach((entity, row) => {
        fields.forEach((field, at) => {
          world.write(entity, component, field, (before[row] as unknown[])[at]);
        });
      });
    },
  };
}

/** A vector's label is what its three fields share, so the undo menu says `position` not `position.x`. */
function stripAxis(fields: readonly string[]): string {
  const first = fields[0] as string;
  if (fields.length === 1) return first;
  const part = vectorPartOf(first);
  return part === null ? first : part.prefix;
}

export function addComponentCommand(
  world: InspectableWorld,
  entities: readonly number[],
  component: string,
): Command | null {
  const missing = entities.filter((entity) => !world.hasComponent(entity, component));
  if (missing.length === 0) return null;
  return {
    label: `Add ${component}`,
    apply: (): void => {
      for (const entity of missing) world.addComponent(entity, component);
    },
    revert: (): void => {
      for (const entity of missing) world.removeComponent(entity, component);
    },
  };
}

/**
 * Remove a component, keeping its values so undo can put them back.
 *
 * **The values are read before the removal and written after the restore.** A remove that only
 * remembers "it was there" gives back a component full of zeroes, which reads as undo having
 * worked and is the worse failure: nothing looks broken.
 */
export function removeComponentCommand(
  world: InspectableWorld,
  entities: readonly number[],
  component: string,
): Command | null {
  const present = entities.filter((entity) => world.hasComponent(entity, component));
  if (present.length === 0) return null;
  const fields = world.schemaOf(component).map((field) => field.name);
  const kept = present.map((entity) => fields.map((field) => world.read(entity, component, field)));

  return {
    label: `Remove ${component}`,
    apply: (): void => {
      for (const entity of present) world.removeComponent(entity, component);
    },
    revert: (): void => {
      present.forEach((entity, row) => {
        world.addComponent(entity, component);
        fields.forEach((field, at) => {
          world.write(entity, component, field, (kept[row] as unknown[])[at]);
        });
      });
    },
  };
}

export interface InspectorWorld {
  readonly world: InspectableWorld;
}

export interface InspectorView {
  readonly root: UiNode;
  readonly selection: Selection;
  /** The rows the last build produced, so routing can find a field by index. */
  rows: InspectorRow[];
  rowHeight: number;
}

export function createInspectorView(options: {
  selection: Selection;
  rowHeight?: number;
}): InspectorView {
  return {
    root: createPanelRoot(inspectorPanel),
    selection: options.selection,
    rows: [],
    rowHeight: options.rowHeight ?? 18,
  };
}

/** What a row shows to the right of its label. `—` is the mark for a disagreement. */
export function rowText(row: InspectorRow): string {
  if (row.value === MIXED) return `${row.label}  —`;
  if (row.kind === 'vector') {
    const parts = (row.value as unknown[]).map((part) => (part === MIXED ? '—' : String(part)));
    return `${row.label}  ${parts.join(', ')}`;
  }
  if (row.kind === 'boolean') return `${row.label}  ${row.value ? 'true' : 'false'}`;
  return `${row.label}  ${String(row.value)}`;
}

export const inspectorPanel: Panel<InspectorWorld, InspectorView> = {
  id: 'inspector',
  title: 'Inspector',

  build(world, view, root): void {
    const entities = selectedEntities(view.selection);
    view.rows = inspectorRows(world.world, entities);
    if (view.rows.length === 0) {
      emptyPanel(root, entities.length === 0 ? 'Nothing selected' : 'No fields in common');
      return;
    }
    root.children.length = 0;
    for (let at = 0; at < view.rows.length; at += 1) {
      const row = view.rows[at] as InspectorRow;
      addUiChild(
        root,
        createUiNode({
          width: 'grow',
          height: view.rowHeight,
          text: rowText(row),
          interactive: row.editable,
          focusable: row.editable,
          name: `field:${at}`,
        }),
      );
    }
  },

  route(): Command | null {
    /* Task 5 wires the field widgets in. Until then the inspector shows and does not edit, which
       is a state worth having rather than a half-built router that swallows keys. */
    return null;
  },
};

/**
 * The shape of a component type, as this package needs it.
 *
 * **Structural rather than imported.** `@driftengine/entities`' `ComponentType` satisfies it, and
 * so does anything else a consumer describes its state with — which is the arrangement
 * `@driftengine/drft` already has with `@driftengine/texture`'s DTEX types across a boundary the
 * one package must not depend across. This package gains no dependency for the adapter below, so
 * the release's place count does not move.
 */
export interface InspectableComponentType {
  readonly name: string;
  readonly schema: { readonly fields: readonly { readonly name: string; readonly type: string }[] };
}

/** The five methods the adapter forwards to. `World` has all of them. */
export interface EntityWorldLike<T> {
  has(entity: number, type: T): boolean;
  add(entity: number, type: T): void;
  remove(entity: number, type: T): boolean;
  read(entity: number, type: T, field: string): unknown;
  write(entity: number, type: T, field: string, value: unknown): void;
}

/**
 * An entity world, as something the inspector can read and edit.
 *
 * **Written once here because every consumer with a world was about to write it.** The inspector
 * addresses a component by name, since a name is what a row carries; a world addresses it by the
 * type object, since that is what indexes its stores. Bridging the two is seven forwarding methods
 * and a lookup, identical wherever it is written.
 *
 * **A name with no type behind it does nothing rather than guessing.** A row built against a stale
 * schema would otherwise write a field into a component the world does not have and report
 * success, which is a silent loss of the edit a person just made and watched apply.
 *
 * `componentsOf` answers in the order the types were given, so a panel's rows do not reorder
 * between frames.
 */
export function entitiesInspectable<T extends InspectableComponentType>(
  world: EntityWorldLike<T>,
  types: readonly T[],
): InspectableWorld {
  const byName = new Map<string, T>();
  for (const type of types) byName.set(type.name, type);

  return {
    componentsOf(entity: number): readonly string[] {
      const out: string[] = [];
      for (const type of types) if (world.has(entity, type)) out.push(type.name);
      return out;
    },
    schemaOf(component: string): readonly { readonly name: string; readonly type: string }[] {
      return byName.get(component)?.schema.fields ?? [];
    },
    read(entity: number, component: string, field: string): unknown {
      const type = byName.get(component);
      return type === undefined ? undefined : world.read(entity, type, field);
    },
    write(entity: number, component: string, field: string, value: unknown): void {
      const type = byName.get(component);
      if (type !== undefined) world.write(entity, type, field, value);
    },
    hasComponent(entity: number, component: string): boolean {
      const type = byName.get(component);
      return type !== undefined && world.has(entity, type);
    },
    addComponent(entity: number, component: string): void {
      const type = byName.get(component);
      if (type !== undefined) world.add(entity, type);
    },
    removeComponent(entity: number, component: string): void {
      const type = byName.get(component);
      if (type !== undefined) world.remove(entity, type);
    },
  };
}
