/// <reference types="driftscript/drs" />

/*
 * What TypeScript knows about `import * as m from './x.drs'`.
 *
 * One line, and the same one `demo/dev/drs.d.ts` carries for the same reason: `driftscript` is an
 * installed dependency, and a `declare module` inside a dependency is invisible unless the file is
 * in *your* compilation. The package ships an `exports` entry for exactly this.
 *
 * It declares `__drift` and deliberately not the generated exports: a `.drs` file's exports depend
 * on what it declares, and knowing them means compiling it. The host reaches a generated module
 * through `Record<string, unknown>`, which is uncomfortable on purpose.
 */
