/*
 * Generated from ../temporalResolve.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const TEMPORAL_RESOLVE_FRAG_WGSL = "struct Uniforms {\n    uReprojection: mat4x4<f32>,\n    uTexel: vec2<f32>,\n    uHistoryBlend: f32,\n}\n\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uHistory_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uHistory_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(36) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uDepth_s: sampler;\n\nfn clipToNeighbourhood_u0028_vf3_u003b_vf3_u003b_vf3_u003b(history: ptr<function, vec3<f32>>, lo: ptr<function, vec3<f32>>, hi: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var centre: vec3<f32>;\n    var extent: vec3<f32>;\n    var offset: vec3<f32>;\n    var ratios: vec3<f32>;\n    var ratio: f32;\n\n    let _e39 = (*lo);\n    let _e40 = (*hi);\n    centre = ((_e39 + _e40) * 0.5f);\n    let _e43 = (*hi);\n    let _e44 = (*lo);\n    extent = ((_e43 - _e44) * 0.5f);\n    let _e47 = (*history);\n    let _e48 = centre;\n    offset = (_e47 - _e48);\n    let _e50 = offset;\n    let _e52 = extent;\n    ratios = (abs(_e50) / max(_e52, vec3<f32>(0.0000001f, 0.0000001f, 0.0000001f)));\n    let _e56 = ratios[0u];\n    let _e58 = ratios[1u];\n    let _e60 = ratios[2u];\n    ratio = max(_e56, max(_e58, _e60));\n    let _e63 = ratio;\n    if (_e63 <= 1f) {\n        let _e65 = (*history);\n        return _e65;\n    }\n    let _e66 = centre;\n    let _e67 = offset;\n    let _e68 = ratio;\n    return (_e66 + (_e67 / vec3(_e68)));\n}\n\nfn historyCatmullRom_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var size: vec2<f32>;\n    var at: vec2<f32>;\n    var base: vec2<f32>;\n    var f: vec2<f32>;\n    var w0_: vec2<f32>;\n    var w1_: vec2<f32>;\n    var w2_: vec2<f32>;\n    var w3_: vec2<f32>;\n    var w12_: vec2<f32>;\n    var at0_: vec2<f32>;\n    var at3_: vec2<f32>;\n    var at12_: vec2<f32>;\n    var sum: vec3<f32>;\n    var weight: f32;\n\n    let _e47 = unnamed.uTexel;\n    size = (vec2(1f) / _e47);\n    let _e50 = (*uv);\n    let _e51 = size;\n    at = (_e50 * _e51);\n    let _e53 = at;\n    base = (floor((_e53 - vec2(0.5f))) + vec2(0.5f));\n    let _e59 = at;\n    let _e60 = base;\n    f = (_e59 - _e60);\n    let _e62 = f;\n    let _e63 = f;\n    let _e64 = f;\n    w0_ = (_e62 * (vec2(-0.5f) + (_e63 * (vec2(1f) - (_e64 * 0.5f)))));\n    let _e72 = f;\n    let _e73 = f;\n    let _e75 = f;\n    w1_ = (vec2(1f) + ((_e72 * _e73) * (vec2(-2.5f) + (_e75 * 1.5f))));\n    let _e82 = f;\n    let _e83 = f;\n    let _e84 = f;\n    w2_ = (_e82 * (vec2(0.5f) + (_e83 * (vec2(2f) - (_e84 * 1.5f)))));\n    let _e92 = f;\n    let _e93 = f;\n    let _e95 = f;\n    w3_ = ((_e92 * _e93) * (vec2(-0.5f) + (_e95 * 0.5f)));\n    let _e100 = w1_;\n    let _e101 = w2_;\n    w12_ = (_e100 + _e101);\n    let _e103 = base;\n    let _e107 = unnamed.uTexel;\n    at0_ = ((_e103 - vec2(1f)) * _e107);\n    let _e109 = base;\n    let _e113 = unnamed.uTexel;\n    at3_ = ((_e109 + vec2(2f)) * _e113);\n    let _e115 = base;\n    let _e116 = w2_;\n    let _e117 = w12_;\n    let _e121 = unnamed.uTexel;\n    at12_ = ((_e115 + (_e116 / _e117)) * _e121);\n    let _e124 = at12_[0u];\n    let _e126 = at0_[1u];\n    let _e128 = textureSampleLevel(uHistory_t, uHistory_s, vec2<f32>(_e124, _e126), 0f);\n    let _e131 = w12_[0u];\n    let _e133 = w0_[1u];\n    let _e137 = at0_[0u];\n    let _e139 = at12_[1u];\n    let _e141 = textureSampleLevel(uHistory_t, uHistory_s, vec2<f32>(_e137, _e139), 0f);\n    let _e144 = w0_[0u];\n    let _e146 = w12_[1u];\n    let _e150 = at12_;\n    let _e151 = textureSampleLevel(uHistory_t, uHistory_s, _e150, 0f);\n    let _e154 = w12_[0u];\n    let _e156 = w12_[1u];\n    let _e161 = at3_[0u];\n    let _e163 = at12_[1u];\n    let _e165 = textureSampleLevel(uHistory_t, uHistory_s, vec2<f32>(_e161, _e163), 0f);\n    let _e168 = w3_[0u];\n    let _e170 = w12_[1u];\n    let _e175 = at12_[0u];\n    let _e177 = at3_[1u];\n    let _e179 = textureSampleLevel(uHistory_t, uHistory_s, vec2<f32>(_e175, _e177), 0f);\n    let _e182 = w12_[0u];\n    let _e184 = w3_[1u];\n    sum = (((((_e128.xyz * (_e131 * _e133)) + (_e141.xyz * (_e144 * _e146))) + (_e151.xyz * (_e154 * _e156))) + (_e165.xyz * (_e168 * _e170))) + (_e179.xyz * (_e182 * _e184)));\n    let _e189 = w12_[0u];\n    let _e191 = w0_[1u];\n    let _e194 = w0_[0u];\n    let _e196 = w12_[1u];\n    let _e200 = w12_[0u];\n    let _e202 = w12_[1u];\n    let _e206 = w3_[0u];\n    let _e208 = w12_[1u];\n    let _e212 = w12_[0u];\n    let _e214 = w3_[1u];\n    weight = (((((_e189 * _e191) + (_e194 * _e196)) + (_e200 * _e202)) + (_e206 * _e208)) + (_e212 * _e214));\n    let _e217 = sum;\n    let _e218 = weight;\n    return max((_e217 / vec3(_e218)), vec3<f32>(0f, 0f, 0f));\n}\n\nfn neighbourhood_u0028_vf3_u003b_vf3_u003b(lo_1: ptr<function, vec3<f32>>, hi_1: ptr<function, vec3<f32>>) {\n    var y: i32;\n    var x: i32;\n    var c: vec3<f32>;\n\n    (*lo_1) = vec3<f32>(1000000000f, 1000000000f, 1000000000f);\n    (*hi_1) = vec3<f32>(-1000000000f, -1000000000f, -1000000000f);\n    y = -1i;\n    loop {\n        let _e36 = y;\n        if (_e36 <= 1i) {\n            x = -1i;\n            loop {\n                let _e38 = x;\n                if (_e38 <= 1i) {\n                    let _e40 = vUv_1;\n                    let _e41 = x;\n                    let _e43 = y;\n                    let _e47 = unnamed.uTexel;\n                    let _e50 = textureSampleLevel(uScene_t, uScene_s, (_e40 + (vec2<f32>(f32(_e41), f32(_e43)) * _e47)), 0f);\n                    c = _e50.xyz;\n                    let _e52 = (*lo_1);\n                    let _e53 = c;\n                    (*lo_1) = min(_e52, _e53);\n                    let _e55 = (*hi_1);\n                    let _e56 = c;\n                    (*hi_1) = max(_e55, _e56);\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e58 = x;\n                    x = (_e58 + 1i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e60 = y;\n            y = (_e60 + 1i);\n        }\n    }\n    return;\n}\n\nfn main_1() {\n    var current: vec3<f32>;\n    var depth: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var lo_2: vec3<f32>;\n    var hi_2: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n    var history_1: vec3<f32>;\n    var param_2: vec2<f32>;\n    var bounded: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec3<f32>;\n    var phi_440_: bool;\n    var phi_447_: bool;\n    var phi_454_: bool;\n\n    let _e46 = vUv_1;\n    let _e47 = textureSampleLevel(uScene_t, uScene_s, _e46, 0f);\n    current = _e47.xyz;\n    let _e50 = unnamed.uHistoryBlend;\n    if (_e50 <= 0f) {\n        let _e52 = current;\n        fragColor = vec4<f32>(_e52.x, _e52.y, _e52.z, 1f);\n        return;\n    }\n    let _e57 = vUv_1;\n    let _e58 = textureSampleLevel(uDepth_t, uDepth_s, _e57, 0f);\n    depth = _e58.x;\n    let _e60 = vUv_1;\n    let _e63 = ((_e60 * 2f) - vec2(1f));\n    let _e64 = depth;\n    clip = vec4<f32>(_e63.x, _e63.y, (1f - (_e64 * 2f)), 1f);\n    let _e71 = unnamed.uReprojection;\n    let _e72 = clip;\n    previous = (_e71 * _e72);\n    let _e75 = previous[3u];\n    if (_e75 <= 0f) {\n        let _e77 = current;\n        fragColor = vec4<f32>(_e77.x, _e77.y, _e77.z, 1f);\n        return;\n    }\n    let _e82 = previous;\n    let _e85 = previous[3u];\n    wasUv = (((_e82.xy / vec2(_e85)) * 0.5f) + vec2(0.5f));\n    let _e92 = wasUv[0u];\n    let _e93 = (_e92 < 0f);\n    phi_440_ = _e93;\n    if !(_e93) {\n        let _e96 = wasUv[0u];\n        phi_440_ = (_e96 > 1f);\n    }\n    let _e99 = phi_440_;\n    phi_447_ = _e99;\n    if !(_e99) {\n        let _e102 = wasUv[1u];\n        phi_447_ = (_e102 < 0f);\n    }\n    let _e105 = phi_447_;\n    phi_454_ = _e105;\n    if !(_e105) {\n        let _e108 = wasUv[1u];\n        phi_454_ = (_e108 > 1f);\n    }\n    let _e111 = phi_454_;\n    if _e111 {\n        let _e112 = current;\n        fragColor = vec4<f32>(_e112.x, _e112.y, _e112.z, 1f);\n        return;\n    }\n    neighbourhood_u0028_vf3_u003b_vf3_u003b((&param), (&param_1));\n    let _e117 = param;\n    lo_2 = _e117;\n    let _e118 = param_1;\n    hi_2 = _e118;\n    let _e119 = wasUv;\n    param_2 = _e119;\n    let _e120 = historyCatmullRom_u0028_vf2_u003b((&param_2));\n    history_1 = _e120;\n    let _e121 = history_1;\n    param_3 = _e121;\n    let _e122 = lo_2;\n    param_4 = _e122;\n    let _e123 = hi_2;\n    param_5 = _e123;\n    let _e124 = clipToNeighbourhood_u0028_vf3_u003b_vf3_u003b_vf3_u003b((&param_3), (&param_4), (&param_5));\n    bounded = _e124;\n    let _e125 = current;\n    let _e126 = bounded;\n    let _e128 = unnamed.uHistoryBlend;\n    let _e130 = mix(_e125, _e126, vec3(_e128));\n    fragColor = vec4<f32>(_e130.x, _e130.y, _e130.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const TEMPORALRESOLVE_BINDINGS = {
  "TEMPORAL_RESOLVE_FRAG": {
    "uniforms": 1,
    "uniformSize": 80,
    "fields": {
      "uReprojection": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uTexel": {
        "offset": 64,
        "size": 8,
        "type": "vec2"
      },
      "uHistoryBlend": {
        "offset": 72,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uScene": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uHistory": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      }
    }
  }
} as const;
