import { describe, expect, it } from 'vitest';

import { appMenuTemplate } from './menu.ts';

describe('appMenuTemplate', () => {
  /*
   * A game with a File / Edit / View menu bar is a game that looks like a web page in a frame.
   * Nothing in the default menu is anything a player needs, and two of its items reload the
   * game or open developer tools.
   */
  it('has no menu at all on Windows and Linux', () => {
    expect(appMenuTemplate('Title', 'win32')).toBeNull();
    expect(appMenuTemplate('Title', 'linux')).toBeNull();
  });

  /*
   * macOS is the exception and it is not cosmetic: the application menu is where Cmd+Q lives.
   * Removing it entirely leaves a game a person cannot quit with the shortcut every other
   * application on the machine answers to.
   */
  it('keeps a minimal application menu on macOS, named after the game', () => {
    const template = appMenuTemplate('Title', 'darwin');
    expect(template).not.toBeNull();
    const first = template?.[0];
    expect(first?.label).toBe('Title');
    const submenu = Array.isArray(first?.submenu) ? first.submenu : [];
    const roles = submenu.map((item) => item.role);
    expect(roles).toContain('quit');
    expect(roles).toContain('hide');
  });

  /* Copy and paste have to work in a text field, and on macOS they are menu roles or nothing. */
  it('keeps edit roles on macOS, because a text field needs them', () => {
    const labels = (appMenuTemplate('Title', 'darwin') ?? []).map((item) => item.label);
    expect(labels).toContain('Edit');
  });
});
