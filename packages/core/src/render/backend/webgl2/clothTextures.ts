/**
 * A cloth binding's textures on WebGL2: the binding and the rest particles once, a mesh's; the
 * particles every frame, a character's.
 *
 * `RGBA32F`, one storage level and `NEAREST` both ways, as the joint palette is: the vertex stage
 * reads them with `texelFetch`, so nothing filters and nothing selects a mip. Rows of at most 2048
 * texels; see `clothBindingData.ts`.
 *
 * **Two particle textures that swap on each update**, so last frame's positions are still there for
 * a motion vector without a copy: an update writes the older of the two and makes it current.
 */
import { clothTextureSize, packClothBinding, packClothParticles } from '../../clothBindingData.ts';
import type { ClothBindingData } from '../../clothBindingData.ts';

function floatTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  texels: Float32Array | null,
): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new Error('cloth: createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (texels !== null) {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, texels);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/** A mesh's binding and its particles at rest. Validated by the renderer against the mesh. */
export class GlClothBinding {
  readonly binding: WebGLTexture;
  readonly rest: WebGLTexture;
  /** How many particles the binding names. */
  readonly particles: number;

  constructor(gl: WebGL2RenderingContext, data: ClothBindingData) {
    const vertices = data.weights.length;
    const size = clothTextureSize(vertices * 2);
    this.binding = floatTexture(gl, size.width, size.height, packClothBinding(data));
    this.particles = data.rest.length / 3;
    const rest = clothTextureSize(this.particles);
    const texels = new Float32Array(rest.width * rest.height * 4);
    packClothParticles(data.rest, texels);
    this.rest = floatTexture(gl, rest.width, rest.height, texels);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteTexture(this.binding);
    gl.deleteTexture(this.rest);
  }
}

/** One character's particles: this frame's and the last, in two textures that swap. */
export class GlClothParticles {
  readonly count: number;
  private readonly width: number;
  private readonly height: number;
  private readonly staging: Float32Array;
  private readonly textures: [WebGLTexture, WebGLTexture];
  private latest = 0;

  constructor(gl: WebGL2RenderingContext, count: number) {
    this.count = count;
    const size = clothTextureSize(count);
    this.width = size.width;
    this.height = size.height;
    this.staging = new Float32Array(size.width * size.height * 4);
    this.textures = [
      floatTexture(gl, size.width, size.height, this.staging),
      floatTexture(gl, size.width, size.height, this.staging),
    ];
  }

  /** This frame's particles. */
  get current(): WebGLTexture {
    return this.textures[this.latest] as WebGLTexture;
  }

  /** Last frame's. */
  get previous(): WebGLTexture {
    return this.textures[1 - this.latest] as WebGLTexture;
  }

  /** Write `positions` (three floats a particle, world space) as this frame's; last frame's stays. */
  update(gl: WebGL2RenderingContext, positions: Float32Array): void {
    if (positions.length !== this.count * 3) {
      throw new Error(
        `cloth: ${this.count} particles and an update of ${positions.length / 3}; a cloth's ` +
          'particle count is fixed when its particles are created',
      );
    }
    packClothParticles(positions, this.staging);
    this.latest = 1 - this.latest;
    gl.bindTexture(gl.TEXTURE_2D, this.current);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      gl.RGBA,
      gl.FLOAT,
      this.staging,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteTexture(this.textures[0]);
    gl.deleteTexture(this.textures[1]);
  }
}
