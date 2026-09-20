import { expect, test } from 'vitest';
import {
  commandForKey,
  createCommandRegistry,
  matchScore,
  registerCommand,
  runCommand,
  searchCommands,
} from './registry.ts';

function registry() {
  const r = createCommandRegistry();
  let ran = '';
  registerCommand(r, {
    id: 'save',
    label: 'Save Scene',
    run: () => (ran = 'save'),
    binding: 'ctrl+s',
  });
  registerCommand(r, { id: 'assets', label: 'Show Asset View', run: () => (ran = 'assets') });
  registerCommand(r, { id: 'undo', label: 'Undo', run: () => (ran = 'undo'), binding: 'ctrl+z' });
  return { r, ran: () => ran };
}

test('a registered command runs by identifier', () => {
  const { r, ran } = registry();
  expect(runCommand(r, 'save')).toBe(true);
  expect(ran()).toBe('save');
});

test('an unknown identifier reports failure rather than throwing', () => {
  expect(runCommand(createCommandRegistry(), 'nope')).toBe(false);
});

test('a binding resolves to its command and an unbound key to nothing', () => {
  const { r } = registry();
  expect(commandForKey(r, 'ctrl+z')).toBe('undo');
  expect(commandForKey(r, 'ctrl+q')).toBe(null);
});

test('registering the same identifier twice is refused, so nothing silently shadows a built-in', () => {
  const { r } = registry();
  expect(registerCommand(r, { id: 'save', label: 'Impostor', run: () => {} })).toBe(false);
  expect(r.commands.get('save')?.label).toBe('Save Scene');
});

test('a prefix match ranks above a subsequence match', () => {
  const { r } = registry();
  const out: string[] = [];
  searchCommands(r, 'sav', out);
  expect(out[0]).toBe('save');
});

test('a non-matching query returns nothing', () => {
  const { r } = registry();
  const out: string[] = [];
  expect(searchCommands(r, 'zzzz', out)).toBe(0);
});

test('an empty query returns every command in a stable order', () => {
  const { r } = registry();
  const a: string[] = [];
  const b: string[] = [];
  searchCommands(r, '', a);
  searchCommands(r, '', b);
  expect(a.length).toBe(3);
  expect(a).toEqual(b);
});

test('a subsequence still matches, just later', () => {
  expect(matchScore('Show Asset View', 'sav')).toBeGreaterThan(matchScore('Save Scene', 'sav'));
  expect(matchScore('Show Asset View', 'sav')).toBeGreaterThanOrEqual(0);
});

test('a contiguous match inside a label beats a scattered one', () => {
  /* Both match: the first contains "scene", the second only spells it out of order. */
  const contiguous = matchScore('Reopen Scene', 'scene');
  const scattered = matchScore('Select Canvas Entry Name', 'scene');
  expect(contiguous).toBeGreaterThanOrEqual(0);
  expect(scattered).toBeGreaterThanOrEqual(0);
  expect(contiguous).toBeLessThan(scattered);
});

test('a label sharing no characters in order does not match at all', () => {
  expect(matchScore('Show Canvas Entry', 'scene')).toBe(-1);
});
