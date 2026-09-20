import { describe, expect, test } from 'vitest';
import { GIZMO_TRANSLATE_X } from '@driftengine/core';
import {
  addUiChild,
  createNullA11yHost,
  createNullTextHost,
  createUiNode,
  type UiNode,
} from '@driftengine/ui2d';
import {
  createLogRing,
  logEntries,
  primarySelection,
  selectedEntities,
  type Command,
  type Panel,
  type UiEvent,
} from '@driftengine/tools';

import { PANEL_TITLE_HEIGHT, dockPanel, type DockRegion } from './panels/docked.ts';

import {
  PALETTE_KEY,
  REDO_KEY,
  UNDO_KEY,
  createEditorShell,
  type EditorShell,
  type ShellScene,
} from './shell.ts';

/** Three props on a line, far enough apart that a ray picks one. */
function scene(): ShellScene {
  const positions = new Map<number, Float32Array>([
    [1, Float32Array.from([-4, 0, 0])],
    [2, Float32Array.from([0, 0, 0])],
    [3, Float32Array.from([4, 0, 0])],
  ]);
  return {
    entities: (): readonly number[] => [...positions.keys()],
    nameOf: (entity: number): string => `prop ${String(entity)}`,
    radiusOf: (): number => 1,
    positionOf(entity: number, out: Float32Array): boolean {
      const at = positions.get(entity);
      if (at === undefined) return false;
      out.set(at);
      return true;
    },
    setPosition(entity: number, x: number, y: number, z: number): void {
      positions.get(entity)?.set([x, y, z]);
    },
    remove(entity: number): void {
      positions.delete(entity);
    },
    restore(entity: number, x: number, y: number, z: number): void {
      positions.set(entity, Float32Array.from([x, y, z]));
    },
  };
}

/**
 * A camera at +z looking down −z, orthographic, so screen x maps to world x by a factor of eight.
 *
 * **Reversed-Z, which is what `screenRay` unprojects with**: the near plane is 1 and the far plane
 * 0, so the near point has to come out *further* along +z than the far one or the ray points away
 * from the scene and picks nothing. That is what the first version of this fixture did.
 */
function camera(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 8;
  m[5] = 8;
  m[10] = 1;
  m[14] = 10;
  m[15] = 1;
  return m;
}

function shellOf() {
  const world = scene();
  const shell = createEditorShell({
    canvas: null,
    textHost: createNullTextHost(),
    a11yHost: createNullA11yHost(),
    scene: world,
  });
  shell.resize(1280, 720);
  shell.setCamera(camera());
  return { shell, world };
}

describe('the shell that assembles the editor', () => {
  test('lays out a menu bar, a viewport and three panel slots', () => {
    const { shell } = shellOf();
    shell.frame(0);
    expect(shell.menuBarHeight).toBeGreaterThan(0);
    /* The viewport starts below the menu bar and does not overlap it. */
    expect(shell.viewport.y).toBeGreaterThanOrEqual(shell.menuBarHeight);
    expect(shell.viewport.w).toBeGreaterThan(0);
    expect(shell.viewport.h).toBeGreaterThan(0);
    expect(shell.panelSlots.length).toBe(3);
    for (const slot of shell.panelSlots) expect(slot.w * slot.h).toBeGreaterThan(0);
  });

  test('gives the viewport and the panels the whole window and no more', () => {
    const { shell } = shellOf();
    shell.frame(0);
    let area = shell.viewport.w * shell.viewport.h;
    for (const slot of shell.panelSlots) area += slot.w * slot.h;
    const below = 1280 * (720 - shell.menuBarHeight);
    /* Divider pixels are the only thing unaccounted for, and there are few of them. */
    expect(area).toBeLessThanOrEqual(below);
    expect(area).toBeGreaterThan(below * 0.95);
  });
});

/** The middle of the viewport, which is where the prop at the origin is drawn. */
const middleOf = (shell: EditorShell): [number, number] => [
  shell.viewport.x + shell.viewport.w / 2,
  shell.viewport.y + shell.viewport.h / 2,
];

describe('selecting by picking', () => {
  test('A PRESS IN THE VIEWPORT SELECTS WHAT IS UNDER IT, IN THE VIEWPORT’S OWN SPACE', () => {
    /*
     * **In the viewport's rectangle, not the window's**, which is the whole of this fix. The ray
     * was built over the window while the scene is drawn into the dock's rectangle, so every pick
     * was offset and scaled by the difference — clicking a marker selected a different one 78
     * pixels away. These coordinates are written as fractions of the viewport for that reason: a
     * test written in window pixels is the assumption that broke it.
     */
    const { shell } = shellOf();
    shell.frame(0);
    expect(shell.pick(...middleOf(shell))).toBe(2);
    expect(primarySelection(shell.selection)).toBe(2);
  });

  test('a press on nothing inside the viewport clears the selection', () => {
    const { shell } = shellOf();
    shell.frame(0);
    shell.pick(...middleOf(shell));
    expect(selectedEntities(shell.selection).length).toBe(1);
    /* Just inside the viewport's left edge, past every prop. */
    expect(shell.pick(shell.viewport.x + 1, shell.viewport.y + shell.viewport.h - 1)).toBe(-1);
    expect(selectedEntities(shell.selection).length).toBe(0);
  });

  test('A PRESS OUTSIDE THE VIEWPORT IS NOT A MISS, AND KEEPS WHAT WAS SELECTED', () => {
    /*
     * **A miss clears the selection and a click on a panel is not a miss.** It was: a stray click
     * on an empty dock silently threw away what somebody had just chosen, which a reader who had
     * not written this found within a few minutes of opening it.
     */
    const { shell } = shellOf();
    shell.frame(0);
    shell.pick(...middleOf(shell));
    expect(selectedEntities(shell.selection).length).toBe(1);
    const slot = shell.panelSlots[0] as { x: number; y: number; w: number; h: number };
    expect(shell.pick(slot.x + slot.w / 2, slot.y + slot.h / 2)).toBe(-1);
    expect(selectedEntities(shell.selection).length).toBe(1);
  });

  test('adding keeps what was there and makes the new one primary', () => {
    const { shell } = shellOf();
    shell.frame(0);
    shell.pick(...middleOf(shell));
    /* Three quarters across the viewport is NDC 0.5, which is world x = 4: the third prop. */
    shell.pick(
      shell.viewport.x + shell.viewport.w * 0.75,
      shell.viewport.y + shell.viewport.h / 2,
      {
        add: true,
      },
    );
    expect(selectedEntities(shell.selection).length).toBe(2);
    expect(primarySelection(shell.selection)).toBe(3);
  });
});

describe('a gizmo on the selection', () => {
  test('drags the selected prop and pushes one undo entry', () => {
    const { shell, world } = shellOf();
    shell.frame(0);
    shell.pick(...middleOf(shell));

    const origin = Float32Array.from([0, 6, 8]);
    const toward = (x: number): Float32Array => {
      const d = Float32Array.from([x - 0, 0 - 6, 0 - 8]);
      const k = 1 / Math.hypot(d[0] as number, d[1] as number, d[2] as number);
      return Float32Array.from([(d[0] as number) * k, (d[1] as number) * k, (d[2] as number) * k]);
    };
    expect(shell.beginDrag(GIZMO_TRANSLATE_X, { origin, direction: toward(0) })).toBe(true);
    for (const x of [1, 2, 3]) shell.updateDrag({ origin, direction: toward(x) });
    shell.endDrag();

    const at = new Float32Array(3);
    world.positionOf(2, at);
    expect(at[0]).toBeGreaterThan(1);
    expect(shell.app.undo.canUndo()).toBe(true);
    expect(shell.app.undo.undo()).toBe(true);
    world.positionOf(2, at);
    expect(at[0]).toBeCloseTo(0, 5);
    /* One entry for the whole drag. */
    expect(shell.app.undo.canUndo()).toBe(false);
  });

  test('refuses to drag with nothing selected', () => {
    const { shell } = shellOf();
    shell.frame(0);
    const origin = Float32Array.from([0, 6, 8]);
    const direction = Float32Array.from([0, -0.6, -0.8]);
    expect(shell.beginDrag(GIZMO_TRANSLATE_X, { origin, direction })).toBe(false);
  });
});

describe('the keys the shell binds', () => {
  test('undo and redo run the stack', () => {
    const { shell, world } = shellOf();
    shell.frame(0);
    shell.pick(...middleOf(shell));
    const origin = Float32Array.from([0, 6, 8]);
    const direction = Float32Array.from([0, -0.6, -0.8]);
    shell.beginDrag(GIZMO_TRANSLATE_X, { origin, direction });
    shell.updateDrag({ origin, direction: Float32Array.from([0.3, -0.55, -0.78]) });
    shell.endDrag();

    const at = new Float32Array(3);
    world.positionOf(2, at);
    const moved = at[0] as number;
    expect(shell.key(UNDO_KEY)).toBe(true);
    world.positionOf(2, at);
    expect(at[0]).toBeCloseTo(0, 5);
    expect(shell.key(REDO_KEY)).toBe(true);
    world.positionOf(2, at);
    expect(at[0]).toBeCloseTo(moved, 5);
  });

  test('opens and closes the command palette', () => {
    const { shell } = shellOf();
    expect(shell.paletteOpen).toBe(false);
    expect(shell.key(PALETTE_KEY)).toBe(true);
    expect(shell.paletteOpen).toBe(true);
    expect(shell.key('Escape')).toBe(true);
    expect(shell.paletteOpen).toBe(false);
  });

  test('answers false for a key it does not bind, so a host can pass it on', () => {
    const { shell } = shellOf();
    expect(shell.key('F7')).toBe(false);
  });
});

describe('the command palette', () => {
  test('searches the registered commands and runs the one chosen', () => {
    const { shell, world } = shellOf();
    shell.frame(0);
    shell.pick(...middleOf(shell));
    shell.key(PALETTE_KEY);

    const found = shell.searchPalette('delete');
    expect(found.length).toBeGreaterThan(0);
    expect(shell.runPalette(found[0] as string)).toBe(true);
    /* The palette closes on running something, which every editor does. */
    expect(shell.paletteOpen).toBe(false);
    /* And the command really ran: the prop is gone and undo brings it back. */
    expect(world.entities().includes(2)).toBe(false);
    expect(shell.app.undo.undo()).toBe(true);
    expect(world.entities().includes(2)).toBe(true);
  });

  test('carries undo and redo as commands too, so the palette is the whole surface', () => {
    const { shell } = shellOf();
    expect(shell.searchPalette('undo').length).toBeGreaterThan(0);
    expect(shell.searchPalette('redo').length).toBeGreaterThan(0);
  });
});

describe('the menu bar', () => {
  test('opens a menu whose items are commands', () => {
    const { shell } = shellOf();
    shell.frame(0);
    expect(shell.openMenuAt(0)).toBe(true);
    expect(shell.openMenuAt(9)).toBe(false);
    expect(shell.menuItems().length).toBeGreaterThan(0);
    shell.closeMenus();
    expect(shell.menuItems().length).toBe(0);
  });
});

describe('a scene that cannot delete', () => {
  /** The same props, with no `remove` and no `restore` — a capture's regions, for instance. */
  function readOnly(): ShellScene {
    const full = scene();
    return {
      entities: full.entities.bind(full),
      nameOf: full.nameOf.bind(full),
      radiusOf: full.radiusOf.bind(full),
      positionOf: full.positionOf.bind(full),
      setPosition: full.setPosition.bind(full),
    };
  }

  function shellFor(world: ShellScene): EditorShell {
    const shell = createEditorShell({
      canvas: null,
      textHost: createNullTextHost(),
      a11yHost: createNullA11yHost(),
      scene: world,
    });
    shell.resize(1280, 720);
    shell.setCamera(camera());
    shell.frame(0);
    return shell;
  }

  test('DOES NOT OFFER DELETE, RATHER THAN OFFERING ONE THAT REMOVES NOTHING', () => {
    /*
     * **It offered it, and it cleared the selection and removed nothing.** Somebody pressed the
     * key the README documents, watched the selection empty, and reasonably concluded something
     * had gone — the count was unchanged, the thing was still on screen, and `Ctrl+Z` had nothing
     * to give back. `ShellScene.remove` has been optional since it existed, and *"a scene that
     * cannot delete simply does not offer it"* is that option's own words.
     */
    const shell = shellFor(readOnly());
    expect(shell.commands.commands.has('edit.delete')).toBe(false);
    expect(shell.searchPalette('delete')).toEqual([]);

    shell.pick(...middleOf(shell));
    expect(selectedEntities(shell.selection).length).toBe(1);
    /* The key is not bound, so a host is told to pass it on rather than swallowing it. */
    expect(shell.key('Delete')).toBe(false);
    expect(selectedEntities(shell.selection).length).toBe(1);
  });

  test('and a scene that can delete still does', () => {
    const shell = shellFor(scene());
    expect(shell.commands.commands.has('edit.delete')).toBe(true);
    shell.pick(...middleOf(shell));
    expect(shell.key('Delete')).toBe(true);
    expect(selectedEntities(shell.selection).length).toBe(0);
    expect(shell.app.undo.canUndo()).toBe(true);
  });
});

/**
 * **The panels are in the product, one per region, reachable three ways.**
 *
 * Until 2026-09-20 they were not: `editor/src/panels/*` and four in `@driftengine/tools` were
 * written, tested and docked nowhere, so the shell drew three empty rectangles and every panel's
 * behaviour was true of code nothing ran. That is why this block exists rather than the panels'
 * own tests being enough — they test the panels, and what was missing was the assembly.
 */
describe('the panels the shell docks', () => {
  /** A panel that records what it was handed, and asks for a command when clicked. */
  function recorder(id: string, title: string, region: DockRegion) {
    const seen: UiEvent[] = [];
    let asked = 0;
    const panel: Panel<number, number> = {
      id,
      title,
      build(_world, _view, root): void {
        root.children.length = 0;
        addUiChild(root, createUiNode({ width: 'grow', height: 16, text: `${title} row` }));
      },
      route(_world, _view, event): Command | null {
        seen.push(event);
        asked += 1;
        return {
          label: `${title} asked`,
          apply(): void {},
          revert(): void {},
        };
      },
    };
    return { docked: dockPanel(panel, region, () => 0, 0), seen, asked: () => asked };
  }

  function shellWithPanels() {
    const left = recorder('left-one', 'Left one', 'left');
    const right = recorder('right-one', 'Right one', 'right');
    const other = recorder('right-two', 'Right two', 'right');
    const log = createLogRing(16);
    const shell = createEditorShell({
      canvas: null,
      textHost: createNullTextHost(),
      a11yHost: createNullA11yHost(),
      scene: scene(),
      panels: [left.docked, right.docked, other.docked],
      log,
    });
    shell.resize(1280, 720);
    shell.setCamera(camera());
    shell.frame(0);
    return { shell, left, right, other, log };
  }

  /** What a slot is actually showing: the strings in the tree the application laid out. */
  function drawn(shell: EditorShell, slot: number): string[] {
    const out: string[] = [];
    const walk = (node: UiNode): void => {
      if (node.text.length > 0) out.push(node.text);
      for (const child of node.children) walk(child);
    };
    const root = shell.panelNodes[slot];
    if (root != null) walk(root);
    return out;
  }

  test('EACH REGION OPENS ON ITS FIRST PANEL, AND A COMMAND SHOWS ANOTHER IN THE SAME REGION', () => {
    const { shell } = shellWithPanels();
    expect(shell.shownPanels()[0]).toBe('left-one');
    expect(shell.shownPanels()[1]).toBe('right-one');
    expect(shell.panelTitles[1]).toBe('Right one');
    expect(drawn(shell, 1)).toEqual(['Right one row']);

    expect(shell.run('view.panel.right-two')).toBe(true);
    shell.frame(1);
    expect(shell.shownPanels()[1]).toBe('right-two');
    expect(shell.panelTitles[1]).toBe('Right two');
    /*
     * **What is drawn, not only what is recorded.** Asserting the title and the identifier passed
     * a version that never told the application anything had changed: the region kept building the
     * panel it had, so the strip said one name over another panel's rows until something else
     * happened to invalidate the layout.
     */
    expect(drawn(shell, 1)).toEqual(['Right two row']);
    /* The other region is untouched: showing a panel is not rearranging the editor. */
    expect(shell.shownPanels()[0]).toBe('left-one');
    expect(drawn(shell, 0)).toEqual(['Left one row']);
    expect(shell.showPanel('nothing-called-this')).toBe(false);
  });

  test('A PRESS IN A PANEL REACHES THAT PANEL, IN ITS OWN SPACE, AND NOT THE SCENE', () => {
    const { shell, left } = shellWithPanels();
    const slot = shell.panelSlots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;

    shell.pick(...middleOf(shell));
    const selected = selectedEntities(shell.selection).length;
    expect(selected).toBe(1);

    expect(shell.pointer(slot.x + 7, slot.y + PANEL_TITLE_HEIGHT + 5)).toBe(true);
    const event = left.seen[0];
    expect(event?.kind).toBe('pointer');
    if (event?.kind !== 'pointer') return;
    /*
     * **The panel's own origin, under its own title.** The site's corner is taken off by the
     * application and the title strip by the binding; a panel that saw either would answer a row
     * other than the one that was clicked, which is the fault the viewport's picker had.
     */
    expect(event.x).toBe(7);
    expect(event.y).toBe(5);
    /* And the press was not also a pick: the selection is what it was. */
    expect(selectedEntities(shell.selection).length).toBe(selected);
    /* What the panel asked for went on the one undo stack, like everything else. */
    expect(shell.app.undo.undoLabel()).toBe('Left one asked');
  });

  test('A PRESS GOES TO THE PANEL THE REGION IS SHOWING NOW, NOT THE ONE IT OPENED WITH', () => {
    /*
     * **The region's press has to follow the swap.** Routing to the panel a region started with
     * would answer clicks with a panel nobody can see — every row hit would belong to the tree
     * that is no longer drawn, which reads as a panel that responds to the wrong thing rather than
     * as one that is not there.
     */
    const { shell, right, other } = shellWithPanels();
    shell.run('view.panel.right-two');
    shell.frame(1);
    const slot = shell.panelSlots[1];
    expect(slot).toBeDefined();
    if (slot === undefined) return;

    expect(shell.pointer(slot.x + 3, slot.y + PANEL_TITLE_HEIGHT + 3)).toBe(true);
    expect(other.seen.length).toBe(1);
    expect(right.seen.length).toBe(0);
  });

  test('a press in the viewport is not a panel’s, so a host can pick with what is left', () => {
    const { shell, left, right } = shellWithPanels();
    expect(shell.pointer(...middleOf(shell))).toBe(false);
    expect(left.seen.length).toBe(0);
    expect(right.seen.length).toBe(0);
  });

  test('every panel is a command, in the palette and in the View menu', () => {
    const { shell } = shellWithPanels();
    expect(shell.searchPalette('right two')).toContain('view.panel.right-two');

    const view = shell.menuTitles().indexOf('View');
    expect(view).toBeGreaterThanOrEqual(0);
    shell.openMenuAt(view);
    const items = shell.menuItems();
    /* Named by the panel rather than by the command, which is what the menu draws. */
    expect(items.map((item) => item.label)).toContain('Right two');
    for (const item of items) expect(shell.commands.commands.has(item.id)).toBe(true);
  });

  test('A COMMAND THAT RAN IS WRITTEN DOWN, SO THE CONSOLE HAS SOMETHING TO SHOW', () => {
    /*
     * **A console nothing writes to is a panel that looks finished and says nothing forever**, and
     * it is indistinguishable from one that is broken. What a person did is the one thing an
     * editor always knows.
     */
    const { shell, log } = shellWithPanels();
    shell.key(UNDO_KEY);
    shell.run('view.panel.right-two');
    const said = logEntries(log).map((entry) => entry.text);
    expect(said).toContain('Undo');
    expect(said).toContain('Show Right two');
  });
});
