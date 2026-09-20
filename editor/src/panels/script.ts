/**
 * DriftScript, edited against the language server that already exists.
 *
 * **Not a second language implementation, and that is the whole design.** DriftScript ships a
 * compiler and a language server with a client; this panel is a text view, a diagnostic gutter and
 * a completion popup over it. Every rule about what the language means stays where the compiler
 * is — which is the same argument the behaviour-graph editor makes about its own vocabulary, and
 * for the same reason: an editor that reimplemented the effect analysis would ship graphs the
 * compiler refuses.
 *
 * **It works with no client at all.** A headless build has no server and a test has none either,
 * so the panel is a text view before it is anything else: one style run, no diagnostics, no
 * completion, and nothing that throws. A panel that needed a server would be a panel nobody could
 * test.
 *
 * **The server's view of the buffer lags it by a message.** A diagnostic arrives describing text
 * that has already been deleted, so its range runs past the end — every time somebody types
 * quickly. Ranges are clamped rather than trusted, and one entirely past the end collapses to an
 * empty mark at the end rather than disappearing: it is still a diagnostic and the gutter still
 * has to say so.
 *
 * **Nothing here awaits the server.** A change notification goes out and the buffer is already
 * updated; a completion request resolves later and is dropped if the popup was dismissed while it
 * was in flight. Awaiting either would stall the editor at exactly the moment somebody is typing.
 */
import { addUiChild, createUiNode, runsFor } from '@driftengine/ui2d';
import type { TextModel, TextRun, UiNode } from '@driftengine/ui2d';
import { emptyPanel } from '@driftengine/tools';
import type { Command, Panel } from '@driftengine/tools';

/** One span the server coloured, by a kind this panel maps to a colour. */
export interface ScriptToken {
  readonly from: number;
  readonly to: number;
  readonly kind: string;
}

export interface ScriptDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: 'error' | 'warning' | 'info';
  /** `DS0288` and the like. Shown, because a code is what somebody searches for. */
  readonly code: string;
  readonly message: string;
}

export interface ScriptCompletion {
  readonly label: string;
  readonly detail: string;
}

/**
 * What the panel needs of the language server's client.
 *
 * Four methods, none of which this file implements. `didChange` returns nothing on purpose: a
 * notification is not a request, and a signature that could be awaited is one somebody eventually
 * awaits.
 */
export interface LanguageClient {
  didChange(version: number, text: string): void;
  tokens(): readonly ScriptToken[];
  diagnostics(): readonly ScriptDiagnostic[];
  complete(offset: number): Promise<readonly ScriptCompletion[]>;
}

/** A diagnostic's range after clamping, which is what the gutter draws. */
export interface DiagnosticMark {
  from: number;
  to: number;
  severity: ScriptDiagnostic['severity'];
  code: string;
  message: string;
}

export interface ScriptView {
  doc: TextModel;
  client: LanguageClient | null;
  /** Bumped by every edit, so a reply about an old version can be recognised. */
  version: number;
  /** Where the completion popup is anchored, or -1 when it is closed. */
  completionAt: number;
  completions: ScriptCompletion[];
  /** Which diagnostic the pointer is over, or -1. */
  hovered: number;
  /** The clamped diagnostics, rebuilt whenever the panel is built. */
  marks: DiagnosticMark[];
}

export function createScriptView(doc: TextModel, client: LanguageClient | null): ScriptView {
  return {
    doc,
    client,
    version: 0,
    completionAt: -1,
    completions: [],
    hovered: -1,
    marks: [],
  };
}

/** Colour per token kind. Anything the server names that is not here reads as plain text. */
const TOKEN_COLOURS: Readonly<Record<string, number>> = {
  keyword: 0x7aa2f7,
  type: 0x7dcfff,
  declaration: 0xc0caf5,
  string: 0x9ece6a,
  number: 0xff9e64,
  comment: 0x565f89,
  identifier: 0xc0caf5,
};

const PLAIN = 0xc0caf5;

/** An error and a warning have to read differently, or the gutter says nothing. */
export const DIAGNOSTIC_COLOURS: Readonly<Record<ScriptDiagnostic['severity'], number>> = {
  error: 0xf7768e,
  warning: 0xe0af68,
  info: 0x7dcfff,
};

const SOURCE_RUNS: TextRun[] = [];

/**
 * Disjoint, ordered, gap-free style runs over the whole document.
 *
 * **`runsFor` and not an implementation of its own.** A highlighter emits overlapping spans and a
 * renderer needs disjoint ones; `richText.ts` already normalises them and already argues why every
 * consumer that skips the step draws a character twice or not at all.
 */
export function scriptStyleRuns(view: ScriptView, out: TextRun[]): number {
  const text = view.doc.text;
  SOURCE_RUNS.length = 0;
  for (const token of view.client?.tokens() ?? []) {
    SOURCE_RUNS.push({
      from: token.from,
      to: token.to,
      colour: TOKEN_COLOURS[token.kind] ?? PLAIN,
      bold: token.kind === 'keyword',
      italic: token.kind === 'comment',
    });
  }
  return runsFor(text, SOURCE_RUNS, out);
}

/**
 * Clamp the server's diagnostics into the buffer as it is now.
 *
 * A range entirely past the end becomes an empty mark at the end rather than nothing: the server
 * has something to say about this document and dropping it loses the only sign that it did.
 */
function rebuildMarks(view: ScriptView): void {
  const end = view.doc.text.length;
  view.marks.length = 0;
  for (const diagnostic of view.client?.diagnostics() ?? []) {
    const from = Math.min(end, Math.max(0, diagnostic.from));
    const to = Math.min(end, Math.max(from, diagnostic.to));
    view.marks.push({
      from,
      to,
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
    });
  }
}

/** Which diagnostic covers an offset, or -1. The end is exclusive, as every editor's ranges are. */
export function diagnosticAt(view: ScriptView, offset: number): number {
  const diagnostics = view.client?.diagnostics() ?? [];
  const end = view.doc.text.length;
  for (let at = 0; at < diagnostics.length; at += 1) {
    const diagnostic = diagnostics[at] as ScriptDiagnostic;
    const from = Math.min(end, Math.max(0, diagnostic.from));
    const to = Math.min(end, Math.max(from, diagnostic.to));
    if (offset >= from && offset < to) return at;
  }
  return -1;
}

/**
 * Replace `[from, to)` with `insert`, tell the server, and do not wait for it.
 *
 * The caret lands after what was inserted, which is where a person's next keystroke belongs.
 */
export function applyScriptEdit(view: ScriptView, from: number, to: number, insert: string): void {
  const text = view.doc.text;
  const start = Math.min(text.length, Math.max(0, from));
  const end = Math.min(text.length, Math.max(start, to));
  view.doc.text = text.slice(0, start) + insert + text.slice(end);
  view.doc.caret = start + insert.length;
  view.doc.anchor = view.doc.caret;
  view.doc.composeFrom = -1;
  view.doc.composeTo = -1;
  view.version += 1;
  view.client?.didChange(view.version, view.doc.text);
}

/**
 * Ask the server what could go here, and open the popup when it answers.
 *
 * **A reply that arrives after a dismissal is dropped.** Somebody presses escape, then the server
 * answers, and a panel that simply assigns the result reopens a popup over the text they went back
 * to typing. The request records which one it was and only the newest may open anything.
 */
let nextRequest = 1;
const OPEN_REQUEST = new WeakMap<ScriptView, number>();

export async function requestCompletion(view: ScriptView, offset: number): Promise<void> {
  const client = view.client;
  if (client === null) return;
  const request = nextRequest;
  nextRequest += 1;
  OPEN_REQUEST.set(view, request);

  const found = await client.complete(offset);
  if (OPEN_REQUEST.get(view) !== request) return;
  view.completionAt = offset;
  view.completions = [...found];
}

export function dismissCompletion(view: ScriptView): void {
  OPEN_REQUEST.set(view, -1);
  view.completionAt = -1;
  view.completions.length = 0;
}

const LINE_HEIGHT = 16;
const GUTTER_WIDTH = 44;

/**
 * Build the editor into `root`: the gutter, the text, and the popup if one is open.
 *
 * The signature takes a view rather than the plan's `(doc, diagnostics, root)`, and the reason is
 * §3 row 10: a panel has view state — a hover, a popup, a version — and none of it belongs to the
 * world. A signature that carried only the document would have to keep the rest somewhere a test
 * could not reach.
 */
export function buildScriptEditor(view: ScriptView, root: UiNode): void {
  root.children.length = 0;
  rebuildMarks(view);

  const lines = view.doc.text.split('\n');
  const body = createUiNode({
    name: 'script.body',
    direction: 'row',
    width: 'grow',
    height: 'grow',
  });
  addUiChild(root, body);

  const gutter = createUiNode({
    name: 'script.gutter',
    direction: 'column',
    width: GUTTER_WIDTH,
    height: 'grow',
  });
  addUiChild(body, gutter);

  const text = createUiNode({
    name: 'script.text',
    direction: 'column',
    width: 'grow',
    height: 'grow',
    clip: true,
  });
  addUiChild(body, text);

  /* Which lines carry a diagnostic, so the gutter can mark them without searching per line. */
  const severityByLine = new Map<number, ScriptDiagnostic['severity']>();
  for (const mark of view.marks) {
    const line = lineOf(view.doc.text, mark.from);
    const current = severityByLine.get(line);
    /* An error outranks a warning on the same line: the worse thing is what a gutter says. */
    if (current === undefined || (current !== 'error' && mark.severity === 'error')) {
      severityByLine.set(line, mark.severity);
    }
  }

  for (let line = 0; line < lines.length; line += 1) {
    const severity = severityByLine.get(line);
    addUiChild(
      gutter,
      createUiNode({
        name: `script.line.${String(line)}`,
        height: LINE_HEIGHT,
        width: 'grow',
        text: `${severity === undefined ? ' ' : '●'} ${String(line + 1)}`,
        tint: severity === undefined ? undefined : colourOf(DIAGNOSTIC_COLOURS[severity]),
      }),
    );
    addUiChild(
      text,
      createUiNode({
        name: `script.source.${String(line)}`,
        height: LINE_HEIGHT,
        width: 'grow',
        text: lines[line] as string,
      }),
    );
  }

  const hovered = view.marks[view.hovered];
  if (hovered !== undefined) {
    addUiChild(
      root,
      createUiNode({
        name: 'script.hover',
        absolute: true,
        x: GUTTER_WIDTH,
        y: (lineOf(view.doc.text, hovered.from) + 1) * LINE_HEIGHT,
        width: 'fit',
        height: LINE_HEIGHT,
        layer: 50,
        text: `${hovered.code}: ${hovered.message}`,
        tint: colourOf(DIAGNOSTIC_COLOURS[hovered.severity]),
      }),
    );
  }

  if (view.completionAt >= 0 && view.completions.length > 0) {
    const popup = createUiNode({
      name: 'script.completion',
      absolute: true,
      direction: 'column',
      x: GUTTER_WIDTH,
      y: (lineOf(view.doc.text, view.completionAt) + 1) * LINE_HEIGHT,
      width: 'fit',
      height: 'fit',
      layer: 60,
    });
    for (const entry of view.completions) {
      addUiChild(
        popup,
        createUiNode({
          name: `script.completion.${entry.label}`,
          height: LINE_HEIGHT,
          width: 'fit',
          text: `${entry.label}  ${entry.detail}`,
        }),
      );
    }
    addUiChild(root, popup);
  }
}

/** Which line an offset is on. Zero-based, because the gutter adds the one people read. */
function lineOf(text: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, text.length);
  for (let at = 0; at < end; at += 1) if (text.charCodeAt(at) === 10) line += 1;
  return line;
}

const TINT = new Float32Array(4);

function colourOf(rgb: number): Float32Array {
  TINT[0] = ((rgb >> 16) & 0xff) / 255;
  TINT[1] = ((rgb >> 8) & 0xff) / 255;
  TINT[2] = (rgb & 0xff) / 255;
  TINT[3] = 1;
  return TINT;
}

/**
 * The script view as a docked panel.
 *
 * **It shows and does not edit, which is a state worth having.** `applyScriptEdit` is written and
 * tested; what is missing between it and a person typing is the keyboard focus and composition
 * that `TextHost` owns, and a router that took keys without those would swallow them — the
 * inspector made the same call for the same reason and said so in the same words. The world is
 * empty because a document is view state here: `createScriptView` holds it, so that a reply about
 * an old version can be recognised against the version beside it.
 */
export const scriptPanel: Panel<Record<string, never>, ScriptView> = {
  id: 'script',
  title: 'Script',

  build(_world, view, root): void {
    if (view.doc.text.length === 0) {
      emptyPanel(root, 'No script open');
      return;
    }
    buildScriptEditor(view, root);
  },

  route(): Command | null {
    return null;
  },
};
