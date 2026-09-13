/*
 * Generated from ../panel.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const PANEL_FRAG_WGSL = "struct Uniforms {\n    uColor: vec3<f32>,\n    uAlpha: f32,\n}\n\nvar<private> outColor: vec4<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n\nfn main_1() {\n    let _e5 = unnamed.uColor;\n    let _e7 = unnamed.uAlpha;\n    outColor = vec4<f32>(_e5.x, _e5.y, _e5.z, _e7);\n    return;\n}\n\n@fragment \nfn main() -> @location(0) vec4<f32> {\n    main_1();\n    let _e1 = outColor;\n    return _e1;\n}\n";

export const PANEL_VERT_WGSL = "struct Uniforms {\n    uRect: vec4<f32>,\n    uViewport: vec2<f32>,\n    uClipCorrection: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var px: vec2<f32>;\n    var ndc: vec2<f32>;\n\n    let _e14 = unnamed.uRect;\n    let _e16 = aCorner_1;\n    let _e18 = unnamed.uRect;\n    px = (_e14.xy + (_e16 * _e18.zw));\n    let _e23 = px[0u];\n    let _e26 = unnamed.uViewport[0u];\n    let _e31 = px[1u];\n    let _e34 = unnamed.uViewport[1u];\n    ndc = vec2<f32>((((_e23 / _e26) * 2f) - 1f), (1f - ((_e31 / _e34) * 2f)));\n    let _e40 = unnamed.uClipCorrection;\n    let _e41 = ndc;\n    unnamed_1.gl_Position = (_e40 * vec4<f32>(_e41.x, _e41.y, 0f, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aCorner: vec2<f32>) -> @builtin(position) vec4<f32> {\n    aCorner_1 = aCorner;\n    main_1();\n    let _e5 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e5);\n    let _e7 = unnamed_1.gl_Position;\n    return _e7;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const PANEL_BINDINGS = {
  "PANEL_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uColor": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uAlpha": {
        "offset": 12,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PANEL_VERT": {
    "uniforms": 0,
    "uniformSize": 96,
    "fields": {
      "uRect": {
        "offset": 0,
        "size": 16,
        "type": "vec4"
      },
      "uViewport": {
        "offset": 16,
        "size": 8,
        "type": "vec2"
      },
      "uClipCorrection": {
        "offset": 32,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
