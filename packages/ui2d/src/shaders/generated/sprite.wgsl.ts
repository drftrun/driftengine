/*
 * Generated from ../sprite.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SPRITE_FRAG_WGSL = "struct Uniforms {\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSpriteTexture_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSpriteTexture_s: sampler;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vTint_1: vec4<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e61 = (*c);\n    low = (_e61 * 12.92f);\n    let _e63 = (*c);\n    high = ((pow(max(_e63, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e69 = high;\n    let _e70 = low;\n    let _e71 = (*c);\n    return mix(_e69, _e70, step(_e71, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e62 = (*c_1)[0u];\n    let _e64 = (*c_1)[1u];\n    let _e66 = (*c_1)[2u];\n    m = max(_e62, max(_e64, _e66));\n    let _e69 = m;\n    if (_e69 <= 0.8f) {\n        let _e71 = (*c_1);\n        return _e71;\n    }\n    let _e72 = m;\n    e = (_e72 - 0.8f);\n    let _e74 = (*c_1);\n    let _e75 = e;\n    let _e77 = e;\n    let _e81 = m;\n    return (_e74 * ((0.8f + ((0.2f * _e75) / (_e77 + 0.2f))) / _e81));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e61 = (*v);\n    let _e62 = (*v);\n    a = ((_e61 * (_e62 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e68 = (*v);\n    let _e69 = (*v);\n    b = ((_e68 * ((_e69 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e76 = a;\n    let _e77 = b;\n    return (_e76 / _e77);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e61 = unnamed.uOutputExposure;\n    let _e62 = (*x);\n    (*x) = (_e62 * _e61);\n    let _e64 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e64);\n    let _e66 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e66), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e63 = unnamed.uOutputTransform;\n    if (_e63 == 0i) {\n        let _e65 = (*c_2);\n        return _e65;\n    }\n    let _e67 = unnamed.uOutputTransform;\n    if (_e67 == 2i) {\n        let _e69 = (*c_2);\n        param_1 = _e69;\n        let _e70 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e70;\n    }\n    let _e72 = unnamed.uOutputTransform;\n    if (_e72 == 3i) {\n        let _e74 = (*c_2);\n        let _e76 = unnamed.uOutputExposure;\n        param_2 = (_e74 * _e76);\n        let _e78 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e78;\n    }\n    let _e79 = (*c_2);\n    param_3 = _e79;\n    let _e80 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e80;\n}\n\nfn main_1() {\n    var texel: vec4<f32>;\n    var colour: vec4<f32>;\n    var param_4: vec3<f32>;\n\n    let _e61 = vUv_1;\n    let _e62 = textureSample(uSpriteTexture_t, uSpriteTexture_s, _e61);\n    texel = _e62;\n    let _e63 = texel;\n    let _e64 = vTint_1;\n    colour = (_e63 * _e64);\n    let _e67 = colour[3u];\n    if (_e67 < 0.00392157f) {\n        discard;\n    }\n    let _e69 = colour;\n    param_4 = _e69.xyz;\n    let _e71 = applyOutputTransform_u0028_vf3_u003b((&param_4));\n    let _e72 = colour;\n    colour = vec4<f32>(_e71.x, _e71.y, _e71.z, _e72.w);\n    let _e78 = colour;\n    let _e81 = colour[3u];\n    let _e82 = (_e78.xyz * _e81);\n    let _e84 = colour[3u];\n    fragColor = vec4<f32>(_e82.x, _e82.y, _e82.z, _e84);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(1) vTint: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vTint_1 = vTint;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

export const SPRITE_VERT_WGSL = "struct Uniforms {\n    uToNdc0_: vec4<f32>,\n    uToNdc1_: vec4<f32>,\n    uClipCorrection: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> gl_VertexIndex_1: i32;\nvar<private> aOrigin_1: vec2<f32>;\nvar<private> aEdges_1: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv: vec2<f32>;\nvar<private> aUv_1: vec4<f32>;\nvar<private> vTint: vec4<f32>;\nvar<private> aTint_1: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var corner: vec2<f32>;\n    var indexable: array<vec2<f32>, 6>;\n    var p: vec2<f32>;\n    var ndc: vec2<f32>;\n    var orientation: f32;\n    var along: vec2<f32>;\n    var local: f32;\n\n    let _e31 = gl_VertexIndex_1;\n    indexable = array<vec2<f32>, 6>(vec2<f32>(0f, 0f), vec2<f32>(1f, 0f), vec2<f32>(0f, 1f), vec2<f32>(0f, 1f), vec2<f32>(1f, 0f), vec2<f32>(1f, 1f));\n    let _e33 = indexable[_e31];\n    corner = _e33;\n    let _e34 = aOrigin_1;\n    let _e35 = aEdges_1;\n    let _e38 = corner[0u];\n    let _e41 = aEdges_1;\n    let _e44 = corner[1u];\n    p = ((_e34 + (_e35.xy * _e38)) + (_e41.zw * _e44));\n    let _e49 = unnamed.uToNdc0_[0u];\n    let _e51 = p[0u];\n    let _e55 = unnamed.uToNdc0_[2u];\n    let _e57 = p[1u];\n    let _e62 = unnamed.uToNdc1_[0u];\n    let _e66 = unnamed.uToNdc0_[1u];\n    let _e68 = p[0u];\n    let _e72 = unnamed.uToNdc0_[3u];\n    let _e74 = p[1u];\n    let _e79 = unnamed.uToNdc1_[1u];\n    ndc = vec2<f32>((((_e49 * _e51) + (_e55 * _e57)) + _e62), (((_e66 * _e68) + (_e72 * _e74)) + _e79));\n    let _e84 = unnamed.uToNdc0_[0u];\n    let _e87 = unnamed.uToNdc0_[3u];\n    let _e91 = unnamed.uToNdc0_[1u];\n    let _e94 = unnamed.uToNdc0_[2u];\n    orientation = ((_e84 * _e87) - (_e91 * _e94));\n    let _e98 = corner[0u];\n    let _e99 = orientation;\n    if (_e99 > 0f) {\n        let _e102 = corner[1u];\n        local = (1f - _e102);\n    } else {\n        let _e105 = corner[1u];\n        local = _e105;\n    }\n    let _e106 = local;\n    along = vec2<f32>(_e98, _e106);\n    let _e108 = aUv_1;\n    let _e110 = aUv_1;\n    let _e112 = along;\n    vUv = mix(_e108.xy, _e110.zw, _e112);\n    let _e114 = aTint_1;\n    vTint = _e114;\n    let _e116 = unnamed.uClipCorrection;\n    let _e117 = ndc;\n    unnamed_1.gl_Position = (_e116 * vec4<f32>(_e117.x, _e117.y, 0f, 1f));\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32, @location(3) aOrigin: vec2<f32>, @location(0) aEdges: vec4<f32>, @location(1) aUv: vec4<f32>, @location(2) aTint: vec4<f32>) -> VertexOutput {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    aOrigin_1 = aOrigin;\n    aEdges_1 = aEdges;\n    aUv_1 = aUv;\n    aTint_1 = aTint;\n    main_1();\n    let _e16 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e16);\n    let _e18 = vUv;\n    let _e19 = vTint;\n    let _e20 = unnamed_1.gl_Position;\n    return VertexOutput(_e18, _e19, _e20);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SPRITE_BINDINGS = {
  "SPRITE_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uOutputTransform": {
        "offset": 0,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 4,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSpriteTexture": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "SPRITE_VERT": {
    "uniforms": 0,
    "uniformSize": 96,
    "fields": {
      "uToNdc0": {
        "offset": 0,
        "size": 16,
        "type": "vec4"
      },
      "uToNdc1": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
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
