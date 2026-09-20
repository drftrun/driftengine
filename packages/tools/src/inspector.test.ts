import { describe, expect, it } from 'vitest';
import { createUndoStack } from './command.ts';
import { createSelection, selectOnly, addToSelection } from './selection.ts';
import { MIXED, inspectorRows, fieldEditable } from './inspector.ts';
import {
  addComponentCommand,
  createInspectorView,
  inspectorPanel,
  removeComponentCommand,
  setFieldCommand,
  type InspectableWorld,
} from './inspector.ts';

/** A world of plain maps, because a panel that needs an engine to be tested is one nobody tests. */
function fakeWorld(): InspectableWorld & { store: Map<string, unknown> } {
  const schemas = new Map<string, { name: string; type: string }[]>([
    [
      'Health',
      [
        { name: 'current', type: 'f32' },
        { name: 'max', type: 'f32' },
        { name: 'invulnerable', type: 'bool' },
      ],
    ],
    [
      'Transform',
      [
        { name: 'position.x', type: 'f32' },
        { name: 'position.y', type: 'f32' },
        { name: 'position.z', type: 'f32' },
      ],
    ],
    ['Mesh', [{ name: 'geometry', type: 'MeshHandle' }]],
    [
      'Span',
      [
        { name: 'range.x', type: 'f32' },
        { name: 'range.y', type: 'f32' },
      ],
    ],
    ['Mood', [{ name: 'state', type: 'enum:Mood' }]],
  ]);
  const has = new Map<number, Set<string>>();
  const store = new Map<string, unknown>();
  const key = (e: number, c: string, f: string): string => `${e}/${c}/${f}`;

  return {
    store,
    componentsOf: (entity) => [...(has.get(entity) ?? [])],
    schemaOf: (component) => schemas.get(component) ?? [],
    read: (entity, component, field) => store.get(key(entity, component, field)),
    write: (entity, component, field, value) => {
      store.set(key(entity, component, field), value);
    },
    hasComponent: (entity, component) => has.get(entity)?.has(component) === true,
    addComponent: (entity, component) => {
      const set = has.get(entity) ?? new Set<string>();
      set.add(component);
      has.set(entity, set);
    },
    removeComponent: (entity, component) => {
      has.get(entity)?.delete(component);
    },
  };
}

function withHealth(entity: number, current: number, max = 100): InspectableWorld {
  const world = fakeWorld();
  world.addComponent(entity, 'Health');
  world.write(entity, 'Health', 'current', current);
  world.write(entity, 'Health', 'max', max);
  world.write(entity, 'Health', 'invulnerable', 0);
  return world;
}

describe('the inspector', () => {
  it('turns a number field into an editable number row', () => {
    const rows = inspectorRows(withHealth(1, 42), [1]);
    const current = rows.find((row) => row.label === 'current');
    expect(current?.kind).toBe('number');
    expect(current?.editable).toBe(true);
    expect(current?.value).toBe(42);
    expect(current?.component).toBe('Health');
  });

  it('turns a bool into a boolean row and an enum into an enum row', () => {
    const world = fakeWorld();
    world.addComponent(1, 'Health');
    world.addComponent(1, 'Mood');
    world.write(1, 'Health', 'invulnerable', 0);
    world.write(1, 'Mood', 'state', 2);

    const rows = inspectorRows(world, [1]);
    expect(rows.find((row) => row.label === 'invulnerable')?.kind).toBe('boolean');
    const mood = rows.find((row) => row.label === 'state');
    expect(mood?.kind).toBe('enum');
    expect(mood?.enumName, 'the name is as far as this can honestly go').toBe('Mood');
  });

  /**
   * **Three fields, one row, one undo entry.** `position.x`, `.y` and `.z` are three declarations
   * in the schema and one thing to a person, and nudging an object by typing into each in turn is
   * one act — three presses of undo to take it back is the editor insisting on its own structure.
   */
  it('gathers x, y and z into one vector row', () => {
    const world = fakeWorld();
    world.addComponent(1, 'Transform');
    world.write(1, 'Transform', 'position.x', 1);
    world.write(1, 'Transform', 'position.y', 2);
    world.write(1, 'Transform', 'position.z', 3);

    const rows = inspectorRows(world, [1]);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.kind).toBe('vector');
    expect(row?.label).toBe('position');
    expect(row?.value).toEqual([1, 2, 3]);
    expect(row?.fields).toEqual(['position.x', 'position.y', 'position.z']);
  });

  /**
   * **An unsupported type is shown read-only rather than dropped.** A field that silently is not
   * there is a field somebody spends an afternoon looking for, and the honest answer is to show it
   * and refuse to edit it.
   */
  it('shows a type it cannot edit rather than hiding it', () => {
    const world = fakeWorld();
    world.addComponent(1, 'Mesh');
    world.write(1, 'Mesh', 'geometry', 'car.drft');

    const rows = inspectorRows(world, [1]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.editable, 'visible and refused').toBe(false);
    expect(rows[0]?.type).toBe('MeshHandle');
    expect(fieldEditable('MeshHandle')).toBe(false);
    expect(fieldEditable('option:f32'), 'an option of something known is known').toBe(true);
  });

  /**
   * **Two of three is not a vector**, it is two fields that happen to be named that way. Gathering
   * them anyway produces a three-component row whose z is undefined, and a command that writes a
   * field the schema never declared.
   */
  it('leaves a pair named x and y as two fields', () => {
    const world = fakeWorld();
    world.addComponent(1, 'Span');
    world.write(1, 'Span', 'range.x', 1);
    world.write(1, 'Span', 'range.y', 2);

    const rows = inspectorRows(world, [1]);
    expect(rows.map((row) => row.label)).toEqual(['range.x', 'range.y']);
    expect(rows.every((row) => row.kind === 'number')).toBe(true);
  });

  it('shows nothing when nothing is selected', () => {
    expect(inspectorRows(withHealth(1, 5), [])).toEqual([]);
  });
});

describe('several entities at once', () => {
  function two(): InspectableWorld {
    const world = fakeWorld();
    for (const entity of [1, 2]) {
      world.addComponent(entity, 'Health');
      world.write(entity, 'Health', 'current', entity === 1 ? 42 : 7);
      world.write(entity, 'Health', 'max', 100);
      world.write(entity, 'Health', 'invulnerable', 0);
    }
    world.addComponent(1, 'Mesh');
    return world;
  }

  /** A field only one of them has is not a field of the selection. */
  it('shows the fields they have in common', () => {
    const rows = inspectorRows(two(), [1, 2]);
    expect(rows.map((row) => row.label).sort()).toEqual(['current', 'invulnerable', 'max']);
  });

  /**
   * **A differing value is marked, not guessed at.** Showing the first entity's is how somebody
   * types into a field, changes nothing they can see, and silently overwrites the other nine.
   */
  it('marks a value they disagree about instead of showing the first', () => {
    const rows = inspectorRows(two(), [1, 2]);
    expect(rows.find((row) => row.label === 'current')?.value).toBe(MIXED);
    expect(rows.find((row) => row.label === 'max')?.value, 'agreeing values still show').toBe(100);
  });

  it('writes one command that reaches all of them', () => {
    const world = two();
    const command = setFieldCommand(world, [1, 2], 'Health', ['current'], [55]);
    const stack = createUndoStack(8);
    stack.push(command!);

    expect(world.read(1, 'Health', 'current')).toBe(55);
    expect(world.read(2, 'Health', 'current')).toBe(55);

    stack.undo();
    expect(world.read(1, 'Health', 'current'), 'each goes back to its own').toBe(42);
    expect(world.read(2, 'Health', 'current')).toBe(7);
  });
});

describe('the commands an inspector emits', () => {
  it('carries the entity, the component, the field and the value', () => {
    const world = withHealth(1, 42);
    const command = setFieldCommand(world, [1], 'Health', ['current'], [99]);
    expect(command?.label).toBe('Health.current');

    const stack = createUndoStack(8);
    stack.push(command!);
    expect(world.read(1, 'Health', 'current')).toBe(99);
    stack.undo();
    expect(world.read(1, 'Health', 'current')).toBe(42);
  });

  it('writes a vector’s three components under one entry', () => {
    const world = fakeWorld();
    world.addComponent(1, 'Transform');
    for (const axis of ['x', 'y', 'z']) world.write(1, 'Transform', `position.${axis}`, 0);

    const stack = createUndoStack(8);
    stack.push(
      setFieldCommand(
        world,
        [1],
        'Transform',
        ['position.x', 'position.y', 'position.z'],
        [4, 5, 6],
      )!,
    );
    expect(world.read(1, 'Transform', 'position.y')).toBe(5);

    expect(stack.undo()).toBe(true);
    expect(world.read(1, 'Transform', 'position.z')).toBe(0);
    expect(stack.canUndo(), 'one entry for all three').toBe(false);
  });

  it('refuses to write a field nothing selected has', () => {
    expect(setFieldCommand(withHealth(1, 1), [1], 'Mesh', ['geometry'], ['x'])).toBe(null);
    expect(setFieldCommand(withHealth(1, 1), [], 'Health', ['current'], [1])).toBe(null);
  });

  it('adds a component, and removing it again is one entry', () => {
    const world = withHealth(1, 42);
    const stack = createUndoStack(8);

    stack.push(addComponentCommand(world, [2], 'Health')!);
    expect(world.hasComponent(2, 'Health')).toBe(true);
    stack.undo();
    expect(world.hasComponent(2, 'Health')).toBe(false);
  });

  it('adds nothing to an entity that already has it', () => {
    expect(addComponentCommand(withHealth(1, 42), [1], 'Health')).toBe(null);
  });

  /** Removing a component throws its values away, so undo has to have kept them. */
  it('puts a removed component’s values back', () => {
    const world = withHealth(1, 42, 250);
    const stack = createUndoStack(8);
    stack.push(removeComponentCommand(world, [1], 'Health')!);
    expect(world.hasComponent(1, 'Health')).toBe(false);

    stack.undo();
    expect(world.hasComponent(1, 'Health')).toBe(true);
    expect(world.read(1, 'Health', 'current')).toBe(42);
    expect(world.read(1, 'Health', 'max')).toBe(250);
  });
});

describe('the inspector panel', () => {
  it('builds a row per field and says so when nothing is selected', () => {
    const world = withHealth(1, 42);
    const selection = createSelection();
    const view = createInspectorView({ selection });

    inspectorPanel.build({ world }, view, view.root);
    expect(view.root.children[0]?.text).toContain('Nothing selected');

    selectOnly(selection, 1);
    inspectorPanel.build({ world }, view, view.root);
    expect(view.rows.map((row) => row.label)).toEqual(['current', 'max', 'invulnerable']);
    expect(view.root.children.length).toBe(3);
  });

  it('is a function of the world and the view', () => {
    const world = withHealth(1, 42);
    const selection = createSelection();
    selectOnly(selection, 1);
    const view = createInspectorView({ selection });

    inspectorPanel.build({ world }, view, view.root);
    const once = view.root.children.map((child) => child.text).join('|');
    inspectorPanel.build({ world }, view, view.root);
    expect(view.root.children.map((child) => child.text).join('|')).toBe(once);
  });

  it('shows the common fields of a multi-entity selection', () => {
    const world = fakeWorld();
    for (const entity of [1, 2]) {
      world.addComponent(entity, 'Health');
      world.write(entity, 'Health', 'current', entity);
      world.write(entity, 'Health', 'max', 100);
      world.write(entity, 'Health', 'invulnerable', 0);
    }
    const selection = createSelection();
    selectOnly(selection, 1);
    addToSelection(selection, 2);

    const view = createInspectorView({ selection });
    inspectorPanel.build({ world }, view, view.root);
    expect(view.root.children[0]?.text).toContain('—');
  });
});
