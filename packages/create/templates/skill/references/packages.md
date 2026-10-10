# The packages

Every package is published to npm under `@driftengine/` and moves on one version line, so a
project installs the same version of each. `@driftengine/core` is the one every game needs.
Generated from the packages' own manifests.

- `@driftengine/ai`: Provider-neutral intelligence sessions, typed tools and context, and an agent loop that does not wait.
- `@driftengine/animation`: Skeletons, clips, poses and the graphs over them: sampling as a pure function of a caller-supplied time.
- `@driftengine/assets`: Model readers and the streaming loader for the .drft container.
- `@driftengine/audio`: Layered stems, synthesis, rhythm analysis and positional placement.
- `@driftengine/capture`: A video to a playable scene, on the player's device: the models it runs and the stages that use them.
- `@driftengine/chemistry`: Thermochemistry of bulk matter: elements, species, substances and what they turn into.
- `@driftengine/core`: The runtime of DriftEngine, a WebGPU game engine with a WebGL2 fallback: renderer, loop, input, cameras, scene graph and physics.
- `@driftengine/create`: Starts a DriftEngine game: a Vite and TypeScript project, its instructions for a coding agent, and the engine's skill.
- `@driftengine/drft`: The .drft container: a streaming format for baked 3D scenes.
- `@driftengine/editor`: The model of a scene editor: a tree of what exists, an inspector over what is selected, and play-in-editor.
- `@driftengine/entities`: Entities with generational identity, component storage, systems and scenes.
- `@driftengine/media`: Clip encoding and frame delivery for recording what the engine draws.
- `@driftengine/native-host`: The engine on a native window and a native WebGPU device, with no browser between them.
- `@driftengine/nav`: A navigation mesh: geometry to walkable convex polygons, and a straight line across them.
- `@driftengine/network`: A transport seam, rewind and replay, lockstep and an authoritative host, on the fixed-step loop.
- `@driftengine/package`: Builds an installable application from a game built on the engine.
- `@driftengine/physics`: Collision shapes, spatial queries and swept kinematic collision.
- `@driftengine/script`: The drift/* capability bindings: what this engine provides to DriftScript, and the only place the two are coupled.
- `@driftengine/splats`: Gaussian splat captures: readers, an off-frame sort, and a pass that composes into the scene.
- `@driftengine/terrain`: Heightfields: a query that answers the surface that is drawn, and patches that meet without cracks.
- `@driftengine/texture`: DriftTexture: a texture as a compiled, sampled field rather than an image.
- `@driftengine/tools`: The editor panels a shipped game can carry, and the command stack that makes their edits undoable.
- `@driftengine/ui2d`: The 2D layer: batched sprites, sheets, tilemaps, and a retained interface tree over them.
- `@driftengine/xr`: WebXR sessions, stereo views, controller input and hand joints, over both backends.
