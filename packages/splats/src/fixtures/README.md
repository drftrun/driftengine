# The `.sog` fixture, and where each of its three files came from

**Nothing here was written by hand, and the chain matters more than the files.** Track O withdrew
its mock capability providers on the argument that a mock is a second implementation of a contract
with no first implementation to check it against, so anything it agrees with is itself. A `.sog`
fixture invented in this repository would have exactly that shape: the reader would agree with it
by construction, and the encoding it agreed on could be anybody's.

So the chain has an independent encoder and an independent decoder in it, and neither is ours:

1. **`cloud.truth.json`** — sixty-four Gaussians with values chosen to be distinguishable: positions
   on a curve, scales spread over an order of magnitude, a rotation that turns through three
   radians, opacities from 0.15 to 0.95. These were written as a `.ply`, in the encodings a training
   run writes — scale as its logarithm, opacity as its logit, rotation as `wxyz`.
2. **`cloud.sog`** — that `.ply` through **`@playcanvas/splat-transform` 3.3.3**, which is the tool
   a consumer with a capture actually runs and the reference implementation of the container. It is
   a real bundle: a ZIP written streaming, so every local header carries a size of zero and the real
   sizes are in the central directory, which is the detail a reader gets wrong first.
3. **`cloud.texels.json`** — the five WebP images decoded to RGBA by **Pillow 10.2**, base64'd.
   Committed because Node has no WebP decoder and this engine will not vendor one: `readSplatSog`
   takes the decoder as a parameter, so the test supplies these and the browser supplies its own.

The test therefore compares values this repository chose against values this repository decoded out
of a file somebody else's encoder wrote and somebody else's decoder read. Nothing in that loop
checks itself.

`scripts/sog-check.mjs` closes the last gap by decoding the same bundle with the browser's own WebP
decoder, which is what `browserWebpDecoder` actually calls.

## Reproducing it

```sh
node scripts/sogFixture.mjs cloud.ply packages/splats/src/fixtures/cloud.truth.json
npx @playcanvas/splat-transform@3.3.3 cloud.ply packages/splats/src/fixtures/cloud.sog
python3 scripts/sogTexels.py packages/splats/src/fixtures/cloud.sog packages/splats/src/fixtures/cloud.texels.json
```
