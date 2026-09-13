import { BrowserWindow } from 'electron';

/**
 * The window the engine badge is drawn in.
 *
 * Frameless and fixed, because a splash somebody can resize is a splash somebody has to think
 * about. Opaque rather than transparent: transparency on Linux depends on a compositor that may
 * not be there, and the failure is a black rectangle with the logo cut out of it — worse than
 * having no rounded corners.
 *
 * **Shown on its own first paint, not on creation.** The same rule the main window follows, for
 * the same reason: a window that appears empty and then fills is the thing this page exists to
 * prevent, and a splash that does it is an unusually poor joke.
 */
export function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    /* Above the game's own window, which is hidden until the swap, and above whatever else is
       on screen for the second or two it lives. A splash that can be buried looks like a hang. */
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      /* It runs no script and reaches nothing. There is no bridge here on purpose: the badge has
         no business holding a handle to the filesystem. */
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.once('ready-to-show', () => splash.show());
  void splash.loadURL('drift://shell/splash.html');
  return splash;
}
