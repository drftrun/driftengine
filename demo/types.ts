/**
 * What a demo scene is, so that whatever mounts one needs to know nothing else.
 *
 * A demo is the engine demonstrating itself. It reaches the engine through the
 * public barrel exactly as any consumer does, and it knows nothing about the page
 * it is drawn on: no DOM beyond the canvas it is handed, no framework, no styling.
 * That restraint is the point rather than tidiness — a demo that needed privileged
 * access to build something impressive would be advertising an engine nobody else
 * can have.
 *
 * `frame` returns what the frame cost. A demo that cannot say what it costs is a
 * picture, and a picture is the one thing this engine's case does not rest on.
 */

import type { RenderBackend, RenderQualityOptions } from '../packages/core/src/index';
import type { OrbitView } from './orbit';

/** What a single rendered frame cost. */
export interface DemoStats {
  /** Draw calls issued for the frame just rendered. */
  draws: number;
  /**
   * GPU time for that frame in milliseconds.
   *
   * Zero where the timer is unavailable, which is most mobile browsers and any
   * context without `EXT_disjoint_timer_query_webgl2`. Zero means *unmeasured*,
   * never *free*, and a consumer showing this figure has to say so rather than
   * print a confident 0.0.
   */
  gpuMs: number;
  /**
   * Instanced items submitted this frame, where a scene draws any.
   *
   * Optional because most scenes have none, and meaningless without `draws` beside it —
   * which is the entire point of reporting it. "Four draws" is a number a reader has no
   * scale for until it sits next to the twelve thousand plants those four draws moved,
   * and that ratio is the single clearest thing instancing has to say for itself.
   */
  instances?: number;
  /**
   * One figure of this scene's own, already worded, for the row beside the rest.
   *
   * An escape hatch, and a narrow one on purpose. Most of what a scene has to say about
   * itself is prose and belongs wherever the consumer keeps prose; this is for the case
   * where the interesting number can only be computed while the scene is running, and
   * where seeing it move is the entire demonstration. A scene proving that two runs of
   * a simulation land in identical positions has nothing to show for it except a count
   * that keeps going up, and no standard field could carry that.
   *
   * Worded by the scene rather than handed over as a number with a label, because the
   * unit is the scene's business and a consumer forced to invent wording for a figure
   * it does not understand will get it wrong.
   */
  extra?: string;
}

/** A mounted scene: driven a frame at a time, and released when it is done. */
export interface DemoHandle {
  /**
   * Advance and draw one frame.
   *
   * `dtSec` is wall-clock seconds since the previous call, already clamped by the
   * caller — a scene must not read a clock, because the caller owns pausing and a
   * scene that timed itself would keep animating while off screen.
   */
  frame(dtSec: number): DemoStats;
  /**
   * Which backend is actually drawing.
   *
   * **Reported rather than inferred, and the difference is the whole point.** `?backend=webgpu`
   * says what was *asked for*: a browser without WebGPU, a device request that failed, or a
   * misspelt query all fall back silently and draw a frame that looks entirely plausible. Two
   * sessions of this port were spent comparing pictures, and a run that quietly compared WebGL2
   * with WebGL2 is the exact failure `--backend` exists to prevent in the capture harness. The
   * readout says which one, so nobody has to trust the address bar.
   *
   * Optional because a consumer's own handle need not have one; the demo scenes all do.
   */
  readonly backend?: RenderBackend;
  /**
   * Whether the device this scene was built on has gone.
   *
   * **A lost device draws nothing and says nothing**: every entry point on the renderer guards
   * and returns, so a host's frame loop runs at full rate against a black canvas with no error
   * to catch. A demos page reported exactly that as a broken renderer. WebGPU cannot restore a
   * device, only replace one, so a host that wants to survive one has to notice and remount —
   * and it cannot notice without being told.
   *
   * Optional, so a handle written before this existed still satisfies the contract; a host
   * treats absent as "cannot say" rather than as "fine".
   */
  readonly lost?: boolean;
  /**
   * Release every GPU resource this scene created.
   *
   * Called on unmount and on context loss. It has to be safe to call twice: a
   * page that loses its context and is then unmounted will do exactly that.
   */
  dispose(): void;
  /**
   * How much daylight the scene stands in: 0 for night, 1 for full day.
   *
   * Optional, because plenty of scenes have one hour and nothing to say about this.
   * A scene that implements it must accept any value in between as a real state, so a
   * caller can animate the change rather than cut between two of them.
   *
   * **It exists because a page can have a light mode and a scene cannot ignore it.** A
   * night render under a light document is a black rectangle in a white page, and
   * asking somebody who chose light mode to look at that is answering the wrong
   * question. Phrased as an hour rather than as a theme on purpose: an engine knows
   * what daylight is and has no business knowing what a stylesheet is.
   */
  setDaylight?(amount: number): void;
  /**
   * The view a person can take hold of, where a scene offers one.
   *
   * A demo runs an automatic camera, and the moment a viewer wants to look at something
   * in particular that camera is in their way. A scene that exposes this lets whatever
   * mounts it turn a drag and a wheel into a view, without either side knowing what the
   * other is made of: the caller owns the element and the gestures, the scene owns the
   * world, and `OrbitView` owns what a gesture means.
   *
   * Optional, because a scene whose whole point is a fixed shot should be allowed to
   * keep it.
   */
  readonly view?: OrbitView;
  /**
   * A load a viewer can move back and forth through, where a scene holds one.
   *
   * **The same division of labour as `view`, and for the same reason.** The caller owns the
   * element and the gesture, the scene owns what a state *is*. A scene that built its own
   * slider would be a scene that knows what a page looks like, and the one thing every demo
   * here refuses to know is that.
   *
   * Optional and often absent: `steps` is 0 while there is nothing to scrub — before a model
   * has finished arriving, on a scene that loads nothing, and on a device where the scene
   * declined to hold the states because they cost a second copy of the geometry. A caller
   * shows its control when the count becomes usable and not before.
   */
  readonly reveal?: RevealControl;
  /**
   * The one quality lever that can move while a scene is running.
   *
   * **It exists so that "this machine is slow" stops being answered with "then you get
   * nothing".** A demo host measures frame times and has, until this, had exactly two things
   * it could do with a bad answer: mount the scene again at a cheaper profile, or stop. Both
   * are all-or-nothing, and the second is permanent, so a machine that was a little short of
   * the rate lost the render entirely. A reader reported precisely that, and the scene behind
   * it had been drawing correctly the whole time.
   *
   * Density is the lever because it is the only one that survives being changed mid-session.
   * A profile decides shadow map sizes and wave surfaces when the renderer is built, so moving
   * one means rebuilding every GPU resource the scene hangs off, which is what a remount is
   * for. Pixels are just pixels.
   *
   * Optional, like the other two controls here, because a scene is entitled to have nothing to
   * say about this. A host that finds it absent is in exactly the position it was in before.
   */
  readonly resolution?: ResolutionControl;
}

/**
 * A scene's drawing-buffer density, readable and movable.
 *
 * Both halves, because a governor moves *relative to where it started* and a caller that
 * cannot read the ceiling would have to assume one. See `Renderer.resolutionScale`: the
 * requested ceiling and the one in force are allowed to differ, and on the devices this is
 * for they usually do.
 */
export interface ResolutionControl {
  /** The density ceiling this scene is drawing at now. */
  readonly ceiling: number;
  /** Draw at a new density ceiling from the next frame. */
  apply(scale: number): void;
}

/**
 * A reveal that can be put back to any of its states.
 *
 * Deliberately whole numbers rather than a fraction of a load. The states are not evenly
 * spaced in anything a fraction could measure — an outline is one state, a part is one state,
 * and the merge at the end is one state — so a slider that addressed them by fraction would
 * make the interesting ones too narrow to stop on.
 */
export interface RevealControl {
  /** How many states there are to choose between. Zero means there is nothing to scrub. */
  readonly steps: number;
  /** Which state is on screen. Out of range is clamped rather than refused. */
  set(step: number): void;
}

/**
 * How much of a GPU a scene may spend.
 *
 * `full` is the scene as authored. `lean` is the same scene with the expensive passes
 * off: the planar reflection, the directional cascade, the wide shadow filter.
 *
 * **It exists because the alternative to a cheaper scene is not a better one, it is a
 * video.** A caller that measures a scene failing to hold its rate has two options, and
 * stopping it outright was the only one available — so a phone that could comfortably
 * run this at two thirds of the cost was shown a recording instead, which is the one
 * outcome that argues against the engine on the engine's own page.
 *
 * Deliberately two named steps rather than a number. A scene picks construction-time
 * render quality from this, and those settings size allocations that cannot be resized
 * afterwards, so a continuum would imply a smoothness the renderer does not have.
 */
export type DemoBudget = 'full' | 'lean';

/*
 * `overrides` on `mount` exist for one job: taking a feature away on a device the author
 * cannot reach, one at a time, to find which one is at fault.
 *
 * A budget is a pair of curated answers. This is the scalpel: a caller that knows
 * something specific about the machine in front of it, or is trying to *learn* something
 * specific, can switch off exactly one pass and see what changes. Applied on top of the
 * budget, so `lean` plus an override is still lean.
 */

/**
 * What the host knows about the assets it serves, which the scene cannot learn from them.
 *
 * **A separate bag from `RenderQualityOptions` because it answers a different question.**
 * Quality is about the machine in front of the reader. This is about the file behind the
 * page: two facts that decide how a model should be presented, that no reader of that model
 * can derive, and that the person who put it there knows for certain.
 *
 * Every field is off when it is absent, and that is the ordering these deserve. Each one is
 * right for some assets and wrong for others, so the default is the one that cannot
 * misrepresent an import: draw what arrived, and nothing else.
 *
 * A scene ignores what it has no use for. A demo that generates every polygon it draws has
 * no model to describe, and passing this to one is not an error.
 */
export interface DemoSceneOptions {
  /**
   * Whether the model this host serves is an exterior shell, so its inside wants closing.
   *
   * A shell has nothing behind its grille, its wheel arches or its windows, so every
   * opening looks straight through the object and out the far side. A model that carries a
   * cabin has seats there, and a generated solid put behind its glass reads as a black box
   * inside the car.
   *
   * **Not something to infer, which is why it is asked for.** The two cases have the same
   * bounds, the same materials and often the same material names, so nothing in the file
   * separates them. A host serving one particular model is the only party that knows.
   */
  readonly fill?: boolean;
  /**
   * How coarse a version of the whole model to open the load on, or `false` for none.
   *
   * Absent takes the engine's own grid, `DEFAULT_COARSE_CELLS`; a number is cells along the
   * longest axis. It answers both halves at once: whether a source format is converted with an
   * outline in it, and whether a container carrying one has it drawn.
   *
   * **`false` is the interesting value**, and it is here rather than in the engine because the
   * case it exists for is a fact about a file. A coarse level is a decimation, so an asset whose
   * detail lives below the grid comes back as ridges, and somebody waiting for a car gets white
   * cliffs, which reads as a broken import where an empty stage reads as a load in progress. A
   * host that has looked at its own model and seen that is the only party that knows.
   */
  readonly outline?: boolean | number;
}

export interface DemoScene {
  /**
   * Stable and URL-safe. Used as a key and as a fragment, never displayed, so it
   * may not change once published even when the title does.
   */
  id: string;
  /** Shown to a reader. */
  title: string;
  /** One line on what this scene is showing, and why it is worth a look. */
  note: string;
  /**
   * Whether this scene fetches anything, so a host can say so without keeping its own list.
   *
   * **It exists because a page said something false about itself.** The demos page counted the
   * scenes rather than writing the number, which was right, and then stated in prose that none
   * of them loads a model, which stopped being true the moment a scene that loads one was
   * registered. A claim about the corpus has to be derived from the corpus for the same reason
   * the count is: the alternative is a sentence nobody remembers to edit.
   *
   * Absent means false, so the scenes that generate everything say nothing and stay the default.
   * That ordering matters here: fetching is the exception this engine makes a point of, and the
   * exception is the thing that should have to declare itself.
   */
  loadsModel?: boolean;
  /**
   * Build the scene against a canvas, and let the engine decide what draws into it.
   *
   * Rejecting here is how a scene reports that it cannot run — a missing extension,
   * a shader that will not compile. The caller keeps its poster and carries on, so
   * failure is a still image rather than a broken page.
   *
   * **Asynchronous, and the caller no longer supplies a context.** This used to take a
   * live `WebGL2RenderingContext` that the host created first. That made the host choose
   * the backend by accident: a canvas which has given a `webgpu` context cannot also give
   * a `webgl2` one, so a scene handed a GL context can only ever be drawn by WebGL2, and
   * `?backend=webgpu` could not reach a single scene in this directory. The engine picks,
   * through `createRenderer`, and picking requires an adapter request, which is a promise.
   *
   * **The two obligations this contract used to place on the host are gone**, and they are
   * gone rather than moved because they were always the engine's own business:
   *
   *   1. The context attributes (`{ alpha: false, antialias: false }`) are asked for by the
   *      renderer that wants them. A host cannot get them wrong for a scene any more.
   *   2. The drawing buffer's dimensions still belong to the scene. `resize()` reads the
   *      element's own size and applies the density and area caps the engine exists to
   *      enforce, so a host writing `canvas.width` as well means two policies for one
   *      number and the loser is whichever ran first.
   */
  mount(
    canvas: HTMLCanvasElement,
    budget?: DemoBudget,
    overrides?: RenderQualityOptions,
    options?: DemoSceneOptions,
  ): Promise<DemoHandle>;
}
