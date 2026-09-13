import { SceneNode } from '@driftengine/core';
import { World, defineComponent } from '@driftengine/entities';
import { expect, test } from 'vitest';
import { Inspector, fieldKindOf } from './inspector.ts';
import { formatValue } from './panel.ts';

const Health = defineComponent('Health', { current: 'f32', armour: 'i32', alive: 'bool' });
const Mood = defineComponent('Mood', { state: 'enum:Alertness', target: 'Entity' });
const Named = defineComponent('Named', { label: 'String', nickname: 'option:String' });

test('a declared type decides the kind, which a read cannot', () => {
  expect(fieldKindOf('f32').kind).toBe('number');
  expect(fieldKindOf('f64').kind).toBe('number');
  expect(fieldKindOf('i32').kind).toBe('integer');
  expect(fieldKindOf('u8').kind).toBe('integer');
  expect(fieldKindOf('bool').kind).toBe('boolean');
  expect(fieldKindOf('String').kind).toBe('text');
  expect(fieldKindOf('Entity').kind).toBe('entity');
});

/*
 * The one a read genuinely cannot answer: every one of these arrives as a number, and only the
 * declaration says whether it is a count, a flag, a handle or a discriminant.
 */
test('an enum is an enum and carries the name it was declared with', () => {
  const enumField = fieldKindOf('enum:Alertness');
  expect(enumField.kind).toBe('enum');
  expect(enumField.enumName).toBe('Alertness');
});

/*
 * `option:f32` and not `f32?`. The suffix is the obvious guess and the store spells it as a prefix,
 * because a field type is a key a migration compares for equality.
 */
test('an option is the kind of its inner type and says it is optional', () => {
  expect(fieldKindOf('option:f32')).toEqual({ kind: 'number', enumName: '', optional: true });
  expect(fieldKindOf('option:String')).toEqual({ kind: 'text', enumName: '', optional: true });
  expect(fieldKindOf('option:enum:Alertness')).toEqual({
    kind: 'enum',
    enumName: 'Alertness',
    optional: true,
  });
  expect(fieldKindOf('f32').optional).toBe(false);
});

test('an unrecognised type falls back to a number rather than throwing', () => {
  expect(fieldKindOf('whatever').kind).toBe('number');
});

test('a node shows its ten transform fields', () => {
  const node = new SceneNode();
  const inspector = new Inspector();
  inspector.showNode(node);
  expect(inspector.showing).toBe('node');
  expect(inspector.fields.map((f) => f.label)).toEqual([
    'position.x',
    'position.y',
    'position.z',
    'rotation.x',
    'rotation.y',
    'rotation.z',
    'scale.x',
    'scale.y',
    'scale.z',
    'rotation.w',
  ]);
  expect(inspector.fields.every((f) => f.group === 'transform')).toBe(true);
});

test('a node reports the values it actually holds', () => {
  const node = new SceneNode();
  node.setPosition(1, 2, 3);
  node.setScale(4, 5, 6);
  const inspector = new Inspector();
  inspector.showNode(node);
  expect(inspector.fields[0]!.value).toBe(1);
  expect(inspector.fields[2]!.value).toBe(3);
  expect(inspector.fields[6]!.value).toBe(4);
  expect(inspector.fields[9]!.value).toBe(1);
});

/*
 * Through the setter and not into the array. Writing `position` directly leaves `worldMatrix`
 * describing where the node used to be, with no error and a plausible matrix, and the geometry draws
 * in the wrong place until something else happens to move it.
 */
test('writing a position field moves the node and its world matrix follows', () => {
  const node = new SceneNode();
  node.updateWorld();
  const inspector = new Inspector();
  inspector.showNode(node);
  expect(inspector.set(0, 7)).toBe(true);
  node.updateWorld();
  expect(node.position[0]).toBe(7);
  expect(node.worldMatrix[12]).toBe(7);
});

test('writing a scale field scales the node', () => {
  const node = new SceneNode();
  const inspector = new Inspector();
  inspector.showNode(node);
  expect(inspector.set(6, 3)).toBe(true);
  expect(node.scale[0]).toBe(3);
});

test('writing a rotation component writes the quaternion', () => {
  const node = new SceneNode();
  const inspector = new Inspector();
  inspector.showNode(node);
  expect(inspector.set(9, 0.5)).toBe(true);
  expect(node.rotation[3]).toBe(0.5);
});

test('a value that is not a finite number is refused rather than written', () => {
  const node = new SceneNode();
  const inspector = new Inspector();
  inspector.showNode(node);
  expect(inspector.set(0, 'seven')).toBe(false);
  expect(inspector.set(0, Number.NaN)).toBe(false);
  expect(node.position[0]).toBe(0);
});

test('an index that is not a field is refused', () => {
  const inspector = new Inspector();
  expect(inspector.set(0, 1)).toBe(false);
  inspector.showNode(new SceneNode());
  expect(inspector.set(99, 1)).toBe(false);
});

/*
 * The property that makes this work for a component a `.drs` file declared and this package has
 * never heard of: nothing here knows what `Health` is.
 */
test('an entity shows every field of every component it has', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 80, armour: 3, alive: true });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health, Mood]);
  expect(inspector.showing).toBe('entity');
  expect(inspector.fields.map((f) => f.label)).toEqual(['current', 'armour', 'alive']);
  expect(inspector.fields.map((f) => f.group)).toEqual(['Health', 'Health', 'Health']);
  expect(inspector.fields.map((f) => f.kind)).toEqual(['number', 'integer', 'boolean']);
  expect(inspector.fields[0]!.value).toBe(80);
});

test('a component the entity does not have contributes nothing', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 1 });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health, Mood, Named]);
  expect(inspector.fields.every((f) => f.group === 'Health')).toBe(true);
});

test('two components both show, each under its own group', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 1 });
  world.add(entity, Mood, { state: 2 });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health, Mood]);
  expect(new Set(inspector.fields.map((f) => f.group))).toEqual(new Set(['Health', 'Mood']));
  const state = inspector.fields.find((f) => f.label === 'state')!;
  expect(state.kind).toBe('enum');
  expect(state.enumName).toBe('Alertness');
  expect(state.value).toBe(2);
});

test('writing an entity field writes it through to the world', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 10 });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health]);
  expect(inspector.set(0, 55)).toBe(true);
  expect(world.read(entity, Health, 'current')).toBe(55);
  expect(inspector.fields[0]!.value).toBe(55);
});

/*
 * **A `bool` column is a `Uint8Array` and reads back as 0 or 1**, not as a boolean, and the value
 * this reports is what the store holds rather than a friendlier version of it. `kind` is what tells
 * a panel to draw a checkbox; transforming the value would make `field.value` disagree with
 * `world.read` for one type out of thirteen, which is a worse surprise than the number.
 */
test('a boolean field takes a boolean and reads back as the number the column holds', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 1, alive: true });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health]);
  const at = inspector.fields.findIndex((f) => f.label === 'alive');
  expect(inspector.fields[at]!.value).toBe(1);
  expect(inspector.set(at, false)).toBe(true);
  expect(world.read(entity, Health, 'alive')).toBe(0);
  expect(inspector.fields[at]!.value).toBe(0);
});

test('a boolean value formats as a word whichever way the column spells it', () => {
  expect(formatValue(0, 'boolean')).toBe('false');
  expect(formatValue(1, 'boolean')).toBe('true');
  expect(formatValue(true, 'boolean')).toBe('true');
});

/* The list is stable while the selection is; the values are not. */
test('refresh re-reads the values and keeps the field objects', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 10 });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health]);
  const first = inspector.fields[0];
  world.write(entity, Health, 'current', 42);
  expect(inspector.fields[0]!.value).toBe(10);
  inspector.refresh();
  expect(inspector.fields[0]).toBe(first);
  expect(inspector.fields[0]!.value).toBe(42);
});

test('showing nothing empties the list', () => {
  const inspector = new Inspector();
  inspector.showNode(new SceneNode());
  expect(inspector.fields.length).toBeGreaterThan(0);
  inspector.showNothing();
  expect(inspector.fields.length).toBe(0);
  expect(inspector.showing).toBe('nothing');
});

test('showing a node after an entity forgets the entity', () => {
  const world = new World();
  const entity = world.create();
  world.add(entity, Health, { current: 1 });
  const inspector = new Inspector();
  inspector.showEntity(world, entity, [Health]);
  inspector.showNode(new SceneNode());
  expect(inspector.showing).toBe('node');
  expect(inspector.fields.every((f) => f.group === 'transform')).toBe(true);
});
