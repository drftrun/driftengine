/** A cubemap of the scene from one point, for surfaces that mirror the room they stand in. */

import type { Vec3 } from '../math/color.ts';
import { Camera } from './camera.ts';
import { roughnessForLevel } from './prefilterEnvMap.ts';

/**
 * What a bake is for, and specifically whether it also replaces the scene's diffuse ambient.
 *
 * **The two halves of a probe were one decision until 2026-09-03, and nothing could ask for the
 * first alone.** A bake fills a cubemap that reflective surfaces sample, and it then reads that
 * cubemap back, projects it onto spherical harmonics and raises `uEnvIrradianceEnabled` — from
 * which frame on **every diffuse surface in the world takes its ambient from the projection
 * instead of from the values the consumer wrote into `Environment`**. A consumer who wanted a car
 * and a puddle to mirror the village got, as well, the whole scene changing what lights it, once,
 * at whatever moment the bake landed.
 *
 * That is a defensible default — a room's own light is usually better than a gradient — but it was
 * not a *choice*, and it correlates with nothing a consumer can see. The one it was reported from
 * gates its bake on a streamer being idle, so the substitution arrived minutes into a drive, and
 * it was filed four times over two days as four different bugs.
 *
 * `irradiance: false` declines the second half. The reflection is unaffected; the ambient stays
 * whatever the consumer set. It also **stops paying for it** — the readback and the projection are
 * the expensive part of a bake, and a caller that does not want the result does not wait for it.
 *
 * **It declines rather than undoes.** A bake that declines leaves an earlier projection in place,
 * because "do not compute this" is not "discard what is there". What a consumer gets by passing it
 * on *every* bake is the guarantee they were asking for: their ambient is never substituted.
 */
export interface ProbeBakeOptions {
  /**
   * Whether this bake also projects the room's diffuse light and lights the scene by it.
   *
   * Defaults to **true**, which is what every bake did before this existed, so a caller that says
   * nothing gets the frame it already had.
   */
  readonly irradiance?: boolean;
}

/**
 * The six directions of a cubemap, as the yaw and pitch a `Camera` aims with.
 *
 * Written as camera angles rather than as look-at targets because that is what `Camera` takes,
 * and because the order is not free: it is the order WebGL numbers the faces, `+X, -X, +Y, -Y,
 * +Z, -Z`, and a face rendered into the wrong slot gives a reflection that is subtly rotated in
 * a way that reads as the whole probe being wrong rather than as one face being swapped.
 *
 * `yaw 0` looks toward -Z and positive yaw turns toward +X, which is this camera's convention.
 */
const FACES: readonly { readonly yaw: number; readonly pitch: number }[] = [
  { yaw: Math.PI / 2, pitch: 0 },
  { yaw: -Math.PI / 2, pitch: 0 },
  { yaw: 0, pitch: Math.PI / 2 },
  { yaw: 0, pitch: -Math.PI / 2 },
  { yaw: Math.PI, pitch: 0 },
  { yaw: 0, pitch: 0 },
];

/**
 * A quarter turn of field of view, which is what makes six faces meet exactly.
 *
 * Anything else leaves a seam or an overlap at every edge, and both read as a crack running
 * across a reflective surface.
 */
const FACE_FOV_DEG = 90;

/**
 * How far the probe's own camera can see.
 *
 * Near is generous because a probe sits in open space in the middle of a room rather than
 * against a wall, and a small near plane spends depth precision on nothing. Far reaches past
 * any room a probe is a reasonable idea for; beyond that, what a reflection needs is a sky.
 */
const NEAR_M = 0.1;
const FAR_M = 200;

export class ReflectionProbe {
  /**
   * The captured cube, box-filtered, which the convolution reads and the projection reads.
   *
   * **Not what the lit pass samples any more.** A box filter averages a square of texels and a
   * GGX lobe is not square, so sampling this chain by roughness was an approximation whose error
   * was largest exactly where a surface looks most interesting. It stays because filtered
   * importance sampling needs a chain to pick a level from, and because `readFaces` projects
   * *this* onto spherical harmonics — an irradiance integral over a lobe-convolved cube would be
   * a convolution of a convolution.
   */
  readonly texture: WebGLTexture;
  /**
   * The prefiltered cube: one GGX-convolved level per roughness, and what `uEnvironment` binds.
   *
   * **A second texture rather than this one rewritten in place**, and it costs one cube of
   * memory. What it buys is worth more than that here: WebGL2's feedback-loop check is per
   * texture object, so rendering into a level of the cube a sampler is holding is the hazard the
   * depth peel already pays for elsewhere, and with two objects it cannot arise. It is also what
   * stops a level being convolved from a level that was already convolved, which applies the lobe
   * twice and compounds up the chain.
   *
   * **What would make it wrong** is a probe large enough for a second cube to be the memory
   * decision; at 128 with a chain that is about a megabyte at half float.
   */
  readonly prefiltered: WebGLTexture;
  /** The camera the caller draws each face with. Reused, so a bake allocates nothing. */
  private readonly camera = new Camera();
  private readonly framebuffer: WebGLFramebuffer;
  /**
   * The convolution's own framebuffer, with no depth attached.
   *
   * The bake's framebuffer carries a full-size depth renderbuffer, and an attachment whose size
   * does not match the colour one makes the framebuffer *incomplete* — so reusing it above level
   * zero would fail at the first mip rather than at the last. A convolution has nothing to sort
   * against and needs no depth at all.
   */
  private readonly prefilterFramebuffer: WebGLFramebuffer;
  private readonly depth: WebGLRenderbuffer;
  /** Face width in texels. Public because the convolution's solid-angle term needs it. */
  readonly size: number;
  /**
   * Whether the cube holds radiance above white, or clamps at it.
   *
   * False on a part without `EXT_color_buffer_float`, and on any caller that did not ask for an
   * HDR scene — where the room the probe photographs was itself clamped before it got here, so a
   * float cube would carry the same crushed values at twice the bandwidth.
   */
  private readonly floatColor: boolean;
  /**
   * Scratch for the byte path of `readFaces`, allocated on first use and reused after.
   *
   * Null rather than sized at construction, because a probe that is never read back — which is
   * every probe on a scene that bakes one and never asks for irradiance — should not carry a
   * megabyte for it.
   */
  private readBytes: Uint8Array | null = null;
  /** Scratch for the byte path of `upload`, on the same terms as `readBytes`. */
  private uploadBytes: Uint8Array | null = null;
  /**
   * Whether anything has ever been rendered into this.
   *
   * The shader must not sample a cubemap nobody has filled: what is in it is whatever the
   * driver left, and a car mirroring uninitialised memory is worse than a car mirroring a
   * gradient. So this gates the uniform rather than the allocation.
   */
  private baked = false;
  /**
   * Set once if the allocation is refused, and never cleared.
   *
   * A reflection is an improvement to an appearance rather than a requirement. The scene still
   * renders without one and `flat.ts` still has the sky-and-ground gradient it used before this
   * existed, so a device that cannot afford six faces loses the room in the paint and keeps
   * everything else.
   */
  private unusable = false;

  constructor(gl: WebGL2RenderingContext, size: number, wantsRange = false) {
    const maximum = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) as number;
    this.size = Math.max(16, Math.min(size, Number.isFinite(maximum) ? maximum : size));
    /*
     * **Half-float when the scene keeps its range, and this is the ceiling on what a metal can
     * look like rather than a quality setting.** A metal has no diffuse term: what it shows is
     * `environment * albedo` and nothing else, so an eight-bit cube caps the whole surface at its
     * own albedo. A dark red panel can then never carry a highlight brighter than dark red,
     * whatever the room contains, and the surface reads as paint however good the map is.
     *
     * Measured on `demo/dev/model.html`, which lights a studio whose panels emit well over white.
     * Driving that gain 1 -> 2.6 -> 8 -> 24 moved the mean over the subject's chest:
     *
     *     RGBA8    33.4  38.9  44.9  45.4      saturated: 3x the light, half a level
     *     RGBA16F  32.2  47.0  83.6  141.4     tracks the room
     *
     * The other backend has always done this — WebGPU's cube takes `pipelines.format` — so this
     * was also the two backends disagreeing about the one thing that decides a metal's appearance.
     *
     * `EXT_color_buffer_float` is what makes a half-float cube *renderable*, and a bake is six
     * render passes into these faces, so its absence is a refusal rather than a slow path. The
     * check mirrors `SceneTarget`'s exactly; filtering needs nothing, being core in WebGL2.
     */
    this.floatColor = wantsRange && gl.getExtension('EXT_color_buffer_float') !== null;

    const texture = gl.createTexture();
    if (texture === null) throw new Error('ReflectionProbe: createTexture failed');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
    /*
     * Mipmapped, and that is the roughness. A polished surface samples level 0 and a satin one
     * samples further up the chain, which is a blur that costs a fetch rather than a pass.
     * `texStorage2D` rather than six `texImage2D` calls because the whole chain has to be
     * declared before a framebuffer will accept a face as an attachment.
     */
    const levels = Math.floor(Math.log2(this.size)) + 1;
    gl.texStorage2D(
      gl.TEXTURE_CUBE_MAP,
      levels,
      this.floatColor ? gl.RGBA16F : gl.RGBA8,
      this.size,
      this.size,
    );
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /*
     * Clamped on every axis. A cube's faces are addressed by direction rather than by UV, so
     * wrapping means nothing here, and leaving it at the default `REPEAT` is how a seam appears
     * along every face edge on the drivers that take it literally.
     */
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

    /*
     * The prefiltered twin: the same storage exactly, because the convolution renders into these
     * levels and a format the bake's own pipeline does not produce is a framebuffer this driver
     * will refuse. Same filters too — the chain is still the roughness, it is simply a chain that
     * now means what the shader assumes it means.
     */
    const prefiltered = gl.createTexture();
    if (prefiltered === null) throw new Error('ReflectionProbe: createTexture failed');
    this.prefiltered = prefiltered;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, prefiltered);
    gl.texStorage2D(
      gl.TEXTURE_CUBE_MAP,
      levels,
      this.floatColor ? gl.RGBA16F : gl.RGBA8,
      this.size,
      this.size,
    );
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

    const depth = gl.createRenderbuffer();
    if (depth === null) throw new Error('ReflectionProbe: createRenderbuffer failed');
    this.depth = depth;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.size, this.size);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) throw new Error('ReflectionProbe: createFramebuffer failed');
    this.framebuffer = framebuffer;

    const prefilterFramebuffer = gl.createFramebuffer();
    if (prefilterFramebuffer === null) throw new Error('ReflectionProbe: createFramebuffer failed');
    this.prefilterFramebuffer = prefilterFramebuffer;
  }

  /**
   * Fill the captured cube from six faces a caller supplies, instead of photographing a room.
   *
   * **The same cube, so everything downstream is the same code.** A loaded environment and a baked
   * one differ only in where the six faces came from; the box chain, the convolution and the
   * spherical-harmonic projection all read this texture either way. That is what keeps a loaded sky
   * from being a second lighting path with its own bugs.
   *
   * **A non-float cube clips rather than tone-maps**, and that is deliberate. The cube stores
   * radiance, and a curve applied here would be a viewing transform baked into stored light — the
   * mistake `bakeReflectionProbe` documents at length on the other side. A part without
   * `EXT_color_buffer_float` gets a clipped environment and a metal that cannot reflect brighter
   * than white, which is the honest degradation and is what `floatColor` already means everywhere
   * else in this file.
   */
  upload(gl: WebGL2RenderingContext, faces: readonly Float32Array[]): boolean {
    if (this.unusable) return false;
    if (faces.length !== 6) {
      throw new Error(
        `ReflectionProbe.upload: needs six faces in cubemap order, got ${faces.length}`,
      );
    }
    const wanted = this.size * this.size * 4;

    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.texture);
    for (let face = 0; face < 6; face++) {
      const pixels = faces[face];
      if (pixels === undefined || pixels.length !== wanted) {
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
        throw new Error(
          `ReflectionProbe.upload: face ${face} is ${pixels?.length ?? 0} floats and this probe ` +
            `wants ${wanted} — build the faces at the probe's own size`,
        );
      }
      const target = gl.TEXTURE_CUBE_MAP_POSITIVE_X + face;
      if (this.floatColor) {
        gl.texSubImage2D(target, 0, 0, 0, this.size, this.size, gl.RGBA, gl.FLOAT, pixels);
      } else {
        const bytes = this.clipToBytes(pixels);
        gl.texSubImage2D(target, 0, 0, 0, this.size, this.size, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      }
    }
    /* The source chain the convolution selects a level from, exactly as a bake leaves behind. */
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    this.baked = true;
    return true;
  }

  /**
   * Linear floats to bytes, clipped at white, for a part with no renderable float cube.
   *
   * Allocated on first use and reused, like `readBytes` above and for the same reason: a probe that
   * is only ever float should not carry a megabyte for a path it never takes.
   */
  private clipToBytes(pixels: Float32Array): Uint8Array {
    let bytes = this.uploadBytes;
    if (bytes === null || bytes.length !== pixels.length) {
      bytes = new Uint8Array(pixels.length);
      this.uploadBytes = bytes;
    }
    for (let i = 0; i < pixels.length; i++) {
      const value = pixels[i] ?? 0;
      bytes[i] = value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
    }
    return bytes;
  }

  /**
   * Convolve the captured chain into the prefiltered one, once per bake.
   *
   * **The caller draws, exactly as it does for a face.** This owns the target — which cube, which
   * face, which level, and the viewport that level wants — and `convolve` owns the program, the
   * uniforms and the triangle, which is the same split `bake` makes with `drawFace` and for the
   * same reason: a probe has no business knowing what a shader is.
   *
   * `roughness` is handed over rather than recomputed by the caller, so the level-to-roughness
   * relation lives in exactly one place. `prefilterEnvMap.ts` is that place, and the lit pass's
   * own level selection is the same relation read the other way.
   */
  prefilter(
    gl: WebGL2RenderingContext,
    convolve: (face: number, level: number, roughness: number) => void,
  ): void {
    if (this.unusable) return;
    const levels = this.maxLod + 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.prefilterFramebuffer);
    for (let level = 0; level < levels; level++) {
      /* A level is half the width of the one below it, and the viewport has to say so or the
         triangle covers a quarter of the target and leaves the rest at the clear colour. */
      const size = Math.max(1, this.size >> level);
      gl.viewport(0, 0, size, size);
      const roughness = roughnessForLevel(level, this.maxLod);
      for (let face = 0; face < 6; face++) {
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          this.prefiltered,
          level,
        );
        convolve(face, level, roughness);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Whether the shader may sample this. False until a bake has finished. */
  get ready(): boolean {
    return this.baked && !this.unusable;
  }

  /** How many mip levels the roughness blur has to work with. */
  get maxLod(): number {
    return Math.floor(Math.log2(this.size));
  }

  /**
   * Render the six faces from `origin`, once.
   *
   * `drawFace` is handed a camera already aimed and is expected to submit the scene exactly as
   * it would to the screen. It is called six times, and it must not call anything that binds a
   * framebuffer of its own: a shadow pass or a planar reflection inside a probe bake would
   * leave the probe's own target unbound halfway through a face.
   *
   * Returns whether the bake happened. A false means the allocation was refused and the caller
   * should carry on without a probe, which is a picture with a gradient in its paint rather
   * than a room.
   */
  bake(
    gl: WebGL2RenderingContext,
    origin: Vec3,
    clearColor: Vec3,
    drawFace: (camera: Camera) => void,
  ): boolean {
    if (this.unusable) return false;

    const camera = this.camera;
    camera.position[0] = origin[0];
    camera.position[1] = origin[1];
    camera.position[2] = origin[2];
    camera.fovYDeg = FACE_FOV_DEG;
    camera.near = NEAR_M;
    camera.far = FAR_M;
    camera.roll = 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.viewport(0, 0, this.size, this.size);

    for (let face = 0; face < FACES.length; face++) {
      const aim = FACES[face];
      if (aim === undefined) continue;
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        this.texture,
        0,
      );
      if (face === 0 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.unusable = true;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        console.warn(
          'ReflectionProbe: this driver will not render to a cubemap face, so reflective ' +
            'surfaces keep the sky-and-ground approximation. Nothing else is affected.',
        );
        return false;
      }

      camera.yaw = aim.yaw;
      camera.pitch = aim.pitch;
      /*
       * Square, so the aspect is 1. Handing the drawing buffer's aspect in here is the mistake
       * that stretches every face and shows up as a reflection that slides at the wrong rate
       * across a curved surface.
       */
      camera.updateMatrices(1);

      gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawFace(camera);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    /* The blur the roughness reads. Once per bake, not once per frame. */
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.texture);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    this.baked = true;
    return true;
  }

  /**
   * Read six faces back off the GPU, at one mip level, for the irradiance projection.
   *
   * **Synchronous, and that is the whole reason the two backends' bindings differ.** `readPixels`
   * blocks until the queue reaches it, and on a level this coarse that is a few thousand texels
   * once per bake. The other backend has no synchronous read at all — its cube is not copyable and
   * `mapAsync` answers on a later tick — so it does this over two frames. Both hand the same six
   * arrays to the same projection, which is where the decision lives.
   *
   * `out` must hold six arrays of at least `(size >> level)^2 * 4` floats. Answers false if the
   * driver would not attach a face for reading, which is the same refusal `bake` already handles
   * by carrying on without a probe: the reflection is already in the cube either way, so a false
   * here costs the diffuse term and nothing else.
   *
   * **What would make it wrong** is reading a level the chain does not have. `texStorage2D`
   * allocated `maxLod + 1` levels, so any level up to `maxLod` is in range; a caller asking for
   * `maxLod - 3` needs a probe of at least eight texels, and below that the projection is not
   * worth doing and the caller skips it.
   */
  readFaces(gl: WebGL2RenderingContext, level: number, out: Float32Array[]): boolean {
    if (this.unusable || !this.baked) return false;
    const side = Math.max(1, this.size >> level);
    const wanted = side * side * 4;
    for (let face = 0; face < 6; face++) {
      const target = out[face];
      if (target === undefined || target.length < wanted) return false;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    /* Depth is irrelevant to a read, and a renderbuffer sized for level 0 makes the framebuffer
       incomplete at any smaller level. */
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);

    let ok = true;
    for (let face = 0; face < 6 && ok; face++) {
      const target = out[face];
      if (target === undefined) {
        ok = false;
        break;
      }
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        this.texture,
        level,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        ok = false;
        break;
      }
      /*
       * **The type has to match what the cube is, and asking for the wrong one is a refusal
       * rather than a conversion.** `RGBA/FLOAT` is readable from the half-float cube this probe
       * allocates when a scene keeps its range, and `INVALID_OPERATION` from the `RGBA8` one it
       * allocates otherwise — *"Invalid format and type combination"*, in the driver's own words,
       * on every face, with the frame drawing perfectly well around it. Most scenes do not ask for
       * range, so the byte path is the common one rather than the fallback.
       */
      if (this.floatColor) {
        gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, target);
      } else {
        const bytes = this.readBytes;
        if (bytes === null || bytes.length < wanted) this.readBytes = new Uint8Array(wanted);
        const buffer = this.readBytes;
        if (buffer === null) {
          ok = false;
          break;
        }
        gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        /* The cube holds linear values — it is a render target, not an art texture, and nothing
           encodes on the way in — so a byte is that value over 255 and nothing else. */
        for (let i = 0; i < wanted; i++) target[i] = (buffer[i] ?? 0) / 255;
      }
    }

    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok && gl.getError() === gl.NO_ERROR;
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.prefilterFramebuffer);
    gl.deleteRenderbuffer(this.depth);
    gl.deleteTexture(this.texture);
    gl.deleteTexture(this.prefiltered);
    this.baked = false;
  }
}
