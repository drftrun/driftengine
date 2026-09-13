/**
 * A loaded asset's textures, addressed by name. One responsibility: which image is which.
 *
 * **A caller must never hold a texture index.** An index is a position in whatever order a
 * reader met its records, which is an accident of parsing rather than anything the asset
 * promised, and code holding one is coupled to a decision nobody meant to publish. Reorder
 * the source, re-export it, or regroup the meshes for drawing, and the index still resolves
 * — to the wrong surface, with no error anywhere. That is the failure this exists to remove.
 *
 * So a consumer says `set('Tire_05_DM.jpg', bitmap)` and an unknown name **throws at the
 * call**, naming what it has. Failing loudly at the moment of the mistake is the whole
 * difference from an index, which fails silently at some later frame.
 *
 * Names come from `TEXS`, which stores what the source called each image. Matching is on the
 * basename as well as the full declared path, because a material may name
 * `textures\Tire_05_DM.jpg` while a person reasonably says `Tire_05_DM.jpg`, and requiring
 * the exact original spelling would put the ordinal problem back with extra steps.
 */

import type { DrftTexture } from '@driftengine/drft';
import { basenameOf } from './assetPath.ts';
import { DrftError } from '@driftengine/drft';

/**
 * Whatever a consumer creates from a decoded texture, kept as it was handed over.
 *
 * Generic because this module must not know what a GPU texture is: `src/asset/` describes
 * files and `src/render/` owns the context. A caller parameterises this with its own handle
 * and gets its own type back.
 */
/**
 * How each of an asset's images should be sampled, decided from what its materials call them.
 *
 * **A colour map and a data map need opposite treatment and the container does not say which is
 * which** — it says only that material *n* names image *k* as its albedo, or its ORM, or its
 * normal. So the roles are read off the materials, and an image nothing names falls to `linear`,
 * which is the harmless answer for an image nothing samples.
 *
 * `srgb` for a base colour and an emissive map: glTF specifies both as sRGB-encoded, and handing
 * those bytes to a shader undecoded treats display values as light — mid-tones arrive far brighter
 * than the author's, and it stays invisible until an output transform washes the surface out.
 *
 * `linear` for a normal or ORM map, whose numbers *are* the data. Decoding a direction or a
 * roughness as though it were a colour bends every one of them toward its floor.
 *
 * **A conflict resolves to `linear`.** An image named as a colour map by one material and as a
 * data map by another is a file nobody meant to write, and of the two ways to be wrong this is the
 * milder: an sRGB-decoded ORM map bends roughness and metallic toward zero and turns the surface
 * to polished chrome, where an undecoded colour map is merely pale.
 */
export function textureColorSpaces(
  materials: readonly {
    readonly albedo: number;
    readonly normalMap: number;
    readonly ormMap: number;
    readonly emissiveMap: number;
  }[],
  count: number,
): ('srgb' | 'linear')[] {
  const colour = new Set<number>();
  const data = new Set<number>();
  for (const material of materials) {
    if (material.albedo >= 0) colour.add(material.albedo);
    if (material.emissiveMap >= 0) colour.add(material.emissiveMap);
    if (material.normalMap >= 0) data.add(material.normalMap);
    if (material.ormMap >= 0) data.add(material.ormMap);
  }
  const out: ('srgb' | 'linear')[] = [];
  for (let at = 0; at < count; at++) {
    out.push(colour.has(at) && !data.has(at) ? 'srgb' : 'linear');
  }
  return out;
}

export class TextureSet<T> {
  private readonly byName = new Map<string, T>();
  /**
   * By the texture's index **in the file**, with a gap where one did not decode.
   *
   * Sparse on purpose. A material stores the index the file gave its map, so packing the
   * successes together would shift every texture after a failed one and repaint the model
   * with its neighbours' images. That is the ordinal hazard this class exists to remove,
   * reappearing inside the thing removing it, which is exactly where it would be missed.
   */
  private readonly byIndex: (T | null)[] = [];

  /**
   * Build the lookup as the textures are created, in file order.
   *
   * `create` returning null means that image could not be decoded, which is survivable: the
   * surface draws untextured and the slot stays addressable, so a later `replace` can still
   * put something there. Dropping the entry instead would renumber everything after it.
   */
  static from<T>(
    textures: readonly DrftTexture[],
    create: (texture: DrftTexture, at: number) => T | null,
  ): TextureSet<T> {
    const set = new TextureSet<T>();
    for (let at = 0; at < textures.length; at++) {
      const texture = textures[at];
      if (texture === undefined) continue;
      const made = create(texture, at);
      /* The slot is kept either way, so the indices materials carry stay true. */
      set.byIndex[at] = made;
      if (made === null) continue;
      /*
       * Both spellings, so a caller may use either. The full path wins a collision because
       * it is what the file actually said; a basename is a convenience over it.
       */
      const base = basenameOf(texture.name);
      if (base !== '' && !set.byName.has(base)) set.byName.set(base, made);
      if (texture.name !== '') set.byName.set(texture.name, made);
    }
    return set;
  }

  /** How many textures were created, which is not the number the file carried. */
  get size(): number {
    return this.byIndex.filter((t) => t !== null).length;
  }

  /** Every created texture, for disposal rather than for addressing. */
  all(): readonly T[] {
    return this.byIndex.filter((t): t is T => t !== null);
  }

  /** The texture a material named, by its index in the file, or null. */
  at(index: number): T | null {
    return index >= 0 ? (this.byIndex[index] ?? null) : null;
  }

  /** Whether a name resolves, for a caller that wants to ask rather than to handle a throw. */
  has(name: string): boolean {
    return this.byName.has(name) || this.byName.has(basenameOf(name));
  }

  /**
   * The texture called this, or a refusal naming every texture the asset does have.
   *
   * Throwing beats returning null. A caller asking by name has a specific image in mind, and
   * a null it forgets to check is the silent-wrong-surface failure that indices already had.
   */
  get(name: string): T {
    const found = this.byName.get(name) ?? this.byName.get(basenameOf(name));
    if (found === undefined) {
      const known = [...this.byName.keys()].join(', ');
      throw new DrftError(
        `no texture called "${name}" in this asset. It carries: ${known === '' ? 'none' : known}`,
      );
    }
    return found;
  }
}
