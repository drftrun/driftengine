/**
 * The district's pictures: each source image decoded once, sized for what it is used as, and
 * written as the container's textures; and the packed occlusion-roughness-metal maps glTF would
 * have needed Blender to compose.
 *
 * **Sized by role, because the budget is memory on the GPU, not bytes on the wire.** The engine
 * uploads RGBA8 with mips, a third again over the base, so a 512 map is 1.4 MB resident and the
 * source's 1,380 distinct images at 2,048 would be 30 GB. Colour and glow are what a viewer reads,
 * so they keep `COLOUR_SIZE`; normal and surface maps are read through lighting, which forgives,
 * and keep `SURFACE_SIZE`. What would change it: a measured texture budget on the lowest tier, or a
 * frame where a facade's windows smear.
 *
 * **Composed where the source splits what glTF packs.** Roughness and metallic often come from two
 * grey images and occlusion from a third; the engine reads one map with occlusion in red,
 * roughness in green and metal in blue, so the three are drawn into one, each channel times its
 * factor, which bakes the factors in and leaves the material's scales at one.
 *
 * **Cached on disk** by the source image's hash and what was asked of it, so a second bake of the
 * same source reads JPEGs instead of decoding three gigabytes of PNG.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BlendStruct, ChannelSource } from '@driftengine/assets';
import { downscaleRgba, packedImage } from '@driftengine/assets';
import { CODEC_JPEG, CODEC_PNG } from '@driftengine/drft';
import type { DrftTextureSource } from '@driftengine/drft';
import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';

import { decodePng, encodePng, rgbaOf } from '../../../packages/core/scripts/png.mjs';

export const COLOUR_SIZE = 512;
export const SURFACE_SIZE = 256;
const QUALITY = 88;

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

let ready: Promise<void> | null = null;
function readyJpeg(): Promise<void> {
  if (ready === null) {
    const require = createRequire(import.meta.url);
    const compile = (file: string): Promise<WebAssembly.Module> =>
      WebAssembly.compile(readFileSync(require.resolve(`@jsquash/jpeg/codec/${file}`)));
    ready = Promise.all([
      compile('dec/mozjpeg_dec.wasm').then((module) => initJpegDecode(module as never)),
      compile('enc/mozjpeg_enc.wasm').then((module) => initJpegEncode(module as never)),
    ]).then(() => undefined);
  }
  return ready;
}

/** One picture the container will carry, and the index it will have. */
interface Written {
  readonly index: number;
  readonly source: DrftTextureSource;
}

export class Pictures {
  readonly written: DrftTextureSource[] = [];
  private readonly byKey = new Map<string, Written>();
  private readonly decoded = new Map<number, Rgba | null>();
  private readonly hashes = new Map<number, string>();

  constructor(private readonly cache: string) {
    mkdirSync(cache, { recursive: true });
  }

  private hash(image: BlendStruct): string | null {
    let known = this.hashes.get(image.offset);
    if (known !== undefined) return known;
    const bytes = packedImage(image);
    if (bytes === null) return null;
    known = createHash('sha1').update(bytes).digest('hex').slice(0, 20);
    this.hashes.set(image.offset, known);
    return known;
  }

  /** The source image, decoded at full size, or null where it is not packed or will not decode. */
  async rgba(image: BlendStruct): Promise<Rgba | null> {
    if (this.decoded.has(image.offset)) return this.decoded.get(image.offset) ?? null;
    const bytes = packedImage(image);
    let out: Rgba | null = null;
    if (bytes !== null) {
      try {
        if (bytes[0] === 0x89) {
          const png = rgbaOf(
            decodePng(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
          );
          out = { width: png.width, height: png.height, data: png.rgba };
        } else if (bytes[0] === 0xff) {
          await readyJpeg();
          const jpeg = await decodeJpeg(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
          out = { width: jpeg.width, height: jpeg.height, data: new Uint8Array(jpeg.data.buffer) };
        }
      } catch {
        out = null;
      }
    }
    this.decoded.set(image.offset, out);
    return out;
  }

  /** Forget decoded sources, which the next region does not need. */
  release(): void {
    this.decoded.clear();
  }

  /** A texture made from `make` once per `key`, cached on disk; its index in the container. */
  private async texture(
    key: string,
    name: string,
    make: () => Promise<Rgba | null>,
    alpha: boolean,
  ): Promise<number> {
    const known = this.byKey.get(key);
    if (known !== undefined) return known.index;
    const file = join(
      this.cache,
      `${createHash('sha1').update(key).digest('hex').slice(0, 24)}.${alpha ? 'png' : 'jpg'}`,
    );
    let source: DrftTextureSource | null = null;
    if (existsSync(file) && existsSync(`${file}.size`)) {
      const [width, height] = readFileSync(`${file}.size`, 'utf8').split('x').map(Number) as [
        number,
        number,
      ];
      source = {
        name,
        codec: alpha ? CODEC_PNG : CODEC_JPEG,
        width,
        height,
        bytes: new Uint8Array(readFileSync(file)),
      };
    } else {
      const rgba = await make();
      if (rgba === null) return -1;
      let bytes: Uint8Array;
      if (alpha) bytes = encodePng(rgba.width, rgba.height, rgba.data);
      else {
        await readyJpeg();
        const image = {
          data: new Uint8ClampedArray(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength),
          width: rgba.width,
          height: rgba.height,
          colorSpace: 'srgb',
        } as ImageData;
        bytes = new Uint8Array(await encodeJpeg(image, { quality: QUALITY }));
      }
      writeFileSync(file, bytes);
      writeFileSync(`${file}.size`, `${rgba.width}x${rgba.height}`);
      source = {
        name,
        codec: alpha ? CODEC_PNG : CODEC_JPEG,
        width: rgba.width,
        height: rgba.height,
        bytes,
      };
    }
    const index = this.written.length;
    this.written.push(source);
    this.byKey.set(key, { index, source });
    return index;
  }

  /** An image as it is, sized to `size` along its longer side; PNG where its alpha is used. */
  async plain(image: BlendStruct, size: number, alpha: boolean): Promise<number> {
    const hash = this.hash(image);
    if (hash === null) return -1;
    return this.texture(
      `plain:${hash}:${size}:${alpha}`,
      `${image.idName()}@${size}`,
      async () => {
        const rgba = await this.rgba(image);
        return rgba === null ? null : fit(rgba, size);
      },
      alpha,
    );
  }

  /**
   * A colour map with its alpha taken from another picture's channel, as a material that cuts its
   * shape with a separate mask reads it. PNG, since the alpha is the point.
   */
  async withAlpha(colour: BlendStruct, mask: ChannelSource, size: number): Promise<number> {
    const a = this.hash(colour);
    const b = this.hash(mask.image);
    if (a === null || b === null) return -1;
    return this.texture(
      `alpha:${a}:${b}.${mask.channel}:${size}`,
      `${colour.idName()}+${mask.image.idName()}@${size}`,
      async () => {
        const rgba = await this.rgba(colour);
        const alpha = await this.rgba(mask.image);
        if (rgba === null || alpha === null) return null;
        const sized = fit(rgba, size);
        const cut = fit(alpha, sized.width, sized.height);
        const k =
          mask.channel === 'g' ? 1 : mask.channel === 'b' ? 2 : mask.channel === 'a' ? 3 : 0;
        const data = new Uint8Array(sized.data);
        for (let i = 0; i < sized.width * sized.height; i++)
          data[i * 4 + 3] = cut.data[i * 4 + k] as number;
        return { width: sized.width, height: sized.height, data };
      },
      true,
    );
  }

  /**
   * The packed surface map: occlusion in red, roughness in green, metal in blue, each read from
   * its own source's channel and multiplied by its factor. -1 where no channel has a map.
   */
  async packed(
    occlusion: ChannelSource | null,
    roughness: ChannelSource | null,
    roughnessFactor: number,
    metal: ChannelSource | null,
    metalFactor: number,
    size: number = SURFACE_SIZE,
  ): Promise<number> {
    if (occlusion === null && roughness === null && metal === null) return -1;
    const part = (c: ChannelSource | null): string =>
      c === null ? '-' : `${this.hash(c.image) ?? c.image.idName()}.${c.channel}`;
    const key = `orm:${part(occlusion)}:${part(roughness)}*${roughnessFactor.toFixed(4)}:${part(metal)}*${metalFactor.toFixed(4)}:${size}`;
    const name = `${(roughness ?? metal ?? occlusion)?.image.idName() ?? 'surface'}#orm`;
    return this.texture(
      key,
      name,
      async () => {
        const channel = async (c: ChannelSource | null): Promise<Uint8Array | null> => {
          if (c === null) return null;
          const rgba = await this.rgba(c.image);
          if (rgba === null) return null;
          const sized = fit(rgba, size, size);
          const out = new Uint8Array(size * size);
          const k = c.channel === 'g' ? 1 : c.channel === 'b' ? 2 : c.channel === 'a' ? 3 : 0;
          for (let i = 0; i < out.length; i++) out[i] = sized.data[i * 4 + k] as number;
          return out;
        };
        const [o, r, m] = await Promise.all([
          channel(occlusion),
          channel(roughness),
          channel(metal),
        ]);
        const data = new Uint8Array(size * size * 4);
        for (let i = 0; i < size * size; i++) {
          data[i * 4] = o === null ? 255 : (o[i] as number);
          data[i * 4 + 1] = Math.min(
            255,
            Math.round((r === null ? 255 : (r[i] as number)) * roughnessFactor),
          );
          data[i * 4 + 2] = Math.min(
            255,
            Math.round((m === null ? 255 : (m[i] as number)) * metalFactor),
          );
          data[i * 4 + 3] = 255;
        }
        return { width: size, height: size, data };
      },
      false,
    );
  }
}

/** An image brought to `size` along its longer side, or exactly `width` × `height` when given. */
export function fit(rgba: Rgba, size: number, height?: number): Rgba {
  const scale = size / Math.max(rgba.width, rgba.height);
  const w = height === undefined ? Math.max(1, Math.round(rgba.width * Math.min(1, scale))) : size;
  const h =
    height === undefined ? Math.max(1, Math.round(rgba.height * Math.min(1, scale))) : height;
  if (w === rgba.width && h === rgba.height) return rgba;
  const data = downscaleRgba(rgba.data, rgba.width, rgba.height, w, h);
  return { width: w, height: h, data };
}
