/**
 * The editor as a host drives it: keys, a pointer, a size, and a picture described rather than drawn.
 *
 * **Everything an entry used to decide that was not about its platform.** The browser entry
 * (`main.ts`) held the key routing — what a binding is called, that typing goes to an open palette,
 * that Enter runs its first match — and every colour and rectangle of the placeholder picture. None
 * of that is the browser's, and a second host would have had to copy it, which is two
 * implementations of one editor. So an entry now turns its platform's events into the calls here
 * and turns `paint`'s calls into its own drawing, and it holds nothing else.
 *
 * **The picture is a list of rectangles, outlines, discs and text** in CSS pixels from the
 * top-left, which a 2D context draws directly and the engine draws as panels and its pixel font.
 *
 * **The viewport is the host's, where the host says so.** `viewportDrawn` is a host stating that it
 * has an engine behind that rectangle: the interface is still described here, and the scene inside
 * the viewport is drawn by `RendererApi` underneath it. Without it, the props are still discs —
 * which is what a host with no device gets, and is honest about being a placeholder rather than a
 * scene. Note what changes: the background is painted *around* the viewport rather than over it,
 * because painting over it would hide the renderer with a flat rectangle and look exactly like a
 * renderer that failed to draw.
 */
import { createFrameHistory, createLogRing, createSelection, pushFrame } from '@driftengine/tools';
import type { FrameHistory, LogRing, NetworkReadout } from '@driftengine/tools';
import type { A11yHost, TextHost, UiNode } from '@driftengine/ui2d';
import type { PassTimings } from '@driftengine/core';

import type { CaptureModel } from './panels/capture.ts';
import { editorPanels, type DockedPanel } from './panels/docked.ts';
import type { AssetIndex } from './panels/assets.ts';
import type { GraphWorld } from './panels/graph.ts';
import { createSceneModel, type SceneModel } from './panels/sceneTree.ts';
import { demoScene } from './demoScene.ts';
import { createEditorShell, MENU_BAR_HEIGHT, PALETTE_KEY } from './shell.ts';
import type { EditorShell, ShellScene } from './shell.ts';

/** A key, as every host can describe one. */
export interface KeyPress {
  /** `KeyboardEvent.key`: the character, or a key's name. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/** What a host draws with. Colours are CSS hex, `#rrggbb` or `#rrggbbaa`. */
export interface EditorPainter {
  rect(x: number, y: number, w: number, h: number, colour: string): void;
  /** A one-pixel line just inside the rectangle's edge. */
  outline(x: number, y: number, w: number, h: number, colour: string): void;
  disc(x: number, y: number, radius: number, colour: string): void;
  /** Text on a baseline at `y`, 12 pixels tall. */
  text(content: string, x: number, y: number, colour: string): void;
  clip(x: number, y: number, w: number, h: number): void;
  unclip(): void;
}

export interface EditorFrontEnd {
  readonly shell: EditorShell;
  readonly scene: ShellScene;
  /** What the console shows. A host appends to it for anything the commands do not cover. */
  readonly log: LogRing;
  /** Whether the key was the editor's, which a browser host answers with `preventDefault`. */
  key(press: KeyPress): boolean;
  pointerDown(x: number, y: number, shift: boolean, button?: number): void;
  /** The window's size in CSS pixels. */
  resize(width: number, height: number): void;
  frame(now: number): void;
  paint(painter: EditorPainter): void;
  /** One line: how many props, how many selected, and what undo would do. */
  readout(): string;
}

export interface FrontEndOptions {
  readonly canvas: unknown;
  readonly textHost: TextHost;
  readonly a11yHost: A11yHost;
  readonly scene?: ShellScene;
  /** True where the host draws the viewport with the engine. See the header. */
  readonly viewportDrawn?: boolean;
  /**
   * The capture a person is working on, or absent.
   *
   * **The front end shows a panel's rows and routes clicks into it; it does not own one.** The
   * model is the host's, because the host is what runs the stages that fill it.
   */
  readonly capture?: CaptureModel;
  /**
   * What the scene tree shows. Built from the scene's own entities where the host has no better.
   *
   * A capture has a real hierarchy — a surface with a region under it per proposal — and
   * `captureSceneModel` is what makes one. A demo scene has no hierarchy at all, so the default
   * below is flat and says so by being flat rather than by inventing parents.
   */
  readonly sceneModel?: () => SceneModel;
  readonly assets?: AssetIndex;
  /** The renderer's per-pass timings, where the host has a renderer. */
  readonly timings?: PassTimings;
  readonly network?: () => NetworkReadout | null;
  readonly graphs?: readonly GraphWorld[];
  /** What the script panel opens on. */
  readonly source?: string;
  /** The whole panel set, where a host wants a different one. Built from the above when absent. */
  readonly panels?: readonly DockedPanel[];
}

const PANEL_FILL = '#11161c';
const PANEL_EDGE = '#1e242c';
/** What a node with no colour of its own is drawn in. */
const PANEL_TEXT = '#d7dde5';

/**
 * How wide a menu title's box is, and how tall a row of its list.
 *
 * **Fixed boxes rather than measured text**, because a painter describes rather than measures and
 * the one thing this has to get right is that the rectangle a click is tested against is the
 * rectangle the word was drawn in.
 */
const MENU_SLOT = 72;
const MENU_ITEM_HEIGHT = 20;
const MENU_WIDTH = 190;

/**
 * Where the command palette sits, computed once so the picture and the pointer agree.
 *
 * **They did not.** `paint` worked the rectangle out locally and `pointerDown` knew nothing about
 * it, so the palette's rows could not be clicked and a click on one fell through to the scene
 * behind — somebody clicked `Undo`, watched a prop get selected instead, and found the entry still
 * pending. A list that looks exactly like a menu and is not one is worse than no list.
 */
const PALETTE_TOP = 80;
const PALETTE_HEIGHT = 160;
const PALETTE_ROW = 18;
const PALETTE_FIRST_ROW = 132;

function paletteBox(width: number): { x: number; y: number; w: number; h: number } {
  const w = Math.min(480, Math.max(120, width - 80));
  return { x: (width - w) / 2, y: PALETTE_TOP, w, h: PALETTE_HEIGHT };
}

/** An orthographic camera looking down −z. Reversed-Z, as `screenRay` expects. */
export function cameraMatrix(width: number, height: number): Float32Array {
  const m = new Float32Array(16);
  const scale = 9;
  m[0] = scale * (width / height);
  m[5] = scale;
  m[10] = 1;
  m[14] = 10;
  m[15] = 1;
  return m;
}

/** A key's binding as the registry names them: `Ctrl+Shift+Z`, `Delete`, `K`. */
export function bindingOf(press: KeyPress): string {
  return (
    (press.ctrl || press.meta ? 'Ctrl+' : '') +
    (press.shift ? 'Shift+' : '') +
    (press.key.length === 1 ? press.key.toUpperCase() : press.key)
  );
}

export function createEditorFrontEnd(options: FrontEndOptions): EditorFrontEnd {
  const scene = options.scene ?? demoScene();
  const log = createLogRing(400);
  const frames: FrameHistory = createFrameHistory(120);
  /*
   * **The selection is made here and given to both**, because the panels read it and the shell
   * owns it. Two selections would be a tree highlighting one thing while the viewport drew another
   * selected, which reads as the tree being broken rather than as there being two of them.
   */
  const selection = createSelection();
  const shell = createEditorShell({
    canvas: options.canvas,
    textHost: options.textHost,
    a11yHost: options.a11yHost,
    scene,
    selection,
    log,
    panels:
      options.panels ??
      editorPanels({
        selection,
        scene,
        sceneModel: options.sceneModel ?? flatModelOf(scene),
        capture: options.capture,
        assets: options.assets,
        log,
        timings: options.timings,
        frames,
        network: options.network,
        graphs: options.graphs,
        source: options.source,
      }),
  });
  const viewportDrawn = options.viewportDrawn === true;
  /** The clock the last frame was drawn at, so the profiler has a frame time to show. */
  let lastFrame = -1;
  /** Which row of the palette the keyboard is on. Reset whenever the query changes. */
  let paletteAt = 0;
  /** Which menu is open, or −1. The shell holds the same answer; this is what paints it. */
  let openMenu = -1;
  let width = 1;
  let height = 1;
  let query = '';
  const at = new Float32Array(3);

  return {
    shell,
    scene,
    log,

    key(press) {
      /*
       * **The key that opens it closes it**, before the palette takes the letter. `Ctrl+K` with the
       * palette open typed a literal `k` into the search box, because the single-character branch
       * below runs first and does not look at the modifiers.
       */
      if (shell.paletteOpen && (press.ctrl || press.meta) && press.key.toLowerCase() === 'k') {
        shell.key('Escape');
        query = '';
        paletteAt = 0;
        return true;
      }

      /* An open palette takes what is typed, before any binding does. */
      if (shell.paletteOpen && press.key.length === 1) {
        query += press.key;
        paletteAt = 0;
        return true;
      }
      if (shell.paletteOpen && press.key === 'Backspace') {
        query = query.slice(0, -1);
        paletteAt = 0;
        return true;
      }
      /*
       * **Arrows move the highlight**, which is the other half of a list somebody can use without
       * typing a command's name exactly. Without them the highlight sat on the first match and
       * nothing reached the others — which is not a list, it is a spelling test.
       */
      if (shell.paletteOpen && (press.key === 'ArrowDown' || press.key === 'ArrowUp')) {
        const matches = shell.searchPalette(query).length;
        if (matches > 0) {
          const step = press.key === 'ArrowDown' ? 1 : matches - 1;
          paletteAt = (paletteAt + step) % matches;
        }
        return true;
      }
      if (shell.paletteOpen && press.key === 'Enter') {
        const matches = shell.searchPalette(query);
        const chosen = matches[Math.min(paletteAt, matches.length - 1)];
        if (chosen !== undefined) shell.runPalette(chosen);
        query = '';
        paletteAt = 0;
        return true;
      }
      const binding = bindingOf(press);
      if (!shell.key(binding)) return false;
      if (binding === PALETTE_KEY || binding === 'Escape') {
        query = '';
        paletteAt = 0;
      }
      return true;
    },

    pointerDown(x, y, shift, button = 0) {
      /*
       * **An open palette takes the click, wherever it lands.** Its rows run what they say, and a
       * click anywhere else closes it — rather than falling through to the scene, which is what it
       * did: clicking `Undo` selected a prop and left the entry pending.
       */
      if (shell.paletteOpen) {
        const box = paletteBox(width);
        const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
        if (!inBox) {
          /* Escape is what closes it; `PALETTE_KEY` opens, so toggling with it leaves it open. */
          shell.key('Escape');
          query = '';
          paletteAt = 0;
          return;
        }
        const row = Math.floor((y - (PALETTE_FIRST_ROW - PALETTE_ROW + 4)) / PALETTE_ROW);
        const chosen = shell.searchPalette(query)[row];
        if (chosen !== undefined) {
          shell.runPalette(chosen);
          query = '';
          paletteAt = 0;
        }
        return;
      }

      /*
       * **The menu bar works.** `Edit` and `View` were painted text over a shell that has had
       * `openMenuAt`, `menuItems` and `closeMenus` since it existed — two of the four things on
       * screen were decoration, and somebody looking for a command went to them first and got no
       * response of any kind.
       */
      if (y < MENU_BAR_HEIGHT) {
        const index = Math.floor((x - 6) / MENU_SLOT);
        const titles = shell.menuTitles();
        if (index < 0 || index >= titles.length || openMenu === index) {
          openMenu = -1;
          shell.closeMenus();
          return;
        }
        openMenu = index;
        shell.openMenuAt(index);
        return;
      }
      if (openMenu >= 0) {
        const items = shell.menuItems();
        const left = 6 + openMenu * MENU_SLOT;
        const row = Math.floor((y - MENU_BAR_HEIGHT - 4) / MENU_ITEM_HEIGHT);
        const chosen = x >= left && x < left + MENU_WIDTH ? items[row] : undefined;
        openMenu = -1;
        shell.closeMenus();
        /* `run` rather than `runPalette`: the latter closes the palette, so `View > Command
           palette` opened it and shut it again in the same click. */
        if (chosen !== undefined) shell.run(chosen.id);
        return;
      }
      /*
       * **Offered to the panels first, and picked with what is left.** The viewport is a dock site
       * with no panel in it, so `shell.pointer` answers false there — rather than a rectangle test
       * here that would have to agree with the dock's own geometry.
       *
       * **What it costs:** the two are disjoint by construction, and `pick` refuses a position
       * outside the viewport rather than treating it as a miss, so the order is currently not
       * observable and no test can pin it. It is kept because either refusal alone has been wrong:
       * a pick that cleared the selection on a press in a panel is exactly what a reader found in
       * this file on 2026-09-20, and this ordering is what stops that being reachable again.
       */
      if (shell.pointer(x, y, button)) return;
      shell.pick(x, y, { add: shift });
    },

    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.floor(nextWidth));
      height = Math.max(1, Math.floor(nextHeight));
      shell.resize(width, height);
      /*
       * **The viewport's aspect, not the window's.** The scene is drawn into the dock's rectangle
       * and picked in it; a camera built over the window puts the picture and the ray in two
       * different spaces, which is the fault this pair was in until 2026-09-20.
       */
      const view = shell.viewport;
      shell.setCamera(cameraMatrix(Math.max(1, view.w), Math.max(1, view.h)));
    },

    frame(now) {
      /* The profiler's frame history is the one timing an editor always has, whether or not the
         host has a renderer that can be asked for per-pass numbers. */
      if (lastFrame >= 0 && now > lastFrame) pushFrame(frames, now - lastFrame);
      lastFrame = now;
      shell.frame(now);
    },

    paint(painter) {
      if (viewportDrawn) {
        /* Around the viewport, never over it: the engine has already drawn underneath. */
        const hole = shell.viewport;
        painter.rect(0, 0, width, hole.y, '#0b0d10');
        painter.rect(0, hole.y + hole.h, width, height - hole.y - hole.h, '#0b0d10');
        painter.rect(0, hole.y, hole.x, hole.h, '#0b0d10');
        painter.rect(hole.x + hole.w, hole.y, width - hole.x - hole.w, hole.h, '#0b0d10');
      } else painter.rect(0, 0, width, height, '#0b0d10');

      /* The menu bar, one box a title so a click can be mapped back to one. */
      painter.rect(0, 0, width, MENU_BAR_HEIGHT, PANEL_FILL);
      shell.menuTitles().forEach((title, at) => {
        const left = 6 + at * MENU_SLOT;
        if (at === openMenu) painter.rect(left, 0, MENU_SLOT, MENU_BAR_HEIGHT, '#1e242c');
        painter.text(title, left + 6, 16, at === openMenu ? '#d7dde5' : '#8fa3b8');
      });

      /*
       * The three panel slots, each drawn from the tree the application laid out in it.
       *
       * **The picture comes from the same tree the click was answered against.** It used to come
       * from a second build into a view's own root, with the row positions worked out here from a
       * row height — two descriptions of one list, which is the arrangement that puts a row in one
       * place and answers it in another.
       */
      shell.panelSlots.forEach((slot, at) => {
        painter.rect(slot.x, slot.y, slot.w, slot.h, PANEL_FILL);
        painter.outline(slot.x, slot.y, slot.w, slot.h, PANEL_EDGE);
        painter.clip(slot.x, slot.y, slot.w, slot.h);
        painter.text(shell.panelTitles[at] ?? '', slot.x + 6, slot.y + 14, '#8fa3b8');
        const root = shell.panelNodes[at];
        if (root != null) paintNode(painter, root);
        painter.unclip();
      });

      /* The viewport, and the props projected into it — unless the host drew a scene there. */
      if (!viewportDrawn) {
        const view = shell.viewport;
        painter.clip(view.x, view.y, view.w, view.h);
        painter.rect(view.x, view.y, view.w, view.h, '#141b22');
        /*
         * **Projected over the viewport's rectangle, which is where a click is answered.** It was
         * projected over the window, so a prop was drawn in one place and picked in another — and
         * the README recorded the visible half, "a prop can be clipped by a panel edge rather than
         * sitting behind it", without the half that matters.
         */
        const camera = cameraMatrix(Math.max(1, view.w), Math.max(1, view.h));
        const scaleX = camera[0] as number;
        const scaleY = camera[5] as number;
        for (const entity of scene.entities()) {
          if (!scene.positionOf(entity, at)) continue;
          const x = view.x + (((at[0] as number) / scaleX + 1) / 2) * view.w;
          const y = view.y + ((1 - (at[1] as number) / scaleY) / 2) * view.h;
          const selected = shell.selection.entities.includes(entity);
          painter.disc(x, y, 22, selected ? '#6fd3a0' : '#4a5a6a');
          painter.text(String(entity), x - 3, y + 4, '#0b0d10');
        }
        painter.unclip();
      }

      /* An open menu, over everything below the bar. */
      if (openMenu >= 0) {
        const items = shell.menuItems();
        const left = 6 + openMenu * MENU_SLOT;
        const tall = items.length * MENU_ITEM_HEIGHT + 6;
        painter.rect(left, MENU_BAR_HEIGHT, MENU_WIDTH, tall, '#11161c');
        painter.outline(left, MENU_BAR_HEIGHT, MENU_WIDTH, tall, PANEL_EDGE);
        items.forEach((item, row) => {
          /*
           * **An item says what it does whether or not it can be done.** `Delete selection` is
           * registered only where the scene can delete; borrowing the label from the registry drew
           * the raw identifier `edit.delete` between two items of prose, which reads as a fault in
           * the menu rather than as an unavailable action. Undo and Redo grey the same way when
           * the stack has nothing, so an item that does nothing looks like one.
           */
          const live =
            shell.commands.commands.has(item.id) &&
            (item.id !== 'edit.undo' || shell.app.undo.canUndo()) &&
            (item.id !== 'edit.redo' || shell.app.undo.canRedo());
          painter.text(
            item.label,
            left + 10,
            MENU_BAR_HEIGHT + 16 + row * MENU_ITEM_HEIGHT,
            live ? '#d7dde5' : '#4a5a6a',
          );
        });
      }

      if (shell.paletteOpen) {
        const box = paletteBox(width);
        /* Opaque: the scene showed through it, over the rows somebody was trying to read. */
        painter.rect(box.x, box.y, box.w, box.h, '#11161c');
        painter.outline(box.x, box.y, box.w, box.h, '#2b3642');
        painter.text(
          'command palette — type, then Enter. Escape closes.',
          box.x + 12,
          104,
          '#8fa3b8',
        );
        /*
         * **What was typed, shown.** It was not: the list narrowed and then went empty with no
         * echo, no caret and no "no matches", so somebody who typed a word the palette does not
         * have could not tell whether their keystrokes had arrived at all. They had.
         */
        painter.text(`> ${query}_`, box.x + 12, 120, '#d7dde5');
        const matches = shell.searchPalette(query);
        if (matches.length === 0) {
          painter.text('no command matches', box.x + 12, PALETTE_FIRST_ROW, '#6d7f92');
        }
        matches.forEach((id, row) => {
          const label = shell.commands.commands.get(id)?.label ?? id;
          const rowY = PALETTE_FIRST_ROW + row * PALETTE_ROW;
          if (rowY > box.y + box.h - 6) return;
          painter.text(label, box.x + 12, rowY, row === paletteAt ? '#6fd3a0' : '#8fa3b8');
        });
      }
    },

    readout() {
      /*
       * **It says when the scene cannot delete.** The key is unbound there and the menu item is
       * greyed, but a person who presses `Delete` and sees the frame not move at all cannot tell
       * whether the key does nothing, the editor is wedged, or the scene refused. One clause is
       * cheaper than any of the ways of finding that out.
       */
      const deletable = shell.commands.commands.has('edit.delete');
      return (
        `${String(scene.entities().length)} props · ` +
        `${String(shell.selection.entities.length)} selected · ` +
        `${shell.app.undo.canUndo() ? `undo: ${shell.app.undo.undoLabel() ?? ''}` : 'nothing to undo'}` +
        `${deletable ? '' : ' · this scene cannot delete'}`
      );
    },
  };
}

/**
 * Draw a laid-out interface tree with a host's painter.
 *
 * **Every panel is drawn the same way, because every panel is the same thing**: a tree of
 * rectangles with text in them, already placed. A host that knew one panel from another would be
 * a host that has to be taught each new one — and the capture panel was drawn exactly that way,
 * with its row positions recomputed here from a row height, until this replaced it.
 *
 * The tree is laid out in the application's space, which starts under the menu bar, so every
 * rectangle moves down by it. `clip` is honoured because a panel's content is routinely taller
 * than its site and a panel drawing over its neighbour is the first thing anybody notices.
 */
export function paintNode(painter: EditorPainter, node: UiNode): void {
  if (node.hidden) return;
  const { x, y, w, h } = node.rect;
  const top = y + MENU_BAR_HEIGHT;
  if (node.background !== null) painter.rect(x, top, w, h, cssColour(node.background));
  if (node.text.length > 0) {
    painter.text(node.text, x, top + TEXT_BASELINE, cssColour(node.tint) ?? PANEL_TEXT);
  }
  if (node.children.length === 0) return;
  if (node.clip) painter.clip(x, top, w, h);
  for (const child of node.children) paintNode(painter, child);
  if (node.clip) painter.unclip();
}

/** Where a 12-pixel line sits inside a row. Rows here are sixteen to eighteen pixels tall. */
const TEXT_BASELINE = 12;

function cssColour(rgba: Float32Array): string;
function cssColour(rgba: Float32Array | null): string | null;
function cssColour(rgba: Float32Array | null): string | null {
  if (rgba === null) return null;
  const part = (at: number): string =>
    Math.round(Math.min(1, Math.max(0, rgba[at] ?? 0)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(0)}${part(1)}${part(2)}`;
}

/**
 * The scene's entities as a flat tree, rebuilt when the scene's membership changes.
 *
 * **Flat because the seam is flat.** `ShellScene` is five methods and none of them is a parent, so
 * a hierarchy here would be one this file invented. A host holding something that does know —
 * a capture, whose regions sit under their surface — passes its own `sceneModel` instead.
 *
 * Rebuilt on a change rather than on every build: a panel is built whenever anything is dirty, and
 * rebuilding a model that has not changed would throw away which branches were open.
 */
export function flatModelOf(scene: ShellScene): () => SceneModel {
  const model = createSceneModel();
  let held: readonly number[] = [];
  return (): SceneModel => {
    const now = scene.entities();
    if (now.length === held.length && now.every((entity, at) => entity === held[at])) return model;
    for (const entity of held) model.remove(entity);
    for (const entity of now) model.add(entity, -1, scene.nameOf(entity));
    held = [...now];
    return model;
  };
}
