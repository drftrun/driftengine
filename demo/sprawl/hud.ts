/**
 * The heads-up display, in the engine's own overlay: the clock and the district top left, the
 * frame's rate and time top right, the ride panel bottom centre, and — until the walker's ground
 * and the city's pictures are in — the loading card over everything.
 *
 * **A string is built when what it shows changes**, not every frame: the clock by the minute, the
 * rate twice a second, the district and the ride when they do. `setText` lays a handle out only
 * when its string differs, so a steady frame builds no string and lays out nothing.
 *
 * The built-in pixel font, over plates: the reference's face is a licence decision taken where
 * `scripts/sdf-font.ts` runs, and this costs no asset until it is taken.
 */
import { DEFAULT_TEXT_STYLE, textWidthPx } from '../../packages/core/src/index';
import type {
  Camera,
  Environment,
  RendererApi,
  TextHandle,
  TextStyle,
  Vec3,
} from '../../packages/core/src/index';

/** What the frame hands the display; the display decides when a string is worth building. */
export interface HudFrame {
  hour: number;
  fps: number;
  ms: number;
  district: string;
  /** The ride's state and destination as one number, and its words when that number changes. */
  rideKey: number;
  rideWords: () => string;
  /** Loading: regions in and wanted, and whether the walker may go. */
  resident: number;
  total: number;
  ready: boolean;
  paused: boolean;
  readonly tier: string;
}

const PLATE: Vec3 = [0.03, 0.035, 0.05];
const WHITE: Vec3 = [0.92, 0.94, 0.98];
const DIM: Vec3 = [0.62, 0.68, 0.78];
const WARM: Vec3 = [1, 0.8, 0.45];
/** How often the rate is rewritten, seconds. */
const RATE_SEC = 0.5;

export class Hud {
  private readonly clock: TextHandle;
  private readonly where: TextHandle;
  private readonly rate: TextHandle;
  private readonly ride: TextHandle;
  private readonly title: TextHandle;
  private readonly detail: TextHandle;
  private readonly pause: TextHandle;
  private minute = -1;
  private district = '';
  private rideKey = -1;
  private rideText = '';
  private rateText = '';
  private sinceRate = RATE_SEC;
  private arrived = -1;
  private pausedTier = '';
  private pauseWords = '';
  /** One style rewritten per draw, rather than a new object a call. */
  private readonly style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {
    ...DEFAULT_TEXT_STYLE,
    /* The font's key light shades a face to 0.82; this much self-light gives the colour back. */
    glow: 0.2,
    alpha: 1,
    reveal: 1,
  };

  constructor(
    private readonly renderer: RendererApi,
    private readonly name: string,
  ) {
    this.clock = renderer.createText();
    this.where = renderer.createText();
    this.rate = renderer.createText();
    this.ride = renderer.createText();
    this.title = renderer.createText();
    this.detail = renderer.createText();
    this.pause = renderer.createText();
    renderer.setText(this.title, name);
  }

  /** Draw the display for `frame`, `dt` after the last, over the finished scene. */
  draw(frame: HudFrame, dt: number, camera: Camera, env: Environment): void {
    const r = this.renderer;
    const width = r.cssWidth;
    const height = r.cssHeight;
    const cell = Math.max(2, Math.round(Math.min(width, height) / 260));
    this.refresh(frame, dt);
    if (!frame.ready) {
      this.card(frame, width, height, cell, camera, env);
      return;
    }
    const pad = cell * 3;
    const line = cell * 9;
    /* Clear of the harness's own readout along the bottom edge. */
    const bottom = height - cell * 26;
    r.fillPanel(
      { left: pad, top: pad, width: cell * 60, height: line * 2 + cell * 4 },
      PLATE,
      0.55,
    );
    r.fillPanel(
      { left: width - pad - cell * 44, top: pad, width: cell * 44, height: line + cell * 4 },
      PLATE,
      0.55,
    );
    const rideWidth = textWidthPx(this.rideText, cell) + cell * 6;
    r.fillPanel(
      {
        left: (width - rideWidth) / 2,
        top: bottom - pad - line - cell * 4,
        width: rideWidth,
        height: line + cell * 4,
      },
      PLATE,
      0.55,
    );
    r.bindMeshPass(camera, env);
    this.text(this.clock, pad + cell * 3, pad + cell * 9, cell, WARM, width, height);
    this.text(
      this.where,
      pad + cell * 3,
      pad + cell * 9 + line,
      Math.max(1, cell - 1),
      DIM,
      width,
      height,
    );
    this.text(
      this.rate,
      width - pad - cell * 41,
      pad + cell * 9,
      Math.max(1, cell - 1),
      DIM,
      width,
      height,
    );
    this.text(
      this.ride,
      (width - rideWidth) / 2 + cell * 3,
      bottom - pad - cell * 3,
      cell,
      WHITE,
      width,
      height,
    );
    if (frame.paused) this.paused(frame, width, height, cell, camera, env);
  }

  /** The pause screen: what the keys do, and the tier Q would open the scene at. */
  private paused(
    frame: HudFrame,
    width: number,
    height: number,
    cell: number,
    camera: Camera,
    env: Environment,
  ): void {
    const r = this.renderer;
    if (frame.tier !== this.pausedTier) {
      this.pausedTier = frame.tier;
      this.pauseWords = `PAUSED   P RESUME   Q QUALITY ${frame.tier.toUpperCase()}`;
      r.setText(this.pause, this.pauseWords);
    }
    const words = this.pauseWords;
    const w = textWidthPx(words, cell) + cell * 8;
    r.fillPanel(
      { left: (width - w) / 2, top: height / 2 - cell * 8, width: w, height: cell * 14 },
      PLATE,
      0.85,
    );
    r.bindMeshPass(camera, env);
    this.text(
      this.pause,
      (width - w) / 2 + cell * 4,
      height / 2 + cell * 2,
      cell,
      WARM,
      width,
      height,
    );
  }

  /** Rebuild the strings whose subject has changed. */
  private refresh(frame: HudFrame, dt: number): void {
    const r = this.renderer;
    const minute = Math.floor(frame.hour * 60);
    if (minute !== this.minute) {
      this.minute = minute;
      const h = Math.floor(minute / 60) % 24;
      const m = minute % 60;
      r.setText(this.clock, `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`);
    }
    if (frame.district !== this.district) {
      this.district = frame.district;
      r.setText(this.where, frame.district.replace(/_/g, ' '));
    }
    if (frame.rideKey !== this.rideKey) {
      this.rideKey = frame.rideKey;
      this.rideText = frame.rideWords();
      r.setText(this.ride, this.rideText);
    }
    this.sinceRate += dt;
    if (this.sinceRate >= RATE_SEC) {
      this.sinceRate = 0;
      this.rateText = `${Math.round(frame.fps)} FPS ${frame.ms.toFixed(1)} MS`;
      r.setText(this.rate, this.rateText);
    }
    if (!frame.ready && frame.resident !== this.arrived) {
      this.arrived = frame.resident;
      r.setText(this.detail, `ARRIVING ${frame.resident} OF ${frame.total} REGIONS ABOUT YOU`);
    }
  }

  /** The loading card: the scene's name, what is arriving, and a bar. */
  private card(
    frame: HudFrame,
    width: number,
    height: number,
    cell: number,
    camera: Camera,
    env: Environment,
  ): void {
    const r = this.renderer;
    r.fillPanel({ left: 0, top: 0, width, height }, PLATE, 0.92);
    const barWidth = Math.min(width * 0.6, cell * 160);
    const left = (width - barWidth) / 2;
    const top = height / 2 + cell * 6;
    r.fillPanel({ left, top, width: barWidth, height: cell * 2 }, DIM, 0.25);
    const share = frame.total > 0 ? Math.min(1, frame.resident / frame.total) : 0;
    r.fillPanel({ left, top, width: barWidth * share, height: cell * 2 }, WARM, 0.9);
    r.bindMeshPass(camera, env);
    const big = cell * 2;
    this.text(
      this.title,
      (width - textWidthPx(this.name, big)) / 2,
      height / 2 - cell * 6,
      big,
      WHITE,
      width,
      height,
    );
    this.text(this.detail, left, top + cell * 12, Math.max(1, cell - 1), DIM, width, height);
  }

  private text(
    handle: TextHandle,
    left: number,
    baseline: number,
    cell: number,
    color: Vec3,
    width: number,
    height: number,
  ): void {
    const style = this.style;
    style.cellSize = cell;
    style.color = color;
    this.renderer.drawText(handle, width, height, left, baseline, style, 0);
  }
}
