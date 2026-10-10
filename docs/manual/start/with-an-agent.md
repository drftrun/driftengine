---
title: Working with a coding agent
description: Start a project a coding agent can build on, give the agent the engine's skill, and check every change by looking at the game on both backends.
packages: ['@driftengine/create', '@driftengine/core']
plain: ['CHROME_PATH']
covers: ['Coding agents']
---

# Working with a coding agent

DriftEngine is built to be written by a coding agent as well as by a person. Each package has one
typed entry point, and its exports carry their documentation with them as comments. A game's rules run in Node with no GPU, so a test
of a rule is a test of the game. And a project can look at its own game on both backends and say
in words what it saw. This page sets a project up so that an agent, such as Claude Code, Codex or
Cursor, works with all three.

## Start a project

```sh
npm create @driftengine@latest my-game
cd my-game
npm install
npm run dev
```

That starts from a lit cube turning at a rate a DriftScript rule decides. For a complete 3D game
to build on, with physics, a character, sound, shadows and a HUD, name the other template:

```sh
npm create @driftengine@latest my-game -- --template first-game
```

The command asks nothing and installs nothing, so an agent can run it unattended. It writes a Vite
and TypeScript project, its program under `src/`, and three things for an agent:

```text
my-game/
  AGENTS.md                        how this project works, and when a change is done
  .agents/skills/driftengine/      the engine's skill, where Codex, Cursor and others look
  .claude/skills/driftengine/      the same skill, where Claude Code looks
  scripts/look.mjs                 npm run look: the game photographed on both backends
```

`AGENTS.md` is the file most coding agents read on their own when they open a project, Claude Code
among them unless the project gives it an instructions file of its own. It lists the commands, the rules the compiler
cannot check, and what done means here. The skill is longer and is read when the work needs it:
the shape of a program, the traps that look like problems in the engine, and where every page of this
manual and every example is, at the version the project installed.

## Check every change

```sh
npm run check
```

`check` runs `typecheck`, then `test`, which runs the project's tests in Node, then `look`. `look`
starts the game, opens it once with `?backend=webgpu` and once with `?backend=webgl2` in Chrome, or
in Edge where Chrome is not installed, on the machine's own GPU, and writes what it saw:

```text
.driftengine/look/webgpu.png    what a player sees on WebGPU
.driftengine/look/webgl2.png    and on WebGL2
.driftengine/look/look.json     the report, with every console line
```

It fails on a console error or warning, on a canvas of one flat colour, and when the backend it
asked for is not the one that drew. It exits with 2 when it cannot look at all: when it finds no
browser, which `CHROME_PATH` answers, or no hardware GPU, which it refuses rather than trust a
software rasteriser's picture. `npm run look -- --headed` opens a real browser window, which reaches
the GPU on a machine where a headless browser does not.

A report can say a frame is not empty. Only looking says it is the right frame, so the project's
`AGENTS.md` tells the agent to open both pictures before it says a change works. Most agents can
read an image.

`look` runs on Windows, macOS and Linux. It has been measured on Linux; on Windows and macOS it uses
each system's own graphics path through ANGLE, Direct3D 11 and Metal, and reports the GPU it found
on its second line, which is the line to read the first time.

## Add the skill to a project you already have

From the project's directory:

```sh
npm create @driftengine@latest . -- --skill
```

That writes the skill into both folders and replaces an older copy of it, touching nothing else.
Run it again after upgrading the engine, so the skill describes the version installed.

The skill is also in the engine's repository, in `skills/driftengine/`, where tools that install
skills from a repository find it:

```sh
npx skills add drftrun/driftengine
```

That copy follows the repository's main branch rather than the version a project installed. To
make the skill available in every project, copy the `driftengine` folder into
`~/.claude/skills/` for Claude Code, or `~/.agents/skills/` for Codex and Cursor.

## What the agent can read

- **The installed types.** `node_modules/@driftengine/core/dist/index.d.ts` names every export of
  the version the project runs and the module each comes from, whose own declarations document it,
  and so does each other package's. DriftScript's own reference is
  `node_modules/driftscript/docs/LANGUAGE.md`.
- **This manual, at that version.** Each page is Markdown in the engine's repository, at the tag of
  every release, and the skill lists every page's address.
- **The examples**, one capability each, at the same tag. [Hello world](hello-world.md) and
  [Your first game](first-game.md) are the two templates, explained.
- **The whole manual as one file**, for an agent that searches rather than browses:
  `https://driftengine.dev/llms-full.txt`, with an index of every page at
  `https://driftengine.dev/llms.txt`.

## What still needs a person

`look` sees the first seconds after the game starts. It does not play the game, so a level reached
by playing, a menu behind a key press, and how the controls feel are not in its pictures. Nor is how
fast the game runs on a phone, which only a phone can say: [Shipping to the web](shipping-to-the-web.md)
covers testing on one.
