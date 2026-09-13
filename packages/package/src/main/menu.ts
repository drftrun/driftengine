import type { MenuItemConstructorOptions } from 'electron';

/**
 * The menu a shipped game has, which on two of three platforms is none.
 *
 * Electron installs a default menu bar with File, Edit, View, Window and Help. Nothing in it
 * belongs to a game — two of its items reload the page and open developer tools — and its presence
 * is the single clearest sign that what you are looking at is a web page in a frame.
 *
 * **macOS is the exception, and not for appearance.** The application menu is where `Cmd+Q`,
 * `Cmd+H` and the services menu live; an application with no menu on that platform is one a person
 * cannot quit with the shortcut every other application answers to. So it keeps the smallest menu
 * that behaves like a Mac application: the app menu, Edit — where copy and paste are roles rather
 * than key handlers a game would have to write — and Window.
 *
 * Pure, so the shape is testable without a running Electron.
 */
export function appMenuTemplate(
  productName: string,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return [
    {
      label: productName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ];
}
