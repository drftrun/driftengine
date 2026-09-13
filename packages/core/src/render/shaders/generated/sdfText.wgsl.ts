/*
 * Generated from ../sdfText.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SDF_TEXT_FRAG_WGSL = "struct Uniforms {\n    uColor: vec3<f32>,\n    uOpacity: f32,\n    uDistanceRange: f32,\n    uAtlasSize: vec2<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uAtlas_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uAtlas_s: sampler;\nvar<private> vUv_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e60 = (*c);\n    low = (_e60 * 12.92f);\n    let _e62 = (*c);\n    high = ((pow(max(_e62, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e68 = high;\n    let _e69 = low;\n    let _e70 = (*c);\n    return mix(_e68, _e69, step(_e70, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e60 = (*v);\n    let _e61 = (*v);\n    a = ((_e60 * (_e61 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e67 = (*v);\n    let _e68 = (*v);\n    b = ((_e67 * ((_e68 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e75 = a;\n    let _e76 = b;\n    return (_e75 / _e76);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e60 = unnamed.uOutputExposure;\n    let _e61 = (*x);\n    (*x) = (_e61 * _e60);\n    let _e63 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e63);\n    let _e65 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e65), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n\n    let _e61 = unnamed.uOutputTransform;\n    if (_e61 == 0i) {\n        let _e63 = (*c_1);\n        return _e63;\n    }\n    let _e65 = unnamed.uOutputTransform;\n    if (_e65 == 2i) {\n        let _e67 = (*c_1);\n        param_1 = _e67;\n        let _e68 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_1) = _e68;\n    }\n    let _e69 = (*c_1);\n    param_2 = _e69;\n    let _e70 = linearToSrgb_u0028_vf3_u003b((&param_2));\n    return _e70;\n}\n\nfn median_u0028_vf3_u003b(rgb: ptr<function, vec3<f32>>) -> f32 {\n    let _e59 = (*rgb)[0u];\n    let _e61 = (*rgb)[1u];\n    let _e64 = (*rgb)[0u];\n    let _e66 = (*rgb)[1u];\n    let _e69 = (*rgb)[2u];\n    return max(min(_e59, _e61), min(max(_e64, _e66), _e69));\n}\n\nfn main_1() {\n    var sampled: vec3<f32>;\n    var distance_: f32;\n    var param_3: vec3<f32>;\n    var texelsPerPixel: vec2<f32>;\n    var pixelRange: f32;\n    var coverage: f32;\n    var param_4: vec3<f32>;\n\n    let _e64 = vUv_1;\n    let _e65 = textureSampleLevel(uAtlas_t, uAtlas_s, _e64, 0f);\n    sampled = _e65.xyz;\n    let _e67 = sampled;\n    param_3 = _e67;\n    let _e68 = median_u0028_vf3_u003b((&param_3));\n    distance_ = (_e68 - 0.5f);\n    let _e70 = vUv_1;\n    let _e71 = fwidth(_e70);\n    let _e73 = unnamed.uAtlasSize;\n    texelsPerPixel = (_e71 * _e73);\n    let _e76 = texelsPerPixel[0u];\n    let _e78 = texelsPerPixel[1u];\n    pixelRange = max((0.5f * (_e76 + _e78)), 0.0001f);\n    let _e82 = distance_;\n    let _e84 = unnamed.uDistanceRange;\n    let _e86 = pixelRange;\n    coverage = clamp((((_e82 * _e84) / _e86) + 0.5f), 0f, 1f);\n    let _e91 = unnamed.uColor;\n    param_4 = _e91;\n    let _e92 = applyOutputTransform_u0028_vf3_u003b((&param_4));\n    let _e93 = coverage;\n    let _e95 = unnamed.uOpacity;\n    outColor = vec4<f32>(_e92.x, _e92.y, _e92.z, (_e93 * _e95));\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = outColor;\n    return _e3;\n}\n";

export const SDF_TEXT_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vUv: vec2<f32>;\nvar<private> aUv_1: vec2<f32>;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(0) \nvar<uniform> unnamed_1: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\n\nfn main_1() {\n    let _e8 = aUv_1;\n    vUv = _e8;\n    let _e10 = unnamed_1.uViewProj;\n    let _e12 = unnamed_1.uModel;\n    let _e14 = aPosition_1;\n    unnamed.gl_Position = ((_e10 * _e12) * vec4<f32>(_e14.x, _e14.y, _e14.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(1) aUv: vec2<f32>, @location(0) aPosition: vec3<f32>) -> VertexOutput {\n    aUv_1 = aUv;\n    aPosition_1 = aPosition;\n    main_1();\n    let _e8 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e8);\n    let _e10 = vUv;\n    let _e11 = unnamed.gl_Position;\n    return VertexOutput(_e10, _e11);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SDFTEXT_BINDINGS = {
  "SDF_TEXT_FRAG": {
    "uniforms": 1,
    "uniformSize": 48,
    "fields": {
      "uColor": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uOpacity": {
        "offset": 12,
        "size": 4,
        "type": "float"
      },
      "uDistanceRange": {
        "offset": 16,
        "size": 4,
        "type": "float"
      },
      "uAtlasSize": {
        "offset": 24,
        "size": 8,
        "type": "vec2"
      },
      "uOutputTransform": {
        "offset": 32,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 36,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uAtlas": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "SDF_TEXT_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uModel": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
