import { addUiChild, createUiNode, layoutUiTree, type UiNode } from '@driftengine/ui2d';
import {
  addToSelection,
  appendLog,
  createLogRing,
  createSelection,
  pointerEvent,
  type Command,
  type Panel,
  type UiEvent,
} from '@driftengine/tools';
import { createPanelRoot } from '@driftengine/tools';
import { expect, test } from 'vitest';

import { createSceneModel } from './sceneTree.ts';
import {
  PANEL_TITLE_HEIGHT,
  dockPanel,
  editorPanels,
  panelRegions,
  transformInspector,
  type DockedPanel,
} from './docked.ts';

/**
 * **The panels are in the product, bound to the editor's own state.**
 *
 * Two claims, and they fail in different ways. *Docked* is geometry: a panel is handed the dock
 * site less the strip its own title is drawn in, and a click is handed the same rectangle — the
 * two disagreeing is how a row is drawn in one place and answered in another, which is the fault
 * the picker had. *Bound* is that what a panel shows is what the editor is actually holding: a
 * panel wired to nothing builds the same empty tree forever and looks exactly like one that works.
 */

/** Every string in a built tree, in the order it was laid out. */
function textsIn(node: UiNode, out: string[] = []): string[] {
  if (node.text.length > 0) out.push(node.text);
  for (const child of node.children) textsIn(child, out);
  return out;
}

/** A panel that records the rectangle it was built into and the events it was handed. */
function recorder(): {
  panel: Panel<number, { built: UiNode | null; events: UiEvent[] }>;
  view: { built: UiNode | null; events: UiEvent[] };
} {
  const view = { built: null as UiNode | null, events: [] as UiEvent[] };
  return {
    view,
    panel: {
      id: 'recorder',
      title: 'Recorder',
      build(_world, held, root): void {
        held.built = root;
      },
      route(_world, held, event): Command | null {
        held.events.push(event);
        return null;
      },
    },
  };
}

test('A DOCKED PANEL GETS THE SITE LESS ITS TITLE STRIP, AND A CLICK GETS THE SAME RECTANGLE', () => {
  const { panel, view } = recorder();
  const docked = dockPanel(panel, 'left', () => 0, view);

  /*
   * What `app.ts` hands a panel, arranged the way it arranges one: an absolute root at the dock
   * site, inside the application's tree, laid out from the application's own origin.
   *
   * **Laid out, and asserted on `rect`.** Asserting the *fields* instead passed a build that never
   * made the content absolute — the numbers were right and the node was placed at the top of the
   * site anyway, with the title drawn across its first row. A position is where layout puts it.
   */
  const application = createUiNode({ width: 400, height: 300, name: 'editor' });
  const root = createPanelRoot({ id: 'panel.left' });
  root.absolute = true;
  root.x = 10;
  root.y = 20;
  root.width = 200;
  root.height = 100;
  addUiChild(application, root);
  docked.build(root);
  layoutUiTree(application, 0, 0, 400, 300);

  const content = root.children[0];
  expect(content).toBeDefined();
  if (content === undefined) return;
  expect(view.built).toBe(content);
  /* At the strip's height and that much shorter, so the title is never drawn over a row. */
  expect(content.rect.x).toBe(10);
  expect(content.rect.y).toBe(20 + PANEL_TITLE_HEIGHT);
  expect(content.rect.w).toBe(200);
  expect(content.rect.h).toBe(100 - PANEL_TITLE_HEIGHT);

  /*
   * Built again over the same site: one child still, in the same place. The content is a child
   * rather than the root moved, because the application re-assigns the root's rectangle before
   * every build and a root that moved itself would walk down the screen a strip at a time.
   */
  docked.build(root);
  layoutUiTree(application, 0, 0, 400, 300);
  expect(root.children.length).toBe(1);
  expect(content.rect.y).toBe(20 + PANEL_TITLE_HEIGHT);
  expect(content.rect.h).toBe(100 - PANEL_TITLE_HEIGHT);

  /*
   * **The event is moved by the same strip.** The application has already taken the site's origin
   * off; what is left is the title, and a panel that saw the untouched number would answer the row
   * above the one that was clicked.
   */
  docked.route(pointerEvent('down', 5, 30));
  const seen = view.events[0];
  expect(seen?.kind).toBe('pointer');
  if (seen?.kind !== 'pointer') return;
  expect(seen.x).toBe(5);
  expect(seen.y).toBe(30 - PANEL_TITLE_HEIGHT);
});

test('A REGION THAT CHANGES PANEL SHOWS THE NEW ONE ONLY', () => {
  /*
   * **The site is reused, so the panel that was in it has to leave.** Both builds are handed the
   * same root — that is what one region showing one panel at a time means — and a root that kept
   * both would draw the profiler's rows under the inspector's, which reads as one panel with
   * nonsense in it rather than as two.
   */
  const first = recorder();
  const second = recorder();
  const root = createPanelRoot({ id: 'panel.right' });
  root.width = 100;
  root.height = 100;

  dockPanel(first.panel, 'right', () => 0, first.view).build(root);
  dockPanel(second.panel, 'right', () => 0, second.view).build(root);
  expect(root.children.length).toBe(1);
  expect(root.children[0]).toBe(second.view.built);
});

test('a site too short for its own title gives the panel no height rather than a negative one', () => {
  const { panel, view } = recorder();
  const docked = dockPanel(panel, 'bottom', () => 0, view);
  const root = createPanelRoot({ id: 'panel.bottom' });
  root.width = 120;
  root.height = 8;
  docked.build(root);
  expect(view.built?.height).toBe(0);
});

/** The editor's own set, over state a test can hold. */
function panels(): readonly DockedPanel[] {
  const model = createSceneModel();
  model.add(1, -1, 'lamp');
  model.add(2, 1, 'shade');
  const positions = new Map<number, Float32Array>([
    [1, Float32Array.from([1, 2, 3])],
    [2, Float32Array.from([4, 5, 6])],
  ]);
  const selection = createSelection();
  addToSelection(selection, 1);
  const log = createLogRing(8);
  appendLog(log, 'info', 'opened a capture');

  return editorPanels({
    selection,
    scene: {
      entities: () => [...positions.keys()],
      positionOf(entity, out) {
        const at = positions.get(entity);
        if (at === undefined) return false;
        out.set(at);
        return true;
      },
      setPosition(entity, x, y, z) {
        positions.get(entity)?.set([x, y, z]);
      },
    },
    sceneModel: () => model,
    log,
    assets: { entries: [{ id: 'a', kind: 'scene', name: 'room.drft', bytes: 2048 }] },
  });
}

function shown(set: readonly DockedPanel[], id: string): string[] {
  const panel = set.find((one) => one.id === id);
  expect(panel, id).toBeDefined();
  if (panel === undefined) return [];
  const root = createUiNode({ width: 200, height: 200 });
  panel.build(root);
  return textsIn(root);
}

test('EVERY REGION OPENS WITH A PANEL, AND EACH ONE SHOWS WHAT THE EDITOR IS HOLDING', () => {
  const set = panels();

  /* A region with nothing in it is a rectangle nobody can explain. */
  for (const region of panelRegions) {
    expect(
      set.some((panel) => panel.region === region),
      region,
    ).toBe(true);
  }

  /* Bound, not merely present: each of these strings is state this test put there. */
  expect(shown(set, 'scene-tree').join(' ')).toContain('lamp');
  expect(shown(set, 'inspector').join(' ')).toContain('position');
  expect(shown(set, 'assets').join(' ')).toContain('room.drft');
  expect(shown(set, 'console').join(' ')).toContain('opened a capture');
});

test('the inspector reads the transform of what is selected, and only of what is selected', () => {
  const set = panels();
  const rows = shown(set, 'inspector').join(' ');
  /* Entity 1 is selected and entity 2 is not, so 4, 5, 6 must not appear. */
  expect(rows).toContain('1, 2, 3');
  expect(rows).not.toContain('4, 5, 6');
});

test('an entity the scene does not hold has no transform, rather than the last one read', () => {
  /*
   * **The reader fills a scratch vector, so a component reported without asking hands back
   * whatever was looked at last.** That is a row of real-looking numbers about an entity that is
   * not there, which is worse than an empty inspector by exactly the amount it is believable.
   */
  const world = transformInspector({
    entities: () => [1],
    positionOf: (entity, out) => {
      if (entity !== 1) return false;
      out.set([7, 8, 9]);
      return true;
    },
    setPosition: () => {},
  });
  expect(world.componentsOf(1)).toEqual(['transform']);
  expect(world.componentsOf(2)).toEqual([]);
  expect(world.hasComponent(2, 'transform')).toBe(false);
  expect(world.read(2, 'transform', 'position.x')).toBe(undefined);
});

test('a panel’s identifier is what a command names it by, and no two share one', () => {
  const ids = panels().map((panel) => panel.id);
  expect(new Set(ids).size).toBe(ids.length);
});
