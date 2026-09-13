/*
 * Generated from ../fullscreen.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FULLSCREEN_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> gl_VertexIndex_1: i32;\nvar<private> vUv: vec2<f32>;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var corner: vec2<f32>;\n\n    let _e11 = gl_VertexIndex_1;\n    let _e16 = gl_VertexIndex_1;\n    corner = ((vec2<f32>(f32(((_e11 << bitcast<u32>(1i)) & 2i)), f32((_e16 & 2i))) * 2f) - vec2(1f));\n    let _e23 = corner;\n    vUv = ((_e23 * 0.5f) + vec2(0.5f));\n    let _e27 = corner;\n    unnamed.gl_Position = vec4<f32>(_e27.x, _e27.y, 0f, 1f);\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32) -> VertexOutput {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    main_1();\n    let _e7 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e7);\n    let _e9 = vUv;\n    let _e10 = unnamed.gl_Position;\n    return VertexOutput(_e9, _e10);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FULLSCREEN_BINDINGS = {
  "FULLSCREEN_VERT": {
    "uniforms": null,
    "textures": {}
  }
} as const;
