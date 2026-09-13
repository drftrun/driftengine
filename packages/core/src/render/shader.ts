/** Shader compilation with fail-fast diagnostics (init-time only, never per-frame). */

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label: string,
): WebGLProgram {
  const vs = compileStage(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
  const fs = compileStage(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);

  const program = gl.createProgram();
  if (program === null) throw new Error(`[${label}] createProgram failed`);

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[${label}] link failed: ${log ?? 'no log'}`);
  }
  return program;
}

/**
 * Whether a uniform lookup that cannot reach the GPU is reported.
 *
 * Two ways it cannot: the program has no such uniform, or the program is not the one
 * currently bound. Both upload nothing; only the second one leaves a GL error behind.
 *
 * **Why this exists.** `gl.uniform*(null, value)` is legal and does *nothing*: no error,
 * no warning, no exception. Every uniform in this renderer is written through
 * `uniforms['name'] ?? null`, so a name that stops matching — renamed, optimised out,
 * spelled for a different driver's convention — silently stops being uploaded, and the
 * effect it drove quietly ceases to exist. There is no symptom except a picture that is
 * subtly or completely wrong, and no thread from the picture back to the cause.
 *
 * That is not a hypothetical. It has now cost this project a trample field that shipped
 * uploading to nothing, and a night spent on a black courtyard while four separate
 * theories were argued from source because nothing anywhere said a word.
 *
 * Off by default, because a renderer that warns in a frame loop is its own problem, and
 * because deliberate optional lookups exist — a shader compiled without point shadows
 * genuinely has no `uPointShadowIndex[0]`. On, it names the program and the uniform once
 * each, which is enough to find it and quiet enough to leave on while looking.
 */
let strictUniforms = false;
const reportedMisses = new Set<string>();

export function setUniformStrictMode(on: boolean): void {
  strictUniforms = on;
  if (!on) reportedMisses.clear();
}

/** Locations of every active uniform, keyed by name. */
export function uniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  label = 'program',
): Record<string, WebGLUniformLocation> {
  const locations: Record<string, WebGLUniformLocation> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info === null) continue;
    const location = gl.getUniformLocation(program, info.name);
    if (location === null) continue;
    locations[info.name] = location;
    /*
     * An array uniform is registered under **both** spellings, whichever one the driver
     * reported it under.
     *
     * Passing `undefined` (or `null`) to `uniformNfv` is a **silent no-op**: the uniform
     * never gets its data, there is no GL error, nothing throws, and the effect simply
     * does not exist. That is how a trample field for the foliage once shipped uploading
     * to nothing while every test passed and the console stayed clean.
     *
     * The subtlety, and the reason this is written symmetrically, is that **the reported
     * name is not portable**. GLES 3.0 §2.12.6 lets an implementation return an active
     * array's name either as `uThing[0]` or as bare `uThing`, and both are conformant.
     * ANGLE — so every desktop browser, and Chrome on Android — returns the subscript.
     * WebKit's Metal backend, so every browser on iOS, returns the bare name.
     *
     * Assuming the subscript cost a fortnight. On iOS the whole point-light system
     * uploaded to `null`: positions, colours, radii and weights all stayed at zero, so
     * point lights contributed exactly nothing. A scene with a sun looked perfect, and a
     * scene lit only by lamps rendered its geometry to ambient alone — a dark room with
     * its fire still burning, because emission needs no light to arrive. It reproduced on
     * nothing the author owned, and it could not show up in any diagnostic, because from
     * the API's point of view nothing went wrong.
     *
     * Registering both means no caller can hold it wrong, and no caller has to know a
     * WebGL naming convention in order to write to an array — that is a fact about the
     * API, not about the shader anybody is trying to use.
     */
    const subscript = info.name.indexOf('[');
    if (subscript > 0) {
      const bare = info.name.slice(0, subscript);
      if (locations[bare] === undefined) locations[bare] = location;
    } else if (info.size > 1) {
      /*
       * `size` is what separates an array reported bare from an ordinary scalar, which
       * the name alone cannot: it is the element count, and it is 1 for everything that
       * is not an array. Registering `uViewProj[0]` for a matrix would be harmless but
       * meaningless, and a lookup map that answers to names nothing declared is a map
       * that stops being evidence of what the shader contains.
       */
      const subscripted = `${info.name}[0]`;
      if (locations[subscripted] === undefined) locations[subscripted] = location;
    }
  }

  if (!strictUniforms) return locations;
  /*
   * A proxy rather than a changed call site, deliberately: the point is to cover *every*
   * lookup in the renderer, including the ones nobody thought to check, and a guard that
   * has to be adopted one call at a time protects only the places somebody already
   * suspected.
   */
  return new Proxy(locations, {
    get(target, key) {
      if (typeof key !== 'string') return target[key as unknown as string];
      if (!(key in target)) {
        const at = `${label}.${key}`;
        if (!reportedMisses.has(at)) {
          reportedMisses.add(at);
          console.warn(
            `Renderer: \`${label}\` has no uniform \`${key}\`. Writing to it does nothing — ` +
              `WebGL treats a missing location as a silent no-op, so whatever this drove is ` +
              `simply absent.`,
          );
        }
      } else if (gl.getParameter(gl.CURRENT_PROGRAM) !== program) {
        /*
         * The other half of the same failure, and the one that leaves evidence somewhere
         * else entirely.
         *
         * A location belongs to the program it was queried from, so writing it while a
         * different program is bound uploads nothing and raises `INVALID_OPERATION`. The
         * shape it takes in a renderer: one pass binds its program once and every other
         * pass interrupts it, so a call made after an interruption addresses a program
         * that has not been current since — and then draws through whichever program *is*
         * bound, because a draw call takes the program it finds rather than the one whose
         * uniforms were just written.
         *
         * Worth reporting separately from a missing name because the damage travels. A
         * pending GL error is not attached to the call that raised it: the next
         * `getError` anywhere in the codebase reads it and concludes that whatever *it*
         * was checking has failed. One such check read exactly this error as a driver
         * refusing to resolve depth, and switched an effect off for the session.
         */
        const at = `${label}.${key}@program`;
        if (!reportedMisses.has(at)) {
          reportedMisses.add(at);
          console.warn(
            `Renderer: \`${label}.${key}\` was looked up while a different program is ` +
              `bound. A uniform location belongs to its own program, so this write uploads ` +
              `nothing, raises INVALID_OPERATION, and leaves an error for the next ` +
              `getError anywhere to misread. Bind \`${label}\` first.`,
          );
        }
      }
      return target[key];
    },
  });
}

function compileStage(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error(`[${label}] createShader failed`);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[${label}] compile failed: ${log ?? 'no log'}`);
  }
  return shader;
}
