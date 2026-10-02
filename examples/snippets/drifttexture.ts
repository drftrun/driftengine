/**
 * A DriftTexture decoded on the CPU, and an encoded material written into a `.drft` as its `DTEX`
 * chunk and read back.
 *
 * A snippet, typechecked with the examples and quoted by the manual's DriftTexture chapter.
 */
import { MeshBuilder } from '@driftengine/core';
import { dtexFromEncoded, encodeMaterial, latentImageOf } from '@driftengine/assets';
import type { ChannelInput } from '@driftengine/assets';
import { readDrft, writeDrft } from '@driftengine/drft';
import type { DrftMaterial } from '@driftengine/drft';
import {
  ADDRESS_MODE,
  DECODE_OP,
  REMAP_SEMANTICS,
  addDecodeNode,
  createDecodeGraph,
  createDecodeRegisters,
  decodeCpu,
  validateDecodeGraph,
} from '@driftengine/texture';

/** The material the program decodes for: an ordinary MATL entry, with its maps left empty. */
const STONE: DrftMaterial = {
  name: 'sandstone',
  color: [1, 1, 1],
  specular: 0,
  roughness: 0.8,
  emissive: 0,
  emissiveColor: [0, 0, 0],
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
};

// #region reference
/**
 * Noise read as gloss, which the remap hands back as roughness: a channel says what convention it
 * was authored in, and comes back in the one the renderer uses.
 */
const graph = createDecodeGraph(2);
addDecodeNode(graph, DECODE_OP.PROCEDURAL_FBM, 3, 4, 0);
const gloss = (REMAP_SEMANTICS.indexOf('gloss-linear') << 4) | 0;
addDecodeNode(graph, DECODE_OP.REMAP_CHANNEL, 0, gloss, 1);
graph.result = 1;
graph.addressMode = ADDRESS_MODE.CENTRE_WRAP;

/** `null` for a graph an interpreter can run; otherwise what is wrong with it. */
export const problem = validateDecodeGraph(graph);

/** The roughness at one point, at simulation time zero. Registers are reused between calls. */
const registers = createDecodeRegisters();
export const roughness = new Float32Array(4);
decodeCpu(graph, { latents: [], blocks: [], networks: [] }, 0.25, 0.75, 0, roughness, registers);
// #endregion

// #region chunk
/** Three channels of a sandstone written in code, encoded jointly, and carried as a `DTEX`. */
const SIZE = 32;
const band = (y: number): number => 0.5 + 0.5 * Math.sin(y * 0.6);
const sandstone: ChannelInput[] = [0.78, 0.6, 0.42].map((base, component) => ({
  spec: { semantic: 'albedo-linear', component },
  data: Float32Array.from({ length: SIZE * SIZE }, (_, i) =>
    Math.min(1, base * (0.8 + 0.3 * band(Math.floor(i / SIZE)))),
  ),
}));
const encoded = encodeMaterial(sandstone, SIZE, SIZE, {
  quality: 0.5,
  addressMode: ADDRESS_MODE.CENTRE_WRAP,
});

export const file = writeDrft({
  head: { name: 'sandstone' },
  meshes: [new MeshBuilder().addBox([0, 1, 0], [1, 1, 1], [1, 1, 1]).build()],
  materials: [STONE],
  /* Paired to its MATL entry by index, so a file may carry programs for some materials only. */
  dtex: [
    {
      material: 0,
      texture: dtexFromEncoded(
        encoded,
        sandstone.map((c) => c.spec),
      ),
    },
  ],
});

/** Read back: the chunk is data, and decoding it is the texture package's job. */
export const carried = readDrft(file).dtex;

/** The same latent as the decoder's input, for checking a bake against its source. */
export const latent = latentImageOf(encoded);
// #endregion
