/**
 * A WebGL2 context that answers everything, for tests that need a renderer and not a GPU.
 *
 * **Not a `.test.ts` file, and that is the point.** Vitest registers a test when the file
 * declaring it is imported, so a second test file importing this from beside its own tests would
 * re-run every test in that file as well — five today, and more with each one added. Split out so
 * that importing the harness costs nothing but the harness.
 *
 * **Until this existed, nothing in this repository had ever constructed the WebGL2 `Renderer` in a
 * test**, which is why every claim about that backend was settled by a capture — expensive, slow,
 * and blind to anything the published scenes do not do. There is a `renderer.test.ts` beside that
 * backend now, and what it pins is the shape a capture is worst at: a frame-wide decision taken
 * from the profile, where the wrong answer still draws a plausible picture. The `Proxy` is the
 * same trick `sceneTarget.test.ts` uses one level down: anything not named below is a recorded
 * no-op returning a fresh object, so a constructor that touches several hundred entry points runs
 * to completion and a test can assert the one thing it is about.
 */
import { countUniformVectors } from './uniformVectorBudget.ts';

export function recordingGl(
  options: {
    /**
     * Extensions this context answers with an object rather than with `null`.
     *
     * **Opt-in, and the default of none is the honest one for most tests**: the shipped default
     * answers `null` to everything, which is the weakest part this engine claims to run on and is
     * what a test that does not care should be written against. A test that *is* about the branch
     * an extension opens has to name it here, or the code under test refuses one step earlier and
     * the test passes for the wrong reason — `EXT_color_buffer_float` is the worked example: with
     * it absent, `OitPass` declines for the float colour buffer and every order-independent
     * profile looks alike whatever its sample count.
     */
    readonly extensions?: readonly string[];
    /**
     * What this context reports for `MAX_FRAGMENT_UNIFORM_VECTORS`. 1024 by default.
     *
     * Named because it is a limit the renderer now *sizes a shader against* rather than merely
     * compares: 256 is an Adreno 740 and 224 is what WebGL2 guarantees, and both are numbers at
     * which the lit shader has to be built smaller than the engine's own budget.
     */
    readonly fragmentUniformVectors?: number;
    /**
     * The ceiling this fake driver actually enforces at link time, if it is not the one it admits.
     *
     * **For the gap between what a device reports and what it does.** `planLightBudget` counts an
     * upper bound over the source, so the interesting failure is the other one: a program the
     * arithmetic passed that the driver still refuses. Setting this below
     * `fragmentUniformVectors` is that device, and it is what the renderer's retry is for.
     * `Infinity` by default, so a link only ever fails where a test asked for it.
     */
    readonly refuseLinkAbove?: number;
  } = {},
) {
  const extensions = new Set(options.extensions ?? []);
  const reportedVectors = options.fragmentUniformVectors ?? 1024;
  const enforcedVectors = options.refuseLinkAbove ?? Number.POSITIVE_INFINITY;
  /** Fragment sources by shader handle, so a refusal can be decided from what was compiled. */
  const fragmentSources = new WeakMap<object, string>();
  /** Each program's fragment source, gathered at `attachShader`. */
  const programFragments = new WeakMap<object, string>();
  const calls: { name: string; args: unknown[] }[] = [];
  const constants: Record<string, number> = {
    ACTIVE_UNIFORMS: 0x8b86,
    ACTIVE_ATTRIBUTES: 0x8b89,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    NO_ERROR: 0,
    MAX_SAMPLES: 0x8d57,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
    MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
    /*
     * Enums a test needs to compare against, rather than merely to pass through.
     *
     * The `Proxy` below answers an unnamed property with a **fresh function**, so
     * `gl.TEXTURE_2D_ARRAY` read twice is two different values and `toContain(gl.TEXTURE_2D)` can
     * never match anything a call recorded. Anything a test asserts on has to be named here; a
     * constant only ever passed along does not.
     */
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    DEPTH_COMPONENT24: 0x81a6,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER: 0x8d40,
    NONE: 0,
    ALWAYS: 0x0207,
    LESS: 0x0201,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    /* The blend factors, so a test can tell an additive stroke from a covering one. */
    SRC_ALPHA: 0x0302,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    TEXTURE0: 0x84c0,
    DEPTH_BUFFER_BIT: 0x00000100,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    /* Named so a pass-owned attachment's two colour formats and its two attachment points can be
       compared rather than merely passed along. See `passTarget.test.ts`. */
    COLOR_ATTACHMENT0: 0x8ce0,
    RGBA8: 0x8058,
    RGBA16F: 0x881a,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    HALF_FLOAT: 0x140b,
    DEPTH_COMPONENT: 0x1902,
    UNSIGNED_INT: 0x1405,
    LINEAR: 0x2601,
    COLOR_BUFFER_BIT: 0x00004000,
    /* Named so a test can tell a mesh that declared itself deforming from one that did not. */
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
  };
  const answers: Record<string, (...a: unknown[]) => unknown> = {
    getParameter: (pname: unknown) => {
      if (pname === constants.MAX_TEXTURE_SIZE) return 4096;
      if (pname === constants.MAX_TEXTURE_IMAGE_UNITS) return 16;
      if (pname === constants.MAX_SAMPLES) return 4;
      if (pname === constants.MAX_FRAGMENT_UNIFORM_VECTORS) return reportedVectors;
      if (pname === constants.MAX_VERTEX_UNIFORM_VECTORS) return 1024;
      /* Generous by default: every remaining limit is a ceiling something is checked against,
         and a small answer is read as a device that cannot do the thing. */
      return 4096;
    },
    getExtension: (name: unknown) => (extensions.has(String(name)) ? {} : null),
    getShaderParameter: () => true,
    /*
     * A shader remembers its own source, and a program remembers its fragment one, so a link can
     * be refused for the reason a real driver refuses it rather than by a flag. Both are no-ops
     * for every test that does not set a ceiling.
     */
    createShader: (type: unknown) => ({ type }),
    shaderSource: (shader: unknown, source: unknown) => {
      if (typeof shader === 'object' && shader !== null && typeof source === 'string') {
        fragmentSources.set(shader, source);
      }
    },
    attachShader: (program: unknown, shader: unknown) => {
      if (typeof program !== 'object' || program === null) return;
      if (typeof shader !== 'object' || shader === null) return;
      const source = fragmentSources.get(shader);
      /* The fragment stage is the one with a `void main` and no attributes; `#version` is on both,
         so the discriminator is the qualifier only a fragment stage declares. */
      if (source !== undefined && source.includes('precision highp float;')) {
        programFragments.set(program, source);
      }
    },
    /* Linked yes; zero active uniforms and attributes, which ends every reflection loop at once
       and is why this harness does not have to know a single uniform name. */
    getProgramParameter: (program: unknown, pname: unknown) => {
      if (pname === constants.ACTIVE_UNIFORMS || pname === constants.ACTIVE_ATTRIBUTES) return 0;
      if (pname !== constants.LINK_STATUS) return true;
      if (!Number.isFinite(enforcedVectors)) return true;
      if (typeof program !== 'object' || program === null) return true;
      const source = programFragments.get(program);
      return source === undefined || countUniformVectors(source) <= enforcedVectors;
    },
    getActiveUniform: () => ({ name: '', size: 1, type: 0 }),
    getActiveAttrib: () => ({ name: '', size: 1, type: 0 }),
    getUniformLocation: () => ({}),
    getAttribLocation: () => -1,
    checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE,
    getError: () => constants.NO_ERROR,
    getShaderInfoLog: () => '',
    /* ANGLE's own words for this refusal, so a test asserting on the message is asserting on the
       sentence a consumer actually pastes into a report. */
    getProgramInfoLog: () =>
      Number.isFinite(enforcedVectors)
        ? `FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(${enforcedVectors})`
        : '',
    isContextLost: () => false,
  };

  const gl = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop in constants) return constants[prop];
        if (prop in answers) {
          return (...args: unknown[]) => {
            calls.push({ name: prop, args });
            return answers[prop]?.(...args);
          };
        }
        /* An unnamed call: recorded, and answered with a fresh object so a handle is a handle. */
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          return {};
        };
      },
    },
  ) as unknown as WebGL2RenderingContext;

  const canvas = {
    width: 640,
    height: 480,
    clientWidth: 640,
    clientHeight: 480,
    getContext: () => gl,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
  } as unknown as HTMLCanvasElement;

  return { gl, canvas, calls };
}
