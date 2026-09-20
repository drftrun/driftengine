import { describe, expect, test } from 'vitest';

import type { EntityProposal } from '@driftengine/capture';
import {
  addUiChild,
  createNullA11yHost,
  createNullTextHost,
  createUiNode,
  layoutUiTree,
} from '@driftengine/ui2d';
import { addToSelection, logEntries } from '@driftengine/tools';

import {
  CAPTURE_STAGES,
  createCaptureModel,
  decisionOf,
  setProposals,
  stageDone,
} from './panels/capture.ts';
import { bindingOf, createEditorFrontEnd, paintNode, type EditorPainter } from './frontEnd.ts';
import { MENU_BAR_HEIGHT } from './shell.ts';

/**
 * **The editor as any host drives it.** An entry turns its platform's keys, pointer and size into
 * these calls and draws what `paint` describes; the browser's does it with a 2D context and the
 * native host's with the engine. What is checked here is the part both share: what a key is called,
 * that an open palette takes typing, that a click picks, and what the picture is.
 */

const press = (key: string, extra: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
  key,
  ctrl: extra.ctrl ?? false,
  meta: extra.meta ?? false,
  shift: extra.shift ?? false,
});

function opened(viewportDrawn = false) {
  const editor = createEditorFrontEnd({
    canvas: null,
    textHost: createNullTextHost(),
    a11yHost: createNullA11yHost(),
    viewportDrawn,
  });
  editor.resize(1280, 720);
  return editor;
}

/** A painter that keeps where each string landed, which is what a click has to agree with. */
function positionedPainter() {
  const texts: { content: string; x: number; y: number }[] = [];
  const painter: EditorPainter = {
    rect: () => {},
    outline: () => {},
    disc: () => {},
    text: (content, x, y) => texts.push({ content, x, y }),
    clip: () => {},
    unclip: () => {},
  };
  return { texts, painter };
}

/** A painter that writes down what it was asked to draw. */
function recorder() {
  const calls: string[] = [];
  const painter: EditorPainter = {
    rect: (x, y, w, h, colour) => calls.push(`rect ${x},${y},${w},${h} ${colour}`),
    outline: (x, y, w, h, colour) => calls.push(`outline ${x},${y},${w},${h} ${colour}`),
    /* To a tenth: a prop's position is single precision, so −1.1 is not quite −1.1. */
    disc: (x, y, r, colour) => calls.push(`disc ${x.toFixed(1)},${y.toFixed(1)},${r} ${colour}`),
    text: (content, x, y, colour) => calls.push(`text ${content} ${colour}`),
    clip: () => calls.push('clip'),
    unclip: () => calls.push('unclip'),
  };
  return { calls, painter };
}

describe('the editor, whatever hosts it', () => {
  test('A KEY IS NAMED THE WAY THE REGISTRY NAMES IT, from any host', () => {
    expect(bindingOf(press('z', { ctrl: true }))).toBe('Ctrl+Z');
    /* The command key is control's twin, so a binding is written once. */
    expect(bindingOf(press('z', { meta: true, shift: true }))).toBe('Ctrl+Shift+Z');
    expect(bindingOf(press('Delete'))).toBe('Delete');
  });

  test('AN OPEN PALETTE TAKES WHAT IS TYPED, and Enter runs its first match', () => {
    const editor = opened();
    expect(editor.key(press('k', { ctrl: true }))).toBe(true);
    expect(editor.shell.paletteOpen).toBe(true);
    for (const key of ['s', 'e', 'l', 'x', 'Backspace']) expect(editor.key(press(key))).toBe(true);
    expect(editor.key(press('Enter'))).toBe(true);
    expect(editor.readout()).toBe('6 props · 6 selected · nothing to undo');
    /* And a key nothing is bound to is not the editor's. */
    expect(editor.key(press('F9'))).toBe(false);
  });

  /**
   * Where each prop's disc was drawn and which prop it is, read back out of the picture.
   *
   * The placeholder paints a disc and then the entity's number over it, so the pair is the two
   * calls in order — which is what lets a test click a prop by *being* a user rather than by
   * repeating the projection it is testing.
   */
  function discs(
    editor: ReturnType<typeof opened>,
  ): { x: number; y: number; colour: string; entity: number }[] {
    const { calls, painter } = recorder();
    editor.paint(painter);
    const out: { x: number; y: number; colour: string; entity: number }[] = [];
    calls.forEach((call, at) => {
      if (!call.startsWith('disc')) return;
      const [, position = '', colour = ''] = call.split(' ');
      const [x = '0', y = '0'] = position.split(',');
      const label = (calls[at + 1] ?? '').split(' ')[1] ?? '';
      out.push({ x: Number(x), y: Number(y), colour, entity: Number(label) });
    });
    return out;
  }

  test('WHAT YOU CLICK IS WHAT YOU GET: the disc a prop is drawn as is the disc that picks it', () => {
    /*
     * **The round trip, rather than a coordinate written down.** The projection was over the
     * window while the ray was built over the viewport's rectangle, so a prop was drawn in one
     * place and picked in another — a reader who had not written it clicked a marker and got a
     * different one 78 pixels away. A test that pins the position in window pixels is the
     * assumption that broke; this one asks the product where it drew something and clicks there.
     */
    const editor = opened();
    const drawn = discs(editor);
    expect(drawn.length).toBeGreaterThan(1);

    /*
     * **Every one of them, because a mismatch between the two spaces can still land on the right
     * prop for one of them.** The first version of this test clicked a single disc and passed with
     * the projection put back over the window — the props near the middle of the world are near
     * the middle of both rectangles. The ones at the edges are where the two spaces disagree.
     */
    for (const disc of drawn) {
      editor.pointerDown(disc.x, disc.y, false);
      expect(editor.shell.selection.entities, `clicking the disc drawn for ${disc.entity}`).toEqual(
        [disc.entity],
      );
    }
  });

  test('the menu bar is not the viewport, and neither is a panel', () => {
    const editor = opened();
    const target = discs(editor)[2] as { x: number; y: number };
    editor.pointerDown(target.x, target.y, false);
    const chosen = [...editor.shell.selection.entities];
    expect(chosen.length).toBe(1);

    /* A click on the menu bar is the menu's: it does not pick, so it does not clear the pick. */
    editor.pointerDown(target.x, 12, false);
    expect(editor.shell.selection.entities).toEqual(chosen);

    /*
     * **And neither does a click on a panel**, which is not a miss. It was: a stray click on an
     * empty dock threw the selection away without saying anything.
     */
    const slot = editor.shell.panelSlots[0] as { x: number; y: number; w: number; h: number };
    editor.pointerDown(slot.x + slot.w / 2, slot.y + slot.h - 4, false);
    expect(editor.shell.selection.entities).toEqual(chosen);

    /* Where a click inside the viewport misses everything, it clears. */
    const view = editor.shell.viewport;
    editor.pointerDown(view.x + 2, view.y + view.h - 2, false);
    expect(editor.shell.selection.entities).toEqual([]);
  });

  test('THE PICTURE IS A MENU BAR, THREE PANELS AND A DISC A PROP, the selected one in its colour', () => {
    const editor = opened();
    const placed = discs(editor)[2] as { x: number; y: number };
    editor.pointerDown(placed.x, placed.y, false);
    const { calls, painter } = recorder();
    editor.paint(painter);
    expect(calls[1]).toBe('rect 0,0,1280,24 #11161c');
    expect(calls.filter((call) => call.startsWith('outline')).length).toBe(3);
    const drawn = calls.filter((call) => call.startsWith('disc'));
    expect(drawn.length).toBe(6);
    expect(drawn[2]?.endsWith('#6fd3a0')).toBe(true);
    expect(drawn[0]?.endsWith('#4a5a6a')).toBe(true);

    /*
     * **Every prop is drawn inside the viewport's rectangle**, which is what projecting over the
     * window did not guarantee: the README recorded that a prop could be clipped by a panel edge
     * rather than sitting behind it, and this is that claim as an assertion.
     */
    const view = editor.shell.viewport;
    for (const disc of discs(editor)) {
      expect(disc.x).toBeGreaterThanOrEqual(view.x);
      expect(disc.x).toBeLessThanOrEqual(view.x + view.w);
      expect(disc.y).toBeGreaterThanOrEqual(view.y);
      expect(disc.y).toBeLessThanOrEqual(view.y + view.h);
    }

    /* The props are drawn inside the viewport's clip, and nothing else is. */
    const clipAt = calls.indexOf('clip');
    expect(clipAt).toBeGreaterThan(0);
    expect(clipAt).toBeLessThan(calls.indexOf(drawn[0] ?? ''));
    expect(calls.at(-1)).toBe('unclip');
  });
});

test('A HOST WITH AN ENGINE BEHIND THE VIEWPORT IS NOT PAINTED OVER', () => {
  /*
   * **The two halves of the same claim.** With no renderer the props are discs, which is a
   * placeholder that says so. With one, nothing in the viewport is painted at all — not the props
   * and not the background behind them, because a flat rectangle over a drawn scene looks exactly
   * like a renderer that failed.
   */
  const placeholder = recorder();
  opened(false).paint(placeholder.painter);
  expect(placeholder.calls.some((call) => call.startsWith('disc'))).toBe(true);
  expect(placeholder.calls).toContain('rect 0,0,1280,720 #0b0d10');

  const drawn = recorder();
  const editor = opened(true);
  editor.paint(drawn.painter);
  expect(drawn.calls.some((call) => call.startsWith('disc'))).toBe(false);
  expect(drawn.calls).not.toContain('rect 0,0,1280,720 #0b0d10');

  /* And what it paints instead covers everything outside the viewport and nothing inside it. */
  const view = editor.shell.viewport;
  const covers = drawn.calls.filter((call) => call.endsWith('#0b0d10'));
  expect(covers.length).toBe(4);
  const area = covers
    .map((call) => (call.match(/rect [\d.]+,[\d.]+,([\d.]+),([\d.]+)/) ?? []).slice(1))
    .reduce((sum, [w, h]) => sum + Number(w) * Number(h), 0);
  expect(area).toBeCloseTo(1280 * 720 - view.w * view.h, 3);
});

describe('the command palette', () => {
  const openPalette = () => {
    const editor = opened();
    editor.key(press('k', { ctrl: true }));
    expect(editor.shell.paletteOpen).toBe(true);
    return editor;
  };

  test('IT SHOWS WHAT WAS TYPED, AND SAYS SO WHEN NOTHING MATCHES', () => {
    /*
     * **The list narrowed and then went empty with no echo of the query.** Somebody typing a word
     * the palette does not have could not tell whether their keystrokes had arrived — they had,
     * and typing a command's name blind still ran it, which is a product that works and cannot be
     * seen to.
     */
    const editor = openPalette();
    for (const key of 'undo') editor.key(press(key));
    const { calls, painter } = recorder();
    editor.paint(painter);
    expect(calls.some((call) => call.includes('> undo_'))).toBe(true);

    for (const key of 'zzz') editor.key(press(key));
    const after = recorder();
    editor.paint(after.painter);
    expect(after.calls.some((call) => call.includes('> undozzz_'))).toBe(true);
    expect(after.calls.some((call) => call.includes('no command matches'))).toBe(true);
  });

  test('a click on a row runs that row, and does not fall through to the scene', () => {
    /*
     * It fell through: clicking `Undo` selected a prop behind the palette and left the undo entry
     * exactly where it was. A list drawn like a menu has to behave like one.
     */
    const editor = openPalette();
    const rows = editor.shell.searchPalette('');
    expect(rows.length).toBeGreaterThan(1);

    const { calls, painter } = recorder();
    editor.paint(painter);
    /* The palette's own rectangle: the one 160 tall, rather than the menu bar's 24. */
    const boxLine = calls.find(
      (call) => call.startsWith('rect') && (call.split(' ')[1] ?? '').endsWith(',160'),
    );
    expect(boxLine).toBeDefined();
    const box = boxLine?.split(' ')[1]?.split(',').map(Number) ?? [0, 0, 0, 0];
    editor.pointerDown((box[0] as number) + 20, 132 + 18, false);
    expect(editor.shell.paletteOpen).toBe(false);
    expect(editor.shell.selection.entities.length).toBe(0);
  });

  test('a click outside closes it rather than reaching the scene', () => {
    const editor = openPalette();
    const view = editor.shell.viewport;
    editor.pointerDown(view.x + view.w / 2, view.y + view.h - 8, false);
    expect(editor.shell.paletteOpen).toBe(false);
    expect(editor.shell.selection.entities.length).toBe(0);
  });

  test('THE ARROWS MOVE THE HIGHLIGHT, AND ENTER RUNS THE ONE HIGHLIGHTED', () => {
    /*
     * **Without them the only row anybody could run was the first.** The highlight sat on the
     * first match and nothing moved it, so every other command had to be typed out exactly —
     * which is not a list, it is a spelling test.
     */
    const editor = openPalette();
    const highlighted = (): string => {
      const { calls, painter } = recorder();
      editor.paint(painter);
      return calls.filter((call) => call.endsWith('#6fd3a0')).join('|');
    };
    const first = highlighted();
    editor.key(press('ArrowDown'));
    const second = highlighted();
    expect(second).not.toBe(first);
    editor.key(press('ArrowUp'));
    expect(highlighted()).toBe(first);
  });
});

describe('the menu bar', () => {
  test('A MENU OPENS, RUNS WHAT IT SAYS, AND SHOWS WHAT THE SCENE CANNOT DO', () => {
    /*
     * **It was painted text.** `Edit` and `View` were drawn to look like menus over a shell that
     * has had `openMenuAt`, `menuItems` and `closeMenus` since it existed — click, hover, hold,
     * nothing. Two of the four things on the screen were decoration, and somebody looking for a
     * command went to them first.
     */
    const editor = opened();
    const titles = editor.shell.menuTitles();
    expect(titles.length).toBeGreaterThan(0);

    const before = recorder();
    editor.paint(before.painter);
    const items = editor.shell.menuItems();
    expect(items.length).toBe(0);

    editor.pointerDown(12, 8, false);
    expect(editor.shell.menuItems().length).toBeGreaterThan(0);
    const open = recorder();
    editor.paint(open.painter);
    expect(open.calls.some((call) => call.includes('Undo'))).toBe(true);

    /* Clicking the title again closes it, which is what every menu bar does. */
    editor.pointerDown(12, 8, false);
    expect(editor.shell.menuItems().length).toBe(0);
  });

  test('a click on a menu item runs it, and a click past the list just closes', () => {
    const editor = opened();
    editor.pointerDown(12, 8, false);
    const items = editor.shell.menuItems();
    expect(items.length).toBeGreaterThan(1);

    /* The first row, a menu-item height below the bar. */
    editor.pointerDown(20, 24 + 10, false);
    expect(editor.shell.menuItems().length).toBe(0);

    editor.pointerDown(12, 8, false);
    /* Far to the right of the list: closes, runs nothing, and does not reach the scene. */
    editor.pointerDown(900, 24 + 10, false);
    expect(editor.shell.menuItems().length).toBe(0);
    expect(editor.shell.selection.entities.length).toBe(0);
  });
});

/**
 * **The panels are in the product, and what one draws is what a click on it hits.**
 *
 * The panels were written, tested and docked nowhere for five days, so the editor drew three empty
 * rectangles and every panel's own green test was a claim about code nothing ran. This block is the
 * assembly, checked the way the viewport's picker had to be checked after somebody who had not
 * written it found that a marker was drawn in one place and answered in another.
 */
describe('the docked panels', () => {
  function proposal(region: number, label: string): EntityProposal {
    return {
      region,
      bounds: Float64Array.from([0, 0, 0, 1, 1, 1]),
      label,
      components: ['transform', 'mesh'],
      walkable: false,
    };
  }

  function withCapture() {
    const capture = createCaptureModel();
    for (const stage of CAPTURE_STAGES) stageDone(capture, stage.id, 'from the file');
    setProposals(capture, [proposal(0, 'alpha'), proposal(1, 'beta'), proposal(2, 'gamma')]);
    const editor = createEditorFrontEnd({
      canvas: null,
      textHost: createNullTextHost(),
      a11yHost: createNullA11yHost(),
      capture,
    });
    editor.resize(1280, 720);
    editor.frame(0);
    return { editor, capture };
  }

  test('A PANEL’S TITLE AND ITS ROWS ARE DRAWN INSIDE ITS OWN SLOT', () => {
    const { editor } = withCapture();
    const { texts, painter } = positionedPainter();
    editor.paint(painter);

    /* The region opens on the capture, because that is what the host handed it. */
    expect(editor.shell.panelTitles[0]).toBe('Capture');
    expect(texts.some((one) => one.content === 'Capture')).toBe(true);

    const slot = editor.shell.panelSlots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    const rows = texts.filter((one) => one.content.includes('from the file'));
    expect(rows.length).toBe(CAPTURE_STAGES.length);
    for (const row of rows) {
      expect(row.x).toBeGreaterThanOrEqual(slot.x);
      expect(row.x).toBeLessThan(slot.x + slot.w);
      /* Under the title strip, never across it. */
      expect(row.y).toBeGreaterThan(slot.y + 14);
      expect(row.y).toBeLessThanOrEqual(slot.y + slot.h);
    }
  });

  test('WHAT YOU CLICK IN A PANEL IS WHAT YOU GET: every row the panel drew, answered', () => {
    /*
     * **Every row, not one.** A test that clicked a single row passed with the whole list offset
     * by one, because one row's rectangle still contained the point. The rows are clicked at the
     * position the painter was asked to draw each one at, which is the only position a person can
     * aim at.
     */
    const { editor, capture } = withCapture();
    const { texts, painter } = positionedPainter();
    editor.paint(painter);
    const rows = texts.filter(
      (one) =>
        one.content.startsWith('alpha') ||
        one.content.startsWith('beta') ||
        one.content.startsWith('gamma'),
    );
    expect(rows.length).toBe(3);

    rows.forEach((row, region) => {
      editor.pointerDown(row.x, row.y, false);
      expect(decisionOf(capture, region), row.content).toBe('accepted');
      /* And nothing else moved: a click that decided two rows is a click that hit the wrong one. */
      expect([...capture.decided.keys()].sort((a, b) => a - b)).toEqual(
        Array.from({ length: region + 1 }, (_, at) => at),
      );
    });
  });

  test('a decision made in a panel is on the one undo stack', () => {
    const { editor, capture } = withCapture();
    const { texts, painter } = positionedPainter();
    editor.paint(painter);
    const row = texts.find((one) => one.content.startsWith('beta'));
    expect(row).toBeDefined();
    if (row === undefined) return;

    editor.pointerDown(row.x, row.y, false);
    expect(decisionOf(capture, 1)).toBe('accepted');
    expect(editor.shell.app.undo.canUndo()).toBe(true);
    editor.key(press('z', { ctrl: true }));
    expect(decisionOf(capture, 1)).toBe('open');
  });

  test('a press in a panel does not also pick in the viewport', () => {
    const { editor } = withCapture();
    const { texts, painter } = positionedPainter();
    editor.paint(painter);
    const row = texts.find((one) => one.content.startsWith('alpha'));
    expect(row).toBeDefined();
    if (row === undefined) return;

    editor.pointerDown(row.x, row.y, false);
    expect(editor.shell.selection.entities.length).toBe(0);
  });

  test('THE CONSOLE SHOWS WHAT WAS DONE, so a panel bound to nothing is not what it looks like', () => {
    const editor = opened();
    editor.key(press('a', { ctrl: true }));
    expect(logEntries(editor.log).map((entry) => entry.text)).toContain('Select all');
  });
});

describe('drawing a panel’s tree', () => {
  test('A NODE IS DRAWN IN ITS OWN COLOUR WHERE IT HAS ONE, AND CUT TO ITS PARENT', () => {
    /*
     * **The tree carries its colours as numbers and a painter takes strings**, so this conversion
     * is the one place a panel's own colouring can be lost. The script panel's gutter is entirely
     * tint — an error and a warning have to read differently or the gutter says nothing.
     */
    const root = createUiNode({ width: 100, height: 40, clip: true, direction: 'column' });
    addUiChild(
      root,
      createUiNode({
        width: 'grow',
        height: 20,
        text: 'warned',
        background: [1, 0, 0, 1],
        tint: [0, 0.5, 1, 1],
      }),
    );
    layoutUiTree(root, 0, 0, 100, 40);

    const calls: string[] = [];
    paintNode(
      {
        rect: (x, y, w, h, colour) => calls.push(`rect ${x},${y},${w},${h} ${colour}`),
        outline: () => {},
        disc: () => {},
        text: (content, x, y, colour) => calls.push(`text ${content} ${x},${y} ${colour}`),
        clip: (x, y, w, h) => calls.push(`clip ${x},${y},${w},${h}`),
        unclip: () => calls.push('unclip'),
      },
      root,
    );

    /* Under the menu bar, because the application's tree starts there. */
    expect(calls).toContain(`clip 0,${String(MENU_BAR_HEIGHT)},100,40`);
    expect(calls).toContain(`rect 0,${String(MENU_BAR_HEIGHT)},100,20 #ff0000`);
    expect(calls).toContain(`text warned 0,${String(MENU_BAR_HEIGHT + 12)} #0080ff`);
    expect(calls.at(-1)).toBe('unclip');
  });

  test('a node with nothing to say draws nothing, and a hidden one draws nothing either', () => {
    const root = createUiNode({ width: 60, height: 20, direction: 'column' });
    addUiChild(root, createUiNode({ width: 'grow', height: 10, text: 'gone', hidden: true }));
    addUiChild(root, createUiNode({ width: 'grow', height: 10 }));
    layoutUiTree(root, 0, 0, 60, 20);

    const calls: string[] = [];
    paintNode(
      {
        rect: () => calls.push('rect'),
        outline: () => {},
        disc: () => {},
        text: () => calls.push('text'),
        clip: () => calls.push('clip'),
        unclip: () => calls.push('unclip'),
      },
      root,
    );
    expect(calls).toEqual([]);
  });
});

describe('the arrangement the editor opens with', () => {
  test('THE SCENE TREE IS ON THE LEFT AND SHOWS THE SCENE, WITH NO CAPTURE TO SHOW INSTEAD', () => {
    const editor = opened();
    editor.frame(0);
    expect(editor.shell.shownPanels()[0]).toBe('scene-tree');
    expect(editor.shell.shownPanels()[1]).toBe('inspector');

    const { texts, painter } = positionedPainter();
    editor.paint(painter);
    const said = texts.map((one) => one.content);
    expect(said).toContain('Scene');
    /* Bound to the scene the viewport draws, which is what `flatModelOf` is for. */
    expect(said.some((one) => one.includes('prop 1'))).toBe(true);
    /* And the right region opens on the inspector, which has nothing selected yet. */
    expect(said).toContain('Inspector');
    expect(said).toContain('Nothing selected');
  });

  test('the inspector follows the selection, because they are one selection', () => {
    /*
     * **One selection, held by reference.** Two would be a tree highlighting one prop while the
     * viewport drew another selected and the inspector showed a third — three panels each correct
     * about a different thing, which reads as every one of them being broken.
     */
    const editor = opened();
    addToSelection(editor.shell.selection, 2);
    editor.shell.app.invalidate();
    editor.frame(0);
    const { texts, painter } = positionedPainter();
    editor.paint(painter);
    expect(texts.map((one) => one.content).some((one) => one.startsWith('position'))).toBe(true);
  });

  test('THE TREE FOLLOWS THE SCENE, SO SOMETHING DELETED LEAVES IT', () => {
    /*
     * **A tree built once is a tree that is right until the first edit.** The model is rebuilt when
     * the scene's membership changes and not otherwise — rebuilding every time would throw away
     * which branches were open, and never rebuilding shows props that are gone.
     */
    const editor = opened();
    editor.frame(0);
    const before = positionedPainter();
    editor.paint(before.painter);
    expect(before.texts.map((one) => one.content).some((one) => one.includes('prop 1'))).toBe(true);

    editor.key(press('a', { ctrl: true }));
    expect(editor.key(press('Delete'))).toBe(true);
    editor.frame(1);
    const after = positionedPainter();
    editor.paint(after.painter);
    expect(after.texts.map((one) => one.content).some((one) => one.includes('prop 1'))).toBe(false);
  });

  test('THE PROFILER HAS A FRAME TIME WHETHER OR NOT THE HOST HAS A RENDERER', () => {
    /*
     * **The one timing an editor always has.** A profiler docked over nothing shows `No timings
     * yet` forever, which is indistinguishable from a profiler that is broken; the interval
     * between two frames is something every host knows without being asked.
     */
    const editor = opened();
    editor.frame(0);
    editor.frame(16);
    editor.frame(32);
    expect(editor.shell.run('view.panel.profiler')).toBe(true);
    editor.frame(48);

    const { texts, painter } = positionedPainter();
    editor.paint(painter);
    const said = texts.map((one) => one.content);
    expect(said).toContain('Profiler');
    expect(said.some((one) => one.startsWith('frame ') && one.includes('mean of 3'))).toBe(true);
  });
});
