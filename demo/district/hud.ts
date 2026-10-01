/**
 * The district's display, in the engine's overlay: the clock and the weather top left, the frame
 * top right, the view's name when one is taken, the keys on H, and the loading card until the
 * ground under the walker is in.
 *
 * **A string is built when what it shows changes** — the clock by the minute, the rate twice a
 * second, the weather and the mode when they do — and `setText` lays a handle out only when its
 * string differs, so a steady frame builds and lays out nothing.
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

export interface DistrictHudFrame {
  hour: number;
  fps: number;
  ms: number;
  weather: string;
  mode: string;
  view: string;
  /** Seconds the view's name has been showing. */
  viewAge: number;
  resident: number;
  total: number;
  ready: boolean;
  help: boolean;
  detail: string;
}

const PLATE: Vec3 = [0.02, 0.025, 0.04];
const WHITE: Vec3 = [0.94, 0.95, 0.99];
const DIM: Vec3 = [0.62, 0.68, 0.8];
const NEON: Vec3 = [1, 0.35, 0.78];
const CYAN: Vec3 = [0.35, 0.95, 1];
const RATE_SEC = 0.5;
/** How long a view's name stays up after the view is taken. */
const VIEW_SEC = 3;

const KEYS = [
  'W A S D  WALK      SHIFT  RUN      SPACE  JUMP',
  'F  FLY OR WALK     MOUSE  LOOK     CLICK  CAPTURE',
  'T  HOUR ON         G  HOUR BACK    N  DAY OR NIGHT',
  'R  WEATHER         P  HOLD TIME    O  FOG',
  'V  NEXT VIEW       B  LAST VIEW    1-9  VIEWS',
  'H  THESE KEYS',
];

export class DistrictHud {
  private readonly clock: TextHandle;
  private readonly status: TextHandle;
  private readonly rate: TextHandle;
  private readonly view: TextHandle;
  private readonly title: TextHandle;
  private readonly detail: TextHandle;
  private readonly hint: TextHandle;
  private readonly keys: TextHandle[];
  private minute = -1;
  private statusText = '';
  private viewText = '';
  private detailText = '';
  private sinceRate = RATE_SEC;
  private readonly style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {
    ...DEFAULT_TEXT_STYLE,
    glow: 0.2,
    alpha: 1,
    reveal: 1,
  };

  constructor(
    private readonly renderer: RendererApi,
    private readonly name: string,
  ) {
    this.clock = renderer.createText();
    this.status = renderer.createText();
    this.rate = renderer.createText();
    this.view = renderer.createText();
    this.title = renderer.createText();
    this.detail = renderer.createText();
    this.hint = renderer.createText();
    this.keys = KEYS.map((line) => {
      const handle = renderer.createText();
      renderer.setText(handle, line);
      return handle;
    });
    renderer.setText(this.title, name);
    renderer.setText(this.hint, 'H  KEYS');
  }

  draw(frame: DistrictHudFrame, dt: number, camera: Camera, env: Environment): void {
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
    const small = Math.max(1, cell - 1);
    r.fillPanel(
      { left: pad, top: pad, width: cell * 76, height: line * 2 + cell * 4 },
      PLATE,
      0.55,
    );
    r.fillPanel(
      { left: width - pad - cell * 44, top: pad, width: cell * 44, height: line + cell * 4 },
      PLATE,
      0.55,
    );
    const showView = frame.view !== '' && frame.viewAge < VIEW_SEC;
    const viewWidth = textWidthPx(this.viewText, cell) + cell * 8;
    if (showView)
      r.fillPanel(
        {
          left: (width - viewWidth) / 2,
          top: height - cell * 40,
          width: viewWidth,
          height: line + cell * 4,
        },
        PLATE,
        0.6,
      );
    const keysTop =
      height - pad - (frame.help ? KEYS.length * line + cell * 4 : line + cell * 4) - cell * 22;
    const keysWidth = frame.help
      ? textWidthPx(KEYS[0] as string, small) + cell * 8
      : textWidthPx('H  KEYS', small) + cell * 6;
    r.fillPanel(
      {
        left: pad,
        top: keysTop,
        width: keysWidth,
        height: (frame.help ? KEYS.length * line : line) + cell * 4,
      },
      PLATE,
      0.55,
    );

    r.bindMeshPass(camera, env);
    this.text(this.clock, pad + cell * 3, pad + cell * 9, cell, NEON, width, height);
    this.text(this.status, pad + cell * 3, pad + cell * 9 + line, small, DIM, width, height);
    this.text(this.rate, width - pad - cell * 41, pad + cell * 9, small, DIM, width, height);
    if (showView)
      this.text(
        this.view,
        (width - viewWidth) / 2 + cell * 4,
        height - cell * 40 + cell * 9,
        cell,
        CYAN,
        width,
        height,
      );
    if (frame.help) {
      this.keys.forEach((handle, i) =>
        this.text(
          handle,
          pad + cell * 4,
          keysTop + cell * 9 + i * line,
          small,
          WHITE,
          width,
          height,
        ),
      );
    } else this.text(this.hint, pad + cell * 3, keysTop + cell * 9, small, DIM, width, height);
  }

  private refresh(frame: DistrictHudFrame, dt: number): void {
    const r = this.renderer;
    const minute = Math.floor(frame.hour * 60);
    if (minute !== this.minute) {
      this.minute = minute;
      const h = Math.floor(minute / 60) % 24;
      const m = minute % 60;
      r.setText(this.clock, `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`);
    }
    const status = `${frame.weather}   ${frame.mode}`;
    if (status !== this.statusText) {
      this.statusText = status;
      r.setText(this.status, status);
    }
    if (frame.view !== this.viewText) {
      this.viewText = frame.view;
      r.setText(this.view, frame.view);
    }
    this.sinceRate += dt;
    if (this.sinceRate >= RATE_SEC) {
      this.sinceRate = 0;
      r.setText(this.rate, `${Math.round(frame.fps)} FPS ${frame.ms.toFixed(1)} MS`);
    }
    if (frame.detail !== this.detailText) {
      this.detailText = frame.detail;
      r.setText(this.detail, frame.detail);
    }
  }

  private card(
    frame: DistrictHudFrame,
    width: number,
    height: number,
    cell: number,
    camera: Camera,
    env: Environment,
  ): void {
    const r = this.renderer;
    r.fillPanel({ left: 0, top: 0, width, height }, PLATE, 0.94);
    const barWidth = Math.min(width * 0.6, cell * 160);
    const left = (width - barWidth) / 2;
    const top = height / 2 + cell * 6;
    r.fillPanel({ left, top, width: barWidth, height: cell * 2 }, DIM, 0.25);
    const share = frame.total > 0 ? Math.min(1, frame.resident / frame.total) : 0;
    r.fillPanel({ left, top, width: barWidth * share, height: cell * 2 }, NEON, 0.9);
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
    const small = Math.max(1, cell - 1);
    this.text(
      this.detail,
      (width - textWidthPx(this.detailText, small)) / 2,
      top + cell * 12,
      small,
      DIM,
      width,
      height,
    );
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
