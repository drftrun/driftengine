/**
 * Where the hotbar's slots are, in CSS pixels.
 *
 * **One statement of the layout, because two things draw it.** `hud.ts` fills the bar's backing
 * panel and the ring around the selected slot; `hotbarIcons.ts` draws the tiles themselves as
 * quads in front of the camera, since nothing on the public surface puts a texture into a screen
 * rectangle — see `GAPS.md`. Those are two coordinate systems, and while each computed its own
 * geometry they agreed only by accident: the tiles sat in a row above the bar rather than in it.
 *
 * So the rectangles are stated once here and both consumers are held to them. A tile lands inside
 * its slot at any viewport size because the two are reading the same numbers.
 */
import { HOTBAR } from './blocks';

export interface HotbarLayout {
  /** The HUD's own scale unit, from the smaller viewport dimension. */
  readonly cell: number;
  /** A slot's side, in CSS pixels. */
  readonly slot: number;
  /** The space between slots, and the width of the ring drawn around the selected one. */
  readonly gap: number;
  /** The bar's total width, edge to edge, without the outer ring. */
  readonly total: number;
  readonly left: number;
  readonly top: number;
}

/** The bar's geometry for a viewport, in CSS pixels. */
export function hotbarLayout(width: number, height: number): HotbarLayout {
  const cell = Math.max(2, Math.round(Math.min(width, height) / 260));
  const slot = cell * 14;
  const gap = cell * 2;
  const total = HOTBAR.length * slot + (HOTBAR.length - 1) * gap;
  return {
    cell,
    slot,
    gap,
    total,
    left: Math.round((width - total) / 2),
    top: height - slot - cell * 6,
  };
}

/** The left edge of slot `index`, in CSS pixels. */
export function slotLeft(layout: HotbarLayout, index: number): number {
  return layout.left + index * (layout.slot + layout.gap);
}
