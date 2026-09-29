/**
 * The lanterns' glass: which material is glass, and what kind.
 *
 * **The file cannot say it.** Intel's lantern panes arrive as `lamp_glass_01`, an opaque grey with no
 * map, so every lantern in the courtyard hung a flat grey box round its flame, and as a caster that
 * box held the flame's light in: measured on the first-floor lantern at 22:06, the vault either side
 * brightened from 37.7 to 50.5 with the panes taken out of the shadow pass. Iron hanging lanterns of
 * this kind were glazed with frosted, etched or seeded panes, which spread the flame into a soft glow
 * rather than showing it, so the panes are declared frosted glass with the warm cast old glass has.
 *
 * What it gives up is a clear pane's view of the flame itself; what would change it is a lantern
 * whose maker shows the wick through the glass. **The black `glass` material is not declared**: it
 * is the gallery windows, and nothing is modelled behind them, so a window that let the eye through
 * would show the void past the wall.
 */
import type { DrftMaterial } from '@driftengine/drft';

const LANTERN_GLASS = /^lamp_glass/;
const FROSTED = { transmission: 0.85, frost: 0.55, tint: [1, 0.93, 0.82] } as const;

export function lanternGlass(material: DrftMaterial | undefined): typeof FROSTED | undefined {
  return LANTERN_GLASS.test(material?.name ?? '') ? FROSTED : undefined;
}
