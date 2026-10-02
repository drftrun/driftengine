---
title: DriftTexture
description: Textures as small programs over a latent image, decoded per pixel on the GPU and on the CPU alike, animated by the simulation's clock and carried in .drft.
packages: ['@driftengine/texture', '@driftengine/assets', '@driftengine/drft', '@driftengine/core']
covers: ['`DTEX`, the chunk', 'A texture cannot move the simulation']
areas: ['texture']
---

# DriftTexture

A DriftTexture is a material's maps as a small program over a latent image, not as pictures. The
program is a few four-word instructions: sample the latent, run a small network over it, add
noise, mix by time, remap a channel's convention. It runs per shaded pixel on the GPU and, word for
word, in `decodeCpu` on the CPU, which is the reference the device is checked against.

`@driftengine/texture` is the format, the reference interpreter and the residency that streams it,
for 2,304 bytes gzipped and no renderer. The device interpreter lives in core's
[GPU-driven pipeline](../rendering/gpu-driven.md), so DriftTexture materials draw on WebGPU.

The example is four materials: bricks and a metal chequer encoded from channels written in code,
a marble that is noise and a colour, and a panel whose glow the simulation's clock animates. Hold
the clock and the panel stops while the camera carries on.

<!-- run: drifttexture -->

## Why a program

**One object a material, not one a channel.** A material's albedo, roughness and normal are three
descriptions of the same scratches and wear. Encoding them apart pays for that structure three
times; encoding them together fits one latent every channel decodes from.

**Time is an argument.** The decoder takes `t` from its caller, which is the simulation's clock, so
an animated texture replays byte for byte. The engine's tests assert it three ways: a run sampling an
animated texture every tick fingerprints identically to a run sampling nothing, the same simulation
run twice at different wall-clock times fingerprints identically, and a decoder reading a wall clock
instead is shown to diverge, so the first two cannot pass by accident.

**The decoder is data, not shader permutations.** A program is four words a node in a buffer,
walked by one shader. A new operation is one more case in one switch, and a thousand materials are a
thousand programs and still one pipeline.

**Conventions are declared, so nothing downstream guesses.** A channel says it is an sRGB albedo, a
Y-down tangent-space normal or a gloss, and comes back linear, Y-up and as roughness. The sRGB curve
is the exact one: the midpoint linearises to 0.2140, not the 0.2176 of the 2.2 approximation.

## The program

```ts sample=drifttexture/main.ts#programs
/** A marble: five octaves of noise, with a warm white laid over it at half strength. */
const marbleGraph = createDecodeGraph(3);
addDecodeNode(marbleGraph, DECODE_OP.PROCEDURAL_FBM, 7, 5, 0);
addDecodeNode(marbleGraph, DECODE_OP.CONSTANT, 0, 0, 1);
addDecodeNode(marbleGraph, DECODE_OP.COMPOSITE, 1, 0, 2);
marbleGraph.result = 2;
marbleGraph.addressMode = ADDRESS_MODE.CENTRE_WRAP;
const marbleConstants = Float32Array.of(0.95, 0.9, 0.82, 0.55);

/** A glow that sweeps from amber to blue once a second of the time it is given. */
const glowGraph = createDecodeGraph(3);
addDecodeNode(glowGraph, DECODE_OP.CONSTANT, 0, 0, 0);
addDecodeNode(glowGraph, DECODE_OP.CONSTANT, 1, 0, 1);
addDecodeNode(glowGraph, DECODE_OP.LATENT_LERP, 0, 1, 2);
glowGraph.result = 2;
const glowConstants = Float32Array.of(1, 0.55, 0.15, 1, 0.2, 0.45, 1, 1);

/** A graph and its constants, as the device's program: no latent and no network to carry. */
const procedural = (graph: DecodeGraph, constants: Float32Array): GpuDrivenProgram => ({
  graph,
  latents: [],
  networks: [],
  constants,
});
```

`createDecodeGraph(capacity)` makes an empty program and `addDecodeNode(graph, op, a, b, out)`
appends an instruction writing register `out`, of which there are `MAX_REGISTERS` (16), each four
components. `result` names the register holding the finished value, and `addressMode` says where
coordinates land, as one of `ADDRESS_MODE`:

- `ADDRESS_MODE.LATTICE_CLAMP` and `ADDRESS_MODE.LATTICE_WRAP` put `u = 0` on the first texel's centre, which a heightfield
  sampled at its own vertices wants.
- `ADDRESS_MODE.CENTRE_CLAMP` and `ADDRESS_MODE.CENTRE_WRAP` put it on the first texel's edge, as every GPU sampler does, which
  a surface tiled across a mesh wants.

The instructions:

| Operation                  | `a`                | `b`                   | Writes                                              |
| -------------------------- | ------------------ | --------------------- | --------------------------------------------------- |
| `DECODE_OP.SAMPLE_LATENT`  | a latent slot      |                       | The latent at (u, v)                                |
| `DECODE_OP.EVAL_NETWORK`   | the input register | a network slot        | The network's outputs                               |
| `DECODE_OP.SAMPLE_BLOCK`   | a block slot       |                       | Raw bytes at (u, v): an ordinary picture            |
| `DECODE_OP.PROCEDURAL_FBM` | a seed             | octaves               | Fractal noise, in all three colour lanes            |
| `DECODE_OP.FLIPBOOK_INDEX` | frames             | frames per second     | The frame the time lands on, looping                |
| `DECODE_OP.LATENT_LERP`    | a register         | a register            | The two mixed by the fractional part of the time    |
| `DECODE_OP.REMAP_CHANNEL`  | a register         | a packed channel spec | That register with one channel's convention applied |
| `DECODE_OP.COMPOSITE`      | a register         | a register            | `a` over `b`, by `a`'s alpha                        |
| `DECODE_OP.CONSTANT`       | a constant slot    |                       | Four numbers from the program's constants           |

`validateDecodeGraph(graph)` returns `null` for a program an interpreter can run and a message for
one it cannot: an unknown operation, a register out of range, a register read before anything wrote
it, a result nothing writes. `graphRegisterCount`, `nodeOp`, `nodeA`, `nodeB` and `nodeOut` read a
program back, and `encodeDecodeGraph` and `decodeDecodeGraph` turn one into words and back.

### On the CPU

```ts sample=snippets/drifttexture.ts#reference
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
```

`decodeCpu(graph, resources, u, v, t, out, registers, lod)` runs a program at one point and writes
the four-component result. `resources` holds the `latents`, `blocks`, `networks` and `constants` the
program's slots name; `registers` comes from `createDecodeRegisters()` and is reused so a decode
allocates nothing. `lod` picks a mip level, so the GPU's trilinear sample has a reference at every
level.

A channel spec for `DECODE_OP.REMAP_CHANNEL` packs a semantic's index in `REMAP_SEMANTICS` above its
component: `(index << 4) | component`. The semantics are `CHANNEL_SEMANTICS`: `albedo-srgb`,
`albedo-linear`, `normal-tangent-yup`, `normal-tangent-ydown`, `roughness-linear`, `gloss-linear`,
`metallic-linear`, `occlusion-linear`, `height-linear`, `emissive-srgb` and `mask-linear`.
`semanticIndex` and `semanticAt` convert, `isColour` and `needsVarianceMips` say which need a
transfer curve or a normal-preserving mip, and `srgbToLinear`, `linearToSrgb` and `normaliseSample`
are the conversions themselves.

### On the GPU

```ts sample=drifttexture/main.ts#materials
/** Material 0 is the ground; the rest wear DriftTexture programs. A cube's faces span 0 to 1, so
    a scale of three tiles the bricks three times across each face. */
const materials: GpuDrivenMaterial[] = [
  { tint: [0.4, 0.42, 0.38], emissive: 0, roughness: 0.9 },
  {
    tint: [1, 1, 1],
    emissive: 0,
    roughness: 0.85,
    textures: {
      baseColour: programFromEncoded(bricks.baseColour),
      normal: programFromEncoded(bricks.normal),
      uScale: 3,
      vScale: 3,
    },
  },
  {
    tint: [1, 1, 1],
    emissive: 0,
    roughness: 1,
    textures: {
      baseColour: programFromEncoded(chequer.baseColour),
      orm: programFromEncoded(chequer.orm),
      uScale: 1,
      vScale: 1,
    },
  },
  {
    tint: [1, 1, 1],
    emissive: 0,
    roughness: 0.3,
    textures: { baseColour: procedural(marbleGraph, marbleConstants), uScale: 1, vScale: 1 },
  },
  {
    tint: [0.8, 0.8, 0.8],
    emissive: 1.2,
    roughness: 0.5,
    textures: { emissive: procedural(glowGraph, glowConstants) },
  },
];
```

A [GPU-driven](../rendering/gpu-driven.md) material takes `textures`: a `GpuDrivenProgram` for any
of `baseColour`, `normal`, `orm` (occlusion, roughness and metallic in R, G and B) and `emissive`,
with `uScale` and `vScale` to tile them and the strengths `SurfaceMaterial` has. A program is a
graph and its resources in bytes: `latents`, `blocks`, `networks` and `constants`.
`programFromEncoded(encoded)` builds one from an encoded material, and `packDecodeTables` is what
the pass flattens every material's programs into. A material with no programs draws exactly as it
did without them.

```ts sample=drifttexture/main.ts#time
/* The decode reads this, never a clock of its own, so a held or replayed time decodes alike. */
view.time = decodeTime;
decodeCpu(glowGraph, glowResources, 0.5, 0.5, decodeTime, sampled, registers);
```

The pass reads the time an animated program samples from its view's `time`, in seconds of the
simulation's clock, never from a clock of its own.

## Encoding a material

```ts sample=drifttexture/main.ts#encode
/** Channels written in code, 64 texels square, then encoded jointly into one latent. */
const SIZE = 64;
function channel(
  semantic: ChannelInput['spec']['semantic'],
  component: number,
  value: (x: number, y: number) => number,
): ChannelInput {
  const data = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) data[y * SIZE + x] = value(x, y);
  return { spec: { semantic, component }, data };
}

/** Tiling, full resolution, addressed at texel centres: what a surface texture wants. */
const encode = (channels: readonly ChannelInput[]): EncodedMaterial =>
  encodeMaterial(channels, SIZE, SIZE, { quality: 1, addressMode: ADDRESS_MODE.CENTRE_WRAP });

/** Courses of bricks: their colour, and a normal that turns at the mortar. */
const mortar = (x: number, y: number): boolean => y % 16 < 2 || (x + ((y >> 4) & 1) * 16) % 32 < 2;
const bevel = (offset: number): number => (offset === 2 ? 0.55 : offset === 31 ? -0.55 : 0);
const nx = (x: number, y: number): number => bevel((x + ((y >> 4) & 1) * 16) % 32);
const ny = (_x: number, y: number): number => bevel(y % 16 === 2 ? 2 : y % 16 === 15 ? 31 : 0);
const bricks = {
  baseColour: encode([
    channel('albedo-linear', 0, (x, y) => (mortar(x, y) ? 0.7 : 0.55)),
    channel('albedo-linear', 1, (x, y) => (mortar(x, y) ? 0.68 : 0.22)),
    channel('albedo-linear', 2, (x, y) => (mortar(x, y) ? 0.64 : 0.15)),
  ]),
  normal: encode([
    channel('normal-tangent-yup', 0, (x, y) => nx(x, y) * 0.5 + 0.5),
    channel('normal-tangent-yup', 1, (x, y) => ny(x, y) * 0.5 + 0.5),
    channel(
      'normal-tangent-yup',
      2,
      (x, y) => Math.sqrt(Math.max(0, 1 - nx(x, y) ** 2 - ny(x, y) ** 2)) * 0.5 + 0.5,
    ),
  ]),
};

/** A chequer of polished metal and rough stone: colour, and occlusion, roughness and metal. */
const tone = (x: number, y: number): number => ((x >> 3) + (y >> 3)) & 1;
const chequer = {
  baseColour: encode([
    channel('albedo-linear', 0, (x, y) => (tone(x, y) ? 0.85 : 0.25)),
    channel('albedo-linear', 1, (x, y) => (tone(x, y) ? 0.8 : 0.3)),
    channel('albedo-linear', 2, (x, y) => (tone(x, y) ? 0.7 : 0.35)),
  ]),
  orm: encode([
    channel('occlusion-linear', 0, (x, y) => (x % 8 === 0 || y % 8 === 0 ? 0.45 : 1)),
    channel('roughness-linear', 1, (x, y) => (tone(x, y) ? 0.25 : 0.85)),
    channel('metallic-linear', 2, (x, y) => (tone(x, y) ? 0.6 : 0)),
  ]),
};
```

`encodeMaterial(channels, width, height, options)` in `@driftengine/assets` fits one latent for a
set of channels, each a `ChannelInput`: a `ChannelSpec` of semantic and component, and its values.
`quality` from 0 to 1 sets the latent's resolution, an eighth of the source up to all of it, and
`addressMode` how it tiles. The result, an `EncodedMaterial`, carries the latent and its mips, a
small network and the two-node program that samples one and evaluates the other.

The fit is a principal-component basis over the channel vectors: exact, deterministic and cheap.
Channels that move together share a component, and a component is kept only where it explains
enough of the channels to be worth its bytes, at most three. A sandstone whose
three colour channels rise and fall together encodes into a single component. Normal maps get
rougher toward their small mips instead of sparkling: the encoder writes the disagreement between
four averaged normals into roughness, which is why both live in one object
(`reduceNormalMip`, `toksvigRoughness`).

A network is evaluated by `evalNetwork`, and by `evalNetworkHalf` at the half precision a device
runs, with `halfPrecisionErrorBound` saying how far the two may differ. `@driftengine/texture` also
exports the tensor operations its networks are built from, for a caller with a network of its own.
`latentImageOf(encoded)` gives the latent as the CPU decoder reads it.

## In a `.drft`

```ts sample=snippets/drifttexture.ts#chunk
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
```

`dtexFromEncoded(encoded, channels, tileSize)` turns an encoded material into a `DtexMaterial`, and
`writeDrft` carries each in a `DTEX` chunk paired to a `MATL` entry by the index it names, so a file
may carry programs for some materials and plain maps for the rest. The chunk holds the latent, what
each channel is, the program, the network's shape and weights, and a tile table.

The tile table is the streaming unit. With a `tileSize`, the latent is stored tile by tile and each
tile carries a 64-bit content hash, so two identical tiles anywhere in a bake share one payload and
a tile resident for one material is resident for every material sharing it. `tileGridFromDtex`
and `dtexTileBytes` read the table back for streaming.

The chunk validates containment, not meaning: a tile whose bytes run past the payload and a result
register no node writes are refused, since either would hand a reader arbitrary memory or an
uninitialised value. Whether a program runs is `validateDecodeGraph`'s question. The chunk is
additive, so an older reader skips it by its length and loses only a material it could not have
decoded. `DTEX_REGISTERS`, `DTEX_ADDRESS_MODES` and `DTEX_MAX_TILES` are its limits.

## Texture arrays and materials

WebGPU has no bindless textures, so a thousand materials as six thousand textures is out of reach.
DriftTexture materials bind as slices of a few arrays: `createMaterialArray` holds them,
`assignLayer` gives a latent its layer, sharing one between identical content, and `layerOf` and
`arrayDescriptor` describe the result. `hashTile`, `createTileIndex`, `internTile` and
`tileSlotCount` are the content addressing underneath.
