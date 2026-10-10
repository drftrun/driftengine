/*
 * Generated from ../panel.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const PANEL_FRAG_WGSL = "struct Uniforms {\n    uColor: vec3<f32>,\n    uAlpha: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e55 = (*c);\n    low = (_e55 * 12.92f);\n    let _e57 = (*c);\n    high = ((pow(max(_e57, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e63 = high;\n    let _e64 = low;\n    let _e65 = (*c);\n    return mix(_e63, _e64, step(_e65, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e56 = (*c_1)[0u];\n    let _e58 = (*c_1)[1u];\n    let _e60 = (*c_1)[2u];\n    m = max(_e56, max(_e58, _e60));\n    let _e63 = m;\n    if (_e63 <= 0.8f) {\n        let _e65 = (*c_1);\n        return _e65;\n    }\n    let _e66 = m;\n    e = (_e66 - 0.8f);\n    let _e68 = (*c_1);\n    let _e69 = e;\n    let _e71 = e;\n    let _e75 = m;\n    return (_e68 * ((0.8f + ((0.2f * _e69) / (_e71 + 0.2f))) / _e75));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e55 = (*v);\n    let _e56 = (*v);\n    a = ((_e55 * (_e56 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e62 = (*v);\n    let _e63 = (*v);\n    b = ((_e62 * ((_e63 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e70 = a;\n    let _e71 = b;\n    return (_e70 / _e71);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e55 = unnamed.uOutputExposure;\n    let _e56 = (*x);\n    (*x) = (_e56 * _e55);\n    let _e58 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e58);\n    let _e60 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e60), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e57 = unnamed.uOutputTransform;\n    if (_e57 == 0i) {\n        let _e59 = (*c_2);\n        return _e59;\n    }\n    let _e61 = unnamed.uOutputTransform;\n    if (_e61 == 2i) {\n        let _e63 = (*c_2);\n        param_1 = _e63;\n        let _e64 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e64;\n    }\n    let _e66 = unnamed.uOutputTransform;\n    if (_e66 == 3i) {\n        let _e68 = (*c_2);\n        let _e70 = unnamed.uOutputExposure;\n        param_2 = (_e68 * _e70);\n        let _e72 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e72;\n    }\n    let _e73 = (*c_2);\n    param_3 = _e73;\n    let _e74 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e74;\n}\n\nfn main_1() {\n    var param_4: vec3<f32>;\n\n    let _e54 = unnamed.uColor;\n    param_4 = _e54;\n    let _e55 = applyOutputTransform_u0028_vf3_u003b((&param_4));\n    let _e57 = unnamed.uAlpha;\n    outColor = vec4<f32>(_e55.x, _e55.y, _e55.z, _e57);\n    return;\n}\n\n@fragment \nfn main() -> @location(0) vec4<f32> {\n    main_1();\n    let _e1 = outColor;\n    return _e1;\n}\n";

export const PANEL_VERT_WGSL = "struct Uniforms {\n    uRect: vec4<f32>,\n    uViewport: vec2<f32>,\n    uClipCorrection: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var px: vec2<f32>;\n    var ndc: vec2<f32>;\n\n    let _e14 = unnamed.uRect;\n    let _e16 = aCorner_1;\n    let _e18 = unnamed.uRect;\n    px = (_e14.xy + (_e16 * _e18.zw));\n    let _e23 = px[0u];\n    let _e26 = unnamed.uViewport[0u];\n    let _e31 = px[1u];\n    let _e34 = unnamed.uViewport[1u];\n    ndc = vec2<f32>((((_e23 / _e26) * 2f) - 1f), (1f - ((_e31 / _e34) * 2f)));\n    let _e40 = unnamed.uClipCorrection;\n    let _e41 = ndc;\n    unnamed_1.gl_Position = (_e40 * vec4<f32>(_e41.x, _e41.y, 0f, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aCorner: vec2<f32>) -> @builtin(position) vec4<f32> {\n    aCorner_1 = aCorner;\n    main_1();\n    let _e5 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e5);\n    let _e7 = unnamed_1.gl_Position;\n    return _e7;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const PANEL_BINDINGS = {
  "PANEL_FRAG": {
    "uniforms": 1,
    "uniformSize": 32,
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
      },
      "uOutputTransform": {
        "offset": 16,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 20,
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
