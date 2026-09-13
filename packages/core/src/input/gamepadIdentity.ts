import { type GamepadButton } from './gamepadMapping.ts';

/**
 * What the pad in the player's hands calls a position, so a consumer can draw the right prompt.
 *
 * **The engine ships no art and never will.** A glyph key is an identifier a consumer maps to its
 * own icon set or font. It exists so that several consumers do not each write the same table, and
 * so the mapping from *hardware* to *name* lives beside the hardware knowledge rather than inside
 * somebody's heads-up display.
 *
 * **Four families, and no device database.** A table of individual controllers is a maintenance
 * obligation that grows with the hardware market and rots silently — and a rotted entry shows a
 * wrong glyph to a player while no test can see it. Four families cover the pads a browser will
 * vouch for; everything else is `generic` and correct rather than guessed.
 *
 * **What would make this wrong:** a family whose members disagree about their own lettering, which
 * would make the family the wrong unit to key on. None of these four do.
 */

export type GamepadFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic';

/** Vendor identifiers, which are the same four hex digits in every browser that reports them. */
const VENDORS: Readonly<Record<string, GamepadFamily>> = {
  '045e': 'xbox',
  '054c': 'playstation',
  '057e': 'nintendo',
};

/** For a pad that names itself but carries no vendor pair, which is most of what XInput reports. */
const NAMED: readonly (readonly [string, GamepadFamily])[] = [
  ['xbox', 'xbox'],
  ['xinput', 'xbox'],
  ['dualsense', 'playstation'],
  ['dualshock', 'playstation'],
  ['playstation', 'playstation'],
  ['nintendo', 'nintendo'],
  ['switch pro', 'nintendo'],
];

/**
 * Read the family out of the `id` string, in either shape a browser writes it.
 *
 * Chromium writes `Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)`; Firefox
 * writes `054c-09cc-Wireless Controller`. Both are matched, because a parser that knew only one
 * would answer `generic` for every pad in the other browser — which is a wrong prompt on screen
 * with nothing anywhere reporting it, the failure this repository's rules about silent plausible
 * answers exist for.
 */
export function identifyGamepad(id: string): GamepadFamily {
  const lower = id.toLowerCase();
  const vendor = /(?:^|vendor:\s*)([0-9a-f]{4})\b/.exec(lower);
  const known = vendor === null ? undefined : VENDORS[vendor[1] ?? ''];
  if (known !== undefined) return known;
  for (const [needle, family] of NAMED) if (lower.includes(needle)) return family;
  return 'generic';
}

/**
 * The vendor's own token for a position, which is also the tail of its glyph key.
 *
 * Only the positions vendors actually name differently are listed. A shoulder is `L1` on every pad
 * that has one printed, so it falls through to the positional label rather than being repeated
 * three times.
 */
const TOKENS: Readonly<Record<GamepadFamily, Partial<Record<GamepadButton, string>>>> = {
  xbox: {
    faceDown: 'a',
    faceRight: 'b',
    faceLeft: 'x',
    faceUp: 'y',
    select: 'view',
    start: 'menu',
  },
  playstation: {
    faceDown: 'cross',
    faceRight: 'circle',
    faceLeft: 'square',
    faceUp: 'triangle',
    select: 'create',
    start: 'options',
    l1: 'l1',
    r1: 'r1',
    l2: 'l2',
    r2: 'r2',
  },
  /* The swap: Nintendo's bottom button is B and its right button is A, the other way round from
     every other pad here. This is the entire reason the engine names positions. */
  nintendo: {
    faceDown: 'b',
    faceRight: 'a',
    faceLeft: 'y',
    faceUp: 'x',
    select: 'minus',
    start: 'plus',
  },
  generic: {},
};

/** `faceDown` to `Face Down`, `l1` to `L1` — true of any pad, and readable rather than cryptic. */
function positionalLabel(button: GamepadButton): string {
  if (/^[lr][123]$/.test(button)) return button.toUpperCase();
  const spaced = button.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A vendor token to the label a player reads on the plastic: `cross` to `Cross`, `a` to `A`. */
function titled(token: string): string {
  return token.length <= 2 ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * What this pad calls that position.
 *
 * A generic pad answers its position — `Face Down` is a poor prompt and it is not a *wrong* one,
 * which is the trade this design takes over inventing a lettering for hardware it cannot identify.
 */
export function labelFor(family: GamepadFamily, button: GamepadButton): string {
  const token = TOKENS[family][button];
  return token === undefined ? positionalLabel(button) : titled(token);
}

/**
 * A stable key for a consumer's own icon set: `xbox.a`, `playstation.cross`, `nintendo.b`.
 *
 * Stable is the load-bearing word. A consumer builds a lookup from these to its own art, so
 * changing one silently breaks an icon in somebody else's repository — they are an interface, not
 * a formatting choice.
 */
export function glyphFor(family: GamepadFamily, button: GamepadButton): string {
  return `${family}.${TOKENS[family][button] ?? button}`;
}
