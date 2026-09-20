/**
 * Text, number and vector fields, on Wave 1B's text model.
 *
 * **A field never writes.** `routeFieldKey` hands back a `Command` and the caller pushes it, which
 * is the rule `@driftengine/tools`'s `Command` states as a signature rather than a convention: a thing that
 * cannot reach the world cannot forget to record what it did. Everything a field owns is a caret,
 * a selection and a string.
 *
 * **Escape is the promise that makes a field safe to type in**, and what it restores is the value
 * the *current edit* opened with rather than the value the field was constructed with. A field
 * edited, committed and reopened has a new starting point, and reverting past it would take back a
 * change the person had already accepted.
 */
import {
  createTextModel,
  createUiNode,
  deleteBackward,
  deleteForward,
  insertText,
  moveCaret,
  moveToLineEdge,
  selectAll,
  selectionRange,
} from '@driftengine/ui2d';
import type { TextModel, UiNode, UiSize } from '@driftengine/ui2d';
import { type Command } from '@driftengine/tools';

export type FieldKind = 'text' | 'number';

/** Builds the command that records a change. The field supplies the two strings and nothing else. */
export type FieldCommandFactory = (from: string, to: string) => Command;

export interface FieldOptions {
  readonly kind?: FieldKind;
  readonly value?: string;
  readonly command?: FieldCommandFactory;
  readonly width?: UiSize;
  readonly height?: UiSize;
  readonly name?: string;
}

export interface Field {
  readonly node: UiNode;
  readonly kind: FieldKind;
  readonly model: TextModel;
  readonly command: FieldCommandFactory | null;
  /** What the current edit began with. Escape restores this. */
  opened: string;
  editing: boolean;
}

/**
 * What a keystroke did.
 *
 * **`ignored` means the field did not handle the key**, so a caller may pass it on to a shortcut
 * table. A caret move is therefore `moved` and not `ignored`: an arrow key the field consumed and
 * also offered onward is an arrow key that moves the caret *and* steps the selection in the scene
 * tree behind it.
 */
export type FieldOutcome = 'ignored' | 'moved' | 'typed' | 'rejected' | 'committed' | 'reverted';

export interface FieldResult {
  readonly outcome: FieldOutcome;
  /** What to push onto the undo stack. Null unless the value actually changed. */
  readonly command: Command | null;
}

export function createField(options: FieldOptions = {}): Field {
  const value = options.value ?? '';
  return {
    node: createUiNode({
      width: options.width ?? 'grow',
      height: options.height ?? 'fit',
      text: value,
      interactive: true,
      focusable: true,
      name: options.name ?? '',
    }),
    kind: options.kind ?? 'text',
    model: createTextModel(value),
    command: options.command ?? null,
    opened: value,
    editing: false,
  };
}

/** Start an edit, recording the point escape returns to. */
export function beginFieldEdit(field: Field): void {
  field.editing = true;
  field.opened = field.model.text;
  selectAll(field.model);
}

/**
 * What a number looks like while it is still being typed.
 *
 * **A number in the making is not yet a number**, and a field that only accepts strings
 * `Number.parseFloat` likes cannot be typed into at all: `-` is not a number, nor is `-.`, nor is
 * `1e`, and each of them is a state every negative, fractional or exponential number passes
 * through. So the test is on the shape rather than on the parse.
 */
const PARTIAL_NUMBER = /^-?\d*\.?\d*(?:[eE][-+]?\d*)?$/;

/** Printable, in the sense that a key name of one character is the character it produces. */
function printable(key: string): boolean {
  return [...key].length === 1;
}

const IGNORED: FieldResult = { outcome: 'ignored', command: null };
const MOVED: FieldResult = { outcome: 'moved', command: null };
const TYPED: FieldResult = { outcome: 'typed', command: null };
const REJECTED: FieldResult = { outcome: 'rejected', command: null };

/**
 * Route one key. Returns what it did and, on a commit, the command that records it.
 *
 * A rejected keystroke leaves the model **exactly** as it was — text, caret and anchor. That is
 * the whole difficulty of a validated field: the obvious implementation reparses and writes back,
 * and a caret in the middle of `1.5` jumps to the end the first time somebody types a letter, so
 * the next real digit lands somewhere else entirely.
 */
export function routeFieldKey(field: Field, key: string): FieldResult {
  const model = field.model;

  if (key === 'Enter') return commitField(field);
  if (key === 'Escape') {
    model.text = field.opened;
    model.caret = model.text.length;
    model.anchor = model.caret;
    field.editing = false;
    return { outcome: 'reverted', command: null };
  }

  if (key === 'Backspace' || key === 'Delete') {
    const before = model.text;
    if (key === 'Backspace') deleteBackward(model);
    else deleteForward(model);
    if (field.kind === 'number' && !PARTIAL_NUMBER.test(model.text)) {
      model.text = before;
      return REJECTED;
    }
    return TYPED;
  }

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    moveCaret(model, key === 'ArrowLeft' ? -1 : 1, false);
    return MOVED;
  }
  if (key === 'Home' || key === 'End') {
    moveToLineEdge(model, key === 'End', false);
    return MOVED;
  }

  if (!printable(key)) return IGNORED;

  if (field.kind === 'number') {
    const { from, to } = selectionRange(model);
    const next = model.text.slice(0, from) + key + model.text.slice(to);
    if (!PARTIAL_NUMBER.test(next)) return REJECTED;
  }
  insertText(model, key);
  return TYPED;
}

/**
 * End the edit and report the change. Reached by Enter, and by a caller losing focus.
 *
 * **An unchanged field is not an undo entry.** Tabbing through a form would otherwise fill the
 * stack with commands that do nothing, and the person's last real change would be several presses
 * of undo away.
 */
export function commitField(field: Field): FieldResult {
  field.editing = false;
  field.node.text = field.model.text;
  if (field.model.text === field.opened) return { outcome: 'committed', command: null };
  const command = field.command === null ? null : field.command(field.opened, field.model.text);
  field.opened = field.model.text;
  return { outcome: 'committed', command };
}

/**
 * The field's text as a number, or zero where it is not yet one.
 *
 * Zero rather than `NaN`: a lone `-` is a number the person has started and not finished, and
 * handing a caller `NaN` for it means every consumer writes the same guard. A caller that needs to
 * know the difference reads the text.
 */
export function fieldValue(field: Field): number {
  const parsed = Number(field.model.text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface VectorFieldOptions {
  readonly value?: readonly number[];
  readonly command?: FieldCommandFactory;
  readonly name?: string;
}

export interface VectorField {
  readonly node: UiNode;
  readonly fields: readonly [Field, Field, Field];
}

export function createVectorField(options: VectorFieldOptions = {}): VectorField {
  const value = options.value ?? [0, 0, 0];
  const node = createUiNode({ direction: 'row', width: 'grow', gap: 4, name: options.name ?? '' });
  const fields: [Field, Field, Field] = [
    createField({ kind: 'number', value: String(value[0] ?? 0), name: 'x' }),
    createField({ kind: 'number', value: String(value[1] ?? 0), name: 'y' }),
    createField({ kind: 'number', value: String(value[2] ?? 0), name: 'z' }),
  ];
  for (const field of fields) {
    node.children.push(field.node);
    field.node.parent = node;
  }
  return { node, fields };
}

/** A vector edit, which absorbs the next edit of the same vector. See `vectorEditCommand`. */
interface VectorEdit extends Command {
  readonly vector: number[];
  readonly from: readonly number[];
  to: number[];
}

function write(vector: number[], values: readonly number[]): void {
  for (let i = 0; i < vector.length && i < values.length; i += 1) vector[i] = values[i] as number;
}

/**
 * One component of a vector, as a command that merges with the next component's.
 *
 * **Three components, one undo entry.** Typing into x, then y, then z is one act to the person
 * doing it, and three presses of undo to take it back is the editor insisting on its own internal
 * structure. The merge is `command.ts`'s existing mechanism — the one a gizmo drag uses — rather
 * than a second one invented here, and it obeys that contract exactly: `next` has *already* been
 * applied by the stack and must not be applied again. What absorbing means is that this command's
 * `revert` now takes both back, so it keeps its own `from` and adopts the other's `to`.
 *
 * Identity is the vector array itself, so two objects moved in turn stay two entries. Comparing by
 * label would merge them, and undoing a move of one object would move the other.
 */
export function vectorEditCommand(
  label: string,
  vector: number[],
  from: readonly number[],
  to: readonly number[],
): Command {
  const edit: VectorEdit = {
    label,
    vector,
    from: [...from],
    to: [...to],
    apply(): void {
      write(vector, edit.to);
    },
    revert(): void {
      write(vector, edit.from);
    },
    merge(next: Command): boolean {
      const other = next as Partial<VectorEdit>;
      if (other.vector !== vector || other.to === undefined) return false;
      edit.to = [...other.to];
      return true;
    },
  };
  return edit;
}
