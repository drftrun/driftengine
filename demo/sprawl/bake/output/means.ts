/**
 * The mean colour of each picture the city wears, as linear light: what a coarse level shades a
 * box by, since from far enough a picture is its mean.
 *
 * **Every texel counts equally, glass included**: a facade's alpha marks its windows, and the box
 * wearing that facade marks them the same way, so what the mean compares is one facade against
 * another, not a facade against its glass. Each picture is read once, from the raster the bake
 * already wrote.
 */
import { readPng, rgbaOf } from '../../../../packages/core/scripts/png.mjs';

import type { Surface } from '../mesh/materials.ts';
import { linear } from '../mesh/materials.ts';
import { rasterKey } from '../textures/rasterize.ts';

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [1, 1, 1];

/** A surface's albedo mean, white where it wears no picture, from the rasters at `paths`. */
export function pictureMeans(paths: ReadonlyMap<string, string>): (surface: Surface) => Rgb {
  const means = new Map<string, Rgb>();
  const table = Array.from({ length: 256 }, (_, b) => linear(b));
  return (surface) => {
    const albedo = surface.textures.albedo;
    if (albedo === null) return WHITE;
    const key = rasterKey(albedo);
    let mean = means.get(key);
    if (mean === undefined) {
      const path = paths.get(key);
      if (path === undefined) throw new Error(`${albedo.file} was not rasterised`);
      const { rgba } = rgbaOf(readPng(path));
      const sum = [0, 0, 0];
      for (let i = 0; i < rgba.length; i += 4) {
        for (let c = 0; c < 3; c++)
          sum[c] = (sum[c] as number) + (table[rgba[i + c] as number] as number);
      }
      const n = rgba.length / 4 || 1;
      mean = [(sum[0] as number) / n, (sum[1] as number) / n, (sum[2] as number) / n];
      means.set(key, mean);
    }
    return mean;
  };
}
