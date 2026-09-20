/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * The engine on a native window and a native WebGPU device: Node, Dawn and SDL, with no browser
 * between them.
 *
 * **Two calls are the whole surface.** `runGame` is what a packaged game's generated entry calls:
 * it starts the host, mounts the game's native entry on the canvas, and draws until the window
 * closes. `startHost` is the same start without a game, for a tool that drives its own frames —
 * the engine repository's scene runner and editor runner are two.
 *
 * Everything a page reads around the canvas — events, pointer lock, fullscreen, gamepads, audio,
 * storage — the host installs as a browser would have it, so the engine and the game run unchanged.
 * The modules that do it are in `src/` and are private.
 *
 * **One capability a page has no equivalent of is offered as well**: `tileFiles`, the texture
 * streamer's tiles read from a directory on disk, for a game's native entry to hand its streamer
 * where a page would fetch them over HTTP.
 */

export { runGame } from './game.ts';
export type { GameEntry, GameOptions } from './game.ts';
export { configDirectory, startHost } from './runtime.ts';
export type { FrameCall, HostOptions, NativeHost, RunOptions } from './runtime.ts';
export { tileFiles } from './tileFiles.ts';
