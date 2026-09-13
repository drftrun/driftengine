# @driftengine/core

The runtime everything needs: renderer, loop, camera, input, geometry. Collision and dynamics live in [`@driftengine/physics`](../physics/README.md), which this package depends on and re-exports whole, so reaching for them through this barrel works as it always did.

**Cost: 670.0 KB gzipped, importing `createRenderer`.** Measured by `scripts/size-gate.test.mjs`, which fails if it drifts more than
3% — the number is a fact about the build rather than a claim in a document.

Part of [DriftEngine](../../README.md). See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
for how the packages divide, and why some features are compiled into core on demand instead.
