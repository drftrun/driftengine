/**
 * The engine's own loading badge, drawn into a frame.
 *
 * **It is the packaged shell's, not a second one invented here.** `packages/package/assets/
 * splash.html` is what a packaged game shows while it boots, and this reproduces its plate, its
 * mark, its name and its hairline so a reader waiting on a demo sees the same thing a player
 * waiting on a game does. A loading screen is the first thing anybody sees, and two of them is
 * two brands.
 *
 * One thing is deliberately different. That splash sweeps an indeterminate bar and says why in
 * its own comment: a progress bar which cannot measure progress is a lie told in pixels. This one
 * *can* measure, because it knows how many chunks it has meshed and how many it owes, so it fills
 * the track honestly instead of sweeping it.
 */
import {
  Camera,
  DEFAULT_TEXT_STYLE,
  createEnvironment,
  textHeightPx,
  type RendererApi,
  type Vec3,
} from '../../packages/core/src/index';

import { buildMarkMesh, MARK_VIEWBOX } from './mark';

/** The splash's own colours, converted from its stylesheet's hex to what the renderer shades in. */
const PLATE: Vec3 = [0.0037, 0.0037, 0.0045];
const TRACK: Vec3 = [0.0075, 0.0165, 0.0135];
const SWEEP: Vec3 = [0.0331, 0.7011, 0.4287];
/** The name under the mark, dimmer than the sweep so the bar stays the brightest thing. */
const NAME: Vec3 = [0.55, 0.78, 0.72];

/**
 * The splash's own measurements, in CSS pixels, and the proportions taken from them.
 *
 * **The numbers are a ratio rather than a size.** `splash.html` is a full window and can state
 * 208 pixels flat; this draws into whatever rectangle a host gives it, and on a phone that is a
 * 348 by 261 frame inside a page. At a fixed 208 the mark was wider than half the canvas and the
 * stack was taller than all of it, so the hairline fell off the bottom edge and the badge read as
 * a logo that did not fit rather than as a badge.
 *
 * So the lockup is a fraction of the smaller side, held between a size worth drawing and the
 * splash's own, and everything else keeps its proportion to it.
 */
const MARK_PX_MAX = 208;
const MARK_PX_MIN = 72;
/** The lockup against the smaller side of the frame, which is what keeps it clear of both edges. */
const MARK_OF_SMALLER_SIDE = 0.34;
/** `168 / 208` and `26 / 208`, from the splash's own stylesheet. */
const BAR_OF_MARK = 168 / 208;
const GAP_OF_MARK = 26 / 208;
const BAR_HEIGHT_PX = 2;

/** Far enough to clear any near plane a quality profile might set. The size is solved for it. */
const DISTANCE_M = 1;

export class Splash {
  private readonly camera = new Camera();
  private readonly model = new Float32Array(16);
  /* Unlit, so none of this is read. `bindMeshPass` wants one all the same. */
  private readonly env = createEnvironment({ ambient: [1, 1, 1], fogDensity: 0 });
  private readonly mark: ReturnType<RendererApi['createMesh']>;
  private readonly wordmark: ReturnType<RendererApi['createText']>;
  private disposed = false;
  /** Which form of the name is laid out, so a frame that has not changed does not re-lay it. */
  private spaced: boolean | null = null;

  constructor(private readonly renderer: RendererApi) {
    this.mark = renderer.createMesh(buildMarkMesh());
    /*
     * `lockup.svg` sets the name in vector letterforms, which a frame has no verb for, so it is
     * set in the engine's own HUD font instead: spaced out, dim, and sized against the mark. That
     * is a substitution and it is the honest one; the alternative is tessellating eleven paths to
     * avoid admitting the font is different.
     */
    this.wordmark = renderer.createText();
  }

  /** One frame of the badge, with the track filled to `fraction`. */
  draw(renderer: RendererApi, fraction: number, timeSec: number): void {
    const width = renderer.cssWidth;
    const height = renderer.cssHeight;
    if (this.disposed || width <= 0 || height <= 0) return;

    this.camera.position[0] = 0;
    this.camera.position[1] = 0;
    this.camera.position[2] = 0;
    this.camera.lookAt(0, 0, DISTANCE_M);
    this.camera.updateMatrices(width / height);

    /* A CSS pixel on the plane the mark sits on, which is what lets the splash's own measurements
       be used unchanged. `hotbarIcons.ts` does the same conversion for the same reason. */
    const markPx = Math.max(
      MARK_PX_MIN,
      Math.min(MARK_PX_MAX, Math.min(width, height) * MARK_OF_SMALLER_SIDE),
    );
    const gapPx = Math.round(markPx * GAP_OF_MARK);
    const barPx = Math.round(markPx * BAR_OF_MARK);

    const halfH = DISTANCE_M / (this.camera.projection[5] as number);
    const perPixel = (2 * halfH) / height;
    const scale = (markPx * perPixel) / MARK_VIEWBOX;

    /* The stack, downward from the mark's centre: mark, name, hairline, the splash's gap between
       each. Lifted above the middle so the lockup sits where a badge is expected. */
    const centreY = height / 2 - markPx * 0.18;
    /*
     * **The name is fitted, not assumed.** Letterspacing it reads as a wordmark and makes it
     * about twice as wide, which on a phone ran it off both edges of the frame. So the spaced
     * form is tried first and shrunk to fit, and if it still will not, the letters close up. A
     * lockup that overflows is worse than one set tight.
     */
    const maxNameWidth = Math.min(width * 0.86, markPx * 1.35);
    let cell = Math.max(1, Math.round(markPx / 52));
    this.layOutName(renderer, true);
    while (cell > 1 && renderer.textWidth(this.wordmark, cell) > maxNameWidth) cell--;
    if (renderer.textWidth(this.wordmark, cell) > maxNameWidth) {
      this.layOutName(renderer, false);
      while (cell > 1 && renderer.textWidth(this.wordmark, cell) > maxNameWidth) cell--;
    }
    const nameBaseline = centreY + markPx / 2 + gapPx + textHeightPx(cell);
    const barTop = Math.round(nameBaseline + gapPx);

    renderer.beginFrame(PLATE);
    renderer.bindMeshPass(this.camera, this.env);
    writeMarkModel(this.model, scale, (height / 2 - centreY) * perPixel, DISTANCE_M);
    renderer.setMaterial(null);
    renderer.drawTranslucentMesh(this.mark, this.model, 1, { lit: false, fog: false });

    renderer.drawText(
      this.wordmark,
      width,
      height,
      Math.round((width - renderer.textWidth(this.wordmark, cell)) / 2),
      Math.round(nameBaseline),
      { ...DEFAULT_TEXT_STYLE, cellSize: cell, color: NAME, glow: 0, alpha: 0.92, reveal: 1 },
      timeSec,
    );

    /* The track, then the fill over it, both flat panels: the splash draws its own hairline like
       this too, and for the reason that a demo is judged on its edges. */
    const left = Math.round((width - barPx) / 2);
    renderer.fillPanel({ left, top: barTop, width: barPx, height: BAR_HEIGHT_PX }, TRACK, 1);
    const filled = Math.round(barPx * Math.max(0, Math.min(1, fraction)));
    if (filled > 0) {
      renderer.fillPanel({ left, top: barTop, width: filled, height: BAR_HEIGHT_PX }, SWEEP, 1);
    }
    renderer.endFrame();
  }

  /** `setText` is a no-op on an unchanged string, and this keeps it that way across frames. */
  private layOutName(renderer: RendererApi, spaced: boolean): void {
    if (this.spaced === spaced) return;
    this.spaced = spaced;
    renderer.setText(this.wordmark, spaced ? 'D R I F T E N G I N E' : 'DRIFTENGINE');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.disposeMesh(this.mark);
    this.renderer.disposeText(this.wordmark);
  }
}

/**
 * The mark's model matrix: scaled, lifted by half the gap so the lockup reads as centred, and
 * pushed out in front of the eye.
 *
 * The camera looks down +Z here, so the mark sits at +Z with its faces pointing back at it.
 */
function writeMarkModel(out: Float32Array, scale: number, lift: number, distance: number): void {
  out.fill(0);
  out[0] = scale;
  out[5] = scale;
  out[10] = scale;
  out[13] = lift;
  out[14] = distance;
  out[15] = 1;
}
