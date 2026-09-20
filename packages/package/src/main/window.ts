import { BrowserWindow, Menu, app, protocol, shell } from 'electron';
import { createReadStream } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

import { planFlags } from '../flags.ts';
import type { PackageManifest, Target } from '../manifest.ts';
import { installIpc, readStoreSnapshot } from './ipc.ts';
import { externalTarget } from './links.ts';
import { appMenuTemplate } from './menu.ts';
import { isBlockedShortcut } from './shortcuts.ts';
import { openSteam } from '../steam/main.ts';
import { contentTypeFor, resolveWithinRoot } from './serve.ts';
import { createSplash } from './splash.ts';
import { splashDecision } from './splashTiming.ts';
import { consoleLine, forwardsConsole } from './consoleForward.ts';
import { CSP } from './csp.ts';
import { electronMajor } from '../runtimeVersion.ts';

/** How often the swap condition is re-read. Fine enough not to be seen, coarse enough to cost
    nothing during a boot that is already busy. */
const SPLASH_POLL_MS = 80;

/**
 * The window, the scheme the game is served over, and the switches it launches with.
 *
 * **`drift://` rather than `file://`, and it is not a preference.** ES modules, `fetch` and
 * workers all need an origin, and `file://` is not one — a game served from it fails to load its
 * own modules, which reads as a broken build rather than as a missing origin.
 *
 * **Every switch is appended before `ready`.** Chromium reads its command line once at startup;
 * a switch appended after the app is ready is accepted silently and does nothing, which is the
 * worst available failure mode for a flag whose whole job is invisible.
 *
 * Not unit-tested, deliberately: this is Electron lifecycle and window state, there is no Electron
 * in the test environment, and the two pieces with logic worth checking — the flag plan and the
 * path resolver — are pure modules that are. What proves this file is `drift-package run`.
 */
export async function startApp(
  manifest: PackageManifest,
  root: string,
  target: Target,
  options: { readonly development: boolean } = { development: false },
): Promise<void> {
  /*
   * **The version is read here rather than assumed**, because this is the one place that cannot be
   * wrong about it: `process.versions.electron` is the runtime executing this line, whatever a
   * consumer's install resolved. A switch is only asked for on a runtime it has been seen to work
   * on, and where one is declined the reason is printed rather than left to look like a driver
   * with no adapter.
   */
  const plan = planFlags(manifest, target, electronMajor(process.versions.electron));
  if (plan.refusal !== null) throw new Error(plan.refusal);
  for (const note of plan.notes) console.log(`[drift-package] ${note}`);
  for (const [name, value] of plan.switches) {
    if (value === '') app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }

  /*
   * **One instance, because the store is a snapshot.** The renderer reads preferences from a copy
   * taken before the window opened, so two windows would each hold a copy and the last one to
   * write would win silently. A second launch raises the first window instead.
   */
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  /*
   * Privileged before `ready`, or the scheme is not a secure context: no modules, no workers,
   * and `crossOriginIsolated` false. Registering it late throws rather than degrading, which is
   * the behaviour to want.
   */
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'drift',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);

  await app.whenReady();

  /*
   * **The default menu bar goes before the first window exists.** Electron installs File, Edit,
   * View, Window and Help — with Reload and Toggle Developer Tools in it — and a game that ships
   * with that menu is a game that announces what it was built in. macOS keeps a minimal one
   * because that is where Cmd+Q lives; see `menu.ts`.
   */
  const template = appMenuTemplate(manifest.name, process.platform);
  Menu.setApplicationMenu(template === null ? null : Menu.buildFromTemplate(template));

  /*
   * **Two roots, chosen by host.** `drift://app/` is the game and `drift://shell/` is the
   * packager's own assets — the badge and the mark it draws. One handler with a table rather than
   * two schemes, so the traversal check that guards the game's root guards the shell's by
   * construction; an unknown host is refused rather than defaulted.
   */
  const roots: Readonly<Record<string, string>> = { app: root, shell: join(__dirname, 'shell') };

  protocol.handle('drift', (request) => {
    const url = new URL(request.url);
    const base = roots[url.host];
    if (base === undefined) return new Response('unknown host', { status: 404 });
    const resolved = resolveWithinRoot(base, decodeURIComponent(url.pathname));
    if (resolved === null) return new Response('forbidden', { status: 403 });
    /* Streamed rather than read whole: a `.drft` world is tens of megabytes and the loader
       consumes it progressively, which is the behaviour the streaming container exists for. */
    return new Response(Readable.toWeb(createReadStream(resolved)) as ReadableStream, {
      headers: { 'content-type': contentTypeFor(resolved), 'content-security-policy': CSP },
    });
  });

  /*
   * **Steam is opened before the window and before anything reads a save.** Whether the store
   * answered decides where preferences come from, and a game that read a local file first and
   * discovered a cloud second would show one set of settings and then replace them.
   */
  const steam = openSteam(manifest.steam.appId, __dirname);

  let window: BrowserWindow | null = null;
  const quit = installIpc(readStoreSnapshot(steam), () => window, steam);

  window = new BrowserWindow({
    width: manifest.window.width,
    height: manifest.window.height,
    resizable: manifest.window.resizable,
    fullscreen: manifest.window.mode === 'fullscreen',
    frame: manifest.window.mode !== 'borderless',
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /*
       * **Developer tools exist in a development run and do not exist in a shipped one.** Not
       * hidden behind a shortcut nobody documents: `devTools: false` means the inspector cannot
       * be opened at all, by a menu, an accelerator, or `webContents.openDevTools`. A player
       * who opens one is a player looking at the inside of a game that was not built to be
       * looked at, and a support request about it costs more than the feature is worth.
       */
      devTools: options.development,
    },
  });

  /*
   * **The badge holds the screen while the game builds its first frame.**
   *
   * Without it the sequence a player sees is: an icon bounces, a black window appears, and
   * several seconds later a game arrives in it — which is indistinguishable from a hang. With it
   * the window stays hidden until it has something to show.
   *
   * The decision itself is in `splashTiming.ts` and is pure, so the three rules that matter — has
   * it painted, has the minimum passed, has the cap been reached — are tested without a window.
   * Polled rather than driven by a timer per condition, because two independent deadlines and an
   * event racing each other is how a splash ends up either flickering or permanent.
   */
  const splash = manifest.splash.show ? createSplash() : null;
  if (splash === null) {
    /* Shown on first paint rather than immediately: a window that appears white and then fills is
       the single most common way a packaged web application looks unfinished. */
    window.once('ready-to-show', () => window?.show());
  } else {
    /* Monotonic. Every reading here is subtracted from another and compared against a minimum,
       and a wall clock that steps backwards holds the badge forever while one that steps forwards
       flashes it and shows a white window. */
    const startedAt = performance.now();
    let painted = false;
    let badgeShownAt: number | null = null;
    window.once('ready-to-show', () => {
      painted = true;
    });
    /*
     * **The badge's own arrival, which is a second unbounded wait and not the same event.** It has
     * a window to create, a protocol request to answer and an image to paint, and the minimum is
     * the time it is meant to be readable for — so it is counted from here.
     */
    splash.once('show', () => {
      badgeShownAt ??= performance.now();
    });
    /*
     * And a badge that cannot load is not worth holding a game for: counting its minimum from
     * process start is exactly what this did before, which is the right behaviour once there is
     * nothing to wait for.
     */
    splash.webContents.once('did-fail-load', () => {
      badgeShownAt ??= startedAt;
    });
    const poll = setInterval(() => {
      const now = performance.now();
      const sinceBadge = badgeShownAt === null ? null : now - badgeShownAt;
      if (splashDecision(now - startedAt, sinceBadge, manifest.splash.minMs, painted) === 'hold')
        return;
      clearInterval(poll);
      window?.show();
      if (!splash.isDestroyed()) splash.close();
    }, SPLASH_POLL_MS);
    /* A window that is closed before the swap leaves an interval and an always-on-top badge
       behind it, which outlives the application it was branding. */
    window.once('closed', () => {
      clearInterval(poll);
      if (!splash.isDestroyed()) splash.close();
    });
  }

  /*
   * **The renderer's warnings reach a terminal, because a packaged game has no developer tools.**
   * A player cannot open a console and a bug report cannot quote one, so the two levels worth
   * reading are forwarded to the process's own output where a launcher, a log file or a support
   * request can carry them. Info and debug are not: a game that logs per frame would make its own
   * log useless.
   */
  /*
   * **A link to the outside opens in the person's own browser, and never in a window of this
   * application.** Both routes have to be closed or the other one is the hole: `window.open` and
   * `target="_blank"` come through the open handler, and an ordinary click on an absolute link
   * comes through `will-navigate`. What is refused rather than opened is in `links.ts`.
   */
  const openOutside = (url: string, route: 'window.open' | 'navigation'): void => {
    const target = externalTarget(url);
    /* Named, with the route it took, in a development run: a game that opens a browser on its own
       at startup is doing something its author will want to see rather than guess at, and which
       of the two routes it took is most of the answer. */
    if (options.development) {
      console.log(`[drift-package] opening externally via ${route}: ${url}`);
    }
    if (target !== null) void shell.openExternal(target);
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url, 'window.open');
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    /* The game navigating within itself is ordinary — a single-page game never does, and one
       that does must not be interrupted. Anything leaving `drift://` is a link to the outside. */
    if (url.startsWith('drift://')) return;
    event.preventDefault();
    openOutside(url, 'navigation');
  });

  /*
   * **The renderer's own output reaches a terminal, and how much of it depends on the build.**
   *
   * A player cannot open developer tools in a shipped artifact — see `devTools` above — so an
   * error that has nowhere to go is an error nobody can quote in a bug report. Errors are
   * forwarded in both kinds of build for exactly that reason. Warnings are development only:
   * they are where a framework's advice and a game's own diagnostics live, and a shipped game
   * printing them to a terminal nobody is watching is noise that hides the line that matters.
   */
  /*
   * **Both argument shapes, because the event changed and the failure of reading the wrong one is
   * silence.** Electron 35 moved the details into the first argument and made the level a string;
   * before that the first argument was the bare event and the details came second, with a numeric
   * level. Reading only the newer shape on an older runtime compares `undefined` against `'error'`
   * for every message, forwards nothing, and looks exactly like a renderer that never logged —
   * which is how this was found, and why the reading is a pure module with tests rather than a
   * predicate written inline against one version's typings.
   */
  window.webContents.on(
    'console-message',
    (first: unknown, second: unknown, third: unknown): void => {
      const line = consoleLine(first, second, third);
      if (line === null || !forwardsConsole(line.level, options.development)) return;
      console.log(`[renderer:${line.level}] ${line.message}`);
    },
  );

  /*
   * **The browser's own key bindings, gone from a shipped build.** Chromium answers Ctrl+R, F5,
   * Ctrl+P, Ctrl+F, the zoom keys and the inspector combinations itself, with no menu item left
   * to remove them — so a player leaning on Ctrl+R loses the run they were in. What is blocked
   * and what is left alone is in `shortcuts.ts`, with a test per rule.
   *
   * In a development run nothing is blocked and F12 opens the inspector, which is most of what a
   * development run is for.
   */
  window.webContents.on('before-input-event', (event, input) => {
    if (isBlockedShortcut(input, process.platform, options.development)) {
      event.preventDefault();
      return;
    }
    if (options.development && input.type === 'keyDown' && input.key === 'F12') {
      window?.webContents.toggleDevTools();
    }
  });

  /*
   * Pinch-zoom and Ctrl+wheel are the other two ways a page gets scaled, and neither goes through
   * the keyboard. A game draws its own interface at its own scale; a scaled one is half off the
   * screen with no way back, because the gesture that undoes it is a browser gesture.
   */
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  window.webContents.setZoomFactor(1);

  window.on('focus', () => window?.webContents.send('drift:focus', true));
  window.on('blur', () => window?.webContents.send('drift:focus', false));

  window.on('close', (event) => {
    const target = window;
    if (target === null || quit.mayClose() || !quit.wantsNotice()) return;
    /* Only a game that registered `onQuitRequest` is waited for. See `installIpc` for why the
       interest flag exists rather than a grace period on every close. */
    event.preventDefault();
    quit.deferClose(target);
  });

  window.on('closed', () => {
    window = null;
  });

  /* The manifest's own entry, not a hardcoded `index.html`: a project that builds to
     `dist/game.html` is an ordinary project, and a shell that silently looked for the wrong file
     would fail with a 404 in a window nobody can open developer tools on. */
  await window.loadURL(`drift://app/${basename(manifest.entry)}`);
}
