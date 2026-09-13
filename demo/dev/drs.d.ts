/// <reference types="driftscript/drs" />

/*
 * What TypeScript knows about `import * as pulse from './pulse.drs'`.
 *
 * **One line, and it replaced a file this repository used to own.** The declaration lived in
 * `packages/driftscript/src/drs.d.ts`, which the engine's tsconfig picked up because it sat under
 * `packages/*​/src`. `driftscript` is an installed dependency now, and a `declare module` inside a
 * dependency is invisible unless the file is in *your* compilation — so it has to be referenced,
 * and the package ships an `exports` entry for exactly that.
 *
 * It declares `__drift` and deliberately not the generated exports: a `.drs` file's exports depend
 * on what it declares, and knowing them means compiling it. The demos reach a generated function
 * through `Record<string, unknown>`, which is uncomfortable on purpose.
 */
