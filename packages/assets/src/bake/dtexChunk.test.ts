import { buildDtex, readDtex } from '@driftengine/drft';
import {
  ADDRESS_MODE,
  createDecodeRegisters,
  decodeCpu,
  hashTile,
  type ChannelSpec,
} from '@driftengine/texture';
import { expect, test } from 'vitest';

import { cutLatentTiles, dtexFromEncoded } from './dtexChunk.ts';
import { encodeMaterial, latentImageOf, type ChannelInput } from './latent.ts';

/**
 * **A material the texture package encodes reaches a file and comes back decoding to the same
 * texels.** That is the whole claim, and it is an end-to-end one on purpose: the encoding, the
 * packing, the chunk and the interpreter are four pieces in three packages, and each of them has
 * its own tests. What nothing tested until now is that a material survives all four.
 */

const WIDTH = 16;
const HEIGHT = 16;

/** A smooth albedo and a roughness that varies the other way, so nothing is constant. */
function channels(): { inputs: ChannelInput[]; specs: ChannelSpec[] } {
  const albedo = new Float32Array(WIDTH * HEIGHT);
  const rough = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      albedo[y * WIDTH + x] = x / (WIDTH - 1);
      rough[y * WIDTH + x] = 1 - y / (HEIGHT - 1);
    }
  }
  const specs: ChannelSpec[] = [
    { semantic: 'albedo-linear', component: 0 },
    { semantic: 'roughness-linear', component: 1 },
  ];
  return {
    inputs: [
      { spec: specs[0] as ChannelSpec, data: albedo },
      { spec: specs[1] as ChannelSpec, data: rough },
    ],
    specs,
  };
}

test('AN ENCODED MATERIAL GOES THROUGH A FILE AND DECODES TO THE SAME TEXELS', () => {
  const { inputs, specs } = channels();
  /*
   * **Encoded with a tiling address mode rather than the default**, which is the difference between
   * a test that would notice the mode being dropped and one that would not: the default is zero,
   * and a field dropped to zero is a field that survived.
   */
  const encoded = encodeMaterial(inputs, WIDTH, HEIGHT, {
    quality: 1,
    addressMode: ADDRESS_MODE.CENTRE_WRAP,
  });
  const texture = dtexFromEncoded(encoded, specs);
  expect(texture.addressMode).toBe(ADDRESS_MODE.CENTRE_WRAP);

  /* Through the chunk and back, at a non-zero offset, because a chunk is read where it lands. */
  const bytes = buildDtex({ material: 0, texture });
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 8);
  const back = readDtex(padded.buffer as ArrayBuffer, 8, bytes.length).texture;
  expect(back.addressMode).toBe(ADDRESS_MODE.CENTRE_WRAP);

  /*
   * **Decoded on both sides and compared texel for texel**, rather than comparing the bytes. The
   * bytes agreeing says the chunk copied them; the decode agreeing says the *program* survived —
   * the graph, the register it results in, the network's shape, its weights and the address mode,
   * any one of which could be dropped without a byte of the latent changing.
   */
  const before = createDecodeRegisters();
  const after = createDecodeRegisters();
  const sourceOut = new Float32Array(4);
  const loadedOut = new Float32Array(4);
  const sourceResources = {
    latents: [latentImageOf(encoded)],
    blocks: [],
    networks: [{ shape: encoded.shape, weights: encoded.weights }],
  };
  const loadedResources = {
    latents: [
      {
        data: Float32Array.from(back.latent, (value) => value / 255),
        width: back.latentWidth,
        height: back.latentHeight,
        channels: back.latentComponents,
        mips: [],
      },
    ],
    blocks: [],
    networks: [
      {
        shape: {
          inputs: back.networkInputs,
          hidden: Array.from(back.hidden),
          outputs: back.networkOutputs,
        },
        weights: back.weights,
      },
    ],
  };
  const loadedGraph = {
    nodes: back.nodes,
    count: back.nodes.length / 4,
    result: back.resultRegister,
    addressMode: back.addressMode,
  };
  let worst = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const u = (x + 0.5) / WIDTH;
      const v = (y + 0.5) / HEIGHT;
      decodeCpu(encoded.graph, sourceResources, u, v, 0, sourceOut, before);
      decodeCpu(loadedGraph, loadedResources, u, v, 0, loadedOut, after);
      for (let c = 0; c < 2; c += 1) {
        worst = Math.max(worst, Math.abs((sourceOut[c] as number) - (loadedOut[c] as number)));
      }
    }
  }
  /* The same arithmetic on the same numbers: not close, identical. */
  expect(worst).toBe(0);
});

test('a channel is packed as its semantic and its component, and an unknown one is refused', () => {
  const { inputs, specs } = channels();
  const encoded = encodeMaterial(inputs, WIDTH, HEIGHT, { quality: 0.5 });
  const texture = dtexFromEncoded(encoded, specs);
  /* `albedo-linear` is index 1 and `roughness-linear` is 4, each with its component beside it. */
  expect(Array.from(texture.channels)).toEqual([(1 << 4) | 0, (4 << 4) | 1]);

  expect(() =>
    dtexFromEncoded(encoded, [{ semantic: 'not-a-thing' as never, component: 0 }]),
  ).toThrow(/not a semantic/);
  expect(() => dtexFromEncoded(encoded, [{ semantic: 'albedo-linear', component: 16 }])).toThrow(
    /four bits/,
  );
  expect(() => dtexFromEncoded(encoded, [])).toThrow(/decodes to nothing/);
});

test('A MATERIAL WITH NO TILE SIZE CARRIES NO TABLE AT ALL', () => {
  /*
   * **Not one entry over the whole image**, which is what it used to write with a zero where the
   * hash goes. A streaming reader believes a table; an empty one says plainly that this material
   * is one row-major image and is not streamed.
   */
  const { inputs, specs } = channels();
  const encoded = encodeMaterial(inputs, WIDTH, HEIGHT, { quality: 0.5 });
  const texture = dtexFromEncoded(encoded, specs);
  expect(texture.tileOffset.length).toBe(0);
  expect(texture.tileSize).toBe(0);
  expect(texture.latent).toBe(encoded.latent);
});

test('A LATENT CUT INTO TILES IS THE GRID, TILE-MAJOR, WITH IDENTICAL TILES SHARING A RUN', () => {
  const { inputs, specs } = channels();
  const encoded = encodeMaterial(inputs, WIDTH, HEIGHT, { quality: 0.5 });
  const tileSize = 4;
  const texture = dtexFromEncoded(encoded, specs, tileSize);

  const across = Math.ceil(encoded.latentWidth / tileSize);
  const down = Math.ceil(encoded.latentHeight / tileSize);
  expect(texture.tileOffset.length).toBe(across * down);
  expect(texture.tileHash.length).toBe(across * down * 2);
  expect(texture.tileSize).toBe(tileSize);

  /*
   * **Put back together, it is the latent it was cut from.** Tile-major is a rearrangement and not
   * a loss, and the test that says so is the one a streaming reader depends on: a consumer that
   * fetched every tile and reassembled must get the material the baker encoded.
   */
  const back = new Uint8Array(encoded.latent.length);
  for (let ty = 0; ty < down; ty += 1) {
    for (let tx = 0; tx < across; tx += 1) {
      const at = ty * across + tx;
      const w = Math.min(tileSize, encoded.latentWidth - tx * tileSize);
      const h = Math.min(tileSize, encoded.latentHeight - ty * tileSize);
      const from = texture.tileOffset[at] as number;
      for (let y = 0; y < h; y += 1) {
        const row = texture.latent.subarray(
          from + y * w * encoded.components,
          from + (y + 1) * w * encoded.components,
        );
        back.set(
          row,
          ((ty * tileSize + y) * encoded.latentWidth + tx * tileSize) * encoded.components,
        );
      }
    }
  }
  expect(Array.from(back)).toEqual(Array.from(encoded.latent));
});

test('the hash in the table is the one residency addresses a tile by', () => {
  /*
   * **`hashTile`, over the tile's stored bytes.** The point of a hash in the file is that a tile
   * which arrived for one material is already resident for every other material sharing it — which
   * is only true while the file's number and the residency cache's are the same number.
   */
  const latent = Uint8Array.from({ length: 4 * 4 * 2 }, (_, at) => (at * 31) & 0xff);
  const cut = cutLatentTiles(latent, 4, 4, 2, 2);
  expect(cut.offset.length).toBe(4);

  const first = cut.payload.subarray(cut.offset[0] as number, cut.length[0] as number);
  const digest = hashTile(first);
  expect((cut.hash[0] as number).toString(16).padStart(8, '0')).toBe(digest.slice(0, 8));
  expect((cut.hash[1] as number).toString(16).padStart(8, '0')).toBe(digest.slice(8));
});

test('two tiles with the same bytes are stored once', () => {
  /* A flat surface tiles into identical squares, and a material that stored each would pay for
     the flatness. */
  const latent = new Uint8Array(8 * 8 * 1).fill(7);
  const cut = cutLatentTiles(latent, 8, 8, 1, 4);
  expect(cut.offset.length).toBe(4);
  expect(Array.from(cut.offset)).toEqual([0, 0, 0, 0]);
  expect(cut.payload.length).toBe(16);
});
