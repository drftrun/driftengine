/// <reference types="driftscript/drs" />

/*
 * What TypeScript knows about a `.drs` module, for the host's own compilation.
 *
 * The host mounts the published scenes, and the voxel sandbox imports two DriftScript modules; the
 * demos carry this same line in `demo/voxelSandbox/drs.d.ts`, which is in the engine's compilation
 * and not in this one. `preload.mjs` is what compiles them at run time.
 */
