# `@driftengine/create`

Starts a DriftEngine game: a Vite and TypeScript project that runs, the instructions a coding agent
reads when it opens the project, and the engine's skill.

```sh
npm create @driftengine@latest my-game
npm create @driftengine@latest my-game -- --template first-game
cd my-game
npm install
npm run dev
```

**It never asks a question.** Every choice has a default and a flag, because the caller is as
likely to be an agent as a person, and an agent cannot answer a prompt. It installs nothing either;
the next steps it prints say to.

| Option              | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `[directory]`       | Where the project goes. It must be empty, or hold only `.git`. Defaults to `my-game` |
| `--template <name>` | `starter`, a lit cube and a rule in DriftScript, or `first-game`, a complete 3D game |
| `--skill`           | Add the skill to an existing project instead, replacing an older copy of it          |
| `--help`            | The options and the templates                                                        |

## What a project holds

```text
my-game/
  package.json            the engine at this package's version, the language pinned exactly
  index.html  src/        the program, from the engine repository's typechecked examples
  vite.config.ts          the DriftScript plugin and the modules a script may import
  tsconfig.json
  AGENTS.md               how the project works, and when a change is done
  .agents/skills/driftengine/   the skill, where Codex, Cursor and others read skills
  .claude/skills/driftengine/   the same skill, where Claude Code reads it
  scripts/look.mjs        npm run look
```

`npm run check` typechecks, runs the tests in Node, and runs `look`, which serves the game, opens
it with `?backend=webgpu` and with `?backend=webgl2` in Chrome or Edge on the machine's own GPU,
and writes `.driftengine/look/webgpu.png`, `webgl2.png` and `look.json`. It fails on a console
error or warning, a canvas of one flat colour, or a backend that was asked for and not used, and it
exits with 2 when it cannot look at all. The photographing is
`@driftengine/core/scripts/look.mjs`, so a project that starts some other way can call it too.

## Where the files come from

`templates/` is generated from the engine repository's `examples/` and `skills/driftengine/` by
`npm run create:templates`, and a test fails when the copy is stale, so a project starts as code the
compiler and the examples page have already run. `shared/` is what every template has around its
program. `npm run cleanroom` in the engine repository starts every template from the packed
tarballs, installs it, and typechecks, tests and builds it.

**What it gives up**: the templates are two. A third is one entry in `scripts/create-templates.mjs`
naming an example, and an example that imports from `examples/common/` cannot be one until it stops.
