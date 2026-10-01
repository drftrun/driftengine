/**
 * The building styles: each row's numbers, the template it names, the palettes it may wear, its
 * tenants, and any cap on how often it may appear — read from the evaluated scripts.
 *
 * A style row is an entity with a `BuildingStyle`, a `(BuildsWith, Template)` pair, children based
 * on palette prefabs, and children carrying `VenueSlot`s; an optional `BuildingRarity` on the row
 * caps how many and how close. That is the scripts' own protocol, and nothing here names a style.
 */
import type { Value } from '../script/values.ts';
import { effective } from '../script/world.ts';
import type { ScriptWorld } from '../script/world.ts';
import { pairTargets, row, rows } from './rows.ts';
import type { Row } from './rows.ts';

export interface Palette {
  readonly name: string;
  readonly weight: number;
  readonly lit: number;
  readonly variant: number;
  /** The palette's colours as the scripts hold them, ready to hand a template. */
  readonly wall: Value;
  readonly trim: Value;
  readonly window: Value;
  readonly accent: Value;
}

export interface VenueSlot {
  readonly name: string;
  readonly kind: string;
  readonly group: number;
  readonly weight: number;
  readonly row: Row;
}

export interface BuildingStyle {
  readonly name: string;
  readonly template: string;
  readonly row: Row;
  readonly district: string;
  readonly weight: number;
  readonly polygon: boolean;
  readonly palettes: readonly Palette[];
  readonly venues: readonly VenueSlot[];
  readonly rarity: { readonly maxCount: number; readonly minSpacing: number } | null;
}

function palette(entity: Parameters<typeof row>[0]): Palette | null {
  const value = effective(entity, 'BuildingPalette');
  if (value?.k !== 'struct' || value.fields === null) return null;
  const r = row(entity, 'BuildingPalette');
  const colour = (key: string): Value => {
    const v = r.v(key);
    if (v === undefined) throw new Error(`palette ${entity.name} has no ${key}`);
    return v;
  };
  return {
    name: entity.bases[0]?.name ?? entity.name,
    weight: r.n('weight', 1),
    lit: r.n('lit', 1),
    variant: r.n('variant', 0),
    wall: colour('wall'),
    trim: colour('trim'),
    window: colour('window'),
    accent: colour('accent'),
  };
}

export function readBuildingStyles(world: ScriptWorld): BuildingStyle[] {
  return rows(world, 'BuildingStyle').map((r) => {
    const template = pairTargets(r.entity, 'BuildsWith')[0];
    if (template === undefined) throw new Error(`style ${r.entity.name} names no template`);
    const palettes: Palette[] = [];
    const venues: VenueSlot[] = [];
    for (const child of r.entity.children) {
      const p = palette(child);
      if (p !== null) palettes.push(p);
      if (child.components.has('VenueSlot')) {
        const v = row(child, 'VenueSlot');
        venues.push({
          name: child.name,
          kind: v.s('kind'),
          group: v.n('group', 0),
          weight: v.n('weight', 1),
          row: v,
        });
      }
    }
    if (palettes.length === 0) throw new Error(`style ${r.entity.name} lists no palette`);
    const rare = r.entity.components.has('BuildingRarity') ? row(r.entity, 'BuildingRarity') : null;
    return {
      name: r.entity.name,
      template,
      row: r,
      district: r.s('district'),
      weight: r.n('weight'),
      polygon: r.n('polygon', 0) !== 0,
      palettes,
      venues,
      rarity: rare ? { maxCount: rare.n('max_count'), minSpacing: rare.n('min_spacing') } : null,
    };
  });
}
