/**
 * What the engine may ask about, and ask of, the surface it draws on.
 *
 * This is the seam a video settings screen is built on: which window mode the game is in, what
 * size the drawing surface is, what displays exist, and what the refresh rate is. A browser can
 * answer some of it and a native shell can answer all of it, so **the browser implementation
 * returns the value that is true** where it cannot answer — `null` for a refresh rate rather than
 * 60, and `false` from a call it cannot perform rather than a silent no-op. `AGENTS.md` requires
 * that of a backend for the same reason it is required here: a plausible answer is a picture
 * rather than an error, and something will divide by it or grey out the wrong control.
 *
 * **There are two window modes and not three, and that is a statement about the platform.**
 * Chromium never takes an exclusive fullscreen: it does not change the display's mode, it covers
 * the display. So "borderless fullscreen" and "fullscreen" would be the same setting under two
 * names, and a settings screen offering both would have one that does nothing. What a game
 * changes instead of a display mode is *how much it renders* — that is `RenderQuality`'s
 * `resolutionScale` and the `ResolutionGovernor`, not this interface.
 *
 * **Mobile is deliberately not modelled here.** A phone has no window and no window mode; what it
 * has is an orientation, a set of safe-area insets and a screen that wants to sleep. Those are
 * `ScreenPresentation`, a separate capability, because a desktop shell has no use for them and a
 * phone has no use for most of this.
 *
 * Taken as parameters, never imported: nothing under `src/` may name a shell, exactly as nothing
 * under `src/` names `localStorage` outside `KeyValueStore`.
 *
 * Not a hot path. Nothing here is called per frame.
 */

/** Windowed, or covering the display. See the class comment for why there is no third. */
export type WindowMode = 'windowed' | 'fullscreen';

/** A display the game could be shown on, as the platform reports it. */
export interface DisplayInfo {
  /** Stable for as long as the display is attached. Opaque: do not parse it. */
  readonly id: string;
  /** What to show in a list. A platform that has no name for it repeats the size. */
  readonly label: string;
  /** Logical pixels, which is what a window is sized in. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per logical pixel on this display. */
  readonly scale: number;
  /** Null where the platform will not say, which includes every browser. */
  readonly refreshHz: number | null;
  readonly primary: boolean;
}

export interface DisplayControl {
  /** The refresh rate of the display the game is on, or null where the platform will not say. */
  readonly refreshHz: number | null;
  /** Which mode the game is in right now, read rather than remembered. */
  mode(): WindowMode;
  /** `false` where the platform refused or cannot. Never rejects. */
  setMode(mode: WindowMode): Promise<boolean>;
  isFullscreen(): boolean;
  /** Never rejects. A browser refuses fullscreen outside a gesture, which is ordinary. */
  setFullscreen(on: boolean): Promise<void>;
  /** The drawing surface, in logical pixels. */
  size(): { readonly width: number; readonly height: number };
  /**
   * Whether `setSize` would work right now, asked without performing one.
   *
   * **A question rather than a mutation, since 2026-08-28.** `false` from `setSize` was the only
   * way to learn this, and `setSize` is the mutator — so a settings screen deciding whether to
   * draw a resolution control at all had to call the thing that changes the window in order to
   * find out whether it may. Reported from outside, where the workaround was a no-op probe at
   * boot, `setSize(...size())`, with a paragraph explaining that it is not what it looks like.
   *
   * **Read on each call and not a constant**, for the reason `mode()` is a call: a shell that can
   * resize a window cannot resize one that is covering a display, so the answer changes with the
   * window mode. A screen that greys its control reads this when it draws.
   *
   * It must agree with `setSize`, and in a shell that agreement is one function rather than two
   * conditions written twice — see `ipc.ts`. Two implementations of one decision drift, and here
   * they would drift into a greyed control that works or a live one that does not.
   *
   * **The engine already had this shape and this surface lacked it**: `pad.canRumble` says whether
   * a browser can drive a pad's motors at all, beside a `rumble` that answers whether the call was
   * taken. A question and a mutation, and the question is the half a settings screen draws with.
   */
  canSetSize(): boolean;
  /**
   * Resize the drawing surface. `false` where the platform will not — a browser never can, and a
   * shell will not while the window is covering a display.
   */
  setSize(width: number, height: number): Promise<boolean>;
  /** Every display the platform will admit to. Never empty where at least one is known. */
  displays(): readonly DisplayInfo[];
}

export class BrowserDisplay implements DisplayControl {
  constructor(private readonly element: HTMLElement) {}

  /**
   * Null always, here: no browser API reports this.
   *
   * Measuring it from frame intervals is possible and is deliberately not done — the answer
   * would be wrong on exactly the machines that care, where the compositor is capping a display
   * that runs faster. A shell asks the operating system and knows.
   */
  readonly refreshHz: number | null = null;

  isFullscreen(): boolean {
    return document.fullscreenElement !== null;
  }

  mode(): WindowMode {
    return this.isFullscreen() ? 'fullscreen' : 'windowed';
  }

  async setMode(mode: WindowMode): Promise<boolean> {
    const before = this.mode();
    await this.setFullscreen(mode === 'fullscreen');
    /* Read back rather than assume: a browser refuses fullscreen outside a user gesture and
       says nothing, and a settings screen that believed the request would show the wrong state
       until something else redrew it. */
    const after = this.mode();
    return after === mode || before === mode;
  }

  async setFullscreen(on: boolean): Promise<void> {
    try {
      if (on) await this.element.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch {
      /* A refusal is normal: fullscreen needs a user gesture and the caller may not be in one.
         Throwing would put a try/catch in every consumer's settings screen. */
    }
  }

  size(): { readonly width: number; readonly height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /**
   * Always false, and it touches nothing to say so.
   *
   * The same answer `setSize` gives and for the same reason, which is why they are written next to
   * each other: a browser cannot resize a window it did not open, so a settings screen greys the
   * control rather than offering one that quietly does nothing.
   */
  canSetSize(): boolean {
    return false;
  }

  /**
   * Always false.
   *
   * `window.resizeTo` is refused for anything but a window the script opened itself, so a browser
   * genuinely cannot do this. Saying so lets a settings screen disable the control; returning
   * `true` and doing nothing would leave a resolution list that appears to work.
   */
  async setSize(_width: number, _height: number): Promise<boolean> {
    return false;
  }

  /**
   * The one screen this browser can see.
   *
   * One entry rather than none: the browser does know the screen it is on, and an empty list
   * would make a settings screen report no displays on a machine that plainly has one. What it
   * does not know is the refresh rate or the names and positions of any other display, and it
   * says so by leaving them null and absent respectively.
   */
  displays(): readonly DisplayInfo[] {
    const screen = window.screen;
    return [
      {
        id: 'browser',
        label: `${screen.width}x${screen.height}`,
        width: screen.width,
        height: screen.height,
        scale: window.devicePixelRatio,
        refreshHz: null,
        primary: true,
      },
    ];
  }
}
