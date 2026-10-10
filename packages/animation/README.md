# @driftengine/animation

Skeletons, clips, poses, and the graphs over them.

**Cost: 6.1 KB gzipped on top of core.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number is derived from the same floors that gate asserts, so a README
quoting a stale one is a red suite rather than a thing somebody notices.

## What it is

A `Skeleton` resolves a `Pose` into a skinning palette. A clip is **sampled as a pure function of a
time you supply** — `sampleClip(clip, seconds, out)` reads no clock of its own, which is what lets an
animation be part of a replay rather than something layered on top of one. Above that: `blendPoses`
and additive layers, a `BlendTree`, a crossfading state machine over parameters you name, two-bone
IK, morph targets, retargeting by joint name, root motion, and **secondary motion** —
`sampleSpring(settings, anchorAt, seconds, out)` for one damped spring and `sampleSpringChain` for a
chain of them, which is hair, a coat, an antenna or a chain reacting to what the subject is doing.

Skinning and morphing run on both backends as vertex-shader permutations, so **a mesh with no rig
carries none of their instructions**. glTF's skins, animations and morph targets import, and `.drft`
carries them.

## Things that cost time before they were written down

**A blend needs a bind pose and does not take one.** `blendPoses(a, b, t, out)` has no bind-pose
parameter — the bind pose belongs to `BlendTree`, which allocates its own scratch poses. Reaching
for one on `blendPoses` is reading a paraphrase rather than the signature.

**Nothing here allocates per frame, and `out` is why.** Every sampler and every blend fills a
caller-owned target. A version returning a fresh `Pose` reads better and allocates one per joint per
frame, which is the shape `AGENTS.md` forbids in a hot path.

**Root motion is two calls and it is a mistake to make only one of them.**
`extractRootMotion(clip, rootJoint, fromSec, toSec, motion)` answers how far the root travelled, in
the root's own frame at `fromSec`, so you apply it as `position += worldRotation * motion.translation`
and `worldRotation = worldRotation * motion.rotation`. Then `stripRootMotion(clip, rootJoint, pose)`
pins the pose's root to the clip's value at time zero. **Extract without stripping and the character
moves twice, at exactly double speed, with nothing failing.**

Loops are accumulated rather than subtracted, which is the part you would otherwise have to write
yourself and get wrong: sampling the root at both times and subtracting answers a full stride
_backwards_ every time the clip wraps. What it gives up is a vertical bob authored on the root —
that leaves the pose with everything else and becomes motion you apply, so if your height is owned
by a physics controller and you ignore `translation[1]`, the bob is in neither.

**Secondary motion is sampled, not advanced, and that is what it is for.** `sampleSpring` takes a
time and an `anchorAt(t, out)` that must itself be a pure function of the time it is handed. It never
carries state between calls, so dragging a playhead backwards gives the same pose the forward pass
gave. The cost is arithmetic per sample instead of per frame: about ninety substeps of a four-multiply
2x2 for one spring, paid in whichever direction the caller is moving.

**`anchorAt` is called at times before the one you asked for**, going back `springSettleSec(settings)`
— which is how long the spring takes to forget, `-ln(1e-3) / (ζω)`. An anchor that reads a clock, or
that answers differently on a second call for one time, breaks the property silently. If yours comes
from a clip, sample the clip at the time it is handed.

**Damping of exactly 0 throws, and that is not a validation nicety.** An undamped spring rings
forever, so no lookback is long enough to sample it purely and there is no honest answer to return.
Anything above zero forgets. 1 is critical damping, which never overshoots; above 1 sags in.

**A chain is `sampleSpringChain`, and it is not the same as calling `sampleSpring` per link.** Each
link's anchor is where the link above it actually is — lagging and overshooting — so a chain
remembers longer than any of its links and needs `springChainSettleSec`, which is longer than
`springSettleSec` and grows with depth. It also has to march on one grid: evaluating a link on its
own would need its parent at every substep and the grandparent at every substep of each of those,
which is `steps^depth` anchor calls for the same answer.

## Where to start

`sampleClip` into a `Pose`, `Skeleton.palette` out of it, and `applyPoseToNode` for a rig you want to
drive without skinning at all.

Part of [DriftEngine](../../README.md). See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
for how the packages divide, and why some features are compiled into core on demand instead.
