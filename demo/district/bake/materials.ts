/**
 * The district's materials: every source material once, with its pictures written at the size its
 * share of the city earns, and its kind of light decided.
 *
 * **One table for the city**, by the source material's datablock: a prototype placed a thousand
 * times and a merged region both name a row of it, so a picture is written once however many
 * meshes wear it. The rows go into the container as `MATL` and into the scene file with what
 * `MATL` has no field for — how strongly a surface glows past one, and what kind of light it is.
 *
 * **Two passes.** `of` registers a row and says nothing about pictures; `write` sizes every picture
 * by how much of the city wears it, then writes them. A picture's size is a budget question that
 * can only be answered for all of them at once: the four facade pictures the generated towers are
 * all built from cover more of the city than a thousand props together, and earn the most texels.
 *
 * **The kind is read from the name the artist gave the material**, because the source says nothing
 * else about it: a facade's lit windows, an advertising screen, a neon tube, a lamp's lens, glass.
 * Each kind glows at night by its own rule at run time. What would make it wrong is a material named
 * for one kind and made as another; the plain kind, which glows as its file says, is the fallback.
 *
 * **A glow that is its own colour map is not a glow.** Ninety-five of the source's materials feed
 * their colour picture to their emission too, which an exporter does to make a model look lit
 * anywhere; by night it makes a shopfront a lamp of its own colour, white where it is pale, and the
 * bloom then haloes the whole of it. Such a surface keeps no glow here and is lit by the lights in
 * front of it, unless it is a sign or a screen, which is made of light.
 */
import type { BlendStruct, BlendSurface } from '@driftengine/assets';
import { readBlendSurface } from '@driftengine/assets';
import type { DrftMaterial } from '@driftengine/drft';

import type { KitPart } from './kit.ts';
import type { Pictures } from './textures.ts';

export type GlowKind = 'plain' | 'window' | 'screen' | 'neon' | 'lamp' | 'glass';

export interface DistrictMaterial {
  readonly id: number;
  readonly name: string;
  drft: DrftMaterial;
  /** How strongly it glows, where its file says past one: the scene's own emission strength. */
  readonly glow: number;
  readonly kind: GlowKind;
}

const DEFAULT_ROUGHNESS = 0.4277;

/** Colour-map sizes by rank of the city's surface they cover: the first `count` get `size`. */
const TIERS: readonly { count: number; size: number }[] = [
  { count: 12, size: 2048 },
  { count: 60, size: 1024 },
  { count: 300, size: 512 },
  { count: Infinity, size: 256 },
];

/**
 * A lamp's or a lantern's panes, which the source makes opaque: clear glass with a little diffusion
 * and a faint warm cast. The Sponza courtyard's old lanterns are frosted; frosted here, a lit street
 * lamp glowed through its panes as a solid white box, and a street lamp's panes are clear. The file cannot say it — every such pane is a
 * Principled surface with no transmission — so the name does. Window glass is not declared: nothing
 * is modelled behind most of the city's windows, and a pane the eye passed through would show it.
 */
const LAMP_GLASS = /(lamp|lantern).*glass|glass.*(lamp|lantern)/i;

/**
 * The glowing core the source sets inside a lantern's head: a solid of its own, white and lit, the
 * shape of the panes. Opaque it was the whole head by day, a white block where a lantern is glass,
 * so it is drawn as frosted glass that still glows — a lit lantern at night, a pale one by day.
 */
const LAMP_CORE = /(^|_)lamp_light/i;
/* Frosted less than a pane would be: frost is what adds the glow of the lamp inside, a hand's breadth away. */
const CORE = { transmission: 0.8, frost: 0.15, tint: [1, 0.97, 0.92] as [number, number, number] };

/** Whether a material is a lamp's or a lantern's panes. */
export const isLampGlass = (name: string): boolean => LAMP_GLASS.test(name);
const LAMP_PANE = {
  transmission: 0.92,
  frost: 0.12,
  tint: [1, 0.96, 0.9] as [number, number, number],
};

/** What a material's name says it is. */
export function kindOf(name: string, transmission: number): GlowKind {
  const n = name.toLowerCase();
  if (transmission > 0.2 || /glass|window_pane|pane\b/.test(n)) return 'glass';
  if (/screen|banner|holo|billboard|ad_|advert|\btv\b|display|monitor/.test(n)) return 'screen';
  if (/neon|sign|strip|beacon|tube|led/.test(n)) return 'neon';
  if (/lamp|bulb|lantern|light|fluoresc|chandelier/.test(n)) return 'lamp';
  if (/facade|fac_|window|win_|building|tower|apartment|tenement|flat|resi_|shoph_|rooms/.test(n))
    return 'window';
  return 'plain';
}

interface Pending {
  readonly part: KitPart;
  readonly source: BlendStruct | null;
  readonly surface: BlendSurface | null;
  /** Square metres of the city wearing this row, filled as placements are counted. */
  area: number;
}

export class Materials {
  readonly rows: DistrictMaterial[] = [];
  /** Each row's Blender material, for what samples its pictures: the coarse levels' colours. */
  readonly sources: (BlendStruct | null)[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly pending: (Pending | null)[] = [];

  constructor(
    private readonly pictures: Pictures,
    private readonly version: number,
  ) {}

  /** The surface a row reads, for a light's colour. */
  surfaceOf(row: number): BlendSurface | null {
    return this.pending[row]?.surface ?? null;
  }

  /**
   * The row the coarse levels wear: no pictures, the colour and glow in the vertices, matte. Its
   * kind is a window's, so a far district's glow comes on with the night as its windows do.
   */
  coarse(): number {
    const id = this.rows.length;
    this.rows.push({
      id,
      name: 'coarse',
      glow: 1,
      kind: 'window',
      drft: {
        name: 'coarse',
        color: [1, 1, 1],
        specular: 0,
        roughness: 0.85,
        emissive: 0,
        emissiveColor: [-1, -1, -1],
        opacity: 1,
        albedo: -1,
        normalMap: -1,
        ormMap: -1,
        emissiveMap: -1,
        roughnessScale: 1,
        metallicScale: 1,
        occlusionStrength: 0,
        reflectivity: 0,
        cutout: 0,
      },
    });
    this.sources.push(null);
    this.pending.push(null);
    return id;
  }

  /**
   * The row a part wears: its own material, or the one a copy's slot puts on it in its place, which
   * shares the part's lanes by the scene's key. Its pictures wait for `write`.
   */
  of(part: KitPart, wearing: BlendStruct | null = part.source): number {
    const key = wearing === null ? `name:${part.material.name}` : `ma:${wearing.offset}`;
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const id = this.rows.length;
    const surface = wearing === null ? null : readBlendSurface(wearing, this.version);
    const name = wearing === null ? part.material.name : wearing.idName();
    const glow = surface === null ? 0 : Math.max(...surface.emission) * surface.emissionStrength;
    this.rows.push({
      id,
      name,
      drft: { ...part.material, name },
      glow,
      kind: kindOf(name, surface?.transmission ?? 0),
    });
    this.sources.push(wearing);
    this.pending.push({ part, source: wearing, surface, area: 0 });
    this.byKey.set(key, id);
    return id;
  }

  /** Count `area` square metres of the city as wearing `row`. */
  wear(row: number, area: number): void {
    const pending = this.pending[row];
    if (pending !== null && pending !== undefined) pending.area += area;
  }

  /** Size every picture by what it covers, write them, and finish every row. */
  async write(log: (line: string) => void): Promise<void> {
    const coverage = new Map<number, number>();
    for (const p of this.pending) {
      if (p === null || p.surface === null) continue;
      for (const map of [p.surface.baseColorMap, p.surface.emissionMap]) {
        if (map !== null)
          coverage.set(map.image.offset, (coverage.get(map.image.offset) ?? 0) + p.area);
      }
    }
    const ranked = [...coverage].sort((a, b) => b[1] - a[1]);
    const sizeOf = new Map<number, number>();
    let rank = 0;
    for (const tier of TIERS) {
      for (let i = 0; i < tier.count && rank < ranked.length; i++, rank++)
        sizeOf.set((ranked[rank] as [number, number])[0], tier.size);
    }
    const colour = (image: BlendStruct): number => sizeOf.get(image.offset) ?? 256;
    /* Normal and surface maps are read through lighting, which forgives: one size down. */
    const surfaceSize = (p: Pending): number => {
      const map = p.surface?.baseColorMap ?? null;
      return Math.max(256, Math.min(1024, (map === null ? 512 : colour(map.image)) / 2));
    };
    let left = ranked.length;
    const spread = TIERS.map((t) => {
      const n = Math.min(t.count, left);
      left -= n;
      return `${n} at ${t.size}`;
    });
    log(
      `pictures: ${ranked.length} colour and glow images ranked by coverage, ${spread.join(', ')}`,
    );
    for (let row = 0; row < this.rows.length; row++) {
      const p = this.pending[row];
      if (p === null || p === undefined) continue;
      (this.rows[row] as DistrictMaterial).drft = await this.build(p, surfaceSize(p), colour);
    }
  }

  private async build(
    p: Pending,
    surfaceSize: number,
    colour: (image: BlendStruct) => number,
  ): Promise<DrftMaterial> {
    const named = p.source?.idName() ?? p.part.material.name;
    const declared =
      (p.part.material.transmission ?? 0) > 0
        ? {}
        : LAMP_GLASS.test(named)
          ? { ...LAMP_PANE, opacity: 1, blend: false }
          : LAMP_CORE.test(named)
            ? { ...CORE, opacity: 1, blend: false }
            : {};
    const base = { ...p.part.material, name: named, ...declared };
    const surface = p.surface;
    if (surface === null)
      return { ...base, albedo: -1, normalMap: -1, ormMap: -1, emissiveMap: -1 };
    const pictures = this.pictures;
    /* The colour map keeps its alpha where the material reads it: cut out or blended. */
    const shaped = surface.alphaMode !== 'OPAQUE' && surface.alphaMap !== null;
    const sameImage = surface.alphaMap?.image.offset === surface.baseColorMap?.image.offset;
    const albedo =
      surface.baseColorMap === null
        ? -1
        : shaped && !sameImage && surface.alphaMap !== null
          ? await pictures.withAlpha(
              surface.baseColorMap.image,
              surface.alphaMap,
              colour(surface.baseColorMap.image),
            )
          : await pictures.plain(
              surface.baseColorMap.image,
              colour(surface.baseColorMap.image),
              shaped,
            );
    const normal =
      surface.normalMap === null
        ? -1
        : await pictures.plain(surface.normalMap.image, surfaceSize, false);
    /* A glow map only where something glows: a strength of nought draws nothing. */
    const kind = kindOf(base.name, surface.transmission);
    const selfLit =
      surface.emissionMap !== null &&
      surface.emissionMap.image.offset === surface.baseColorMap?.image.offset &&
      kind !== 'neon' &&
      kind !== 'screen';
    const glows = surface.emissionStrength > 0 && Math.max(...surface.emission) > 0 && !selfLit;
    const emissive =
      surface.emissionMap === null || !glows
        ? -1
        : await pictures.plain(surface.emissionMap.image, colour(surface.emissionMap.image), false);
    const dark: Partial<DrftMaterial> = glows ? {} : { emissive: 0, emissiveColor: [-1, -1, -1] };
    const orm = await pictures.packed(
      surface.occlusionMap,
      surface.roughnessMap,
      surface.roughness,
      surface.metallicMap,
      surface.metallic,
      surfaceSize,
    );
    /* The surface's alpha as the bake reads it, which can differ from glTF's: see `alphaOf`. */
    const shape: Partial<DrftMaterial> =
      surface.alphaMode === 'MASK'
        ? { cutout: surface.alphaCutoff, blend: false, opacity: 1 }
        : surface.alphaMode === 'OPAQUE'
          ? { cutout: 0, blend: false, opacity: 1 }
          : {};
    if (orm < 0)
      return {
        ...base,
        ...shape,
        ...dark,
        albedo,
        normalMap: normal,
        ormMap: -1,
        emissiveMap: emissive,
      };
    return {
      ...base,
      ...shape,
      ...dark,
      albedo,
      normalMap: normal,
      ormMap: orm,
      emissiveMap: emissive,
      /* The factors are drawn into the packed map, so its scales are one. */
      roughnessScale: 1,
      metallicScale: 1,
      occlusionStrength: surface.occlusionMap === null ? 0 : 1,
      roughness: DEFAULT_ROUGHNESS,
      specular: 0,
      reflectivity: 0,
    };
  }
}
