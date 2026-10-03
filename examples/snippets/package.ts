/**
 * A game's side of packaging: one host for every platform, leaving a game on each, a store's
 * features where there is one, and the entry the native host starts a game through.
 *
 * A snippet, typechecked with the examples and quoted by the manual's packaging chapter.
 */
import { createHost } from '@driftengine/package';

// #region host
/**
 * Every capability, picked for wherever the build is running: the browser's in a tab, the shell's
 * in a desktop or mobile build. A game writes one settings screen against it and ships it to all.
 */
export async function settings(canvas: HTMLCanvasElement) {
  const host = createHost(canvas);
  await host.display.setMode('fullscreen');
  if (host.display.canSetSize()) await host.display.setSize(1920, 1080);
  /* A file beside the application in a shell, localStorage in a tab, Steam Cloud where the
     manifest names an app. The game writes the same line in all three. */
  host.store.write('settings.volume', '0.8');
  return host;
}
// #endregion

// #region leave
/** An exit button only where one does something, and a chance to keep the player first. */
export function leaving(canvas: HTMLCanvasElement, menu: { addExit(leave: () => void): void }) {
  const host = createHost(canvas);
  if (host.lifecycle.canQuit) menu.addExit(() => host.lifecycle.requestQuit());
  host.lifecycle.onQuitRequest(() => {
    /* A window's close button, or Android's back gesture: pause, ask, then go. */
    if (confirm('Leave the run?')) host.lifecycle.requestQuit();
  });
}
// #endregion

// #region store
/** Achievements, where a store build was launched by its store; null everywhere else. */
export function finishedTheGame(canvas: HTMLCanvasElement): void {
  const host = createHost(canvas);
  host.services?.unlockAchievement('FINISHED');
  host.services?.setRichPresence('Watching the credits');
}
// #endregion

// #region native
/**
 * The native host has no page to find a canvas in, so the manifest's `native.entry` names a module
 * that exports `mount`, and the host calls it with the canvas it made. A game that already mounts
 * onto a canvas it is given needs nothing more than this.
 */
export function mount(canvas: HTMLCanvasElement): void {
  void settings(canvas);
}
// #endregion
