/**
 * What a phone has instead of a window.
 *
 * A handset has no window mode, no window size a game may choose and no second display, so
 * `DisplayControl` has almost nothing to offer it. What it has instead is an **orientation** it
 * may rotate out of, a **safe area** that a notch, a camera cut-out or a gesture bar has taken
 * from the screen, and a **screen that wants to sleep** while somebody is holding a controller
 * rather than touching the glass. Those are the three, and they are here rather than folded into
 * the display seam because a desktop shell has no use for any of them.
 *
 * **Every one of them can be refused, and each says so.** iOS will not lock an orientation at
 * all; Android will not lock one outside fullscreen; a browser with no Wake Lock API cannot keep
 * a screen awake. A game that is told `false` can lay itself out for either orientation, or warn,
 * or carry on — what it cannot do is find out later from a player.
 *
 * Not a hot path: a layout reads the safe area on a resize, not on a frame.
 */
export type ScreenOrientation = 'portrait' | 'landscape';

/** Logical pixels the platform has taken from each edge. Zero where it has taken nothing. */
export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ScreenPresentation {
  orientation(): ScreenOrientation;
  /** `null` unlocks. `false` where the platform refused, which iOS always does. */
  lockOrientation(orientation: ScreenOrientation | null): Promise<boolean>;
  safeArea(): SafeAreaInsets;
  /** `false` where the platform has no wake lock, or refused this one. */
  keepAwake(on: boolean): Promise<boolean>;
}

/** The four properties the style below defines, read back through the cascade. */
const INSET_PROPERTIES = ['top', 'right', 'bottom', 'left'] as const;

/** Marks the one style element this installs, so a second instance does not add another. */
const STYLE_ID = 'drift-safe-area';

interface WakeLockSentinel {
  release(): Promise<void>;
}

export class BrowserScreenPresentation implements ScreenPresentation {
  private held: WakeLockSentinel | null = null;

  /**
   * Installs one stylesheet, once, and that is the only side effect in this file.
   *
   * `env(safe-area-inset-*)` cannot be read from script directly — it is only valid inside a CSS
   * declaration — so the values are copied into custom properties on the root element and read
   * back through `getComputedStyle`. The alternative is a hidden probe element whose padding is
   * measured, which costs a layout on every read and a node in every consumer's tree.
   */
  constructor() {
    try {
      if (document.getElementById?.(STYLE_ID) != null) return;
      const style = document.createElement('style');
      style.setAttribute('id', STYLE_ID);
      style.textContent = `:root{${INSET_PROPERTIES.map(
        (edge) => `--drift-safe-${edge}:env(safe-area-inset-${edge},0px)`,
      ).join(';')}}`;
      document.head.appendChild(style);
    } catch {
      /* No document, or a head that will not take a child. The insets then read zero, which is
         the same answer a platform with no cut-out gives, and is never worth failing a boot for. */
    }
  }

  orientation(): ScreenOrientation {
    const type = window.screen?.orientation?.type;
    if (typeof type === 'string') return type.startsWith('portrait') ? 'portrait' : 'landscape';
    /* No orientation API: every desktop browser, and iOS Safari for most of its life. The shape
       of the window is the same answer the platform would have given. */
    return window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
  }

  async lockOrientation(orientation: ScreenOrientation | null): Promise<boolean> {
    const screen = window.screen?.orientation as
      { lock?: (o: string) => Promise<void>; unlock?: () => void } | undefined;
    if (screen === undefined) return false;
    try {
      if (orientation === null) {
        screen.unlock?.();
        return true;
      }
      if (typeof screen.lock !== 'function') return false;
      await screen.lock(orientation);
      return true;
    } catch {
      /* iOS refuses outright; Android refuses outside fullscreen. Both are ordinary. */
      return false;
    }
  }

  safeArea(): SafeAreaInsets {
    const read = (edge: (typeof INSET_PROPERTIES)[number]): number => {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(
          `--drift-safe-${edge}`,
        );
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    };
    return { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') };
  }

  async keepAwake(on: boolean): Promise<boolean> {
    const wakeLock = (
      navigator as { wakeLock?: { request(kind: string): Promise<WakeLockSentinel> } }
    ).wakeLock;
    try {
      if (!on) {
        if (this.held === null) return true;
        await this.held.release();
        this.held = null;
        return true;
      }
      if (wakeLock === undefined) return false;
      this.held = await wakeLock.request('screen');
      return true;
    } catch {
      /* A lock is dropped whenever the page is hidden, and re-requesting it is the caller's
         business. A failure here is not worth a throw. */
      return false;
    }
  }
}
