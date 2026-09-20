/**
 * A window's title as this SDL can show it.
 *
 * **Under X11 the title SDL writes is in the process's locale, and Node leaves that at C.** SDL
 * 2.32's X11 driver sets `WM_NAME` through `XmbTextListToTextProperty`, so a UTF-8 title's bytes
 * go in as Latin-1, and the `_NET_WM_NAME` it should add in UTF-8 — the one a window manager prefers —
 * is not on the window at all. Read back with `xprop` on 2026-09-19: `WM_NAME(STRING) = "Showroom
 * â\302\200\302\224 DriftEngine"` and no `_NET_WM_NAME`, which the desktop drew as `Showroom â€”
 * DriftEngine`; reported by the maintainer. So under X11 a title is made ASCII before SDL sees it:
 * accents dropped, dashes and quotes in their ASCII forms, and anything else one `?` rather than
 * three characters of noise.
 *
 * What would make it wrong: an SDL that sets `_NET_WM_NAME`, which `xprop -id <window>
 * _NET_WM_NAME` shows, and this then drops letters for nothing. Wayland's title is UTF-8 and is
 * left alone.
 */

const PLAIN = new Map([
  ['–', '-'],
  ['—', '-'],
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['…', '...'],
]);

/** `title` as `driver` can show it: unchanged, or in ASCII under X11. */
export function windowTitle(title: string, driver: string): string {
  if (driver !== 'x11') return title;
  return [...title.normalize('NFKD').replace(/\p{M}/gu, '')]
    .map((character) =>
      character.charCodeAt(0) < 0x80 ? character : (PLAIN.get(character) ?? '?'),
    )
    .join('');
}
