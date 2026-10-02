---
title: Patterns
description: How the examples split work between the page and its scripts, from a record the page owns to a rule that decides and systems over components.
packages: ['@driftengine/script']
plain: ['Director', 'Lamp', 'Autosave', 'Store', 'Actions']
---

# Patterns

Every example in this manual that has behaviour keeps it in DriftScript, and they divide the work
the same few ways. This page names each one and shows the example it comes from, so a new game can
pick the shape before writing the first rule.

## A record the page owns

```drs sample=xr/headset.drs#lamp
// The lamp follows the right trigger while a session is running and the controller is tracked. A
// headset taken off ends the session, and the lamp goes out with it.
fn light(lamp: mut Lamp, dt: f32) {
    var want: f32 = 0
    if xr.presenting() && xr.holding("right") {
        want = xr.trigger("right")
    }
    lamp.level = lamp.level + (want - lamp.level) * math.min(1, lamp.ease * dt)
}
```

The commonest shape, and the one to start from. The script declares a `data` record and the
functions that change it; the page creates the record once, keeps it, passes it in, and reads it
back to draw. Here the XR example's lamp eases toward the right trigger, and the page sets the
light's colour from `lamp.level` every frame.

The record is the line between the two halves. Everything the rule needs to remember goes in it,
so a function has nothing hidden to lose when a save replaces it, and everything the page needs to
draw comes out of it, so the page never asks the script how it reached a number. When a record gains
a field in a save, the live one gains it too, with its declared default.

## Deciding, and acting on the decision

```drs sample=cinematic/director.drs#direct
// A take-off cuts at once, across the line of travel and low, the shot that sells a gap; a landing
// cuts to an orbit round it. Otherwise a shot holds its time, the tower is framed when the buggy
// passes it, and a long shot gives way to the next in turn.
fn direct(director: mut Director, cam: Camera, airborne: bool, nearTower: bool) -> i32 {
    let age = camera.shotAge(cam)
    var want = director.shot
    if airborne && !director.flying {
        want = LOW_WIDE
    } else if !airborne && director.flying {
        want = ORBIT
    } else if age < director.least {
        want = director.shot
    } else if nearTower && director.shot != LOOK_AT {
        want = LOOK_AT
    } else if age > director.most {
        want = next(director.shot)
    }
    director.flying = airborne
    if want == director.shot {
        return -1
    }
    director.shot = want
    director.cuts += 1
    return want
}
```

The cinematic example's director decides which shot the camera cuts to and when. It returns a
number, the index of a shot in a list the page holds, or `-1` to stay on the current one, and the
page makes the cut with the camera rig it owns. The script never moves the camera. It reads one
fact from it, `camera.shotAge(cam)`, through the rig the page passed in, and answers a question.

This is the shape for anything with taste in it: which animation to blend to, which line a character
says, when an enemy gives up a chase. The decision is the part tuned by watching, so it goes in the
script. The doing needs the engine's objects, so it stays in the page:

```ts sample=cinematic/main.ts#director
const script = hostScript(directorScript);
interface Director {
  shot: number;
  cuts: number;
}
const director = exported<() => Director>(script, 'createDirector')();
type Direct = (
  director: Director,
  camera: CinematicCamera,
  airborne: boolean,
  nearTower: boolean,
) => number;
if (import.meta.hot) {
  import.meta.hot.accept('./director.drs', (next) => {
    if (next !== undefined) {
      patchModule(script, next as Record<string, unknown>, { Director: [director] });
    }
  });
}
```

## Engine objects as arguments

A script cannot create an engine object or look one up. It uses the ones it is handed:

- the puck's rules read the controls through the page's `ActionMap`, passed as `actions`;
- the director reads the age of a shot from the page's camera rig, passed as `cam`;
- the garden's autosave writes through the page's store, passed as `store`:

```drs sample=saves/garden.drs#autosave
data Autosave {
    // Seconds between autosaves, and since the last one.
    every: f32 = 5
    since: f32 = 0
    written: u32 = 0
    // How many were held back because the one before had not landed.
    held: u32 = 0
}

// The page offers the garden once a second and the script decides whether it is written. An
// autosave waits while the last one is still on its way, so a slow server is never handed a queue.
fn autosave(auto: mut Autosave, store: Store, garden: String, dt: f32) -> bool {
    auto.since = auto.since + dt
    if auto.since < auto.every {
        return false
    }
    if persistence.pendingSaves(store) > 0 {
        auto.held = auto.held + 1
        return false
    }
    persistence.write(store, "driftengine.examples.saves.auto", garden)
    auto.since = 0
    auto.written = auto.written + 1
    return true
}
```

The types (`Actions`, `Camera`, `Store`) are opaque in the script. It can pass one to the engine
functions that take it and do nothing else with it. That is what makes a script safe to replace in a
running game: everything a function can affect arrives through its own arguments, and the page
decides what those are each time it calls.

## Services the page gives once

Some engine modules act on something that belongs to the whole game, the entity world, the mixer,
the navigation graph, and passing it to every call would be noise. The page gives those once, at
bind, in `services`. The XR example hands `drift/xr` the session it reads; the audio example hands
`drift/audio` its graph and sound registry; the entities and saves examples hand `drift/ecs` the
component registry their script declared. [Setting up scripts](setting-up.md#what-a-host-gives)
lists all eight.

## Systems over components

```drs sample=entities/pond.drs#hunt
// Four times a second, each rested frog fixes on the nearest fly within its reach.
system Hunt {
    reads Fly
    reads Position
    writes Frog

    update at 4Hz {
        for frog in query<Frog, Position>() {
            if frog.Frog.resting > 0 {
                continue
            }
            var best = frog.Frog.reach * frog.Frog.reach
            frog.Frog.aiming = false
            for fly in query<Fly, Position>() {
                let dx = fly.Position.x - frog.Position.x
                let dy = fly.Position.y - frog.Position.y
                let dz = fly.Position.z - frog.Position.z
                let distance = dx * dx + dy * dy + dz * dz
                if distance < best {
                    best = distance
                    frog.Frog.aiming = true
                    frog.Frog.target = fly
                }
            }
        }
    }
}
```

When a rule applies to many things of one kind, frogs, flies, plants, it is a `system` over
`component`s, declared in the script. A system says which components it reads and writes, how
often it runs, and loops over a query; the engine's schedule runs the systems each step in an order
their reads and writes allow. The page registers the script's components and systems once and steps
the schedule, and it can read any component back to draw. [Entities](../simulation/entities.md)
covers components, prefabs, systems and rewinding in full, and
[Saves and preferences](../systems/saves.md) writes a whole world of them out and reads it back.

## Many small files

A script is a module, and a game is better as several than as one. A `.drs` file can import another
by a relative path (`import { start } from "./round"`), and anything else it imports is an engine or
language module. A `data` record can extend another and stand in for it wherever the base is
expected. Keep one file per subject: the round, the enemies, the pickups, the camera. A save then
replaces one subject's rules and nothing else's, and each file's imports say exactly which engine
modules that subject touches.

## What stays out of a script

- **Drawing.** A script never calls the renderer. It decides what is drawn and the page draws it.
- **Loading.** Models, textures, sounds and levels are loaded by the page, which hands the script
  what it needs once they exist.
- **Anything that reads the wall clock or the input inside the fixed step.** Rules that run in the
  simulation see the step's time and the step's input, which the page passes in, so a recorded game
  replays. [Determinism, testing and shipping](testing.md) has the annotation that enforces it.
- **The platform.** Storage, the network and a desktop shell are the page's; a script reaches them
  only through what it is handed, as the garden reaches its save store.
