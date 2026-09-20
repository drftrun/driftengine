# `@driftengine/texture`

A texture as a compiled, sampled field rather than an image.

**Cost: 2,305 bytes gzipped, standalone** — 2,226 of code and 79 for the licence banner every
package carries. Measured by `scripts/size-gate.test.mjs`, which fails if
it drifts more than 3%. The package imports no renderer, so this is the whole of what a consumer
pays — there is no core in the number.

**The interpreter that runs a decode graph on the device is not in this package.** It lives in
`@driftengine/core`'s GPU-driven pass as `DECODE_WGSL`, and `scripts/gpu-parity.mjs` checks it
against `decodeCpu` on a real texture array and real samplers, over all nine operations and all four
address modes.

```ts
import { createDecodeGraph, addDecodeNode, DECODE_OP, decodeCpu } from '@driftengine/texture';

const graph = createDecodeGraph(4);
addDecodeNode(graph, DECODE_OP.SAMPLE_LATENT, 0, 0, 0);
addDecodeNode(graph, DECODE_OP.REMAP_CHANNEL, 0, (0 << 4) | 0, 1); // albedo-srgb, component 0
graph.result = 1;

decodeCpu(graph, resources, u, v, simulationTime, out, registers);
```

## What makes it different from an image

**One object per material, not per channel.** Albedo, normal, roughness and the rest are strongly
correlated, and every engine in the world compresses them apart — which throws that correlation
away before it can pay for anything.

**Time is an argument, not a clock.** `decodeCpu` takes `t` from the caller, which is the
simulation's clock. So an animated texture is byte-exact under replay. Every other engine's
animated texture reads a wall clock, which means replaying one simulation twice shows different
texels — invisible in a game, fatal in a rollback session, a deterministic capture, or an
automated visual comparison.

**The decoder is data, not a shader permutation.** A decode graph is four words per node in a
uniform buffer, walked by one shader. `docs/ARCHITECTURE.md` records what the other choice costs
with the number: a fifth permutation flag took the generated WGSL corpus from 914 KB to 1,906 KB
and cost 196,910 gzipped bytes on every consumer, including those who never enabled the feature.
Per material rather than per feature, that does not survive contact with a real project.

**Conventions are declared, so nothing downstream guesses.** A channel says it is a Y-down
tangent-space normal, or an sRGB albedo, or gloss — and comes back Y-up, linear, and as roughness.
The exact sRGB curve, not the 2.2 approximation: the midpoint linearises to 0.2140, and the
approximation's 0.2176 is a colour shift nobody attributes to the right cause for weeks.

**Normal mips get rougher instead of sparkling.** Averaging four normals and renormalising discards
how much they disagreed, and that disagreement _is_ roughness at the smaller scale. Preserving it
needs the mip chain to write roughness as well as normals, which needs both in one object.

**Materials bind as array slices.** WebGPU has no bindless access, so a thousand materials as six
thousand textures is unreachable; a thousand latent slices in a handful of arrays, indexed from a
storage buffer, is ordinary. Identical content shares a layer.

**Two address conventions, because two kinds of data need them.** A lattice puts `u = 0` on the
first texel's centre, which is what a height field sampled at its own vertices wants; a centre mode
puts it on the first texel's edge, which is what every GPU sampler does and what a surface tiled
across a mesh wants. `ADDRESS_MODE` names all four, and `decodeCpu` takes a mip level as well, so
the device's trilinear sample has a reference at every level.

## What a predicted view needs

**Prediction knows where the camera will be; `tilesForView` says what it will sample there.** For
each instance whose bounds are inside the predicted view, the level comes from its nearest point —
where the surface is finest on screen — and the tiles from its texture coordinates' span at that
level. It names the finer level too within an eighth of a level of a boundary, and every coarser
level, because a sampler with a fine tile missing falls back to a coarse one. An estimate is
enough: a tile it names that the frame does not sample is a wasted fetch.

```ts
import {
  TILE_RESIDENT,
  enqueue,
  latentTileGrid,
  runPrediction,
  tileState,
  tilesForView,
} from '@driftengine/texture';

const grid = latentTileGrid(latent, 16, graph.addressMode); // content-addressed, level by level
runPrediction(
  simulation,
  {
    needs: (view, out, budget) => tilesForView(view, projection, scene, out, budget),
    resident: (hash) => tileState(table, hash) === TILE_RESIDENT,
    request: (hash, priority) => enqueue(queue, hash, priority),
  },
  6,
  step,
  512,
);
```

The answer is ordered by the screen each tile covers, and at any budget it is a prefix of the answer
with none; `runPrediction` keeps that order inside each predicted frame when it hands tiles to the
queue. `popIn.test.ts` flies a corridor of real latents through it: nothing is late after the three
frames no fetch could have reached.

## What is not here

**The offline joint encoder is not in this package, by design**: it is a baker, and it lives in
`@driftengine/assets` as `encodeMaterial`, so a game that only decodes never carries it. The `NNET`
weights chunk is `@driftengine/drft`'s, and the half-precision network reference is here beside the
single-precision one, as `evalNetworkHalf`.
