---
title: Packages
description: How the engine divides into packages, what each one costs in a build, how they depend on each other, and which to install for what.
packages: ['@driftengine/core']
---

# Packages

DriftEngine is a set of npm packages under the `@driftengine` scope, all released together on one
version line. A game installs `@driftengine/core` and adds the others as it needs them.

<!-- packages -->

## What core is, and what it brings with it

`@driftengine/core` is the runtime: the loop, the renderer and its passes on both backends, the
scene graph and culling, cameras, input, geometry builders, maths, storage and preferences. It
depends on two other packages and re-exports both, so you can import their names from core:

- **`@driftengine/physics`** in full. The cameras and the ribbon builder use its collision sweep, so
  core cannot be built without it, and re-exporting it means `PhysicsWorld` and
  `CharacterController` come from the same import as `createRenderer`.
- **`@driftengine/drft`** for the mesh data type every package shares, `MeshData`. Its validator,
  `validateMeshData`, is imported from `@driftengine/drft` itself.

Everything else is optional, and a package that builds on core declares it as a peer dependency.

## Every package on one version

Each package pins the exact version of every engine package it depends on, so a project uses one
version for every `@driftengine` package it installs. Upgrade them together:

```sh
npm install @driftengine/core@latest @driftengine/audio@latest @driftengine/assets@latest
```

A mismatch is caught by npm at install time, as an unmet peer dependency, which is a better place to
find it than a missing export at run time.

## What each costs

The engine's size gate builds each entry point on its own and fails the engine's CI if the gzipped
size moves more than 3% from the figure it holds. These are those figures, read from the gate at the
release this site documents:

<!-- sizes -->

Most of core is shader source, generated WGSL for every combination of features the lit pass can be
built with. Shader text barely minifies, which is why the optional packages look small beside it.

Features that live inside the lit pass cannot be packages, so they are compiled in only when a
quality option asks for them: physically based maps, spot and area lights, clustered lighting,
image-based lighting, depth of field, screen-space reflection, temporal antialiasing, colour
grading and decals. A driver compiles the text it is given, so a feature that is off costs no GPU
time.

## Which package for what

| You want                                                       | Install                    |
| -------------------------------------------------------------- | -------------------------- |
| A renderer, a loop, input, cameras, collision and rigid bodies | `@driftengine/core`        |
| Models from glTF, OBJ, FBX, USD, STL, 3MF or Blender           | `@driftengine/assets`      |
| Music, sound effects, positional audio                         | `@driftengine/audio`       |
| Skeletal animation, blending, IK                               | `@driftengine/animation`   |
| Sprites, tilemaps and an interface tree                        | `@driftengine/ui2d`        |
| Entities, components and systems                               | `@driftengine/entities`    |
| Multiplayer: lockstep, prediction, rollback                    | `@driftengine/network`     |
| Navigation meshes and pathfinding                              | `@driftengine/nav`         |
| Heightfield terrain                                            | `@driftengine/terrain`     |
| Gaussian splat captures                                        | `@driftengine/splats`      |
| Textures as compiled programs, streamed                        | `@driftengine/texture`     |
| A video turned into a scene                                    | `@driftengine/capture`     |
| Recording video of the game                                    | `@driftengine/media`       |
| VR and AR through WebXR                                        | `@driftengine/xr`          |
| Language-model agents with typed tools                         | `@driftengine/ai`          |
| Chemistry of bulk matter: fire, smoke, reactions               | `@driftengine/chemistry`   |
| Editor panels inside a shipped game                            | `@driftengine/tools`       |
| The scene editor's model                                       | `@driftengine/editor`      |
| DriftScript bindings to the engine                             | `@driftengine/script`      |
| Desktop and Android builds of the game                         | `@driftengine/package`     |
| Running with no browser                                        | `@driftengine/native-host` |

## Three packages that need nothing else

`@driftengine/physics`, `@driftengine/entities` and `@driftengine/chemistry` import no other engine
package. A server that runs a simulation, or a worker that steps one, can import any of them without
pulling a renderer into its module graph. That's what makes an authoritative multiplayer host
possible in plain Node.

## Built JavaScript or TypeScript source

Every package ships compiled JavaScript with declaration files, and that is what a bundler and Node
find by default. Every package also ships its TypeScript source behind the `drift-source` export
condition, for a project that depends on a checkout of the engine and wants an edit to it live with
no build; [Installation](../start/installation.md) covers that set-up.
