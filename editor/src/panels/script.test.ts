import { describe, expect, test } from 'vitest';
import { createTextModel, type TextRun, type UiNode } from '@driftengine/ui2d';
import { createPanelRoot } from '@driftengine/tools';

import {
  DIAGNOSTIC_COLOURS,
  applyScriptEdit,
  buildScriptEditor,
  createScriptView,
  diagnosticAt,
  dismissCompletion,
  requestCompletion,
  scriptStyleRuns,
  type LanguageClient,
  type ScriptCompletion,
  type ScriptDiagnostic,
  type ScriptToken,
} from './script.ts';

const SOURCE = 'system Move reads Position writes Velocity {\n  update { }\n}\n';

/** A client that answers from what it was handed, and records what it was told. */
function clientOf(
  options: {
    tokens?: readonly ScriptToken[];
    diagnostics?: readonly ScriptDiagnostic[];
    completions?: readonly ScriptCompletion[];
    /** A `didChange` that never settles, which is what a slow server looks like. */
    hang?: boolean;
  } = {},
) {
  const changes: { version: number; text: string }[] = [];
  let resolveCompletion: ((value: readonly ScriptCompletion[]) => void) | null = null;
  const client: LanguageClient & { changes: typeof changes; settle: () => void } = {
    changes,
    didChange(version: number, text: string): void {
      changes.push({ version, text });
      if (options.hang === true) {
        /* A server that never answers. The panel must not care. */
        return;
      }
    },
    tokens: () => options.tokens ?? [],
    diagnostics: () => options.diagnostics ?? [],
    complete: () =>
      new Promise<readonly ScriptCompletion[]>((resolve) => {
        resolveCompletion = resolve;
        if (options.hang !== true) resolve(options.completions ?? []);
      }),
    settle(): void {
      resolveCompletion?.(options.completions ?? []);
    },
  };
  return client;
}

function findNode(node: UiNode, name: string): UiNode | null {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findNode(child, name);
    if (found !== null) return found;
  }
  return null;
}

function textOf(node: UiNode, out: string[] = []): string[] {
  if (node.text.length > 0) out.push(node.text);
  for (const child of node.children) textOf(child, out);
  return out;
}

describe('the text a script editor shows', () => {
  test('is styled by the server tokens, as disjoint runs', () => {
    /*
     * **Wave 1B's normalisation and not a second one.** A highlighter emits overlapping runs — a
     * rule for the declaration and a narrower one for the identifier inside it — and a renderer
     * needs them disjoint, in order and gap-free, or a character is drawn twice or not at all.
     */
    const tokens: ScriptToken[] = [
      { from: 0, to: 6, kind: 'keyword' },
      { from: 7, to: 11, kind: 'type' },
      { from: 0, to: 44, kind: 'declaration' },
    ];
    const view = createScriptView(createTextModel(SOURCE), clientOf({ tokens }));
    const runs: TextRun[] = [];
    const count = scriptStyleRuns(view, runs);

    expect(count).toBeGreaterThan(2);
    let previous = 0;
    for (let at = 0; at < count; at += 1) {
      const run = runs[at] as TextRun;
      expect(run.from).toBe(previous);
      expect(run.to).toBeGreaterThan(run.from);
      previous = run.to;
    }
    expect(previous).toBe(SOURCE.length);
  });

  test('is plain with no language client at all', () => {
    /*
     * A headless build has no server and a test has none either, so the panel has to be a text
     * view before it is anything else. One run, no diagnostics, and nothing throws.
     */
    const view = createScriptView(createTextModel(SOURCE), null);
    const runs: TextRun[] = [];
    expect(scriptStyleRuns(view, runs)).toBe(1);
    expect((runs[0] as TextRun).from).toBe(0);
    expect((runs[0] as TextRun).to).toBe(SOURCE.length);

    const root = createPanelRoot({ id: 'script' });
    buildScriptEditor(view, root);
    expect(textOf(root).join('\n')).toContain('system Move');
  });

  test('is empty without an empty run, which a renderer cannot draw', () => {
    const view = createScriptView(createTextModel(''), null);
    const runs: TextRun[] = [];
    expect(scriptStyleRuns(view, runs)).toBe(0);
  });
});

describe('diagnostics', () => {
  const diagnostics: ScriptDiagnostic[] = [
    { from: 19, to: 27, severity: 'error', code: 'DS0288', message: 'Position is not declared' },
    { from: 34, to: 42, severity: 'warning', code: 'DS0291', message: 'Velocity is never read' },
  ];

  test('mark their range and are found by offset for a hover', () => {
    const view = createScriptView(createTextModel(SOURCE), clientOf({ diagnostics }));
    expect(diagnosticAt(view, 20)).toBe(0);
    expect(diagnosticAt(view, 35)).toBe(1);
    expect(diagnosticAt(view, 2)).toBe(-1);
    /* The end is exclusive, which is what every editor's ranges are. */
    expect(diagnosticAt(view, 27)).toBe(-1);
    expect(diagnosticAt(view, 26)).toBe(0);
  });

  test('show their code and message, and an error reads differently from a warning', () => {
    const view = createScriptView(createTextModel(SOURCE), clientOf({ diagnostics }));
    view.hovered = 0;
    const root = createPanelRoot({ id: 'script' });
    buildScriptEditor(view, root);
    const shown = textOf(root).join('\n');
    expect(shown).toContain('DS0288');
    expect(shown).toContain('Position is not declared');
    expect(DIAGNOSTIC_COLOURS.error).not.toBe(DIAGNOSTIC_COLOURS.warning);
  });

  test('a range past the end of the document is clamped rather than thrown at', () => {
    /*
     * **The server's view of the buffer lags it by a message.** A diagnostic arrives describing
     * text that has already been deleted, so its range runs past the end — every time somebody
     * types quickly. Throwing there takes the editor down on exactly the input that produces it.
     */
    const stale: ScriptDiagnostic[] = [
      { from: 900, to: 950, severity: 'error', code: 'DS0001', message: 'from a longer document' },
      { from: 40, to: 9000, severity: 'error', code: 'DS0002', message: 'half past the end' },
    ];
    const view = createScriptView(createTextModel(SOURCE), clientOf({ diagnostics: stale }));
    const marks = view.marks;
    expect(() => buildScriptEditor(view, createPanelRoot({ id: 'script' }))).not.toThrow();
    expect(marks.length).toBe(2);
    for (const mark of marks) {
      expect(mark.from).toBeGreaterThanOrEqual(0);
      expect(mark.to).toBeLessThanOrEqual(SOURCE.length);
      expect(mark.to).toBeGreaterThanOrEqual(mark.from);
    }
    /* The one entirely past the end collapses rather than disappearing: it is still a diagnostic
       and the gutter still has to say so. */
    expect((marks[0] as { from: number; to: number }).from).toBe(SOURCE.length);
  });

  test('none at all when there is no client, rather than a guess', () => {
    const view = createScriptView(createTextModel(SOURCE), null);
    expect(diagnosticAt(view, 20)).toBe(-1);
    expect(view.marks.length).toBe(0);
  });
});

describe('editing', () => {
  test('sends a change notification and does not wait for the reply', () => {
    /*
     * **A panel that awaited the server would stall on every keystroke**, at exactly the moment a
     * person is typing. The notification goes out and the buffer is already updated.
     */
    const client = clientOf({ hang: true });
    const view = createScriptView(createTextModel(SOURCE), client);
    applyScriptEdit(view, 0, 6, 'behaviour');
    expect(view.doc.text.startsWith('behaviour Move')).toBe(true);
    expect(client.changes.length).toBe(1);
    expect(client.changes[0]?.text.startsWith('behaviour Move')).toBe(true);
  });

  test('numbers every change, so a reply about an old version can be recognised', () => {
    const client = clientOf();
    const view = createScriptView(createTextModel(SOURCE), client);
    applyScriptEdit(view, 0, 0, 'a');
    applyScriptEdit(view, 0, 0, 'b');
    expect(client.changes.map((change) => change.version)).toEqual([1, 2]);
    expect(view.version).toBe(2);
  });

  test('works with no client, because a headless build still edits text', () => {
    const view = createScriptView(createTextModel('abc'), null);
    applyScriptEdit(view, 1, 2, 'X');
    expect(view.doc.text).toBe('aXc');
  });

  test('puts the caret after what was inserted', () => {
    const view = createScriptView(createTextModel('abc'), null);
    applyScriptEdit(view, 1, 1, 'XY');
    expect(view.doc.text).toBe('aXYbc');
    expect(view.doc.caret).toBe(3);
    expect(view.doc.anchor).toBe(3);
  });
});

describe('completion', () => {
  /*
   * **Labels that do not occur in the source**, which the first version of this test got wrong:
   * it offered `Position`, asserted the built tree contained the word, and passed because the
   * document says `reads Position` on line one. Blanking every completion's text left it green.
   */
  const completions: ScriptCompletion[] = [
    { label: 'Acceleration', detail: 'component' },
    { label: 'Damping', detail: 'component' },
  ];

  test('appears when asked and lists what the server offered', async () => {
    const view = createScriptView(createTextModel(SOURCE), clientOf({ completions }));
    expect(view.completionAt).toBe(-1);
    await requestCompletion(view, 19);
    expect(view.completionAt).toBe(19);
    expect(view.completions.map((entry) => entry.label)).toEqual(['Acceleration', 'Damping']);

    const root = createPanelRoot({ id: 'script' });
    buildScriptEditor(view, root);
    /* Read out of the popup itself rather than out of the whole tree, so the source text cannot
       answer for it. */
    const popup = findNode(root, 'script.completion');
    expect(popup).not.toBeNull();
    expect(textOf(popup as UiNode).join('\n')).toContain('Acceleration');
    expect(textOf(popup as UiNode).join('\n')).toContain('component');
  });

  test('dismisses on escape', async () => {
    const view = createScriptView(createTextModel(SOURCE), clientOf({ completions }));
    await requestCompletion(view, 19);
    expect(view.completionAt).toBe(19);
    dismissCompletion(view);
    expect(view.completionAt).toBe(-1);
    expect(view.completions.length).toBe(0);
  });

  test('a reply that arrives after a dismissal is dropped', async () => {
    /*
     * **The race every completion popup has.** A person presses escape, then the server answers,
     * and a panel that simply assigns the result reopens a popup nobody asked for — over the text
     * they went back to typing.
     */
    const client = clientOf({ completions, hang: true });
    const view = createScriptView(createTextModel(SOURCE), client);
    const pending = requestCompletion(view, 19);
    dismissCompletion(view);
    client.settle();
    await pending;
    expect(view.completionAt).toBe(-1);
    expect(view.completions.length).toBe(0);
  });

  test('asks nothing of a client that is not there', async () => {
    const view = createScriptView(createTextModel(SOURCE), null);
    await requestCompletion(view, 19);
    expect(view.completionAt).toBe(-1);
  });
});
