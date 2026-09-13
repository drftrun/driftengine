# @driftengine/media

Clip encoding and frame delivery. Carries the `mp4-muxer` dependency so core does not.

**Not size-gated, and this once claim it was.** There is no media fixture, so no floor moves when
this package does. The encoder it carries — `mp4-muxer`, behind a dynamic import — is only fetched by
a consumer that records a clip, which is the whole reason it lives here rather than in core.

A claim to be measured is worth less than no claim when nothing measures it: a reader trusts the
number precisely because the sentence says something checks it. `scripts/packages.test.mjs` now
refuses that sentence in a package with no fixture.

Part of [DriftEngine](../../README.md). See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
for how the packages divide, and why some features are compiled into core on demand instead.
