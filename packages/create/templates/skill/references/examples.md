# The examples

Small programs, one capability each, typechecked with the engine and runnable with
`npm run examples` in its repository. Generated from the table in `examples/README.md`.

Each folder is at `https://github.com/drftrun/driftengine/tree/v<version>/examples/<name>`, and its program is
`https://raw.githubusercontent.com/drftrun/driftengine/v<version>/examples/<name>/main.ts`, where
`<version>` is the installed engine's, from `node -p "require('@driftengine/core/package.json').version"`,
so what it says matches the code the project runs.

- `starter/`: A lit cube turning at a rate a DriftScript rule sets. **The one to copy out** to start a game.
- `first-game/`: A complete 3D game: physics, a character, shadows, sound, a HUD, and its rules in DriftScript.
- `game-2d/`: A whole game — paddle, ball, bricks, score, lives, win and loss — laid out in the XY plane.
- `postprocess/`: Ambient occlusion, bloom, and the two settings bloom is useless without.
- `antialiasing/`: `sceneSamples` at 1 and at 4, on the edges where the difference is visible.
- `overlay-text/`: Screen-space panels and the built-in font, a keycap prompt, and a portrait in a box of its own.
- `lines/`: Strokes with width in metres, an antialiased edge, and a buffer rewritten in place.
- `materials/`: Image maps built in code, metalness and roughness, and the per-draw surface dials.
- `instancing/`: Ten thousand rocks in culled batches, and a batch rewritten every frame.
- `lights/`: Lamps that cast, a spot with a cookie, a photometric profile and a window that is an area light.
- `lightmaps/`: A room lit by a bake: a page read at each surface's second coordinates, and a shadow in it.
- `driftlight/`: Seven hundred candles, the sixteen nearest shaded exactly and the rest summed by DriftLight.
- `driftray/`: Bounced light traced on the GPU, following a wall that changes colour. WebGPU.
- `air/`: A sunbeam through a window, fire and smoke, and a medium that fills the room.
- `sky/`: A day in ninety seconds: sun, moon, stars, clouds, and lamps that come on at dusk.
- `weather/`: Fog, one wind, rain, lightning and puddles that mirror the street.
- `water/`: The open sea under three winds, a planar reflection, and caustics under a pier.
- `look/`: Exposure, a colour grade, vignette, grain, a fade, depth of field and motion blur.
- `drifttr/`: The scene drawn smaller and rebuilt to full size by temporal reconstruction. WebGPU.
- `gpu-driven/`: 2,500 meshes culled and drawn by the GPU-driven pipeline. WebGPU.
- `particles/`: Sparks, smoke and motes from pools, emitted deterministically.
- `picking/`: Hover and click: what is under the pointer.
- `terrain/`: A valley drawn as a clipmap, painted and planted by rules in DriftScript.
- `streaming/`: A town far from the origin, streamed in cells by prediction, with walkers that freeze and thaw.
- `hlod/`: A city of 144 blocks drawn at the level of detail each one's distance deserves, crossfaded.
- `kit/`: A street built from copies of three pieces, as placements and expanded, with rules in a script.
- `solids/`: A gatehouse built from closed solids, with windows and a doorway cut by booleans.
- `splats/`: A rock garden of Gaussian splats, sorted off the frame, with geometry standing in it.
- `drifttexture/`: Materials as programs decoded per pixel, one animated by the simulation's clock. WebGPU.
- `scorch/`: A wall a scripted turret scorches, with a clock that runs backwards and burns the marks again.
- `capture/`: A synthesised clip of a room fused into a surface, proposed as entities, that balls land on.
- `physics/`: A wall of crates, a ramp of rolling shapes, and a cannon scripted in DriftScript.
- `joints/`: A bridge of hinged planks, a door on a motor, a swinging lamp and a breakable chain.
- `queries/`: A laser casting rays, a sensor counting what stands on it, and a kinematic wall.
- `character/`: A character controller in a valley of steps, a slab, a bridge and a pond.
- `vehicle/`: A raycast car on a ring of cones, driven by a DriftScript driver or by you, on tarmac or ice.
- `ragdoll/`: A ragdoll shoved down the stairs, a flag in a gusting wind, and a sheet dropped over a crate.
- `garment/`: A figure walking a circle in a cape: skinned cloth on the device, and a finer mesh bound to it.
- `animation/`: A figure walking a circle on a blend tree, reaching for a lantern, its pace set in DriftScript.
- `navigation/`: Villagers walking lanes in DriftScript, and dogs crossing a square on a mesh built from it.
- `entities/`: Frogs catching fireflies over a pond, every rule a DriftScript system, with time that rewinds.
- `chemistry/`: A campfire where everything heats at its own rate, with rain, wind and green wood scripted.
- `agents/`: Villagers whose routines shelter from the rain and resume, and a crier who asks a model.
- `models/`: A turntable that reads glTF, OBJ and STL in a worker and streams them, or a model you drop.
- `audio/`: A courtyard heard from the camera: a scripted bell, a muffled cart, lanterns on the kick.
- `input/`: A puck driven by keys, a gamepad or a thumb, a controls screen that rebinds, and rumble.
- `cinematic/`: A buggy and a jump, cut by a scripted director, a cinematic as data, and a keyed path.
- `sprites/`: A tilemap garden and a gardener who picks its flowers, one sprite pass, in DriftScript.
- `interface/`: A pause menu and options over a running scene: laid out, themed, clipped, in DriftScript.
- `xr/`: A headset across a room: its head, controllers and hand read each frame, a lamp on the trigger.
- `saves/`: A garden bed that saves to a server that can fail, loads across a change, and keeps preferences.
- `recording/`: A still, a clip recorded as it plays, and one rendered frame by frame with its score.
- `display/`: A video settings screen drawn from what the host says it can do, and why where it cannot.
- `tools/`: An inspector, a console and a profiler over a running game, and edits that undo.
- `netplay/`: Two players in one match over a lossy link, rewinding when a guess was wrong, staying in step.
