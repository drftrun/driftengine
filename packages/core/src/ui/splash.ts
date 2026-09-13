/**
 * The engine badge a web-delivered game shows while it builds its first frame.
 *
 * **The packaged shell already does this, and a browser has nowhere to put it.** `drift-package`
 * opens a small frameless window with `assets/splash.html` in it and holds the game's own window
 * hidden until it paints. A game served from a URL has one document and no shell, so the same
 * badge has to be drawn *inside* the page, over whatever is already there, and taken down again
 * without leaving a trace in a DOM the engine does not own.
 *
 * **On by default, which is the only reason it exists.** A splash a consumer has to remember to
 * mount is one that every consumer mounts a different way and one forgets. `createRenderer` mounts
 * this one before it probes for a device, so a game inherits it by calling the function it was
 * already calling. `{ splash: false }` turns it off, and `?splash=0` turns it off without a code
 * change — the two-way form of the same flag `forcedBackend` reads.
 *
 * **It covers a real wait rather than manufacturing one.** Between `createRenderer` and the first
 * `endFrame` a browser probes for a GPU, compiles shaders and uploads whatever the game builds at
 * startup, and the alternative to a badge is a white page followed by an empty canvas. What it
 * cannot cover is the wait before this module exists at all: the bundle still has to arrive and
 * parse, and nothing inside the bundle can paint sooner than that.
 *
 * The mark is inlined rather than fetched. A badge that can fail to load is worse than none, and
 * the file it would fetch lives in `@driftengine/package`, which a web consumer never installs.
 *
 * **What it cannot do, stated because it looks like a bug.** A consumer's own loading screen that
 * is markup in `index.html` is on screen before this module exists — measured on a real game at
 * about a second in development — and no code inside the bundle can paint sooner than the bundle
 * parses. From the moment it mounts the plate is uncoverable, because it is in the top layer; the
 * window before that belongs to the page, and only markup in the page can close it.
 */
import { holdFrames } from '../core/bootGate.ts';

/**
 * What decides whether a badge is shown at all. Taken as data so the rule is testable in Node,
 * which is where the engine's tests run — the mount below is verified by looking at it.
 */
export interface SplashConditions {
  /** What the consumer asked for. `true` unless it opted out. */
  readonly enabled: boolean;
  /** Running inside `drift-package`, whose shell shows the same badge in its own window. */
  readonly packagedShell: boolean;
  /** The query string, so the flag can be flipped on a deployed build. */
  readonly search: string;
  /** Whether there is a document to mount on at all. False in a test, a bake or a worker. */
  readonly document: boolean;
}

/**
 * `?splash=1` or `?splash=0`, or null for anything else.
 *
 * Only the two values count, exactly as `forcedBackend` reads `?backend`. A flag that treats
 * every unrecognised string as one of its states is a typo that silently changes behaviour.
 */
export function forcedSplash(search: string): boolean | null {
  const value = new URLSearchParams(search).get('splash');
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

export function splashWanted(conditions: SplashConditions): boolean {
  /* Not a preference and not overridable: there is nothing to mount on. */
  if (!conditions.document) return false;

  const forced = forcedSplash(conditions.search);
  if (forced !== null) return forced;

  return conditions.enabled && !conditions.packagedShell;
}

export type SplashDecision = 'hold' | 'swap';

/**
 * The ceiling on the whole badge, whatever the caller asked for.
 *
 * Twenty seconds is long enough for a large world to stream in over a slow connection — which is
 * exactly the boot a badge should cover — and short enough that a failure is seen in the same
 * sitting. The same number `@driftengine/package` uses, for the same reason.
 */
export const SPLASH_HARD_CAP_MS = 20_000;

/**
 * How long the badge stays even on a machine that paints instantly.
 *
 * **Three seconds, which is a deliberate hold rather than a covered wait.** The mark's entrance
 * takes 640ms and the hairline sweeps on a 1500ms cycle, so anything under about two seconds
 * shows a logo arriving and then leaving before it has finished arriving — which reads as a
 * rendering fault rather than as a brand. A game boots once and this is the only place its engine
 * is named, so the seconds are spent on purpose.
 *
 * **What would make it wrong** is a consumer that is not a game booting: a page whose canvas is
 * one section among several, or a tool that opens into an interface. Three seconds of black is an
 * interruption there, which is why `enabled: false` exists and why the sites and the editing tool
 * in this repository pass it.
 */
export const SPLASH_MIN_MS = 3_000;

/** How long the plate takes to leave. Short: this is a handoff, not a transition. */
export const SPLASH_FADE_MS = 420;

/**
 * When the badge gives the screen to the game. Two conditions and a cap, each for a named failure.
 *
 *   - **The game has painted.** Swapping before that shows the empty canvas the badge exists to
 *     cover.
 *   - **The minimum has passed.** A badge that vanishes the instant a fast machine paints is a
 *     flicker, and the machines that boot fastest are the ones a developer tests on.
 *   - **The cap overrides both**, and is checked first so that a minimum longer than the cap
 *     cannot pin the screen. Past it the game is shown in whatever state it is in, because a
 *     broken game that can be seen is better than a brand that cannot be dismissed.
 *
 * Pure, so all three are testable without a browser: the caller owns the clock. This is the
 * second copy of the rule — `@driftengine/package`'s runs in Electron's main process, which
 * cannot import this engine — and `splash.test.ts` says why that duplication is deliberate.
 */
export function splashDecision(
  elapsedMs: number,
  minMs: number,
  contentReady: boolean,
  capMs: number = SPLASH_HARD_CAP_MS,
): SplashDecision {
  if (elapsedMs >= capMs) return 'swap';
  if (!contentReady) return 'hold';
  return elapsedMs >= minMs ? 'swap' : 'hold';
}

export interface SplashOptions {
  /** Off with `false`. Default on, which is the point of the module. */
  readonly enabled?: boolean;
  /** How long the badge stays even on a machine that paints immediately. */
  readonly minMs?: number;
  /** The query string to read `?splash` from. Defaults to the page's own. */
  readonly search?: string;
}

export interface MountedSplash {
  /** Tell the badge a frame reached the screen. Cheap, and ignored after the first one. */
  present(): void;
  /** Take it down now, whatever the clock says. Idempotent. */
  release(): void;
}

/**
 * The badge markup. One constant string, interpolated into nothing.
 *
 * **Everything is scoped under the host element**, including the keyframes, because this is
 * mounted into a document the engine does not own and a bare `@keyframes fade` would be a name
 * collision with whatever the consumer already defined.
 *
 * **The lockup's own `:root` rule is dropped on the way in.** In its own file that rule sets the
 * colour of the SVG document; inlined into a page, `:root` is the *page's* html element, so the
 * file would recolour the game it is covering and flip to near-black on a machine that prefers a
 * light scheme — an invisible mark on a black plate. The colour is set on the element instead.
 */
const SPLASH_MARK = `<svg viewBox="0 0 233.30 207.08" style="color:#ececf0" aria-hidden="true" focusable="false">
<g transform="translate(27.96,0)">
<polygon points="38.04,54.65 4.00,71.67 4.00,82.07 38.04,65.05" fill="#2ac79c"/>
<polygon points="38.04,83.02 4.00,100.04 4.00,110.44 38.04,93.42" fill="#116352"/>
<polygon points="49.39,43.31 88.69,66.00 88.69,111.39 49.39,88.69" fill="#0f5b49"/>
<polygon points="88.69,66.00 128.00,43.31 128.00,88.69 88.69,111.39" fill="#1c9b7c"/>
<polygon points="88.69,20.61 128.00,43.31 88.69,66.00 49.39,43.31" fill="#35e0b0"/>
</g>
<g transform="translate(0.00,196.96)">
<path transform="translate(0.00,0.00) scale(0.04600,-0.04600)" d="M247 685H111V0H258C399 0 566 64 566 348C566 630 406 685 247 685ZM255 635C375 635 503 599 503 348C503 102 380 50 262 50H171V635Z" fill="currentColor"/>
<path transform="translate(29.37,0.00) scale(0.04600,-0.04600)" d="M309 534C236 534 189 492 161 406L156 523H106V0H164V320C192 427 231 479 304 479C322 479 335 477 350 473L361 528C347 532 329 534 309 534Z" fill="currentColor"/>
<path transform="translate(46.83,0.00) scale(0.04600,-0.04600)" d="M134 753C108 753 91 734 91 711C91 688 108 669 134 669C161 669 178 688 178 711C178 734 161 753 134 753ZM164 523H106V0H164Z" fill="currentColor"/>
<path transform="translate(59.55,0.00) scale(0.04600,-0.04600)" d="M260 695C293 695 325 687 359 672L379 715C340 733 302 743 257 743C166 743 112 691 112 609V523H21V476H112V0H170V476H300L308 523H170V607C170 669 201 695 260 695Z" fill="currentColor"/>
<path transform="translate(74.62,0.00) scale(0.04600,-0.04600)" d="M321 62C295 47 270 39 241 39C188 39 164 69 164 130V476H292L299 523H164V655L106 648V523H18V476H106V127C106 36 155 -11 234 -11C276 -11 312 1 344 22Z" fill="currentColor"/>
<path transform="translate(90.60,0.00) scale(0.04600,-0.04600)" d="M486 692H73V0H488V108H220V299H438V405H220V585H470Z" fill="#35e0b0"/>
<path transform="translate(115.19,0.00) scale(0.04600,-0.04600)" d="M366 546C298 546 247 516 204 463L193 530H70V0H212V366C241 413 273 440 314 440C350 440 372 423 372 362V0H514V386C514 486 459 546 366 546Z" fill="#35e0b0"/>
<path transform="translate(142.12,0.00) scale(0.04600,-0.04600)" d="M509 610C445 574 383 543 261 546C128 546 35 471 35 354C35 286 63 239 129 203C91 179 67 142 67 104C67 48 113 0 224 0H302C358 0 385 -22 385 -58C385 -96 359 -123 261 -123C160 -123 138 -101 138 -51H11C11 -157 64 -220 258 -220C435 -220 528 -155 528 -48C528 40 451 104 331 104H250C198 104 189 121 189 139C189 153 197 166 209 174C228 169 248 167 271 167C406 167 489 242 489 345C489 412 456 452 391 481C455 481 505 486 544 501ZM264 451C323 451 352 421 352 358C352 293 322 259 265 259C211 259 177 295 177 356C177 414 210 451 264 451Z" fill="#35e0b0"/>
<path transform="translate(167.45,0.00) scale(0.04600,-0.04600)" d="M140 803C89 803 54 767 54 720C54 673 89 637 140 637C191 637 227 673 227 720C227 767 191 803 140 803ZM212 530H70V0H212Z" fill="#35e0b0"/>
<path transform="translate(180.72,0.00) scale(0.04600,-0.04600)" d="M366 546C298 546 247 516 204 463L193 530H70V0H212V366C241 413 273 440 314 440C350 440 372 423 372 362V0H514V386C514 486 459 546 366 546Z" fill="#35e0b0"/>
<path transform="translate(207.65,0.00) scale(0.04600,-0.04600)" d="M518 277C518 446 429 546 279 546C124 546 38 422 38 262C38 96 127 -16 297 -16C380 -16 446 14 498 56L439 136C393 104 355 90 310 90C242 90 194 120 184 222H515C516 237 518 259 518 277ZM377 311H184C191 411 226 449 282 449C350 449 377 397 377 317Z" fill="#35e0b0"/>
</g>
</svg>`;

/**
 * The plate, as the packaged badge with its window taken away.
 *
 * Same flat near-black with one very soft lift behind the mark, which is what stops a full screen
 * of `#0b0b0d` reading as a page that failed to paint. Sized in `vmin` rather than the packaged
 * page's fixed pixels: that page knew its window was 420x300, and this one is asked to look
 * deliberate on a phone held upright and on an ultrawide.
 */
function splashStyle(fadeMs: number): string {
  /*
   * **The reset before the layout is the popover's, not decoration.** A `[popover]` element
   * carries a UA border, padding, a background and `width:fit-content`, and it is `display:none`
   * until shown — so the four resets below are what turn the browser's dialog-shaped default back
   * into a full-bleed plate. `max-width`/`max-height` are the ones that are easy to miss: the UA
   * caps a popover at the viewport minus its margin, which crops the plate by a hair on some
   * platforms and looks like a rounding fault.
   */
  return `[data-drift-splash]{position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;border:0;padding:0;z-index:2147483647;margin:0;display:grid;place-items:center;background:#0b0b0d;background-image:radial-gradient(60% 55% at 50% 42%,#12161a 0%,#0b0b0d 70%);color-scheme:dark;overflow:hidden;opacity:1;transition:opacity ${fadeMs}ms linear}
[data-drift-splash]::backdrop{background:#0b0b0d}
[data-drift-splash][data-drift-splash-leaving]{opacity:0}
[data-drift-splash] .drift-splash-stack{display:grid;justify-items:center;gap:clamp(18px,3vmin,26px)}
[data-drift-splash] svg{width:min(232px,30vmin);height:auto;animation:drift-splash-arrive 640ms cubic-bezier(0.16,0.84,0.44,1) both}
@keyframes drift-splash-arrive{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:translateX(0)}}
[data-drift-splash] .drift-splash-line{width:min(168px,24vmin);height:2px;border-radius:2px;background:#1a2320;overflow:hidden;animation:drift-splash-fade 700ms 260ms both}
[data-drift-splash] .drift-splash-line::after{content:'';display:block;width:42%;height:100%;border-radius:2px;background:linear-gradient(90deg,rgba(53,224,176,0),#35e0b0,rgba(53,224,176,0));animation:drift-splash-sweep 1500ms cubic-bezier(0.45,0,0.55,1) infinite}
@keyframes drift-splash-fade{from{opacity:0}to{opacity:1}}
@keyframes drift-splash-sweep{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
@media (prefers-reduced-motion:reduce){[data-drift-splash] svg{animation:drift-splash-fade 300ms both}[data-drift-splash] .drift-splash-line::after{animation:none;width:100%;opacity:0.5}}`;
}

/** True when `drift-package`'s preload bridge is on the page. One name, feature-detected. */
function inPackagedShell(): boolean {
  return (globalThis as Record<string, unknown>)['__driftHost'] !== undefined;
}

/**
 * Put the badge up, and hand back the two verbs that take it down.
 *
 * Returns null when the conditions say no, so a caller can `?.present()` without asking twice.
 * Nothing here runs per frame: `present` is called once by the renderer's first `endFrame` and
 * the clock is a single `setTimeout`, not a `requestAnimationFrame` watch.
 */
export function mountSplash(options: SplashOptions = {}): MountedSplash | null {
  const hasDocument = typeof document !== 'undefined' && document !== null;
  const wanted = splashWanted({
    enabled: options.enabled ?? true,
    packagedShell: inPackagedShell(),
    search: options.search ?? globalThis.location?.search ?? '',
    document: hasDocument,
  });
  if (!wanted) return null;

  const minMs = Math.min(SPLASH_HARD_CAP_MS, Math.max(0, options.minMs ?? SPLASH_MIN_MS));
  const started = performance.now();

  const host = document.createElement('div');
  host.setAttribute('data-drift-splash', '');
  /*
   * **Manual popover, so the plate is in the top layer and cannot be covered.**
   *
   * `z-index` alone is not enough and the reason is not hypothetical: a consumer's own loading
   * screen is frequently already in the document before the engine's bundle has even parsed, and
   * whatever it sets, a later sibling with an equal z-index wins on document order. The top layer
   * is outside that argument entirely — nothing painted by ordinary content reaches it, including
   * an element that asks for the same maximum.
   *
   * `manual` rather than `auto`: an auto popover is light-dismissed by a click or the escape key,
   * and a badge somebody can dismiss by pressing a key while a game boots is a badge that
   * sometimes is not there. The z-index above stays as the fallback for a browser with no popover
   * support, where the plate is an ordinary fixed layer and the old argument applies again.
   */
  host.setAttribute('popover', 'manual');
  const style = document.createElement('style');
  style.textContent = splashStyle(SPLASH_FADE_MS);
  host.append(style);
  const stack = document.createElement('div');
  stack.className = 'drift-splash-stack';
  /* A constant with nothing interpolated into it. The alternative is forty `createElementNS`
     calls for a picture that never changes. */
  stack.innerHTML = SPLASH_MARK;
  const line = document.createElement('div');
  line.className = 'drift-splash-line';
  stack.append(line);
  host.append(stack);

  /* `body` is missing for a script in `<head>` without `defer`, and a badge that throws during
     boot is the failure this whole module is trying to prevent. */
  (document.body ?? document.documentElement).append(host);

  /* Guarded rather than assumed: `showPopover` is absent on older Safari and on any engine
     without the top layer, where the element stays an ordinary fixed layer and still draws. */
  if (typeof host.showPopover === 'function') {
    try {
      host.showPopover();
    } catch {
      /* An implementation that has the method and refuses the element. The plate is already in
         the document and already styled; nothing here needs to be undone. */
    }
  }

  let painted = false;
  let leaving = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /*
   * **Freeze the game the moment it has proved it can draw.**
   *
   * `painted` is the first `endFrame`, and everything after it until the plate leaves is time the
   * game would otherwise spend running behind an opaque screen. `bootGate` is read by `startLoop`
   * and named by neither of them; see its own comment for why the state is shared that way.
   */
  const openGate = holdFrames(() => painted && !leaving);

  const remove = (): void => {
    /* Leaving the top layer is what `hidePopover` is for. `remove()` alone takes the element out
       of the document, and an element removed while shown is not a state worth relying on. */
    if (host.isConnected && typeof host.hidePopover === 'function') {
      try {
        host.hidePopover();
      } catch {
        /* Not shown, or shown by nobody. The removal below is the part that matters. */
      }
    }
    host.remove();
  };

  const release = (): void => {
    if (leaving) return;
    leaving = true;
    /* Before the fade, not after it: the game resumes as the plate becomes transparent, so what
       shows through is a running frame rather than the still one it was frozen on. */
    openGate();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    host.setAttribute('data-drift-splash-leaving', '');
    /* A timeout rather than `transitionend`, which never fires for an element in a background
       tab — where a boot is exactly as likely to finish. */
    setTimeout(remove, SPLASH_FADE_MS);
  };

  /**
   * Ask the rule, and either go or come back when it could have changed.
   *
   * Two things move `splashDecision`: a frame arriving and the clock passing a threshold. The
   * first calls this directly; for the second it schedules itself for whichever threshold is
   * next, so an idle badge costs one pending timer rather than a frame callback.
   */
  const settle = (): void => {
    if (leaving) return;
    const elapsed = performance.now() - started;
    if (splashDecision(elapsed, minMs, painted) === 'swap') {
      release();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    const next = painted ? minMs - elapsed : SPLASH_HARD_CAP_MS - elapsed;
    timer = setTimeout(settle, Math.max(0, next));
  };

  settle();

  return {
    present(): void {
      if (painted || leaving) return;
      painted = true;
      settle();
    },
    release,
  };
}
