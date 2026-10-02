---
title: Introduction
description: What DriftEngine is, what ships in it, how its packages divide, and where to start reading this manual.
packages: ['@driftengine/core']
---

# Introduction

DriftEngine is a 3D game engine written in strict TypeScript. It draws with WebGPU, and falls back
to WebGL2 when a browser can't give it a usable WebGPU device. Your game code doesn't change between
the two: you ask for a renderer, and the engine tells you which backend it got and why.

A game built on it ships as a web page. The same build can also be packaged as a desktop app for
Linux, Windows or macOS, or as an Android app, and it can run on a native window with no browser in
the process at all.

You write a game as a program. You create a renderer on a canvas, build or load meshes, step a
simulation on a fixed clock and draw frames. There is an editor, with a scene tree, an inspector and
a timeline you can scrub backwards, but nothing in the engine requires you to use it.

## What ships

**Rendering.** A forward renderer with clustered lighting, cascaded sun shadows, point and spot
lights with their own shadows, rectangular area lights, physically based materials, ambient
occlusion, bloom, colour grading and motion blur. On WebGPU there is more: a GPU-driven path that
culls instances and clusters on the device and draws them with one indirect call, DriftTR temporal
reconstruction, which renders below output resolution and resolves back up, DriftRay traced indirect
light, and DriftLight, which lets thousands of fixed lights reach a frame.

**Worlds.** Heightfield terrain whose levels of detail meet without cracks, worlds larger than
single precision can address, hierarchical detail for distant geometry, streaming that does its
work in slices of a frame, Gaussian splats, and DriftTexture, where a texture is a small compiled program over a
learned field instead of an image.

**Simulation.** A deterministic physics engine of its own: rigid bodies, seven kinds of joint, a
character controller, raycast vehicles, ragdolls, cloth and buoyancy. Skeletal animation with blend
trees, state machines, two-bone IK and retargeting. Navigation meshes, an entity component system,
and agents.

**Content.** Models import from glTF, OBJ, FBX, USD, STL, 3MF and Blender files, and bake into the
`.drft` container, which streams a coarse outline of a model while its geometry downloads. Audio has
a mix tree, positional sources, reverb zones, and a synthesised stand-in for every sound you haven't
recorded yet.

**Interaction.** Keyboard, mouse, touch and gamepads behind one action map. Cameras, including a
third-person rig that won't put its lens inside a wall. A 2D layer for sprites and interface, and
WebXR.

**Systems.** The simulation runs on a fixed step with seeded randomness, so a run can be replayed
exactly, and the networking is built on that: lockstep, and an authoritative host with prediction
and rollback. Video capture, saves, and DriftScript, a scripting language whose modules reload while
the game keeps running.

**Shipping.** Desktop and Android apps from one manifest, Steam cloud saves and achievements, and a
native host.

## Packages

Install what you use and nothing else. `@driftengine/core` is the runtime every game needs: the
loop, the renderer, input, cameras, the scene graph and geometry. It also re-exports the whole of
`@driftengine/physics`. Every other package is optional and takes core as a peer dependency, so
one you never install costs you nothing.

<!-- packages -->

## The shape of the API

The engine takes positions, colours, sizes and time, and it doesn't know what your game is. You
won't find a player class to subclass or a level format to adopt: the rules, the world and the HUD
are yours. That makes the first program a little longer than in an engine that decides those things
for you, and it means you can replace any one piece when you outgrow it.

Three rules run through every page of this manual, and the examples follow all of them.

1. **Import only from a package's top level.** `@driftengine/core` is the public surface. Anything
   you can't import from there is internal and can change without notice.
2. **Don't allocate in the frame.** Build meshes, nodes and buffers once, and rewrite them in place.
3. **Interpolate on `alpha`.** The simulation advances in fixed steps and the display doesn't, so
   anything that moves is drawn between its last two states.

## Where to start

Read [Installation](installation.md), then [Hello world](hello-world.md), which puts a lit, turning
cube on the screen in about a hundred lines. [The loop](the-loop.md) and
[Moving things](moving-things.md) explain the two ideas every game here is built on, and
[Your first game](first-game.md) puts them together into a complete game you can play in this page.
