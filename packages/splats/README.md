# @driftengine/splats

Gaussian splat captures: the readers, view-dependent colour, an off-frame sort, and a pass that
composes into the scene.

**Cost: 16.5 KB gzipped on top of core.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number is derived from the same floors that gate asserts, so a README
quoting a stale one is a red suite rather than a thing somebody notices.

## What it is

A photographed place, drawn as several hundred thousand oriented ellipsoids. `readSplatPly` takes the
format the capture tools emit; `packSplats` writes the packed record `.drft` carries as `SPLT`.
`createSplatPass` composes them into a scene that also contains ordinary meshes.

## The sort is the whole problem

Splats are transparent, so they draw back to front, and the order changes whenever the camera does.
Sorting hundreds of thousands of them inside a frame is what makes a naive implementation stutter.

So **the sort is off-frame and the pass draws whatever order it last received** — a frame is never
blocked on one. `SplatSortFn` is the seam: supply your own, on a worker or wherever you like, and it
is handed a `SplatSortScratch` it reuses rather than an array it allocates. The cost is that a fast
camera move draws a slightly stale order for a frame or two, which reads as a soft settle rather than
as a stall. What would make that wrong is a capture small enough to sort inline, where the seam is
overhead.

## Colour that changes with the view

A capture from a training run stores its colour as a spherical-harmonic expansion: the constant term
is the colour from every angle, and the bands above it are how that colour changes as you move past
the surface. **The l=1 band is read and the rest is not**, which is a decision with numbers behind
it rather than a partial implementation.

Nine coefficients, transposed out of the file's channel-major order and packed into **one extra
texel a splat** — nine 8-bit values and a per-splat scale in the fourth word. That is 48 bytes a
record against 32, and the vertex stage runs six times a splat, so it is 288 bytes a splat a frame
against 192. At the mobile budget of 400,000 splats: **115 MB a frame against 77**.

Degree 2 is three extra texels and degree 3 is six, which at the same budget is 192 MB and 307 MB a
frame — against a mid-range phone already moving 389 MB a frame of attachment traffic. So the sharp
specular bands are declined, and the broad directional lobe that makes glass and a wet floor read as
themselves is the one that ships.

**A capture without harmonics pays nothing**: it is eight words a splat and two texels exactly as
before, and the shader's gate is a uniform, so it performs no third fetch. The width travels in the
`SPLT` block's own header, which the format designed for this.

## Streaming

The `SPLT` record is blocked and coarse-ordered, so a reader can draw the first block before the rest
arrives. Measured on a 332 KB capture: the first of sixteen blocks is 662 splats in 24 KB, and it
draws the whole room rather than a corner of it.

Part of [DriftEngine](../../README.md). See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
for how the packages divide, and why some features are compiled into core on demand instead.
