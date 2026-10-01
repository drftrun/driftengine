/**
 * What a coarse level's vertices are coloured with: each material's colour map and glow map read
 * at the vertex's UV, times the material's own factors, in linear light.
 *
 * **From a thumbnail of each picture**, 32 texels a side, averaged down from the source: a coarse
 * level is drawn from a block away or more, where a vertex stands for a cell half a metre to eight
 * metres across, and what it should carry is the colour of that much surface, which is what a
 * small mip is.
 */
import type { BlendStruct } from '@driftengine/assets';
import { readBlendSurface } from '@driftengine/assets';
import type { MeshData } from '@driftengine/drft';

import type { Pictures } from './textures.ts';
import { fit } from './textures.ts';

const THUMB = 32;

const linear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

interface Thumb {
  readonly rgb: Float32Array;
}

export class Sampler {
  private readonly thumbs = new Map<number, Thumb | null>();
  private readonly surfaces = new Map<number, ReturnType<typeof readBlendSurface>>();

  constructor(
    private readonly pictures: Pictures,
    private readonly version: number,
  ) {}

  private async thumb(image: BlendStruct | null): Promise<Thumb | null> {
    if (image === null) return null;
    if (this.thumbs.has(image.offset)) return this.thumbs.get(image.offset) ?? null;
    const rgba = await this.pictures.rgba(image);
    let out: Thumb | null = null;
    if (rgba !== null) {
      const small = fit(rgba, THUMB, THUMB);
      const rgb = new Float32Array(THUMB * THUMB * 3);
      for (let i = 0; i < THUMB * THUMB; i++)
        for (let k = 0; k < 3; k++) rgb[i * 3 + k] = linear(small.data[i * 4 + k] as number);
      out = { rgb };
    }
    this.thumbs.set(image.offset, out);
    return out;
  }

  /** The mean colour a material glows, linear: its emission times its glow map's mean. */
  async meanGlow(material: BlendStruct | null): Promise<[number, number, number]> {
    if (material === null) return [0, 0, 0];
    let surface = this.surfaces.get(material.offset) ?? null;
    if (surface === null) {
      surface = readBlendSurface(material, this.version);
      this.surfaces.set(material.offset, surface);
    }
    const thumb = await this.thumb(surface.emissionMap?.image ?? null);
    const mean = [1, 1, 1];
    if (thumb !== null) {
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let i = 0; i < THUMB * THUMB; i++) sum += thumb.rgb[i * 3 + k] as number;
        mean[k] = sum / (THUMB * THUMB);
      }
    }
    return [0, 1, 2].map((k) => (mean[k] as number) * (surface.emission[k] as number)) as [
      number,
      number,
      number,
    ];
  }

  /** Per-vertex colour and glow for `mesh` as `material` paints it, three floats each. */
  async paint(
    mesh: MeshData,
    material: BlendStruct | null,
  ): Promise<{ colors: Float32Array; glows: Float32Array }> {
    const count = mesh.positions.length / 3;
    const colors = new Float32Array(count * 3);
    const glows = new Float32Array(count * 3);
    let surface = material === null ? null : (this.surfaces.get(material.offset) ?? null);
    if (material !== null && surface === null) {
      surface = readBlendSurface(material, this.version);
      this.surfaces.set(material.offset, surface);
    }
    const albedo = await this.thumb(surface?.baseColorMap?.image ?? null);
    const glow = await this.thumb(surface?.emissionMap?.image ?? null);
    const base = surface?.baseColor ?? [0.8, 0.8, 0.8];
    const emission =
      surface === null
        ? [0, 0, 0]
        : surface.emission.map((c) => c * Math.min(1, surface.emissionStrength));
    const lit = emission.some((c) => c > 0);
    const uvs = mesh.uvs;
    for (let v = 0; v < count; v++) {
      let texel = -1;
      if (uvs !== undefined) {
        const u = (uvs[v * 2] as number) - Math.floor(uvs[v * 2] as number);
        const w = (uvs[v * 2 + 1] as number) - Math.floor(uvs[v * 2 + 1] as number);
        texel =
          Math.min(THUMB - 1, Math.floor(w * THUMB)) * THUMB +
          Math.min(THUMB - 1, Math.floor(u * THUMB));
      }
      for (let k = 0; k < 3; k++) {
        const a = albedo !== null && texel >= 0 ? (albedo.rgb[texel * 3 + k] as number) : 1;
        colors[v * 3 + k] = a * (base[k] as number);
        const g = glow !== null && texel >= 0 ? (glow.rgb[texel * 3 + k] as number) : lit ? 1 : 0;
        glows[v * 3 + k] = g * (emission[k] as number);
      }
    }
    return { colors, glows };
  }
}
