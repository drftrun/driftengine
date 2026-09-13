/**
 * A loader that says what a `.drft` is doing while it arrives, drawn by the engine.
 *
 * **Drawn rather than laid out in the page**, which is the whole reason it is here: a demo has
 * to work wherever it is embedded, and a loading bar made of DOM would be a second thing to
 * style and a thing the website would have to know about. `fillPanel` and `TextRenderer` are
 * already in the engine, so this is thirty lines of composition and no new capability.
 *
 * **What it reports is the stages the format actually has**, not a spinner and a percentage.
 * docs/FORMAT.md §4.6 argues that the chunk kinds *are* the stages, and the chunk table is a
 * manifest that arrives in the first few kilobytes — so before any geometry lands, the loader
 * already knows there are 187 parts and six images coming and how many bytes each will be. A
 * bar that counts parts is telling the truth about the file rather than interpolating a
 * fraction, and the phase names come from what has completed rather than from a timer.
 */

import { DEFAULT_TEXT_STYLE, GLYPH_HEIGHT } from '../packages/core/src/index';
import type { RendererApi, TextHandle, TextStyle, Vec3 } from '../packages/core/src/index';
import type { DrftLoadProgress } from '@driftengine/assets';

const BAR_WIDTH_FRACTION = 0.34;
const BAR_HEIGHT_PX = 6;
const TRACK: Vec3 = [0.18, 0.19, 0.22];
const FILL: Vec3 = [0.62, 0.78, 1];
const LABEL: Vec3 = [0.82, 0.86, 0.94];
/** Long enough to read, short enough that a fast load does not hold the frame. */
const FADE_SEC = 0.45;

export class LoadProgress {
  private readonly title: TextHandle;
  private readonly detail: TextHandle;
  /** Held above zero while the bar fades out, so a finished load does not blink away. */
  private fade = 0;

  /**
   * Built from the renderer rather than from a context, which is what lets this run on either
   * backend — and is why `showroom` can now be drawn by one it does not name.
   */
  constructor(private readonly renderer: RendererApi) {
    this.title = renderer.createText();
    this.detail = renderer.createText();
  }

  /**
   * Draw the bar for this frame, or nothing once it has faded.
   *
   * Called after the world and before the frame resolves, like any overlay. `dtSec` drives the
   * fade rather than a clock, so a held frame holds the bar too.
   */
  draw(
    renderer: RendererApi,
    state: DrftLoadProgress,
    dtSec: number,
    timeSec: number,
    /**
     * Words and a fraction from somewhere other than the container, drawn instead of it.
     *
     * For the stages that happen *before* there is a container to report on: fetching a source
     * format whole, parsing it, welding it, writing it. The loader has nothing to say during any
     * of that, quite correctly, because none of it has reached the loader. Passed in rather than
     * added to `DrftLoadPhase` for the reason that enum exists: those are the chunk kinds the
     * format actually has, and a conversion is not one of them.
     */
    override?: { readonly title: string; readonly detail: string; readonly fraction: number },
  ): void {
    const finished = override === undefined && state.phase === 'ready';
    if (finished) this.fade = Math.min(this.fade + dtSec / FADE_SEC, 1);
    else this.fade = 0;
    const alpha = 1 - this.fade;
    if (alpha <= 0.01) return;

    const width = renderer.cssWidth;
    const height = renderer.cssHeight;
    const barWidth = Math.max(180, width * BAR_WIDTH_FRACTION);
    const x = (width - barWidth) / 2;
    const y = Math.round(height * 0.82);

    /*
     * The track first, then the fill over it. Both are opaque panels rather than one panel with
     * a border: a demo is judged on edges, and a two-pixel outline drawn by a shader that has
     * no notion of one is four more panels and a worse result.
     */
    renderer.fillPanel(
      { left: x, top: y, width: barWidth, height: BAR_HEIGHT_PX },
      TRACK,
      0.55 * alpha,
    );
    const filled = Math.max(0, Math.min(1, override?.fraction ?? state.fraction)) * barWidth;
    if (filled > 0) {
      renderer.fillPanel(
        { left: x, top: y, width: filled, height: BAR_HEIGHT_PX },
        FILL,
        0.9 * alpha,
      );
    }

    /*
     * Both lines are baselines with the glyphs standing *above* them, which is why the second
     * one clears the bar by a whole cell height rather than by a few pixels. The first attempt
     * put it 26 pixels below the track and the detail drew straight through it.
     */
    const cell = Math.max(2, Math.round(Math.min(width, height) / 320));
    const lineHeight = cell * GLYPH_HEIGHT;
    renderer.setText(this.title, override?.title ?? titleFor(state.phase));
    renderer.drawText(
      this.title,
      width,
      height,
      x,
      y - 14,
      style(cell, LABEL, alpha, timeSec),
      timeSec,
    );
    renderer.setText(this.detail, override?.detail ?? detailFor(state));
    renderer.drawText(
      this.detail,
      width,
      height,
      x,
      y + BAR_HEIGHT_PX + lineHeight + 12,
      style(cell, LABEL, 0.72 * alpha, timeSec),
      timeSec,
    );
  }

  dispose(): void {
    this.renderer.disposeText(this.title);
    this.renderer.disposeText(this.detail);
  }
}

/**
 * The words, which are the point of naming stages at all.
 *
 * Each one says what is *arriving*, not how far through something is: a person watching a model
 * build wants to know that the paint has landed and the images have not, which is a fact about
 * the file rather than a percentage.
 */
function titleFor(phase: DrftLoadProgress['phase']): string {
  if (phase === 'idle' || phase === 'connecting') return 'OPENING THE FILE';
  if (phase === 'manifest') return 'READING THE MANIFEST';
  /* The coarse whole model, which is on screen from here until the real one replaces it. */
  if (phase === 'outline') return 'OUTLINE';
  if (phase === 'materials') return 'PAINT';
  if (phase === 'geometry') return 'BUILDING THE MODEL';
  if (phase === 'textures') return 'IMAGES';
  if (phase === 'absent') return 'NO MODEL BAKED';
  if (phase === 'failed') return 'THE MODEL FAILED';
  return 'READY';
}

/**
 * The second line, composed here from the loader's numbers.
 *
 * The engine hands over counts and a phase and deliberately no prose, which is the right split: it
 * cannot know whether its caller wants "part 142 of 187", a language other than this one, or
 * nothing at all.
 */
function detailFor(state: DrftLoadProgress): string {
  if (state.phase === 'absent' || state.phase === 'failed') return state.message.toUpperCase();
  if (state.phase === 'manifest' || state.phase === 'outline' || state.phase === 'materials') {
    const megabytes = (state.totalBytes / 1e6).toFixed(1);
    return `${state.partsTotal} PARTS, ${state.imagesTotal} IMAGES, ${megabytes} MB`;
  }
  if (state.phase === 'geometry') return `PART ${state.partsDone} OF ${state.partsTotal}`;
  if (state.phase === 'textures') return `IMAGE ${state.imagesDone} OF ${state.imagesTotal}`;
  return '';
}

function style(cell: number, color: Vec3, alpha: number, timeSec: number): TextStyle {
  return {
    ...DEFAULT_TEXT_STYLE,
    cellSize: cell,
    color,
    glow: 0.4,
    alpha,
    reveal: 1,
    spin: 0,
    punch: 0,
    /* A shade of movement, so a bar that is waiting on a slow byte does not read as frozen. */
    bob: Math.sin(timeSec * 2.2) * 0.6,
  } satisfies TextStyle;
}
