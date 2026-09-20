import { describe, expect, it } from 'vitest';
import { createUndoStack } from '@driftengine/tools';
import {
  beginFieldEdit,
  createField,
  createVectorField,
  fieldValue,
  routeFieldKey,
  vectorEditCommand,
} from './field.ts';

function type(field: ReturnType<typeof createField>, text: string): void {
  for (const ch of text) routeFieldKey(field, ch);
}

describe('a text field', () => {
  it('routes typing into the text model', () => {
    const field = createField({ value: '' });
    beginFieldEdit(field);
    type(field, 'hello');
    expect(field.model.text).toBe('hello');
    expect(field.model.caret).toBe(5);

    /* Backspace takes the character before the caret, so moving first changes which one. */
    routeFieldKey(field, 'ArrowLeft');
    routeFieldKey(field, 'Backspace');
    expect(field.model.text).toBe('helo');
    expect(field.model.caret, 'and the caret stays where the deletion left it').toBe(3);
  });

  /**
   * Opening a field selects what is in it, so the first keystroke replaces rather than appends.
   * That is what every editor does and what makes a numeric field usable with one click and a
   * number — and it is why the escape case below types `!!!` and gets `!!!`.
   */
  it('opens with everything selected, so typing replaces', () => {
    const field = createField({ value: 'original' });
    beginFieldEdit(field);
    type(field, 'x');
    expect(field.model.text).toBe('x');
  });

  /**
   * **The field never writes.** It hands back a command and the caller pushes it, which is the
   * rule `command.ts` states as a signature rather than a convention: a panel that cannot reach the
   * world cannot forget to record what it did.
   */
  it('emits a command on commit instead of writing', () => {
    let stored = 'before';
    const field = createField({
      value: stored,
      command: (from, to) => ({
        label: 'Rename',
        apply: () => {
          stored = to;
        },
        revert: () => {
          stored = from;
        },
      }),
    });

    beginFieldEdit(field);
    field.model.text = 'after';
    const result = routeFieldKey(field, 'Enter');

    expect(result.outcome).toBe('committed');
    expect(stored, 'committing does not write; the stack does').toBe('before');

    const stack = createUndoStack(8);
    stack.push(result.command!);
    expect(stored).toBe('after');
    stack.undo();
    expect(stored).toBe('before');
  });

  it('commits nothing when the value did not change', () => {
    const field = createField({
      value: 'same',
      command: () => ({ label: 'x', apply() {}, revert() {} }),
    });
    beginFieldEdit(field);
    const result = routeFieldKey(field, 'Enter');
    expect(result.outcome).toBe('committed');
    expect(result.command, 'an unchanged field is not an undo entry').toBe(null);
  });

  /** Escape is the promise that makes a field safe to type in at all. */
  it('gives back the value it opened with on escape', () => {
    const field = createField({ value: 'original' });
    beginFieldEdit(field);
    type(field, '!!!');
    expect(field.model.text, 'the open selected everything, so this replaced it').toBe('!!!');

    const result = routeFieldKey(field, 'Escape');
    expect(result.outcome).toBe('reverted');
    expect(field.model.text).toBe('original');
    expect(field.editing).toBe(false);
  });

  /**
   * Escape restores what the field opened with, not what it was constructed with. A field edited,
   * committed and reopened has a new starting point, and reverting to the older one would undo a
   * change the person had already accepted.
   */
  it('reverts to the value the current edit began with', () => {
    const field = createField({ value: 'one' });
    beginFieldEdit(field);
    field.model.text = 'two';
    routeFieldKey(field, 'Enter');

    beginFieldEdit(field);
    type(field, '!');
    routeFieldKey(field, 'Escape');
    expect(field.model.text).toBe('two');
  });

  it('ignores keys it has no meaning for', () => {
    const field = createField({ value: '' });
    beginFieldEdit(field);
    expect(routeFieldKey(field, 'F7').outcome).toBe('ignored');
    expect(field.model.text).toBe('');
  });
});

describe('a number field', () => {
  it('takes the keystrokes a number is made of', () => {
    const field = createField({ kind: 'number', value: '' });
    beginFieldEdit(field);
    type(field, '-12.5e3');
    expect(field.model.text).toBe('-12.5e3');
    expect(fieldValue(field)).toBe(-12500);
  });

  /**
   * **Rejecting must not disturb the caret**, which is the whole difficulty. The obvious
   * implementation re-parses the text and writes it back, and a caret in the middle of `1.5`
   * jumps to the end the first time somebody types a letter — so the next real digit lands in the
   * wrong place and the field is worse than one with no validation at all.
   */
  it('rejects a keystroke that is not part of a number, and keeps the caret where it was', () => {
    const field = createField({ kind: 'number', value: '1.5' });
    beginFieldEdit(field);
    field.model.caret = 1;
    field.model.anchor = 1;

    const result = routeFieldKey(field, 'a');
    expect(result.outcome).toBe('rejected');
    expect(field.model.text).toBe('1.5');
    expect(field.model.caret, 'the caret did not move').toBe(1);
  });

  it('rejects a second decimal point but allows the first', () => {
    const field = createField({ kind: 'number', value: '' });
    beginFieldEdit(field);
    type(field, '1.5');
    expect(routeFieldKey(field, '.').outcome).toBe('rejected');
    expect(field.model.text).toBe('1.5');
  });

  /** A number in the making is not yet a number, and a field that refuses `-` cannot start one. */
  it('accepts the states a number passes through on its way to being one', () => {
    const field = createField({ kind: 'number', value: '' });
    beginFieldEdit(field);
    for (const partial of ['-', '-.', '-.5', '-.5e', '-.5e-', '-.5e-2']) {
      field.model.text = '';
      field.model.caret = 0;
      field.model.anchor = 0;
      type(field, partial);
      expect(field.model.text, `${partial} must be typeable`).toBe(partial);
    }
  });

  it('reads an unfinished number as the number it is so far', () => {
    const field = createField({ kind: 'number', value: '-' });
    expect(fieldValue(field), 'a lone minus is not a number, and zero is the honest stand-in').toBe(
      0,
    );
  });

  it('deleting back to nothing is allowed', () => {
    const field = createField({ kind: 'number', value: '5' });
    beginFieldEdit(field);
    expect(routeFieldKey(field, 'Backspace').outcome).toBe('typed');
    expect(field.model.text).toBe('');
  });
});

describe('a vector field', () => {
  it('has one text model per component, each a number field', () => {
    const vector = createVectorField({ value: [1, 2, 3] });
    expect(vector.fields.map((f) => f.model.text)).toEqual(['1', '2', '3']);
    expect(vector.fields[0]?.kind).toBe('number');
  });

  /**
   * **Three components, one undo entry.** Nudging an object by typing into x, then y, then z is
   * one act to the person doing it; three presses of undo to take it back is the editor insisting
   * on its own internal structure. The commands merge, which is the mechanism `command.ts` already
   * has for a gizmo drag rather than a second one invented here.
   */
  it('merges its three components into one undo entry', () => {
    const position = [0, 0, 0];
    const stack = createUndoStack(8);

    stack.push(vectorEditCommand('Move', position, [0, 0, 0], [5, 0, 0]));
    stack.push(vectorEditCommand('Move', position, [5, 0, 0], [5, 7, 0]));
    stack.push(vectorEditCommand('Move', position, [5, 7, 0], [5, 7, 9]));
    expect(position).toEqual([5, 7, 9]);

    expect(stack.undo()).toBe(true);
    expect(position, 'one undo takes back all three').toEqual([0, 0, 0]);
    expect(stack.canUndo()).toBe(false);
  });

  /** And a different vector is a different entry, or moving two objects becomes one undo. */
  it('does not merge across vectors', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const stack = createUndoStack(8);

    stack.push(vectorEditCommand('Move', a, [0, 0, 0], [1, 0, 0]));
    stack.push(vectorEditCommand('Move', b, [0, 0, 0], [2, 0, 0]));

    stack.undo();
    expect(b).toEqual([0, 0, 0]);
    expect(a, 'the first object has not moved back yet').toEqual([1, 0, 0]);
    stack.undo();
    expect(a).toEqual([0, 0, 0]);
  });

  it('redoes to the merged end state and not to an intermediate one', () => {
    const position = [0, 0, 0];
    const stack = createUndoStack(8);
    stack.push(vectorEditCommand('Move', position, [0, 0, 0], [1, 0, 0]));
    stack.push(vectorEditCommand('Move', position, [1, 0, 0], [1, 2, 0]));

    stack.undo();
    expect(position).toEqual([0, 0, 0]);
    stack.redo();
    expect(position).toEqual([1, 2, 0]);
  });
});

/**
 * **`ignored` is what lets a caller pass a key on**, so it has to mean the field did nothing.
 * An arrow key reported as ignored is an arrow key that moves the caret *and* steps the selection
 * in the tree behind the field — a bug with no symptom until somebody has a field focused.
 */
describe('what a field says it did', () => {
  it('distinguishes a key it consumed from a key it did not', () => {
    const field = createField({ value: 'abc' });
    beginFieldEdit(field);
    expect(routeFieldKey(field, 'ArrowLeft').outcome).toBe('moved');
    expect(routeFieldKey(field, 'Home').outcome).toBe('moved');
    expect(routeFieldKey(field, 'F7').outcome).toBe('ignored');
    expect(routeFieldKey(field, 'Delete').outcome).toBe('typed');
  });
});
