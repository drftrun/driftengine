# my-game

A game built on [DriftEngine](https://driftengine.dev).

```sh
npm install
npm run dev      # serve it with hot reload
npm run check    # typecheck, test, and look at it on WebGPU and WebGL2
npm run build    # static files in dist/
```

`src/main.ts` is the program and `src/*.drs` are its rules in DriftScript. `AGENTS.md` is written
for a coding agent working in this project, and the `driftengine` skill in `.agents/skills/` and
`.claude/skills/` teaches it the engine.

The [manual](https://driftengine.dev/docs) explains each system with code that runs, and the
[examples](https://github.com/drftrun/driftengine/tree/main/examples) are small programs, one
capability each.
