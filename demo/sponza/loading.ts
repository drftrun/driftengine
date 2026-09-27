/**
 * The courtyard arriving: a dark frame with the scene's name, how much has come, and a thin bar,
 * until every pack is in and the light has been baked, then a fade into the finished picture.
 *
 * **The load is hidden rather than watched.** Five packs streaming in parts and a hundred maps
 * landing one by one read as a building assembling itself for fifteen seconds, and nobody sees the
 * scene until it has stopped. Behind the veil the world is not drawn at all, so every frame of the
 * load goes to uploading it rather than to shading half of it.
 *
 * Drawn after the present, in the overlay pass, so it lands over the veil rather than under it.
 */
import { DEFAULT_TEXT_STYLE } from '../../packages/core/src/index';
import type {
  InsetRect,
  RendererApi,
  TextHandle,
  TextStyle,
  Vec3,
} from '../../packages/core/src/index';

/** The same shape, writable, so one object is rewritten in place rather than built each frame. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

const INK: Vec3 = [0.86, 0.8, 0.68];
const TRACK: Vec3 = [0.16, 0.15, 0.14];
const FILL: Vec3 = [0.93, 0.76, 0.45];

export class SponzaLoading {
  private readonly renderer: RendererApi;
  private readonly title: TextHandle;
  private readonly line: TextHandle;
  private shown = -1;
  /* Rewritten in place each frame, so the screen allocates nothing while it shows. */
  private readonly titleStyle: Writable<TextStyle> = {
    ...DEFAULT_TEXT_STYLE,
    color: INK,
    glow: 0,
    reveal: 1,
  };
  private readonly lineStyle: Writable<TextStyle> = {
    ...DEFAULT_TEXT_STYLE,
    color: INK,
    glow: 0,
    reveal: 1,
  };
  private readonly track: Writable<InsetRect> = { left: 0, top: 0, width: 0, height: 0 };
  private readonly fill: Writable<InsetRect> = { left: 0, top: 0, width: 0, height: 0 };

  constructor(renderer: RendererApi) {
    this.renderer = renderer;
    this.title = renderer.createText();
    this.line = renderer.createText();
    renderer.setText(this.title, 'SPONZA ATRIUM');
  }

  /** The screen, at `fraction` of the way, faded to `alpha`. Call after `endFrame`. */
  draw(fraction: number, alpha: number, timeSec: number): void {
    if (alpha <= 0) return;
    const renderer = this.renderer;
    const width = renderer.cssWidth;
    const height = renderer.cssHeight;
    const percent = Math.min(100, Math.floor(fraction * 100));
    if (percent !== this.shown) {
      this.shown = percent;
      renderer.setText(this.line, `LOADING ${percent}%`);
    }
    const cell = Math.max(2, Math.round(Math.min(width, height) / 160));
    const small = Math.max(1, cell - 1);
    const middle = height / 2;
    const titleStyle = this.titleStyle;
    titleStyle.cellSize = cell;
    titleStyle.alpha = alpha;
    const lineStyle = this.lineStyle;
    lineStyle.cellSize = small;
    lineStyle.alpha = alpha * 0.8;
    const titleLeft = (width - renderer.textWidth(this.title, cell)) / 2;
    renderer.drawText(this.title, width, height, titleLeft, middle - cell * 6, titleStyle, timeSec);
    const lineLeft = (width - renderer.textWidth(this.line, small)) / 2;
    renderer.drawText(this.line, width, height, lineLeft, middle + cell * 9, lineStyle, timeSec);
    const track = this.track;
    track.width = Math.min(width * 0.5, 480);
    track.left = (width - track.width) / 2;
    track.top = middle + cell * 2;
    track.height = Math.max(2, cell / 2);
    renderer.fillPanel(track, TRACK, alpha);
    const fill = this.fill;
    fill.left = track.left;
    fill.top = track.top;
    fill.height = track.height;
    fill.width = track.width * Math.min(1, fraction);
    renderer.fillPanel(fill, FILL, alpha);
  }

  dispose(): void {
    this.renderer.disposeText(this.title);
    this.renderer.disposeText(this.line);
  }
}
