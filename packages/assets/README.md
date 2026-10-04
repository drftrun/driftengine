# @driftengine/assets

Model readers for nine formats — `.blend` among them, read from the file's own DNA — and the streaming loader that uploads them.

**Cost: 23.2 KB gzipped on top of core.** Measured by `scripts/size-gate.test.mjs`, which fails if it drifts more than
3% — the number is a fact about the build rather than a claim in a document.

Part of [DriftEngine](../../README.md). See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
for how the packages divide, and why some features are compiled into core on demand instead.
