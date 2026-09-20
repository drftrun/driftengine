import { describe, expect, it } from 'vitest';
import { addUiChild, createUiNode } from '@driftengine/ui2d';
import { emptyPanel, keyEvent, pointerEvent, type Panel } from './panel.ts';
import type { Command } from './command.ts';
import {
  bindPanel,
  createToolsOverlay,
  paintOverlay,
  type OverlayPainter,
  type PanelBinding,
} from './overlay.ts';

interface RowWorld {
  rows: string[];
}

interface RowView {
  pressed: number;
  pressedX: number;
}

/** A panel with exactly enough behaviour to exercise the overlay and nothing more. */
function rowPanel(id: string): Panel<RowWorld, RowView> {
  return {
    id,
    title: id,
    build(world, _view, root) {
      root.children.length = 0;
      if (world.rows.length === 0) {
        emptyPanel(root, 'nothing');
        return;
      }
      for (const row of world.rows) {
        addUiChild(root, createUiNode({ width: 'grow', height: 10, text: row, name: row }));
      }
    },
    route(world, view, event) {
      if (event.kind !== 'pointer' || event.phase !== 'down') return null;
      view.pressed = event.y;
      view.pressedX = event.x;
      /*
       * Mutated in place rather than reassigned, because `route` is handed the world read-only —
       * which is the whole point of the signature. A command that reassigned a field would not
       * compile, and that refusal is the contract working rather than something to route around.
       */
      const rows = world.rows;
      return {
        label: 'add a row',
        apply: () => void rows.push('added'),
        revert: () => void rows.pop(),
      } satisfies Command;
    },
  };
}

function binding(
  id: string,
  world: RowWorld,
  view: RowView = { pressed: -1, pressedX: -1 },
): PanelBinding {
  return bindPanel(rowPanel(id), () => world, view);
}

/** Records what a host would have drawn, so a painter needs no device and no canvas. */
function recorder(): OverlayPainter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rect: (x, y, w, h) => void calls.push(`rect ${x},${y} ${w}x${h}`),
    text: (content, x, y) => void calls.push(`text ${content} @${x},${y}`),
    clip: (x, y, w, h) => void calls.push(`clip ${x},${y} ${w}x${h}`),
    unclip: () => void calls.push('unclip'),
  };
}

describe('the overlay a shipped game carries', () => {
  it('is hidden until the key is pressed, and draws nothing while it is', () => {
    const world: RowWorld = { rows: ['a', 'b'] };
    const overlay = createToolsOverlay({ panels: [binding('profiler', world)] });
    overlay.resize(800, 600);

    expect(overlay.visible).toBe(false);
    const painter = recorder();
    overlay.frame(0);
    paintOverlay(painter, overlay);
    expect(painter.calls).toEqual([]);

    expect(overlay.route(keyEvent('F3'))).toBe(true);
    expect(overlay.visible).toBe(true);
    overlay.frame(1);
    paintOverlay(painter, overlay);
    expect(painter.calls.length).toBeGreaterThan(0);
  });

  it('takes the key it was given rather than a fixed one, and takes it back', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({ panels: [binding('p', world)], key: 'F9' });
    expect(overlay.route(keyEvent('F3'))).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(overlay.route(keyEvent('F9'))).toBe(true);
    expect(overlay.visible).toBe(true);
    expect(overlay.route(keyEvent('F9'))).toBe(true);
    expect(overlay.visible).toBe(false);
  });

  it('lets every other event past while it is hidden, so a game keeps its input', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({ panels: [binding('p', world)] });
    overlay.resize(800, 600);
    expect(overlay.route(pointerEvent('down', 700, 100))).toBe(false);
    expect(overlay.route(keyEvent('w'))).toBe(false);
    expect(world.rows).toEqual(['a']);
  });

  it('puts its column on the side it was asked for, at the width it was asked for', () => {
    const world: RowWorld = { rows: ['a'] };
    const right = createToolsOverlay({ panels: [binding('p', world)], width: 200 });
    right.setVisible(true);
    right.resize(800, 600);
    right.frame(0);
    expect(right.root.rect.x).toBe(600);
    expect(right.root.rect.w).toBe(200);

    const left = createToolsOverlay({
      panels: [binding('p', world)],
      width: 200,
      side: 'left',
    });
    left.setVisible(true);
    left.resize(800, 600);
    left.frame(0);
    expect(left.root.rect.x).toBe(0);
  });

  /*
   * **Both axes, and the second panel rather than the first.** Written against one panel at the
   * top of the column this asserted nothing: that panel's origin is y 0, so the shift is zero on
   * the axis being checked and removing the shift entirely left the test green. The column starts
   * at x 600 and the second panel at y 300, so each subtraction now has a number in it.
   */
  it('hands a panel an event in the panel’s own space, never the screen’s', () => {
    const world: RowWorld = { rows: ['a'] };
    const view: RowView = { pressed: -1, pressedX: -1 };
    const overlay = createToolsOverlay({
      panels: [binding('first', world), bindPanel(rowPanel('second'), () => world, view)],
      width: 200,
    });
    overlay.setVisible(true);
    overlay.resize(800, 600);
    overlay.frame(0);
    overlay.route(pointerEvent('down', 650, 340));
    expect(view.pressedX).toBe(50);
    expect(view.pressed).toBe(40);
  });

  it('pushes what a panel returns onto the undo stack, and ctrl+z takes it back', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({ panels: [binding('p', world)], width: 200 });
    overlay.setVisible(true);
    overlay.resize(800, 600);
    overlay.frame(0);

    expect(overlay.route(pointerEvent('down', 650, 20))).toBe(true);
    expect(world.rows).toEqual(['a', 'added']);
    expect(overlay.route(keyEvent('z', false, true))).toBe(true);
    expect(world.rows).toEqual(['a']);
  });

  it('does not lay out again for a resize to the size it already is', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({ panels: [binding('p', world)] });
    overlay.setVisible(true);
    overlay.resize(800, 600);
    overlay.frame(0);
    const was = overlay.layoutCount;
    overlay.resize(800, 600);
    overlay.frame(1);
    expect(overlay.layoutCount).toBe(was);
    overlay.resize(801, 600);
    overlay.frame(2);
    expect(overlay.layoutCount).toBe(was + 1);
  });

  it('stacks several panels down the column rather than over each other', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({
      panels: [binding('one', world), binding('two', world)],
      width: 200,
    });
    overlay.setVisible(true);
    overlay.resize(800, 600);
    overlay.frame(0);
    const sites = overlay.sites();
    expect(sites).toHaveLength(2);
    expect(sites[0]?.y).toBe(0);
    expect(sites[1]?.y).toBe(sites[0]?.h);
    expect(sites[0]?.h).toBe(300);

    /*
     * **An odd height, because an even one cannot see the remainder.** At 600 across two panels
     * the division is exact, so dropping the last panel's remainder entirely left this green. At
     * 601 the floor is 300 and the last panel has to take 301 or the column ends a pixel short of
     * the screen, which is a gap a person sees before they see anything else.
     */
    overlay.resize(800, 601);
    overlay.frame(1);
    const odd = overlay.sites();
    expect(odd[0]?.h).toBe(300);
    expect(odd[1]?.h).toBe(301);
    expect((odd[1]?.y ?? 0) + (odd[1]?.h ?? 0)).toBe(601);
  });

  it('paints a clip for a panel and closes it again, so one panel cannot draw over the next', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({ panels: [binding('p', world)], width: 200 });
    overlay.setVisible(true);
    overlay.resize(800, 600);
    overlay.frame(0);
    const painter = recorder();
    paintOverlay(painter, overlay);
    expect(painter.calls.filter((c) => c.startsWith('clip')).length).toBe(
      painter.calls.filter((c) => c === 'unclip').length,
    );
    expect(painter.calls.some((c) => c.startsWith('text a'))).toBe(true);
  });

  it('stops answering once it is disposed', () => {
    const world: RowWorld = { rows: ['a'] };
    const overlay = createToolsOverlay({ panels: [binding('p', world)] });
    overlay.setVisible(true);
    overlay.resize(800, 600);
    overlay.frame(0);
    overlay.dispose();
    expect(overlay.visible).toBe(false);
    expect(overlay.route(pointerEvent('down', 650, 20))).toBe(false);
    const painter = recorder();
    paintOverlay(painter, overlay);
    expect(painter.calls).toEqual([]);
  });
});
