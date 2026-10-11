/**
 * A point skin on WebGL2: posed by transform feedback, a vertex stage run once a vertex with the
 * rasteriser off, its two outputs captured into the dynamic mesh's own position and normal buffers.
 * What a point skin is, and why it poses into a mesh, is `pointSkin.ts`; the same arithmetic in the
 * same order is `backend/webgpu/shaders/pointSkin.wgsl.ts`.
 *
 * **Every binding it makes it undoes**, because it runs between a frame's draws: the program, the
 * vertex array, the joint texture on its own unit, the feedback buffers and the discard. A buffer
 * left bound for feedback while a draw reads it as vertices is an error WebGL2 raises at the draw.
 */
import { POINT_SKIN_TEXTURE_UNIT } from '../../lightBudget.ts';
import type { Mesh } from '../../mesh.ts';
import { reachOf, type PointSkinData, type PointSkinReach } from '../../pointSkin.ts';
import { compileProgram } from '../../shader.ts';

const POSE_VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aNamed;
layout(location = 1) in vec4 aWeights;
layout(location = 2) in vec3 aPoint0;
layout(location = 3) in vec3 aPoint1;
layout(location = 4) in vec3 aPoint2;
layout(location = 5) in vec3 aPoint3;
layout(location = 6) in vec3 aNormal;
uniform highp sampler2D uJoints;
out vec3 vPosition;
out vec3 vNormal;

mat4 jointAt(float joint) {
  int at = int(joint) * 4;
  return mat4(
    texelFetch(uJoints, ivec2(at, 0), 0),
    texelFetch(uJoints, ivec2(at + 1, 0), 0),
    texelFetch(uJoints, ivec2(at + 2, 0), 0),
    texelFetch(uJoints, ivec2(at + 3, 0), 0)
  );
}

void main() {
  vec3 p = vec3(0.0);
  if (aWeights.x != 0.0) p += aWeights.x * (jointAt(aNamed.x) * vec4(aPoint0, 1.0)).xyz;
  if (aWeights.y != 0.0) p += aWeights.y * (jointAt(aNamed.y) * vec4(aPoint1, 1.0)).xyz;
  if (aWeights.z != 0.0) p += aWeights.z * (jointAt(aNamed.z) * vec4(aPoint2, 1.0)).xyz;
  if (aWeights.w != 0.0) p += aWeights.w * (jointAt(aNamed.w) * vec4(aPoint3, 1.0)).xyz;
  vec3 raw = mat3(jointAt(aNamed.x)) * aNormal;
  float l = length(raw);
  vNormal = l > 0.0 ? raw / l : raw;
  vPosition = p;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const POSE_FRAG = /* glsl */ `#version 300 es
precision mediump float;
out vec4 colour;
void main() {
  colour = vec4(0.0);
}
`;

/** The program and feedback object every skin on a context poses with, made at the first skin. */
export interface PointSkinPose {
  readonly program: WebGLProgram;
  readonly feedback: WebGLTransformFeedback;
}

export function createPointSkinPose(gl: WebGL2RenderingContext): PointSkinPose {
  const program = compileProgram(gl, POSE_VERT, POSE_FRAG, 'pointSkin.pose', [
    'vPosition',
    'vNormal',
  ]);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'uJoints'), POINT_SKIN_TEXTURE_UNIT);
  gl.useProgram(null);
  const feedback = gl.createTransformFeedback();
  if (feedback === null) throw new Error('createTransformFeedback failed');
  return { program, feedback };
}

export class GlPointSkin {
  readonly mesh: Mesh;
  readonly reach: PointSkinReach;
  private readonly count: number;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly joints: WebGLTexture;
  private readonly width: number;

  constructor(gl: WebGL2RenderingContext, mesh: Mesh, data: PointSkinData) {
    this.mesh = mesh;
    this.reach = reachOf(data);
    this.count = data.weights.length / 4;
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);
    this.attach(gl, data.joints, [[0, 4, 16, 0]]);
    this.attach(gl, data.weights, [[1, 4, 16, 0]]);
    this.attach(gl, data.points, [
      [2, 3, 48, 0],
      [3, 3, 48, 12],
      [4, 3, 48, 24],
      [5, 3, 48, 36],
    ]);
    this.attach(gl, data.normals, [[6, 3, 12, 0]]);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    /* One row, four texels a joint, as the skin palette is. */
    this.width = Math.max(1, this.reach.joints * 4);
    const joints = gl.createTexture();
    if (joints === null) throw new Error('createTexture failed');
    this.joints = joints;
    gl.activeTexture(gl.TEXTURE0 + POINT_SKIN_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, joints);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.width, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** One buffer, read as each `[location, size, stride, offset]` says. */
  private attach(
    gl: WebGL2RenderingContext,
    values: Float32Array,
    reads: readonly (readonly [number, number, number, number])[],
  ): void {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('createBuffer failed');
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    for (const [location, size, stride, offset] of reads) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }
  }

  /** Pose every vertex into the mesh's buffers now, and undo every binding it made. */
  pose(gl: WebGL2RenderingContext, pose: PointSkinPose, matrices: Float32Array): void {
    const streams = this.mesh.streams;
    if (streams === null) return;
    gl.useProgram(pose.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0 + POINT_SKIN_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.joints);
    if (this.reach.joints > 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, 1, gl.RGBA, gl.FLOAT, matrices, 0);
    }
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, pose.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, streams.positions);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, streams.normals);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteTexture(this.joints);
    gl.deleteVertexArray(this.vao);
  }
}
