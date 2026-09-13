/*
 * Generated from ../temporalResolve.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const TEMPORAL_RESOLVE_FRAG_WGSL = "struct Uniforms {\n    uReprojection: mat4x4<f32>,\n    uTexel: vec2<f32>,\n    uHistoryBlend: f32,\n}\n\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(36) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uDepth_s: sampler;\n@group(0) @binding(34) \nvar uHistory_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uHistory_s: sampler;\n\nfn clipToNeighbourhood_u0028_vf3_u003b_vf3_u003b_vf3_u003b(history: ptr<function, vec3<f32>>, lo: ptr<function, vec3<f32>>, hi: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var centre: vec3<f32>;\n    var extent: vec3<f32>;\n    var offset: vec3<f32>;\n    var ratios: vec3<f32>;\n    var ratio: f32;\n\n    let _e35 = (*lo);\n    let _e36 = (*hi);\n    centre = ((_e35 + _e36) * 0.5f);\n    let _e39 = (*hi);\n    let _e40 = (*lo);\n    extent = ((_e39 - _e40) * 0.5f);\n    let _e43 = (*history);\n    let _e44 = centre;\n    offset = (_e43 - _e44);\n    let _e46 = offset;\n    let _e48 = extent;\n    ratios = (abs(_e46) / max(_e48, vec3<f32>(0.0000001f, 0.0000001f, 0.0000001f)));\n    let _e52 = ratios[0u];\n    let _e54 = ratios[1u];\n    let _e56 = ratios[2u];\n    ratio = max(_e52, max(_e54, _e56));\n    let _e59 = ratio;\n    if (_e59 <= 1f) {\n        let _e61 = (*history);\n        return _e61;\n    }\n    let _e62 = centre;\n    let _e63 = offset;\n    let _e64 = ratio;\n    return (_e62 + (_e63 / vec3(_e64)));\n}\n\nfn neighbourhood_u0028_vf3_u003b_vf3_u003b(lo_1: ptr<function, vec3<f32>>, hi_1: ptr<function, vec3<f32>>) {\n    var y: i32;\n    var x: i32;\n    var c: vec3<f32>;\n\n    (*lo_1) = vec3<f32>(1000000000f, 1000000000f, 1000000000f);\n    (*hi_1) = vec3<f32>(-1000000000f, -1000000000f, -1000000000f);\n    y = -1i;\n    loop {\n        let _e32 = y;\n        if (_e32 <= 1i) {\n            x = -1i;\n            loop {\n                let _e34 = x;\n                if (_e34 <= 1i) {\n                    let _e36 = vUv_1;\n                    let _e37 = x;\n                    let _e39 = y;\n                    let _e43 = unnamed.uTexel;\n                    let _e46 = textureSampleLevel(uScene_t, uScene_s, (_e36 + (vec2<f32>(f32(_e37), f32(_e39)) * _e43)), 0f);\n                    c = _e46.xyz;\n                    let _e48 = (*lo_1);\n                    let _e49 = c;\n                    (*lo_1) = min(_e48, _e49);\n                    let _e51 = (*hi_1);\n                    let _e52 = c;\n                    (*hi_1) = max(_e51, _e52);\n                    continue;\n                } else {\n                    break;\n                }\n                continuing {\n                    let _e54 = x;\n                    x = (_e54 + 1i);\n                }\n            }\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e56 = y;\n            y = (_e56 + 1i);\n        }\n    }\n    return;\n}\n\nfn main_1() {\n    var current: vec3<f32>;\n    var depth: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var lo_2: vec3<f32>;\n    var hi_2: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n    var history_1: vec3<f32>;\n    var bounded: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec3<f32>;\n    var phi_223_: bool;\n    var phi_230_: bool;\n    var phi_237_: bool;\n\n    let _e41 = vUv_1;\n    let _e42 = textureSampleLevel(uScene_t, uScene_s, _e41, 0f);\n    current = _e42.xyz;\n    let _e45 = unnamed.uHistoryBlend;\n    if (_e45 <= 0f) {\n        let _e47 = current;\n        fragColor = vec4<f32>(_e47.x, _e47.y, _e47.z, 1f);\n        return;\n    }\n    let _e52 = vUv_1;\n    let _e53 = textureSampleLevel(uDepth_t, uDepth_s, _e52, 0f);\n    depth = _e53.x;\n    let _e55 = vUv_1;\n    let _e58 = ((_e55 * 2f) - vec2(1f));\n    let _e59 = depth;\n    clip = vec4<f32>(_e58.x, _e58.y, (1f - (_e59 * 2f)), 1f);\n    let _e66 = unnamed.uReprojection;\n    let _e67 = clip;\n    previous = (_e66 * _e67);\n    let _e70 = previous[3u];\n    if (_e70 <= 0f) {\n        let _e72 = current;\n        fragColor = vec4<f32>(_e72.x, _e72.y, _e72.z, 1f);\n        return;\n    }\n    let _e77 = previous;\n    let _e80 = previous[3u];\n    wasUv = (((_e77.xy / vec2(_e80)) * 0.5f) + vec2(0.5f));\n    let _e87 = wasUv[0u];\n    let _e88 = (_e87 < 0f);\n    phi_223_ = _e88;\n    if !(_e88) {\n        let _e91 = wasUv[0u];\n        phi_223_ = (_e91 > 1f);\n    }\n    let _e94 = phi_223_;\n    phi_230_ = _e94;\n    if !(_e94) {\n        let _e97 = wasUv[1u];\n        phi_230_ = (_e97 < 0f);\n    }\n    let _e100 = phi_230_;\n    phi_237_ = _e100;\n    if !(_e100) {\n        let _e103 = wasUv[1u];\n        phi_237_ = (_e103 > 1f);\n    }\n    let _e106 = phi_237_;\n    if _e106 {\n        let _e107 = current;\n        fragColor = vec4<f32>(_e107.x, _e107.y, _e107.z, 1f);\n        return;\n    }\n    neighbourhood_u0028_vf3_u003b_vf3_u003b((&param), (&param_1));\n    let _e112 = param;\n    lo_2 = _e112;\n    let _e113 = param_1;\n    hi_2 = _e113;\n    let _e114 = wasUv;\n    let _e115 = textureSampleLevel(uHistory_t, uHistory_s, _e114, 0f);\n    history_1 = _e115.xyz;\n    let _e117 = history_1;\n    param_2 = _e117;\n    let _e118 = lo_2;\n    param_3 = _e118;\n    let _e119 = hi_2;\n    param_4 = _e119;\n    let _e120 = clipToNeighbourhood_u0028_vf3_u003b_vf3_u003b_vf3_u003b((&param_2), (&param_3), (&param_4));\n    bounded = _e120;\n    let _e121 = current;\n    let _e122 = bounded;\n    let _e124 = unnamed.uHistoryBlend;\n    let _e126 = mix(_e121, _e122, vec3(_e124));\n    fragColor = vec4<f32>(_e126.x, _e126.y, _e126.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

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
