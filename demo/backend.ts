/**
 * Which backend the scenes in this directory ask for, decided once rather than eight times.
 *
 * **WebGPU where the browser has it.** These scenes are the engine demonstrating itself, and
 * both products this engine ships to now prefer WebGPU, so a demo that quietly drew on the older
 * path would be advertising a backend nobody runs. `?backend=webgl2` still forces the other one
 * in every build, and a browser with no usable adapter falls back on its own and says which it
 * used through `DemoHandle.backend` — so this changes which path is preferred and nothing about
 * which paths exist.
 *
 * **Here rather than in each scene**, for the reason `lightVolumeDraw.ts` gives about the clamp:
 * eight copies of a choice is eight places for them to stop agreeing, and a host mounting two
 * scenes onto one page would then be comparing backends without being told.
 *
 * **`demo/dev/` deliberately does not use this.** Those pages are comparison instruments — they
 * exist to be photographed on one backend and then the other — so they stay on the engine's own
 * default and take `?backend=` explicitly. A harness that silently preferred one side is a
 * harness that cannot be trusted to report a difference between the two, which is the whole of
 * what it is for.
 *
 * **And no engine badge, for the same reason it is decided once.** These scenes are sections of a
 * page rather than a game booting: a host mounts several of them, and one that covered the whole
 * viewport in black for three seconds every time somebody scrolled to it would be an interruption
 * and not a cover. `splash: false` here is what `driftengine.dev` inherits — a site that never
 * repeats the opt-out in its own code cannot forget it on the one demo it adds next.
 */
import type { CreateRendererOptions } from '../packages/core/src/index';

export const DEMO_BACKEND: CreateRendererOptions = { preferWebGpu: true, splash: false };
