/**
 * The browser's own key bindings, taken away from a shipped game.
 *
 * **Chromium answers these itself and there is no menu item to remove.** With the menu bar gone a
 * player still has Ctrl+R and F5 reloading the game mid-run, Ctrl+P offering to print it, Ctrl+F
 * opening a find bar over it, Ctrl+minus shrinking the whole interface, and Ctrl+Shift+I opening
 * an inspector on it. None of those belong to a game, and every one of them is somebody's bug
 * report about a run they lost.
 *
 * **In a development run nothing is blocked**, because those are exactly the tools a developer
 * wants. The build kind is decided by `build.json`, written by the packager — never by an
 * environment variable a player could set.
 *
 * **Quit is left alone on macOS**, and so is Cmd+W: they are what every application on that
 * platform answers to, and a game that swallowed them would be the one a person cannot get out
 * of. Ctrl+W elsewhere is a browser habit rather than a platform one, and goes.
 *
 * Pure, and every rule above is a test.
 */
export interface KeyPress {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Reload, print, view source, find, and the two zoom directions plus reset. */
const WITH_MODIFIER = new Set(['r', 'p', 'u', 'f', 'g', '+', '-', '=', '0']);
/** The inspector, on the two combinations every platform binds it to. */
const INSPECTOR = new Set(['i', 'j', 'c']);

export function isBlockedShortcut(
  input: KeyPress,
  platform: NodeJS.Platform,
  development: boolean,
): boolean {
  if (development) return false;
  if (input.type !== 'keyDown') return false;

  const key = input.key.toLowerCase();
  if (key === 'f5' || key === 'f12') return true;

  const command = input.control || input.meta;
  if (!command) return false;

  if (input.shift && INSPECTOR.has(key)) return true;
  if (input.meta && input.alt && INSPECTOR.has(key)) return true;
  if (WITH_MODIFIER.has(key)) return true;
  /* Closing: a platform gesture on macOS, a browser one everywhere else. */
  if (key === 'w' && input.control && platform !== 'darwin') return true;

  return false;
}
