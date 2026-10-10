/*
 * Generated from ../skinBlur.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SKIN_BLUR_FRAG_WGSL = "struct Uniforms {\n    uStep: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n    uFocal: f32,\n    uProfiles: array<vec4<f32>, 8>,\n    uApplyAlbedo: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(36) \nvar uAlbedo_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uAlbedo_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uSkin_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSkin_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\n\nfn burleyMass_u0028_f1_u003b_vf3_u003b(x: ptr<function, f32>, d: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e94 = (*x);\n    let _e96 = (*d);\n    let _e100 = (*x);\n    let _e102 = (*d);\n    return (vec3(0.5f) - ((exp((vec3(-(_e94)) / _e96)) + (exp((vec3(-(_e100)) / (_e102 * 3f))) * 3f)) * 0.125f));\n}\n\nfn viewZ_u0028_f1_u003b(depth: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e94 = (*depth);\n    ndc = (1f - (_e94 * 2f));\n    let _e99 = unnamed.uDepthToViewZ[0u];\n    let _e100 = ndc;\n    let _e104 = unnamed.uDepthToViewZ[1u];\n    let _e108 = unnamed.uDepthToViewZ[2u];\n    let _e109 = ndc;\n    let _e113 = unnamed.uDepthToViewZ[3u];\n    return (((_e99 * _e100) + _e104) / ((_e108 * _e109) + _e113));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e95 = (*c);\n    low = (_e95 * 12.92f);\n    let _e97 = (*c);\n    high = ((pow(max(_e97, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e103 = high;\n    let _e104 = low;\n    let _e105 = (*c);\n    return mix(_e103, _e104, step(_e105, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e96 = (*c_1)[0u];\n    let _e98 = (*c_1)[1u];\n    let _e100 = (*c_1)[2u];\n    m = max(_e96, max(_e98, _e100));\n    let _e103 = m;\n    if (_e103 <= 0.8f) {\n        let _e105 = (*c_1);\n        return _e105;\n    }\n    let _e106 = m;\n    e = (_e106 - 0.8f);\n    let _e108 = (*c_1);\n    let _e109 = e;\n    let _e111 = e;\n    let _e115 = m;\n    return (_e108 * ((0.8f + ((0.2f * _e109) / (_e111 + 0.2f))) / _e115));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e95 = (*v);\n    let _e96 = (*v);\n    a = ((_e95 * (_e96 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e102 = (*v);\n    let _e103 = (*v);\n    b = ((_e102 * ((_e103 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e110 = a;\n    let _e111 = b;\n    return (_e110 / _e111);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e95 = unnamed.uOutputExposure;\n    let _e96 = (*x_1);\n    (*x_1) = (_e96 * _e95);\n    let _e98 = (*x_1);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e98);\n    let _e100 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e100), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e97 = unnamed.uOutputTransform;\n    if (_e97 == 0i) {\n        let _e99 = (*c_2);\n        return _e99;\n    }\n    let _e101 = unnamed.uOutputTransform;\n    if (_e101 == 2i) {\n        let _e103 = (*c_2);\n        param_1 = _e103;\n        let _e104 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e104;\n    }\n    let _e106 = unnamed.uOutputTransform;\n    if (_e106 == 3i) {\n        let _e108 = (*c_2);\n        let _e110 = unnamed.uOutputExposure;\n        param_2 = (_e108 * _e110);\n        let _e112 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e112;\n    }\n    let _e113 = (*c_2);\n    param_3 = _e113;\n    let _e114 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e114;\n}\n\nfn withAlbedo_u0028_vf3_u003b(light: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var albedo: vec4<f32>;\n    var param_4: vec3<f32>;\n\n    let _e96 = unnamed.uApplyAlbedo;\n    if (_e96 < 0.5f) {\n        let _e98 = (*light);\n        return _e98;\n    }\n    let _e99 = vUv_1;\n    let _e100 = textureSampleLevel(uAlbedo_t, uAlbedo_s, _e99, 0f);\n    albedo = _e100;\n    let _e101 = (*light);\n    let _e102 = albedo;\n    let _e106 = albedo[3u];\n    param_4 = ((_e101 * _e102.xyz) / vec3(max(_e106, 0.0001f)));\n    let _e110 = applyOutputTransform_u0028_vf3_u003b((&param_4));\n    return _e110;\n}\n\nfn main_1() {\n    var own: vec4<f32>;\n    var depth_1: f32;\n    var param_5: vec3<f32>;\n    var profile: i32;\n    var d_1: vec3<f32>;\n    var widest: f32;\n    var z: f32;\n    var param_6: f32;\n    var pixels: f32;\n    var param_7: vec3<f32>;\n    var centre: vec3<f32>;\n    var param_8: f32;\n    var param_9: vec3<f32>;\n    var sum: vec3<f32>;\n    var weight: vec3<f32>;\n    var i: i32;\n    var outer: vec3<f32>;\n    var local: vec3<f32>;\n    var indexable: array<f32, 6>;\n    var param_10: f32;\n    var param_11: vec3<f32>;\n    var w: vec3<f32>;\n    var indexable_1: array<f32, 6>;\n    var param_12: f32;\n    var param_13: vec3<f32>;\n    var side: i32;\n    var uv: vec2<f32>;\n    var indexable_2: array<f32, 7>;\n    var tap: vec4<f32>;\n    var tapZ: f32;\n    var param_14: f32;\n    var keep: f32;\n    var cover: f32;\n    var param_15: vec3<f32>;\n\n    let _e126 = vUv_1;\n    let _e127 = textureSampleLevel(uSkin_t, uSkin_s, _e126, 0f);\n    own = _e127;\n    let _e129 = own[3u];\n    if (_e129 < 0.0001f) {\n        fragColor = vec4<f32>(0f, 0f, 0f, 0f);\n        return;\n    }\n    let _e131 = vUv_1;\n    let _e132 = textureSampleLevel(uDepth_t, uDepth_s, _e131, 0f);\n    depth_1 = _e132.x;\n    let _e134 = depth_1;\n    if (_e134 <= 0f) {\n        let _e136 = own;\n        param_5 = _e136.xyz;\n        let _e138 = withAlbedo_u0028_vf3_u003b((&param_5));\n        let _e140 = own[3u];\n        fragColor = vec4<f32>(_e138.x, _e138.y, _e138.z, _e140);\n        return;\n    }\n    let _e146 = own[3u];\n    profile = clamp((i32(((_e146 * 8f) + 0.5f)) - 1i), 0i, 7i);\n    let _e152 = profile;\n    let _e155 = unnamed.uProfiles[_e152];\n    d_1 = max(_e155.xyz, vec3<f32>(0.000001f, 0.000001f, 0.000001f));\n    let _e159 = d_1[0u];\n    let _e161 = d_1[1u];\n    let _e163 = d_1[2u];\n    widest = max(_e159, max(_e161, _e163));\n    let _e166 = depth_1;\n    param_6 = _e166;\n    let _e167 = viewZ_u0028_f1_u003b((&param_6));\n    z = abs(_e167);\n    let _e169 = widest;\n    let _e171 = unnamed.uFocal;\n    let _e173 = z;\n    pixels = ((_e169 * _e171) / max(_e173, 0.0001f));\n    let _e176 = pixels;\n    if (_e176 < 0.5f) {\n        let _e178 = own;\n        param_7 = _e178.xyz;\n        let _e180 = withAlbedo_u0028_vf3_u003b((&param_7));\n        let _e182 = own[3u];\n        fragColor = vec4<f32>(_e180.x, _e180.y, _e180.z, _e182);\n        return;\n    }\n    let _e187 = widest;\n    param_8 = (0.2f * _e187);\n    let _e189 = d_1;\n    param_9 = _e189;\n    let _e190 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_8), (&param_9));\n    centre = (_e190 * 2f);\n    let _e192 = own;\n    let _e194 = centre;\n    sum = (_e192.xyz * _e194);\n    let _e196 = centre;\n    weight = _e196;\n    i = 1i;\n    loop {\n        let _e197 = i;\n        if (_e197 < 7i) {\n            let _e199 = i;\n            if (_e199 < 6i) {\n                let _e201 = i;\n                indexable = array<f32, 6>(0.2f, 0.75f, 1.6f, 2.8f, 4.55f, 7.3f);\n                let _e204 = indexable[min(_e201, 5i)];\n                let _e205 = widest;\n                param_10 = (_e204 * _e205);\n                let _e207 = d_1;\n                param_11 = _e207;\n                let _e208 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_10), (&param_11));\n                local = _e208;\n            } else {\n                local = vec3<f32>(0.5f, 0.5f, 0.5f);\n            }\n            let _e209 = local;\n            outer = _e209;\n            let _e210 = outer;\n            let _e211 = i;\n            indexable_1 = array<f32, 6>(0.2f, 0.75f, 1.6f, 2.8f, 4.55f, 7.3f);\n            let _e214 = indexable_1[(_e211 - 1i)];\n            let _e215 = widest;\n            param_12 = (_e214 * _e215);\n            let _e217 = d_1;\n            param_13 = _e217;\n            let _e218 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_12), (&param_13));\n            w = (_e210 - _e218);\n            side = -1i;\n            loop {\n                let _e220 = side;\n                if (_e220 <= 1i) {\n                    let _e222 = vUv_1;\n                    let _e224 = unnamed.uStep;\n                    let _e225 = side;\n                    let _e227 = i;\n                    indexable_2 = array<f32, 7>(0f, 0.4f, 1.1f, 2.1f, 3.5f, 5.6f, 9f);\n                    let _e229 = indexable_2[_e227];\n                    let _e231 = pixels;\n                    uv = (_e222 + (_e224 * ((f32(_e225) * _e229) * _e231)));\n                    let _e235 = uv;\n                    let _e236 = textureSampleLevel(uSkin_t, uSkin_s, _e235, 0f);\n                    tap = _e236;\n                    let _e237 = uv;\n                    let _e238 = textureSampleLevel(uDepth_t, uDepth_s, _e237, 0f);\n                    param_14 = _e238.x;\n                    let _e240 = viewZ_u0028_f1_u003b((&param_14));\n                    tapZ = abs(_e240);\n                    let _e242 = tapZ;\n                    let _e243 = z;\n                    let _e246 = widest;\n                    keep = clamp((1f - (abs((_e242 - _e243)) / (4f * _e246))), 0f, 1f);\n                    let _e252 = tap[3u];\n                    let _e254 = own[3u];\n                    cover = clamp((_e252 / _e254), 0f, 1f);\n                    let _e257 = tap;\n                    let _e259 = w;\n                    let _e261 = keep;\n                    let _e263 = sum;\n                    sum = (_e263 + ((_e257.xyz * _e259) * _e261));\n                    let _e265 = w;\n                    let _e266 = cover;\n                    let _e267 = keep;\n                    let _e270 = weight;\n                    weight = (_e270 + (_e265 * (_e266 * _e267)));\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e272 = side;\n                    side = (_e272 + 2i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e274 = i;\n            i = (_e274 + 1i);\n        }\n    }\n    let _e276 = sum;\n    let _e277 = weight;\n    param_15 = (_e276 / _e277);\n    let _e279 = withAlbedo_u0028_vf3_u003b((&param_15));\n    let _e281 = own[3u];\n    fragColor = vec4<f32>(_e279.x, _e279.y, _e279.z, _e281);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SKINBLUR_BINDINGS = {
  "SKIN_BLUR_FRAG": {
    "uniforms": 1,
    "uniformSize": 192,
    "fields": {
      "uStep": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToViewZ": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      },
      "uFocal": {
        "offset": 32,
        "size": 4,
        "type": "float"
      },
      "uProfiles": {
        "offset": 48,
        "size": 128,
        "type": "vec4",
        "length": 8,
        "stride": 16
      },
      "uApplyAlbedo": {
        "offset": 176,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 180,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 184,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSkin": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uAlbedo": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      }
    }
  }
} as const;
