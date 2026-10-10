# The manual

Every page of DriftEngine's manual, generated from `docs/manual/` in the engine's repository.

Each page is Markdown at `https://raw.githubusercontent.com/drftrun/driftengine/v<version>/docs/manual/<page>`, where
`<version>` is the installed engine's, from `node -p "require('@driftengine/core/package.json').version"`,
so what it says matches the code the project runs.
The same page is on the web at `https://driftengine.dev/docs/<page>`, without the `.md`.

## Getting started

Read in order. It ends with a complete game.

- `start/introduction.md`: **Introduction.** What DriftEngine is, what ships in it, how its packages divide, and where to start reading this manual.
- `start/installation.md`: **Installation.** Add DriftEngine to a project, set up the page, TypeScript and DriftScript, pick a backend for testing, and know what the licence asks of you.
- `start/with-an-agent.md`: **Working with a coding agent.** Start a project a coding agent can build on, give the agent the engine's skill, and check every change by looking at the game on both backends.
- `start/hello-world.md`: **Hello world.** A complete first program. A renderer on a canvas, light, two meshes, a camera, a loop that turns a cube on a fixed clock, and a rule in DriftScript.
- `start/the-loop.md`: **The loop.** A fixed simulation step, rendering between steps with alpha, pausing without freezing the screen, and the tick count replays and networking key on.
- `start/moving-things.md`: **Moving things.** Read the keyboard, the mouse, a gamepad and a touch screen through one action map, and turn what you read into movement on the fixed step.
- `start/first-game.md`: **Your first game.** A complete 3D game. An arena with physics, a character, crates to push, orbs to gather against the clock, sound, shadows, a HUD, and rules in DriftScript.
- `start/a-2d-game.md`: **A 2D game.** A complete breakout game drawn in the XY plane by the same 3D renderer, with a camera that makes it read as flat and one mesh tinted per brick.
- `start/shipping-to-the-web.md`: **Shipping to the web.** Build a DriftEngine game into static files, host it anywhere, test it on a phone, and know what a web build carries and why.

## Concepts

How the engine thinks: its packages, its two backends, the scene graph, determinism, coordinates, quality and the shape of a frame.

- `concepts/packages.md`: **Packages.** How the engine divides into packages, what each one costs in a build, how they depend on each other, and which to install for what.
- `concepts/backends.md`: **WebGPU and WebGL2.** How the engine chooses between WebGPU and WebGL2, what it reports about the choice, what only WebGPU can do, and how to tune quality per backend.
- `concepts/scene-graph.md`: **The scene graph.** Nodes, parents and world matrices, bounds that enclose a whole subtree, culling by frustum and by occluder, and levels of detail chosen by apparent size.
- `concepts/determinism.md`: **Determinism.** How a DriftEngine simulation gives the same result every run on every browser, which replays, rollback netcode and the editor's timeline all depend on.
- `concepts/coordinates.md`: **Coordinates and units.** Metres, Y up, which way the camera looks, how matrices are laid out, and how a world larger than single precision stays exact.
- `concepts/quality.md`: **Render quality.** The quality profile a renderer is built with, what each group of options does and costs, the defaults that surprise people, and the dials that move per frame.
- `concepts/the-frame.md`: **The frame.** What happens between beginFrame and endFrame, in what order a game issues its work, where custom passes and compute fit, and how the GPU-driven path differs.

## DriftScript

The engine's scripting language and how a game uses it: what belongs in a script and what stays in TypeScript, setting it up, the patterns the examples use, every function a script can call, and testing and shipping it.

- `scripting/driftscript.md`: **DriftScript in a game.** What the engine's scripting language is for, what belongs in a script and what stays in TypeScript, and how the two share one game.
- `scripting/setting-up.md`: **Setting up scripts.** The build that compiles .drs files, loading and binding a script, the services a host gives it, calling it, and hot reload that keeps the game's state.
- `scripting/patterns.md`: **Patterns.** How the examples split work between the page and its scripts, from a record the page owns to a rule that decides and systems over components.
- `scripting/reach.md`: **What a script can reach.** Every engine module a DriftScript file can import, what the host binds it from, and each function's signature and whether it is deterministic.
- `scripting/testing.md`: **Determinism, testing and shipping.** What @deterministic and @pure promise and how the compiler holds a script to them, testing a script in Node, CI, and what reaches the bundle.

## Rendering

Everything that puts pixels on the screen: meshes and materials, lights and shadows, the sky, the air and water, DriftLight and DriftRay, post-processing, the GPU-driven pipeline, and passes of your own.

- `rendering/meshes.md`: **Meshes and geometry.** Build geometry in code with MeshBuilder or from raw arrays, upload it, rewrite it every frame, and stream big meshes in pieces.
- `rendering/materials.md`: **Materials.** Surfaces from vertex values or image maps, compressed blocks for every device, shading models for metal, hair, skin and eyes, lightmaps and surface dials.
- `rendering/texture-arrays.md`: **Texture arrays and surface effects.** Many images as one texture, chosen per vertex, so a merged mesh of many materials is one draw, with lit windows, rooms, wear and rain.
- `rendering/instancing.md`: **Instancing.** Thousands of copies of one mesh in one call, culled, moved every frame or played as a crowd, still draws recorded once, and foliage in the wind.
- `rendering/splines-and-lines.md`: **Splines, ribbons and lines.** Curves sampled by arc length, banked surfaces swept along them with gaps and colliders, the exact ground on a route, and world-space strokes with real width.
- `rendering/translucency.md`: **Translucent and additive meshes.** Glass that colours the light through it, refraction, light that adds instead of covering, untoned draws, and transparency in any order.
- `rendering/decals.md`: **Decals.** Marks on surfaces two ways: baked into a mesh once from its own triangles, or projected every frame onto whatever was drawn.
- `rendering/lights.md`: **Lights.** Point lights, spots, rectangular lights, measured photometric profiles and cookies, how a frame picks the lights it shades, and thousands of them.
- `rendering/shadows.md`: **Shadows.** The sun's shadow map focused around the player, its static, peeled and moving layers, one caster list for every pass, and the quality dials.
- `rendering/light-in-the-air.md`: **Light in the air.** Shafts of light with dust in them, cut to shape by a window's shadow, fire and smoke plumes, and a medium that fills a room with light.
- `rendering/driftlight.md`: **DriftLight.** Every fixed light in a scene lights the world, near or far: the lights the frame does not shade summed into an occluded volume.
- `rendering/driftray.md`: **DriftRay.** Light that bounces, traced on the GPU through signed distance fields into the probe grid every frame, so a room follows its own changes. WebGPU only.
- `rendering/reflections.md`: **Reflections.** What shiny surfaces show: the sky gradient, a captured room, a grid of probes baked a little at a time, bounced light and an HDR sky.
- `rendering/sky-and-atmosphere.md`: **Sky and atmosphere.** A procedural sky with sun, moon, stars and clouds, a celestial clock for a real latitude and date, and a palette that lights the hours.
- `rendering/fog-and-weather.md`: **Fog and weather.** Height fog and linear fog, the underwater atmosphere, one wind for the scene, rain that stops under roofs, lightning, and storm debris.
- `rendering/water.md`: **Water.** One water for sea, lake, fountain and canal: waves the wind builds, Fresnel and planar reflections, caustics, and the view from below.
- `rendering/wet-surfaces.md`: **Wet surfaces.** A world that gets wet in the rain and dries after, puddles that fade at their rims and mirror the street, and the sheen of an oil slick.
- `rendering/post-processing.md`: **Post-processing.** The scene target screen effects need, brightness kept above white, bloom, ambient occlusion, and multisampled and temporal antialiasing.
- `rendering/colour-and-motion.md`: **Colour and motion.** The tone curve, exposure and an eye that adapts, colour grading with a lookup table, vignette, grain and fades, depth of field and motion blur.
- `rendering/drifttr.md`: **DriftTR.** Draw the scene at a fraction of the output size and rebuild the full picture from this frame and the ones before it, on WebGPU.
- `rendering/gpu-driven.md`: **The GPU-driven pipeline.** A second pipeline for very large scenes on WebGPU: the device culls, picks detail and draws clusters, and shades once per material.
- `rendering/particles.md`: **Particles.** Sparks, smoke and motes from a pool and a batch, deterministic emission, textured sprites and flipbooks, particles placed by your own plan, and birds.
- `rendering/text-and-overlays.md`: **Text and overlays.** A built-in pixel font for heads-up displays, panels and keycaps, a portrait in a box of its own, and distance-field text in the world.
- `rendering/picking.md`: **Picking.** What is under the pointer, from meshes registered for it, with the hit's point and distance, moving pickables, and a set of your own.
- `rendering/custom-passes.md`: **Custom passes and compute.** Add a draw pass of your own, fill targets it owns before the frame opens, dispatch compute on WebGPU, and keep a pass right on both backends.

## Worlds

Ground and the worlds built on it: terrain, worlds bigger than a float, hierarchical detail, worlds built from a kit, procedural solids, splats, textures as programs, streaming, and capture from video.

- `worlds/terrain.md`: **Terrain.** A heightfield whose queries answer the ground that is drawn, a clipmap with matched seams, blended materials, colliders, and heights kept as textures.
- `worlds/large-worlds.md`: **Large worlds.** The cell grid a large world streams in, streaming by where the camera will be, and freezing cells so streaming never changes what the simulation computes.
- `worlds/hierarchical-detail.md`: **Hierarchical detail.** Drawing each region of a world at the level its distance deserves, crossfading between levels, and baking proxies and impostors offline.
- `worlds/worlds-from-a-kit.md`: **Worlds from a kit.** A world built from a few pieces placed many times, carried as its placements in a .drft, expanded by arithmetic, and paged in region by region.
- `worlds/procedural-solids.md`: **Procedural solids.** Closed solids built in code, from boxes and lathes to sweeps, combined by booleans, smoothed, painted and handed to the renderer as meshes.
- `worlds/splats.md`: **Gaussian splats.** Captured places drawn as hundreds of thousands of soft ellipsoids, composed into a scene of meshes, sorted off the frame and streamed in blocks.
- `worlds/drifttexture.md`: **DriftTexture.** Textures as small programs over a latent image, decoded per pixel on the GPU and on the CPU alike, animated by the simulation's clock and carried in .drft.
- `worlds/texture-streaming.md`: **Texture streaming.** Deciding which tiles of a texture are resident by running the simulation ahead to see where the camera will be, and giving up on tiles that will not come.
- `worlds/writable-textures.md`: **Writable textures.** Marks written into a texture at run time, allocated only where they land, recorded beside the input so a replay or a rollback draws the same wall.
- `worlds/driftcapture.md`: **DriftCapture.** A video of a place turned into a surface, a collider, materials and proposed entities on the player's own device, and each stage's measured limits.

## Simulation

Everything that moves on the fixed clock: rigid bodies and their queries, characters, vehicles, ragdolls and cloth, animation, navigation, entities, chemistry and agents.

- `simulation/rigid-bodies.md`: **Rigid bodies.** A deterministic physics world of boxes, spheres, capsules, cylinders, hulls and meshes, with soft contacts, sleeping islands and a fingerprint.
- `simulation/joints.md`: **Joints.** Seven kinds of joint between bodies, with one-sided limits, motors and a breaking load, and a six-degree-of-freedom joint described axis by axis.
- `simulation/queries.md`: **Queries and colliders.** Rays, swept shapes and overlaps against the world, sensors and contact events, a collider set for kinematic movement, and scenery that streams in by region.
- `simulation/characters.md`: **Characters.** A kinematic character controller with coyote time and jump buffering, ground surfaces for roads and decks, water, and an escape for a trapped body.
- `simulation/vehicles.md`: **Vehicles.** A raycast vehicle of a chassis body and wheels that are rays on springs, gripping by tyre curves you supply, on bodies or an analytic road.
- `simulation/ragdolls-and-cloth.md`: **Ragdolls and cloth.** Ragdolls built from a skeleton's joints and driven toward an animated pose, and cloth that hangs, blows, drapes and pushes what it lands on.
- `simulation/animation.md`: **Animation.** Skeletons, clips sampled at a time you supply, blend trees, state machines, two-bone IK, retargeting, root motion, springs and morph targets.
- `simulation/navigation.md`: **Navigation.** Routes over a graph of lanes and roads, and over a navigation mesh built from a level's geometry, with the following of a route in DriftScript.
- `simulation/entities.md`: **Entities.** Generational handles, components as typed columns, systems that declare what they touch, prefabs, saved scenes and rewinds, from DriftScript and TypeScript.
- `simulation/chemistry.md`: **Chemistry.** Matter as parcels of real substances, whose heat, phase changes, burning and smoke follow from conserved energy, steered from DriftScript.
- `simulation/agents.md`: **Agents and behaviour.** Behaviour trees that pause, interrupt and resume, and agent sessions whose deterministic floor keeps them moving while a model answers late.

## Content

Getting what artists make into a game: importing models, the .drft container and how it streams, sound and music, and the tools that bake and check them.

- `content/importing-models.md`: **Importing models.** Reading glTF, OBJ, STL, USD, 3MF, FBX and Blender files, at build time with the baker or in a worker when a player brings a file.
- `content/drft.md`: **The .drft container.** The engine's own file: loaded without parsing, streamed onto the screen as it arrives, and opened by every future reader.
- `content/audio.md`: **Sound and music.** A mix of buses and snapshots, sounds by name, music whose kick drives lights, sounds placed among rooms and walls, and scripts that play it all.
- `content/cli.md`: **Command-line tools.** The baker and its options, comparing two containers, building a distance-field font, the visual gate, the frame audit and the dev servers.

## Interface

How a player reaches the game, and what they see: every input device through one action map, cameras that cut between shots and fly keyed paths, the 2D layer of sprites and tilemaps, menus built as a tree, and a WebXR session read every frame.

- `interface/input.md`: **Input.** Keyboard, mouse, gamepads and touch through one action map, with rebinding and saving, prompts for the device in use, rumble, and scripts that read it.
- `interface/cameras.md`: **Cameras and cinematics.** The camera, a rig that cuts between shots for replays and cinematics, cinematics written as data, keyed camera paths, and re-timing a stretch of play.
- `interface/sprites.md`: **Sprites and tilemaps.** The 2D layer: textured quads batched in the order drawn, sheets cut into frames, tilemaps that cost the view, and a camera for a 2D world.
- `interface/interface.md`: **Interfaces.** Menus and heads-up displays as a retained tree: layout without coordinates, focus, routing, clipping and scrolling, themes, text, and scripts.
- `interface/xr.md`: **XR.** Asking a browser what it can present, entering a WebXR session, and reading the head, controllers and hands each frame. Drawing into a headset is not built yet.

## Systems

What a game keeps, shares and ships: saves and preferences, networking and rollback, recorded clips, the window and the host, and packaged applications.

- `systems/saves.md`: **Saves and preferences.** The store a game saves to, preferences checked field by field, saves to a server that answers later, and a world written out and read back across a change.
- `systems/networking.md`: **Networking and rollback.** Two peers simulating one match over a lossy link, inputs as bytes, a rewind that replays a wrong guess, and an authority with clients that predict.
- `systems/recording.md`: **Recording and clips.** Saving a still, recording a clip as it plays with the mix underneath, and rendering one frame by frame with every frame stamped at its own instant.
- `systems/display.md`: **Display and the host.** The window, the screen and the shell as capabilities a game asks about: window mode and size, orientation, focus and quitting, files, and the boot badge.
- `systems/packaging.md`: **Packaging an application.** Turning a web build into a desktop, mobile or native application with drift-package, and the one host a game writes its settings and its exit against.

## Tools

Looking inside a running game: the panels a shipped build can carry, and the instruments beside them.

- `tools/in-game-tools.md`: **In-game tools.** An inspector, a console, a profiler and a network panel over a running game on a key, with undoable edits, plus core's frame meter and contact probe.

## Coming from another engine

For developers who know another web engine: what each of its ideas is called here, with the same code written in both.

- `coming-from/threejs.md`: **Coming from Three.js.** What a Three.js scene, renderer, animation loop, geometry, light and loader become in DriftEngine, with the same program written in both.
- `coming-from/babylonjs.md`: **Coming from Babylon.js.** What a Babylon.js engine, scene, render loop, mesh builder, light, loader and Havok body become in DriftEngine, with the same program written in both.
- `coming-from/playcanvas.md`: **Coming from PlayCanvas.** What a PlayCanvas application, entity, component, script, light, asset and rigid body become in DriftEngine, with the same program written in both.
