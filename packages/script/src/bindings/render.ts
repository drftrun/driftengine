import type { RendererApi } from '@driftengine/core';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const RENDER_MODULE = 'drift/render';

/**
 * `drift/render` — how the finished image is presented, for the frame about to be drawn.
 *
 * **The linker refused this module by name from the day the language shipped until now**, and the
 * roadmap slot it was waiting on was Track D. Track D completed on 2026-09-03 with refraction, so
 * the wait ended five releases before anything noticed — `docs/CAPABILITIES.md` still mapped this
 * module to a track that had closed, while `host.test.ts` had already been corrected to say it
 * waits on a row of its own. Two documents, one right.
 *
 * ## What this module is, which is a smaller thing than "the renderer"
 *
 * `RenderQuality` has fifty fields and **none of them are here.** The engine already draws
 * the line this module needs, in `renderQuality.ts`'s own words about depth of field:
 *
 * > A ceiling rather than the effect [...] this says how far a defocused point may spread and
 * > therefore what the pass may cost, and `setDepthOfField` says where this frame's lens is focused
 * > and how much of the ceiling it takes. A camera focuses on a subject; a quality profile decides
 * > how expensive that is allowed to be.
 *
 * **A quality profile is the application's and a dial is the game's.** A profile is chosen once,
 * from what the device can afford, and is clamped by `capabilityClamp` against what the adapter
 * actually reports; a script that wrote to one would be overruling a decision made about hardware
 * it cannot see, and two machines running the same script would draw different pictures for
 * reasons the script did not choose. So this module binds the seven dials and none of the ceilings.
 *
 * ## Writes only, and the reason is the same one
 *
 * There is no `render.bloomOf` here, and nothing reads a dial back. Every one of these is **clamped
 * against the ceiling the host set** — `setBloom` does nothing at all when `bloom` is 0, because
 * the chain is never built — so what a read would answer is a fact about the machine wearing the
 * costume of a fact about the frame. The language wrote this argument once already, for
 * `network.read` and a confirmed-input watermark: a host registering a machine-dependent number
 * under a deterministic effect hands a `@deterministic` system a value that differs between a run
 * and its replay. A script sets a dial; what the device did with it is the device's business.
 *
 * ## The effect, which needed no language release
 *
 * **`scene.write`, and it is a description rather than a borrowing.** `capability.ts` puts
 * `scene.write` outside `DETERMINISTIC_EFFECTS` and says exactly why: *"a `SceneNode` is what
 * draws, and `ARCHITECTURE.md` forbids render code mutating simulation state, so moving a node is
 * a change to the view."* Every capability here is a change to the view and nothing else — the
 * renderers' own comments call these *"a renderer parameter rather than a scene one: it describes
 * how the finished image is presented, not anything in the world, which is why nothing about the
 * world has to know it exists."* Two files arriving at the same sentence from opposite ends is the
 * argument.
 *
 * So no capability here is deterministic, and that is the property rather than a limitation: a
 * `@deterministic` system may not dim the screen. Presentation belongs outside the fixed step,
 * where the frame is.
 */
export const RENDER_TYPES: readonly OpaqueType[] = [
  {
    module: RENDER_MODULE,
    name: 'Renderer',
    doc: 'The renderer drawing this frame. Reaches a script through `uses`.',
  },
];

const define = (
  name: string,
  params: readonly { name: string; type: string }[],
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module: RENDER_MODULE,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> void`,
    params: [...params],
    returns: 'void',
    effects: ['scene.write'],
    deterministic: false,
    doc,
    implementation: `${RENDER_MODULE}.${name}`,
  });

const R = { name: 'renderer', type: 'Renderer' } as const;

export const RENDER_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    'bloom',
    [R, { name: 'scale', type: 'f32' }],
    "How much of the frame's bloom ceiling to take, 0 to 1. Held until changed. Does nothing " +
      "when the quality profile's `bloom` is 0, because the chain is never built.",
  ),
  define(
    'exposure',
    [R, { name: 'stops', type: 'f32' }],
    "How far this frame is scaled into the tone curve, above 0. Replaces the profile's " +
      '`outputExposure` for this frame onward. Adaptation is yours: a game knows it walked into a ' +
      'cave, and the renderer could only find out a frame late. Ignored unless the output ' +
      'transform is `aces`, since otherwise there is no curve to be exposed into.',
  ),
  define(
    'motionBlur',
    [R, { name: 'scale', type: 'f32' }],
    'How much of the camera motion blur ceiling this frame takes, 0 to 1. Held until changed. ' +
      'Ramp it with whatever "fast" means here: blur that is always on stops being a speed cue ' +
      'within seconds and costs eight taps a moving pixel while doing so.',
  ),
  define(
    'speedBlur',
    [R, { name: 'strength', type: 'f32' }],
    'How much speed blur the frame resolves with, 0 to 1. Held until changed, and ignored when ' +
      'screen effects are off.',
  ),
  define(
    'focus',
    [
      R,
      { name: 'distance', type: 'f32' },
      { name: 'range', type: 'f32' },
      { name: 'scale', type: 'f32' },
    ],
    "Where this frame's lens is focused and how deep the sharp zone is, in metres, and how much " +
      'of the depth-of-field ceiling to take, 0 to 1. Held until changed. `scale` is required ' +
      'here though the engine defaults it to 1, because taking the whole ceiling is the expensive ' +
      'answer and a script author is further from that cost than a TypeScript caller.',
  ),
  define(
    'medium',
    [
      R,
      { name: 'density', type: 'f32' },
      { name: 'albedo', type: 'f32' },
      { name: 'anisotropy', type: 'f32' },
      { name: 'maxDistance', type: 'f32' },
    ],
    'How thick the air is: a medium filling the whole frustum, rather than a beam inside a hull. ' +
      '`density` is extinction per metre and 0 is off — nothing is allocated and nothing is drawn, ' +
      'so a script that never raises it costs nothing. `albedo` is how much of what the air takes ' +
      'out comes back as light rather than heat, 0 to 1; `anisotropy` is -1 back to 1 forward, and ' +
      'is what makes haze glow toward a low sun; `maxDistance` is where the search for light to ' +
      'scatter stops, in metres, which is not where the fog stops. Held until changed. Does ' +
      "nothing when the quality profile's `globalMediumSteps` is 0, because no march is built.",
  ),
  define(
    'veil',
    [
      R,
      { name: 'red', type: 'f32' },
      { name: 'green', type: 'f32' },
      { name: 'blue', type: 'f32' },
      { name: 'alpha', type: 'f32' },
    ],
    'Composite a flat colour over the finished frame, for a cut dipping to white or to black. ' +
      '**Once per frame: a frame that does not call this draws with no veil at all**, unlike the ' +
      'dials above, because a transition that forgets to turn itself off is worse than one that ' +
      'forgets to turn on.',
  ),
];

/**
 * Unconditional, like `drift/terrain` and `drift/editor`: every capability takes the renderer it
 * acts on, which reaches a script through `uses`, so there is nothing for an absent service to
 * make fail.
 *
 * **`medium` takes every argument the engine defaults**, unlike `setGlobalMedium`, and for the
 * reason `focus` gives about its own `scale`: a script author is further from the cost than a
 * TypeScript caller, and a defaulted albedo is a number somebody has to go and look up before they
 * can tell what their fog will look like. Four numbers is one line either way.
 *
 *  * **`speedBlur` is the one name here that is not the engine's own.** The method is `setSpeedRush`,
 * and a rush is a thing that happens in somebody's game rather than a description of an image
 * operation — binding that spelling would have written one consumer's noun into the language's
 * surface, where it could not later be taken back. A binding is a lookup and this is what a lookup
 * is for.
 */
export function renderImplementation(): Record<string, unknown> {
  return {
    bloom: (renderer: RendererApi, scale: number) => renderer.setBloom(scale),
    exposure: (renderer: RendererApi, stops: number) => renderer.setOutputExposure(stops),
    motionBlur: (renderer: RendererApi, scale: number) => renderer.setCameraMotionBlur(scale),
    speedBlur: (renderer: RendererApi, strength: number) => renderer.setSpeedRush(strength),
    focus: (renderer: RendererApi, distance: number, range: number, scale: number) =>
      renderer.setDepthOfField(distance, range, scale),
    medium: (
      renderer: RendererApi,
      density: number,
      albedo: number,
      anisotropy: number,
      maxDistance: number,
    ) => renderer.setGlobalMedium(density, albedo, anisotropy, maxDistance),
    veil: (renderer: RendererApi, red: number, green: number, blue: number, alpha: number) =>
      renderer.setFrameVeil(red, green, blue, alpha),
  };
}
