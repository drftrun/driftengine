/*
 * Generated from ../skinBlur.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SKIN_BLUR_FRAG_WGSL = "struct Uniforms {\n    uStep: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n    uFocal: f32,\n    uProfiles: array<vec4<f32>, 8>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSkin_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSkin_s: sampler;\nvar<private> vUv_1: vec2<f32>;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\n\nfn burleyMass_u0028_f1_u003b_vf3_u003b(x: ptr<function, f32>, d: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e51 = (*x);\n    let _e53 = (*d);\n    let _e57 = (*x);\n    let _e59 = (*d);\n    return (vec3(0.5f) - ((exp((vec3(-(_e51)) / _e53)) + (exp((vec3(-(_e57)) / (_e59 * 3f))) * 3f)) * 0.125f));\n}\n\nfn viewZ_u0028_f1_u003b(depth: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e51 = (*depth);\n    ndc = (1f - (_e51 * 2f));\n    let _e56 = unnamed.uDepthToViewZ[0u];\n    let _e57 = ndc;\n    let _e61 = unnamed.uDepthToViewZ[1u];\n    let _e65 = unnamed.uDepthToViewZ[2u];\n    let _e66 = ndc;\n    let _e70 = unnamed.uDepthToViewZ[3u];\n    return (((_e56 * _e57) + _e61) / ((_e65 * _e66) + _e70));\n}\n\nfn main_1() {\n    var own: vec4<f32>;\n    var depth_1: f32;\n    var profile: i32;\n    var d_1: vec3<f32>;\n    var widest: f32;\n    var z: f32;\n    var param: f32;\n    var pixels: f32;\n    var centre: vec3<f32>;\n    var param_1: f32;\n    var param_2: vec3<f32>;\n    var sum: vec3<f32>;\n    var weight: vec3<f32>;\n    var i: i32;\n    var outer: vec3<f32>;\n    var local: vec3<f32>;\n    var indexable: array<f32, 6>;\n    var param_3: f32;\n    var param_4: vec3<f32>;\n    var w: vec3<f32>;\n    var indexable_1: array<f32, 6>;\n    var param_5: f32;\n    var param_6: vec3<f32>;\n    var side: i32;\n    var uv: vec2<f32>;\n    var indexable_2: array<f32, 7>;\n    var tap: vec4<f32>;\n    var tapZ: f32;\n    var param_7: f32;\n    var keep: f32;\n    var cover: f32;\n\n    let _e80 = vUv_1;\n    let _e81 = textureSampleLevel(uSkin_t, uSkin_s, _e80, 0f);\n    own = _e81;\n    let _e83 = own[3u];\n    if (_e83 < 0.0001f) {\n        fragColor = vec4<f32>(0f, 0f, 0f, 0f);\n        return;\n    }\n    let _e85 = vUv_1;\n    let _e86 = textureSampleLevel(uDepth_t, uDepth_s, _e85, 0f);\n    depth_1 = _e86.x;\n    let _e88 = depth_1;\n    if (_e88 <= 0f) {\n        let _e90 = own;\n        fragColor = _e90;\n        return;\n    }\n    let _e92 = own[3u];\n    profile = clamp((i32(((_e92 * 8f) + 0.5f)) - 1i), 0i, 7i);\n    let _e98 = profile;\n    let _e101 = unnamed.uProfiles[_e98];\n    d_1 = max(_e101.xyz, vec3<f32>(0.000001f, 0.000001f, 0.000001f));\n    let _e105 = d_1[0u];\n    let _e107 = d_1[1u];\n    let _e109 = d_1[2u];\n    widest = max(_e105, max(_e107, _e109));\n    let _e112 = depth_1;\n    param = _e112;\n    let _e113 = viewZ_u0028_f1_u003b((&param));\n    z = abs(_e113);\n    let _e115 = widest;\n    let _e117 = unnamed.uFocal;\n    let _e119 = z;\n    pixels = ((_e115 * _e117) / max(_e119, 0.0001f));\n    let _e122 = pixels;\n    if (_e122 < 0.5f) {\n        let _e124 = own;\n        fragColor = _e124;\n        return;\n    }\n    let _e125 = widest;\n    param_1 = (0.2f * _e125);\n    let _e127 = d_1;\n    param_2 = _e127;\n    let _e128 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_1), (&param_2));\n    centre = (_e128 * 2f);\n    let _e130 = own;\n    let _e132 = centre;\n    sum = (_e130.xyz * _e132);\n    let _e134 = centre;\n    weight = _e134;\n    i = 1i;\n    loop {\n        let _e135 = i;\n        if (_e135 < 7i) {\n            let _e137 = i;\n            if (_e137 < 6i) {\n                let _e139 = i;\n                indexable = array<f32, 6>(0.2f, 0.75f, 1.6f, 2.8f, 4.55f, 7.3f);\n                let _e142 = indexable[min(_e139, 5i)];\n                let _e143 = widest;\n                param_3 = (_e142 * _e143);\n                let _e145 = d_1;\n                param_4 = _e145;\n                let _e146 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_3), (&param_4));\n                local = _e146;\n            } else {\n                local = vec3<f32>(0.5f, 0.5f, 0.5f);\n            }\n            let _e147 = local;\n            outer = _e147;\n            let _e148 = outer;\n            let _e149 = i;\n            indexable_1 = array<f32, 6>(0.2f, 0.75f, 1.6f, 2.8f, 4.55f, 7.3f);\n            let _e152 = indexable_1[(_e149 - 1i)];\n            let _e153 = widest;\n            param_5 = (_e152 * _e153);\n            let _e155 = d_1;\n            param_6 = _e155;\n            let _e156 = burleyMass_u0028_f1_u003b_vf3_u003b((&param_5), (&param_6));\n            w = (_e148 - _e156);\n            side = -1i;\n            loop {\n                let _e158 = side;\n                if (_e158 <= 1i) {\n                    let _e160 = vUv_1;\n                    let _e162 = unnamed.uStep;\n                    let _e163 = side;\n                    let _e165 = i;\n                    indexable_2 = array<f32, 7>(0f, 0.4f, 1.1f, 2.1f, 3.5f, 5.6f, 9f);\n                    let _e167 = indexable_2[_e165];\n                    let _e169 = pixels;\n                    uv = (_e160 + (_e162 * ((f32(_e163) * _e167) * _e169)));\n                    let _e173 = uv;\n                    let _e174 = textureSampleLevel(uSkin_t, uSkin_s, _e173, 0f);\n                    tap = _e174;\n                    let _e175 = uv;\n                    let _e176 = textureSampleLevel(uDepth_t, uDepth_s, _e175, 0f);\n                    param_7 = _e176.x;\n                    let _e178 = viewZ_u0028_f1_u003b((&param_7));\n                    tapZ = abs(_e178);\n                    let _e180 = tapZ;\n                    let _e181 = z;\n                    let _e184 = widest;\n                    keep = clamp((1f - (abs((_e180 - _e181)) / (4f * _e184))), 0f, 1f);\n                    let _e190 = tap[3u];\n                    let _e192 = own[3u];\n                    cover = clamp((_e190 / _e192), 0f, 1f);\n                    let _e195 = tap;\n                    let _e197 = w;\n                    let _e199 = keep;\n                    let _e201 = sum;\n                    sum = (_e201 + ((_e195.xyz * _e197) * _e199));\n                    let _e203 = w;\n                    let _e204 = cover;\n                    let _e205 = keep;\n                    let _e208 = weight;\n                    weight = (_e208 + (_e203 * (_e204 * _e205)));\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e210 = side;\n                    side = (_e210 + 2i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e212 = i;\n            i = (_e212 + 1i);\n        }\n    }\n    let _e214 = sum;\n    let _e215 = weight;\n    let _e216 = (_e214 / _e215);\n    let _e218 = own[3u];\n    fragColor = vec4<f32>(_e216.x, _e216.y, _e216.z, _e218);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SKINBLUR_BINDINGS = {
  "SKIN_BLUR_FRAG": {
    "uniforms": 1,
    "uniformSize": 176,
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
      }
    }
  }
} as const;
