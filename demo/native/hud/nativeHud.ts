/**
 * The native harness's interface for one window: the tree, a painter for the scene showing, the
 * pointer routing, and what each control does to the scene.
 *
 * **What `demo/dev/main.ts` does with HTML, done with the engine**: the same readout line, the
 * same player following the scene's clock, the same scrubber for a scene with states to reveal,
 * and the same list of scenes to switch between. What it cannot do is say why a scene failed to
 * mount, since the window's only means of drawing is the renderer the scene never made; that goes
 * to the terminal.
 *
 * The readout is rebuilt four times a second rather than every frame, which is steadier to read
 * than a figure changing sixty times a second and builds a string a quarter of a second rather
 * than one a frame; the player follows every frame, since a playhead that moved in steps would
 * look broken.
 */

import type { DemoHandle, DemoStats } from '../../types.ts';

import { bindHudInput } from './hudInput.ts';
import { HudPainter } from './hudPaint.ts';
import { createHudTree, layoutHud, setError, setLabel, setReadout } from './hudTree.ts';
import type { HudTree } from './hudTree.ts';

const READOUT_EVERY_SEC = 0.25;

export class NativeHud {
  private readonly tree: HudTree;
  private readonly unbind: () => void;
  private handle: DemoHandle | null = null;
  private painter: HudPainter | null = null;
  private title = '';
  private fps = 60;
  private sinceReadout = Number.POSITIVE_INFINITY;
  /** The reveal's step count last frame, so the scrubber parks at the end when a count arrives. */
  private revealSteps = 0;
  /* What the player last said, so a still clock rebuilds no strings. */
  private playing: boolean | null = null;
  private clockLabel = '';

  constructor(canvas: EventTarget, titles: readonly string[], pick: (index: number) => void) {
    this.tree = createHudTree(titles);
    this.unbind = bindHudInput(canvas, this.tree, {
      toggleMenu: () => {
        this.tree.menu.hidden = !this.tree.menu.hidden;
        this.layout();
      },
      closeMenu: () => {
        this.tree.menu.hidden = true;
        this.layout();
      },
      pick,
      playPause: () => {
        const clock = this.handle?.clock;
        if (clock === undefined) return;
        if (clock.playing) clock.pause();
        else clock.play();
      },
      stop: () => this.handle?.clock?.stop(),
      seek: (fraction) => {
        const clock = this.handle?.clock;
        if (clock !== undefined) clock.seek(fraction * clock.lengthSec);
      },
      reveal: (fraction) => {
        const reveal = this.handle?.reveal;
        if (reveal === undefined || reveal.steps < 2) return;
        const step = Math.round(fraction * (reveal.steps - 1));
        reveal.set(step);
        this.tree.revealAt = step / (reveal.steps - 1);
      },
    });
  }

  /** A scene is showing: draw over it with its renderer, from its next frame. */
  attach(handle: DemoHandle, index: number, title: string): void {
    this.handle = handle;
    this.title = title;
    this.tree.current = index;
    this.painter = handle.renderer === undefined ? null : new HudPainter(handle.renderer);
    this.sinceReadout = Number.POSITIVE_INFINITY;
    this.revealSteps = 0;
    this.playing = null;
    this.clockLabel = '';
    this.tree.error.hidden = true;
    this.layout();
  }

  /**
   * Where everything is, now rather than at the next frame, so a pointer arriving before it — a
   * replayed click, or one on a menu just opened — finds the controls where they will be drawn.
   */
  private layout(): void {
    const renderer = this.handle?.renderer;
    if (renderer !== undefined) layoutHud(this.tree, renderer.cssWidth, renderer.cssHeight);
  }

  /** The scene is going: let go of what was made with its renderer while it still exists. */
  detach(): void {
    this.painter?.dispose();
    this.painter = null;
    this.handle = null;
  }

  /** Something the scene threw while drawing, shown over the last frame it drew. */
  failed(message: string): void {
    const renderer = this.handle?.renderer;
    if (renderer !== undefined) setError(this.tree, message, renderer.cssWidth);
  }

  /** Follow the scene and draw the interface over the frame it has just finished. */
  frame(dtSec: number, stats: DemoStats | undefined): void {
    const handle = this.handle;
    const renderer = handle?.renderer;
    const painter = this.painter;
    if (handle === null || renderer === undefined || painter === null) return;
    this.fps += (1 / Math.max(dtSec, 1e-4) - this.fps) * 0.1;
    this.sinceReadout += dtSec;
    if (this.sinceReadout >= READOUT_EVERY_SEC) {
      this.sinceReadout = 0;
      setReadout(this.tree, this.readout(handle, stats), renderer.cssWidth);
    }
    this.followClock(handle);
    this.followReveal(handle);
    this.layout();
    painter.paint(this.tree);
  }

  dispose(): void {
    this.detach();
    this.unbind();
  }

  /** The browser harness's readout, part by part, so a narrow window breaks it between parts. */
  private readout(handle: DemoHandle, stats: DemoStats | undefined): string[] {
    const parts = [
      handle.backend ?? '?',
      `${this.title} — ${this.fps.toFixed(0)} fps`,
      `${stats?.draws ?? 0} draws`,
      `${(stats?.gpuMs ?? 0).toFixed(2)} ms gpu`,
    ];
    if (stats?.extra !== undefined && stats.extra !== '') parts.push(...stats.extra.split(' · '));
    if (handle.view?.taken === true) parts.push('camera yours (double click to release)');
    return parts;
  }

  private followClock(handle: DemoHandle): void {
    const clock = handle.clock;
    const shown = clock !== undefined && clock.ready;
    this.tree.transport.hidden = !shown;
    if (!shown) return;
    if (this.playing !== clock.playing) {
      this.playing = clock.playing;
      setLabel(this.tree.play, clock.playing ? 'Pause' : 'Play');
    }
    if (this.clockLabel !== clock.label) {
      this.clockLabel = clock.label;
      setLabel(this.tree.clock, clock.label);
    }
    /* Left where the pointer holds it, as the browser's playhead is. */
    if (!this.tree.timeline.pressed) this.tree.timelineAt = clock.atSec / clock.lengthSec;
  }

  private followReveal(handle: DemoHandle): void {
    const steps = handle.reveal?.steps ?? 0;
    this.tree.reveal.hidden = steps < 2;
    /* Parked at the end when the count arrives, which is the state the scene is showing. */
    if (steps !== this.revealSteps) {
      this.revealSteps = steps;
      this.tree.revealAt = 1;
    }
  }
}
