/**
 * The editor, assembled: a menu bar, a viewport, three panel slots, a palette, undo, selection
 * and a gizmo, wired to each other and to nothing else.
 *
 * **Separate from `app.ts` on purpose, and that is a deviation from the plan worth stating.** The
 * plan said to assemble everything into `app.ts`. That file is the *shell* — dock geometry, panel
 * routing, layout, the accessibility tree — and its whole test suite rests on it needing no
 * selection, no scene and no graphics device. Assembling a product into it would make the general
 * thing depend on the particular one, and the first consumer wanting a different arrangement would
 * have to take the editor's selection model with it. So `app.ts` stays the shell and this is the
 * product built out of it.
 *
 * **The scene is a seam, not a type this file owns.** `ShellScene` is five methods; the editor
 * must work over whatever a consumer is holding, which is the same rule `freeze.ts` states for
 * worlds and `gizmo.ts` for transforms.
 *
 * **Every action is a command, including the ones bound to keys.** Undo, redo and delete are in
 * the registry under the same identifiers the palette searches, so the menu, the palette and the
 * keyboard cannot drift apart — there is one list and three ways of reaching it. An editor where
 * a menu item and its shortcut do different things is one where somebody wired the same action
 * twice, and this is the arrangement that makes that impossible rather than merely discouraged.
 */
import { screenRay } from './viewport/pick.ts';
import { pickNearest, type PickCandidate } from './viewport/pick.ts';
import {
  beginGizmoDrag,
  createGizmoState,
  endGizmoDrag,
  updateGizmoDrag,
  type GizmoState,
  type Ray,
  type TransformSource,
} from './viewport/gizmo.ts';
import {
  addToSelection,
  appendLog,
  clearSelection,
  createSelection,
  panelIdOf,
  pointerEvent,
  selectOnly,
  selectedEntities,
  type Command,
  type LogRing,
  type Selection,
} from '@driftengine/tools';
import type { A11yHost, TextHost, UiNode } from '@driftengine/ui2d';

import { createEditorApp, type EditorApp, type PanelBinding } from './app.ts';
import { panelRegions, type DockedPanel, type DockRegion } from './panels/docked.ts';
import { createDockLayout, type DockLayout, type DockNode } from './dock/layout.ts';
import {
  commandForKey,
  createCommandRegistry,
  registerCommand,
  runCommand,
  searchCommands,
  type CommandRegistry,
} from './command/registry.ts';

/** Height of the menu bar, in pixels. Everything else starts below it. */
export const MENU_BAR_HEIGHT = 24;

export const UNDO_KEY = 'Ctrl+Z';
export const REDO_KEY = 'Ctrl+Shift+Z';
export const PALETTE_KEY = 'Ctrl+K';
export const DELETE_KEY = 'Delete';

/** The dock identifiers the shell arranges. The viewport is a site like any other. */
export const VIEWPORT_ID = 'viewport';
export const PANEL_IDS = ['panel.left', 'panel.right', 'panel.bottom'] as const;

/** What the editor needs of whatever holds the scene. */
export interface ShellScene extends TransformSource {
  entities(): readonly number[];
  nameOf(entity: number): string;
  /** Bounding radius, for picking. */
  radiusOf(entity: number): number;
  /** Remove an entity. Optional: a scene that cannot delete simply does not offer it. */
  remove?(entity: number): void;
  /** Put one back exactly, which is what makes a delete undoable. */
  restore?(entity: number, x: number, y: number, z: number): void;
}

export interface ShellOptions {
  readonly canvas: unknown;
  readonly textHost: TextHost;
  readonly a11yHost: A11yHost;
  readonly scene: ShellScene;
  readonly layout?: DockLayout;
  /**
   * What the three regions can show, in the order each region opens.
   *
   * **The panels are built before the shell and handed in**, because two of them read the
   * selection and the selection is the shell's — so either the shell builds the panels, which
   * makes the general thing depend on every particular panel, or the caller makes the selection
   * first and gives it to both. `selection` below is that.
   */
  readonly panels?: readonly DockedPanel[];
  /** Made here when absent. Supply one to bind panels to the same selection the viewport uses. */
  readonly selection?: Selection;
  /** Where a command that ran is written down, so the console has something to show. */
  readonly log?: LogRing;
}

export interface ShellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditorShell {
  readonly app: EditorApp;
  readonly selection: Selection;
  readonly commands: CommandRegistry;
  readonly gizmo: GizmoState;
  readonly menuBarHeight: number;
  readonly viewport: ShellRect;
  readonly panelSlots: readonly ShellRect[];
  /** What each slot's title strip says, in `panelSlots` order. Empty where a region shows nothing. */
  readonly panelTitles: readonly string[];
  /**
   * The laid-out tree in each slot, in `panelSlots` order, or null where a region shows nothing.
   *
   * **Read rather than rebuilt**, for the reason `EditorApp.sites` gives about its own rectangles:
   * a host that built the panel again to draw it would be drawing a second tree that is allowed to
   * disagree with the one the click was answered against.
   */
  readonly panelNodes: readonly (UiNode | null)[];
  readonly paletteOpen: boolean;
  frame(now: number): void;
  resize(width: number, height: number): void;
  /** The inverse view-projection the viewport is drawn with. Picking needs it and nothing else. */
  setCamera(invViewProj: Float32Array): void;
  /** Pick at a window position and select. Returns the entity, or -1. */
  pick(x: number, y: number, options?: { add?: boolean }): number;
  /**
   * Offer a press at a window position to whichever panel is under it.
   *
   * True where a panel took it, which is a host's signal not to pick. **A press in the viewport is
   * not taken**, because the viewport is a dock site with no panel in it, so a host can offer
   * every press here first and pick with what is left.
   */
  pointer(x: number, y: number, button?: number): boolean;
  /** Show a panel in the region it belongs to. False where no panel has that identifier. */
  showPanel(id: string): boolean;
  /** Which panel each region is showing, in `panelSlots` order. Empty where none. */
  shownPanels(): readonly string[];
  beginDrag(handle: number, ray: Ray): boolean;
  updateDrag(ray: Ray): boolean;
  endDrag(): void;
  /** Run whatever this key is bound to. False when nothing is. */
  key(binding: string): boolean;
  searchPalette(query: string): string[];
  runPalette(id: string): boolean;
  /**
   * Run a command by name, without the palette's own behaviour.
   *
   * **`runPalette` closes the palette on success**, which is right for the palette and wrong for
   * everything else: the menu ran `view.palette` through it, the command opened the palette, and
   * the close that follows shut it again — so the one item in the View menu did nothing, twice a
   * frame, for as long as it existed.
   */
  run(id: string): boolean;
  openMenuAt(index: number): boolean;
  /** What the menu bar says, in order. A host draws these and maps a click back to an index. */
  menuTitles(): readonly string[];
  /** What an open menu holds: the command to run and the words to draw for it. */
  menuItems(): readonly MenuItem[];
  closeMenus(): void;
  dispose(): void;
}

/**
 * The arrangement the editor opens with: a viewport with three panels around it.
 *
 * Left and bottom get a third and a quarter; the right panel takes a fifth. Written as a tree
 * rather than as rectangles for the reason `dockSites` gives — a saved arrangement outlives the
 * window it was made in.
 */
export function defaultDockLayout(): DockNode {
  return {
    kind: 'split',
    direction: 'column',
    ratio: 0.75,
    first: {
      kind: 'split',
      direction: 'row',
      ratio: 0.2,
      first: { kind: 'panel', id: PANEL_IDS[0] },
      second: {
        kind: 'split',
        direction: 'row',
        ratio: 0.75,
        first: { kind: 'panel', id: VIEWPORT_ID },
        second: { kind: 'panel', id: PANEL_IDS[1] },
      },
    },
    second: { kind: 'panel', id: PANEL_IDS[2] },
  };
}

export function createEditorShell(options: ShellOptions): EditorShell {
  const scene = options.scene;
  const selection = options.selection ?? createSelection();
  const gizmo = createGizmoState(scene, selection);
  const commands = createCommandRegistry();
  const layout = options.layout ?? createDockLayout(defaultDockLayout());
  const docked = options.panels ?? [];

  /*
   * **One panel per region, and the first declared for a region is what it opens with.** The dock
   * is splits and leaves with no tabs in it, so seven panels visible at once would be seven
   * slivers; showing one and offering the rest through `View` and the palette is the arrangement
   * that fits what the dock can actually express. Tabs are a rough edge, written down.
   */
  const showing = new Map<DockRegion, string>();
  for (const panel of docked) {
    if (!showing.has(panel.region)) showing.set(panel.region, panel.id);
  }
  const panelFor = (region: DockRegion): DockedPanel | undefined => {
    const id = showing.get(region);
    return id === undefined ? undefined : docked.find((panel) => panel.id === id);
  };

  /*
   * One binding per *site*, delegating to whichever panel that region is showing. The application
   * looks a binding up by the site's identifier, so a binding named after a panel would stop
   * being found the moment the region showed a different one.
   */
  const bindings: PanelBinding[] = PANEL_IDS.map((siteId, index) => {
    const region = panelRegions[index] as DockRegion;
    return {
      id: siteId,
      get title(): string {
        return panelFor(region)?.title ?? '';
      },
      /*
       * A region with no panel leaves its root empty, which is what a root that was never built
       * into already is: `showing` is filled once from the declared panels and only ever reset to
       * another of them, so a region that has a panel never stops having one. Clearing here as
       * well was a line that could not be wrong.
       */
      build(root): void {
        panelFor(region)?.build(root);
      },
      route(event): Command | null {
        return panelFor(region)?.route(event) ?? null;
      },
    };
  });

  const app = createEditorApp({
    canvas: options.canvas,
    textHost: options.textHost,
    a11yHost: options.a11yHost,
    layout,
    panels: bindings,
  });

  let width = 0;
  let height = 0;
  const invViewProj = new Float32Array(16);
  const viewport: ShellRect = { x: 0, y: MENU_BAR_HEIGHT, w: 0, h: 0 };
  const slots: ShellRect[] = PANEL_IDS.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const nodes: (UiNode | null)[] = PANEL_IDS.map(() => null);
  const titles: string[] = PANEL_IDS.map(() => '');
  let paletteOpen = false;
  let openMenu = -1;

  const rayOrigin = new Float32Array(3);
  const rayDirection = new Float32Array(3);
  const candidates: PickCandidate[] = [];
  const at = new Float32Array(3);

  /** Rectangles come from the dock, which is the one place that knows the arrangement. */
  const measure = (): void => {
    const sites = app.sites();
    for (const site of sites) {
      if (site.id === VIEWPORT_ID) {
        viewport.x = site.x;
        viewport.y = site.y + MENU_BAR_HEIGHT;
        viewport.w = site.w;
        viewport.h = site.h;
        continue;
      }
      const index = PANEL_IDS.indexOf(site.id as (typeof PANEL_IDS)[number]);
      if (index < 0) continue;
      const slot = slots[index] as ShellRect;
      slot.x = site.x;
      slot.y = site.y + MENU_BAR_HEIGHT;
      slot.w = site.w;
      slot.h = site.h;
      titles[index] = panelFor(panelRegions[index] as DockRegion)?.title ?? '';
    }
    /* The trees the application laid out, found by the identifier each root carries — rather than
       by position in a list, which is a second thing that has to stay in step. */
    nodes.fill(null);
    for (const child of app.root.children) {
      const index = PANEL_IDS.indexOf(panelIdOf(child) as (typeof PANEL_IDS)[number]);
      if (index >= 0) nodes[index] = child;
    }
  };

  /** A command that removes an entity and can put it back exactly. */
  const deleteCommand = (): Command | null => {
    if (scene.remove === undefined || scene.restore === undefined) return null;
    const entities = [...selectedEntities(selection)];
    if (entities.length === 0) return null;
    const saved = new Float32Array(entities.length * 3);
    for (let i = 0; i < entities.length; i += 1) {
      if (scene.positionOf(entities[i] as number, at)) saved.set(at, i * 3);
    }
    const remove = scene.remove.bind(scene);
    const restore = scene.restore.bind(scene);
    return {
      label: entities.length === 1 ? 'Delete' : `Delete ${String(entities.length)}`,
      apply(): void {
        for (const entity of entities) remove(entity);
      },
      revert(): void {
        for (let i = 0; i < entities.length; i += 1) {
          restore(
            entities[i] as number,
            saved[i * 3] as number,
            saved[i * 3 + 1] as number,
            saved[i * 3 + 2] as number,
          );
        }
      },
    };
  };

  registerCommand(commands, {
    id: 'edit.undo',
    label: 'Undo',
    binding: UNDO_KEY,
    run: () => {
      app.undo.undo();
    },
  });
  registerCommand(commands, {
    id: 'edit.redo',
    label: 'Redo',
    binding: REDO_KEY,
    run: () => {
      app.undo.redo();
    },
  });
  /*
   * **Registered only where the scene can actually delete**, which is what `ShellScene.remove`
   * being optional has always meant — "a scene that cannot delete simply does not offer it".
   *
   * It was registered unconditionally, and on a scene with no `remove` it cleared the selection,
   * pushed nothing and removed nothing. A reader who had not written it pressed the key the README
   * documents, watched the selection empty, and reasonably concluded something had been deleted:
   * the count was unchanged, the thing was still on screen, and `Ctrl+Z` had nothing to give back.
   * **It failed in the quietest direction there is.** Absent, the key does nothing at all and the
   * palette does not offer a command that cannot work.
   */
  if (scene.remove !== undefined && scene.restore !== undefined) {
    registerCommand(commands, {
      id: 'edit.delete',
      label: 'Delete selection',
      binding: DELETE_KEY,
      run: () => {
        const command = deleteCommand();
        if (command === null) return;
        app.undo.push(command);
        clearSelection(selection);
        app.invalidate();
      },
    });
  }
  registerCommand(commands, {
    id: 'edit.selectAll',
    label: 'Select all',
    binding: 'Ctrl+A',
    run: () => {
      clearSelection(selection);
      for (const entity of scene.entities()) addToSelection(selection, entity);
      app.invalidate();
    },
  });
  registerCommand(commands, {
    id: 'view.palette',
    label: 'Command palette',
    binding: PALETTE_KEY,
    run: () => {
      paletteOpen = true;
    },
  });

  /*
   * **Every panel is a command, which is what makes the palette the whole surface.** A panel
   * reachable only from a menu is one somebody has to know the menu to find; registered here it is
   * in the same list the keyboard and the menu bar read, and there is one implementation of
   * "show the profiler" rather than three.
   */
  const show = (id: string): boolean => {
    const panel = docked.find((one) => one.id === id);
    if (panel === undefined) return false;
    showing.set(panel.region, panel.id);
    app.invalidate();
    return true;
  };
  for (const panel of docked) {
    registerCommand(commands, {
      id: panelCommandId(panel.id),
      label: `Show ${panel.title}`,
      run: () => {
        show(panel.id);
      },
    });
  }

  const menus: { title: string; items: readonly MenuItem[] }[] = [
    { title: 'Edit', items: EDIT_MENU },
    {
      title: 'View',
      items: [
        { id: 'view.palette', label: 'Command palette' },
        ...docked.map((panel) => ({ id: panelCommandId(panel.id), label: panel.title })),
      ],
    },
  ];

  /**
   * Run a command and write down that it ran.
   *
   * **The log is the console's world**, and a console that nothing writes to is a panel that looks
   * finished and says nothing forever. What a person did is the one thing an editor always knows
   * and is exactly what somebody reads a console to reconstruct.
   */
  const runAndLog = (id: string): boolean => {
    const ran = runCommand(commands, id);
    if (ran && options.log !== undefined) {
      appendLog(options.log, 'info', commands.commands.get(id)?.label ?? id);
    }
    return ran;
  };

  const found: string[] = [];

  return {
    app,
    selection,
    commands,
    gizmo,
    menuBarHeight: MENU_BAR_HEIGHT,
    viewport,
    panelSlots: slots,
    panelTitles: titles,
    panelNodes: nodes,
    get paletteOpen(): boolean {
      return paletteOpen;
    },

    frame(now: number): void {
      app.frame(now);
      measure();
    },

    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth;
      height = nextHeight;
      /* The menu bar is taken off the top before the dock divides what is left, so a panel never
         starts underneath it — which is the arrangement bug every first shell has. */
      app.resize(width, Math.max(0, height - MENU_BAR_HEIGHT));
      measure();
    },

    setCamera(next: Float32Array): void {
      invViewProj.set(next);
    },

    /**
     * Pick at a window position, in the **viewport's** space.
     *
     * **The ray has to be built over the rectangle the picture occupies**, and until 2026-09-20 it
     * was built over the whole window — which was harmless while the viewport was a placeholder
     * drawn across the window, and wrong the moment the engine started drawing into the dock's
     * rectangle. A reader who had not written it found the shape in a minute: clicking a marker
     * selected a different one 78 pixels away, and clicking empty background 163 pixels below the
     * room selected something. Every pick was offset and scaled by the difference between the two
     * rectangles.
     *
     * **A click outside the viewport is not a pick at all**, rather than a miss: a miss clears the
     * selection, so a stray click on an empty panel silently threw away what the user had chosen.
     */
    pick(x: number, y: number, pickOptions: { add?: boolean } = {}): number {
      const view = viewport;
      if (x < view.x || y < view.y || x >= view.x + view.w || y >= view.y + view.h) return -1;
      screenRay(x - view.x, y - view.y, view.w, view.h, invViewProj, rayOrigin, rayDirection);
      candidates.length = 0;
      for (const entity of scene.entities()) {
        if (!scene.positionOf(entity, at)) continue;
        candidates.push({
          entity,
          cx: at[0] as number,
          cy: at[1] as number,
          cz: at[2] as number,
          radius: scene.radiusOf(entity),
        });
      }
      const hit = pickNearest(rayOrigin, rayDirection, candidates);
      if (hit < 0) {
        if (pickOptions.add !== true) clearSelection(selection);
        app.invalidate();
        return -1;
      }
      if (pickOptions.add === true) addToSelection(selection, hit);
      else selectOnly(selection, hit);
      app.invalidate();
      return hit;
    },

    /**
     * A press at a window position, offered to the panel under it.
     *
     * **In the application's space, which is the window less the menu bar.** The application's own
     * sites were measured after that subtraction, so a host that handed this a raw window position
     * would route a press near the top of a panel into the panel above it.
     */
    pointer(x: number, y: number, button = 0): boolean {
      return app.route(pointerEvent('down', x, y - MENU_BAR_HEIGHT, button));
    },

    showPanel(id: string): boolean {
      return show(id);
    },

    shownPanels(): readonly string[] {
      return panelRegions.map((region) => showing.get(region) ?? '');
    },

    beginDrag(handle: number, ray: Ray): boolean {
      return beginGizmoDrag(gizmo, handle, ray);
    },

    updateDrag(ray: Ray): boolean {
      const command = updateGizmoDrag(gizmo, ray);
      if (command === null) return false;
      app.undo.push(command);
      app.invalidate();
      return true;
    },

    endDrag(): void {
      endGizmoDrag(gizmo);
    },

    key(binding: string): boolean {
      if (binding === 'Escape') {
        if (!paletteOpen && openMenu < 0) return false;
        paletteOpen = false;
        openMenu = -1;
        return true;
      }
      /* `commandForKey` is the registry's own lookup: one binding map, not a scan that could
         disagree with it about which command a key runs. */
      const id = commandForKey(commands, binding);
      if (id === null) return false;
      return runAndLog(id);
    },

    searchPalette(query: string): string[] {
      const count = searchCommands(commands, query, found);
      return found.slice(0, count);
    },

    run(id: string): boolean {
      return runAndLog(id);
    },

    runPalette(id: string): boolean {
      const ran = runAndLog(id);
      /* Closed on running, which is what every palette does and what stops a second command
         being run by the keystroke that was meant to dismiss the first. */
      if (ran) paletteOpen = false;
      return ran;
    },

    openMenuAt(index: number): boolean {
      if (index < 0 || index >= menus.length) return false;
      openMenu = index;
      return true;
    },

    menuTitles(): readonly string[] {
      return menus.map((menu) => menu.title);
    },

    menuItems(): readonly MenuItem[] {
      if (openMenu < 0) return [];
      return (menus[openMenu] as { items: readonly MenuItem[] }).items;
    },

    closeMenus(): void {
      openMenu = -1;
    },

    dispose(): void {
      app.dispose();
    },
  };
}

/** The menu bar's own contents, as command identifiers. One list, three ways in. */
/**
 * A menu item carries its own words.
 *
 * **Because a command that is not registered has no label to borrow.** `Delete selection` exists
 * only where the scene can delete, and the menu drew the raw identifier `edit.delete` between two
 * items of prose — which reads as a bug in the menu rather than as an unavailable action.
 */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
}

const EDIT_MENU: readonly MenuItem[] = [
  { id: 'edit.undo', label: 'Undo' },
  { id: 'edit.redo', label: 'Redo' },
  { id: 'edit.delete', label: 'Delete selection' },
  { id: 'edit.selectAll', label: 'Select all' },
];

/**
 * What the command that shows a panel is called.
 *
 * **Derived rather than written down twice.** The menu item, the palette entry and the
 * registration all name the same string, and three literals that have to agree is the arrangement
 * that produces a menu item running nothing.
 */
export function panelCommandId(panelId: string): string {
  return `view.panel.${panelId}`;
}
