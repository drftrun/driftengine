/*
 * Generated from ../ambientOcclusion.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const AO_BLUR_FRAG_WGSL = "struct Uniforms {\n    uStep: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uAo_s: sampler;\nvar<private> fragColor: f32;\n\nfn viewZ_u0028_f1_u003b(depth: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e22 = (*depth);\n    ndc = (1f - (_e22 * 2f));\n    let _e27 = unnamed.uDepthToViewZ[0u];\n    let _e28 = ndc;\n    let _e32 = unnamed.uDepthToViewZ[1u];\n    let _e36 = unnamed.uDepthToViewZ[2u];\n    let _e37 = ndc;\n    let _e41 = unnamed.uDepthToViewZ[3u];\n    return (((_e27 * _e28) + _e32) / ((_e36 * _e37) + _e41));\n}\n\nfn main_1() {\n    var centre: f32;\n    var param: f32;\n    var tolerance: f32;\n    var sum: f32;\n    var weight: f32;\n    var i: i32;\n    var uv: vec2<f32>;\n    var z: f32;\n    var param_1: f32;\n    var w: f32;\n    var local: f32;\n\n    let _e31 = vUv_1;\n    let _e32 = textureSampleLevel(uDepth_t, uDepth_s, _e31, 0f);\n    param = _e32.x;\n    let _e34 = viewZ_u0028_f1_u003b((&param));\n    centre = _e34;\n    let _e35 = centre;\n    tolerance = ((0.02f * abs(_e35)) + 0.0001f);\n    sum = 0f;\n    weight = 0f;\n    i = -3i;\n    loop {\n        let _e39 = i;\n        if (_e39 <= 4i) {\n            let _e41 = vUv_1;\n            let _e43 = unnamed.uStep;\n            let _e44 = i;\n            uv = (_e41 + (_e43 * f32(_e44)));\n            let _e48 = uv;\n            let _e49 = textureSampleLevel(uDepth_t, uDepth_s, _e48, 0f);\n            param_1 = _e49.x;\n            let _e51 = viewZ_u0028_f1_u003b((&param_1));\n            z = _e51;\n            let _e52 = z;\n            let _e53 = centre;\n            let _e56 = tolerance;\n            w = max(0f, (1f - (abs((_e52 - _e53)) / _e56)));\n            let _e60 = uv;\n            let _e61 = textureSampleLevel(uAo_t, uAo_s, _e60, 0f);\n            let _e63 = w;\n            let _e65 = sum;\n            sum = (_e65 + (_e61.x * _e63));\n            let _e67 = w;\n            let _e68 = weight;\n            weight = (_e68 + _e67);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e70 = i;\n            i = (_e70 + 1i);\n        }\n    }\n    let _e72 = weight;\n    if (_e72 > 0f) {\n        let _e74 = sum;\n        let _e75 = weight;\n        local = (_e74 / _e75);\n    } else {\n        let _e77 = vUv_1;\n        let _e78 = textureSampleLevel(uAo_t, uAo_s, _e77, 0f);\n        local = _e78.x;\n    }\n    let _e80 = local;\n    fragColor = _e80;\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) f32 {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

export const AO_FRAG_WGSL = "struct Uniforms {\n    uProjScale: vec2<f32>,\n    uInvProjection: mat4x4<f32>,\n    uRadius: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uDepth_s: sampler;\nvar<private> fragColor: f32;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn viewPosition_u0028_vf2_u003b_f1_u003b(uv: ptr<function, vec2<f32>>, depth: ptr<function, f32>) -> vec3<f32> {\n    var clip: vec4<f32>;\n    var view: vec4<f32>;\n\n    let _e33 = (*uv);\n    let _e36 = ((_e33 * 2f) - vec2(1f));\n    let _e37 = (*depth);\n    clip = vec4<f32>(_e36.x, _e36.y, (1f - (_e37 * 2f)), 1f);\n    let _e44 = unnamed.uInvProjection;\n    let _e45 = clip;\n    view = (_e44 * _e45);\n    let _e47 = view;\n    let _e50 = view[3u];\n    return (_e47.xyz / vec3(_e50));\n}\n\nfn main_1() {\n    var stepX: vec2<f32>;\n    var stepY: vec2<f32>;\n    var depth_1: f32;\n    var p: vec3<f32>;\n    var param: vec2<f32>;\n    var param_1: f32;\n    var dpdx_: vec3<f32>;\n    var dpdy_: vec3<f32>;\n    var right: vec3<f32>;\n    var param_2: vec2<f32>;\n    var param_3: f32;\n    var left: vec3<f32>;\n    var param_4: vec2<f32>;\n    var param_5: f32;\n    var down: vec3<f32>;\n    var param_6: vec2<f32>;\n    var param_7: f32;\n    var up: vec3<f32>;\n    var param_8: vec2<f32>;\n    var param_9: f32;\n    var here: f32;\n    var edgeFloor: f32;\n    var rightGap: f32;\n    var leftGap: f32;\n    var downGap: f32;\n    var upGap: f32;\n    var n: vec3<f32>;\n    var reach: vec2<f32>;\n    var tile: f32;\n    var turn: f32;\n    var sum: f32;\n    var i: i32;\n    var t: f32;\n    var angle: f32;\n    var uv_1: vec2<f32>;\n    var sampled: f32;\n    var v: vec3<f32>;\n    var param_10: vec2<f32>;\n    var param_11: f32;\n    var vv: f32;\n\n    let _e69 = vUv_1;\n    let _e70 = dpdx(_e69);\n    stepX = _e70;\n    let _e71 = vUv_1;\n    let _e72 = dpdy(_e71);\n    stepY = _e72;\n    let _e73 = vUv_1;\n    let _e74 = textureSampleLevel(uDepth_t, uDepth_s, _e73, 0f);\n    depth_1 = _e74.x;\n    let _e76 = vUv_1;\n    param = _e76;\n    let _e77 = depth_1;\n    param_1 = _e77;\n    let _e78 = viewPosition_u0028_vf2_u003b_f1_u003b((&param), (&param_1));\n    p = _e78;\n    let _e79 = p;\n    let _e80 = dpdx(_e79);\n    dpdx_ = _e80;\n    let _e81 = p;\n    let _e82 = dpdy(_e81);\n    dpdy_ = _e82;\n    let _e83 = depth_1;\n    if (_e83 <= 0f) {\n        fragColor = 1f;\n        return;\n    }\n    let _e85 = vUv_1;\n    let _e86 = stepX;\n    let _e88 = vUv_1;\n    let _e89 = stepX;\n    let _e91 = textureSampleLevel(uDepth_t, uDepth_s, (_e88 + _e89), 0f);\n    param_2 = (_e85 + _e86);\n    param_3 = _e91.x;\n    let _e93 = viewPosition_u0028_vf2_u003b_f1_u003b((&param_2), (&param_3));\n    right = _e93;\n    let _e94 = vUv_1;\n    let _e95 = stepX;\n    let _e97 = vUv_1;\n    let _e98 = stepX;\n    let _e100 = textureSampleLevel(uDepth_t, uDepth_s, (_e97 - _e98), 0f);\n    param_4 = (_e94 - _e95);\n    param_5 = _e100.x;\n    let _e102 = viewPosition_u0028_vf2_u003b_f1_u003b((&param_4), (&param_5));\n    left = _e102;\n    let _e103 = vUv_1;\n    let _e104 = stepY;\n    let _e106 = vUv_1;\n    let _e107 = stepY;\n    let _e109 = textureSampleLevel(uDepth_t, uDepth_s, (_e106 + _e107), 0f);\n    param_6 = (_e103 + _e104);\n    param_7 = _e109.x;\n    let _e111 = viewPosition_u0028_vf2_u003b_f1_u003b((&param_6), (&param_7));\n    down = _e111;\n    let _e112 = vUv_1;\n    let _e113 = stepY;\n    let _e115 = vUv_1;\n    let _e116 = stepY;\n    let _e118 = textureSampleLevel(uDepth_t, uDepth_s, (_e115 - _e116), 0f);\n    param_8 = (_e112 - _e113);\n    param_9 = _e118.x;\n    let _e120 = viewPosition_u0028_vf2_u003b_f1_u003b((&param_8), (&param_9));\n    up = _e120;\n    let _e122 = p[2u];\n    here = -(_e122);\n    let _e124 = here;\n    edgeFloor = (0.05f * _e124);\n    let _e127 = right[2u];\n    let _e129 = here;\n    rightGap = abs((-(_e127) - _e129));\n    let _e133 = left[2u];\n    let _e135 = here;\n    leftGap = abs((-(_e133) - _e135));\n    let _e139 = down[2u];\n    let _e141 = here;\n    downGap = abs((-(_e139) - _e141));\n    let _e145 = up[2u];\n    let _e147 = here;\n    upGap = abs((-(_e145) - _e147));\n    let _e150 = rightGap;\n    let _e151 = leftGap;\n    let _e153 = edgeFloor;\n    if (_e150 > ((_e151 * 8f) + _e153)) {\n        let _e156 = p;\n        let _e157 = left;\n        dpdx_ = (_e156 - _e157);\n    } else {\n        let _e159 = leftGap;\n        let _e160 = rightGap;\n        let _e162 = edgeFloor;\n        if (_e159 > ((_e160 * 8f) + _e162)) {\n            let _e165 = right;\n            let _e166 = p;\n            dpdx_ = (_e165 - _e166);\n        }\n    }\n    let _e168 = downGap;\n    let _e169 = upGap;\n    let _e171 = edgeFloor;\n    if (_e168 > ((_e169 * 8f) + _e171)) {\n        let _e174 = p;\n        let _e175 = up;\n        dpdy_ = (_e174 - _e175);\n    } else {\n        let _e177 = upGap;\n        let _e178 = downGap;\n        let _e180 = edgeFloor;\n        if (_e177 > ((_e178 * 8f) + _e180)) {\n            let _e183 = down;\n            let _e184 = p;\n            dpdy_ = (_e183 - _e184);\n        }\n    }\n    let _e186 = dpdx_;\n    let _e187 = dpdy_;\n    n = normalize(cross(_e186, _e187));\n    let _e190 = n;\n    let _e191 = p;\n    if (dot(_e190, _e191) > 0f) {\n        let _e194 = n;\n        n = -(_e194);\n    }\n    let _e197 = unnamed.uRadius;\n    let _e199 = unnamed.uProjScale;\n    let _e203 = p[2u];\n    reach = min((((_e199 * _e197) * 0.5f) / vec2(max(-(_e203), 0.001f))), vec2<f32>(0.06f, 0.06f));\n    let _e210 = gl_FragCoord_1[0u];\n    let _e216 = gl_FragCoord_1[1u];\n    tile = ((_e210 - (floor((_e210 / 4f)) * 4f)) + (4f * (_e216 - (floor((_e216 / 4f)) * 4f))));\n    let _e223 = tile;\n    turn = (_e223 * 0.3926991f);\n    sum = 0f;\n    i = 0i;\n    loop {\n        let _e225 = i;\n        if (_e225 < 12i) {\n            let _e227 = i;\n            t = ((f32(_e227) + 0.5f) / 12f);\n            let _e231 = turn;\n            let _e232 = i;\n            angle = (_e231 + (f32(_e232) * 2.3999631f));\n            let _e236 = vUv_1;\n            let _e237 = angle;\n            let _e239 = angle;\n            let _e242 = t;\n            let _e245 = reach;\n            uv_1 = (_e236 + ((vec2<f32>(cos(_e237), sin(_e239)) * sqrt(_e242)) * _e245));\n            let _e248 = uv_1;\n            let _e249 = textureSampleLevel(uDepth_t, uDepth_s, _e248, 0f);\n            sampled = _e249.x;\n            let _e251 = sampled;\n            if (_e251 <= 0f) {\n                continue;\n            }\n            let _e253 = uv_1;\n            param_10 = _e253;\n            let _e254 = sampled;\n            param_11 = _e254;\n            let _e255 = viewPosition_u0028_vf2_u003b_f1_u003b((&param_10), (&param_11));\n            let _e256 = p;\n            v = (_e255 - _e256);\n            let _e258 = v;\n            let _e259 = v;\n            vv = dot(_e258, _e259);\n            let _e261 = vv;\n            let _e263 = unnamed.uRadius;\n            let _e265 = unnamed.uRadius;\n            if (_e261 > (_e263 * _e265)) {\n                continue;\n            }\n            let _e268 = v;\n            let _e269 = n;\n            let _e272 = p[2u];\n            let _e277 = vv;\n            let _e280 = sum;\n            sum = (_e280 + (max(0f, (dot(_e268, _e269) - (0.004f * -(_e272)))) / (_e277 + 0.01f)));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e282 = i;\n            i = (_e282 + 1i);\n        }\n    }\n    let _e285 = unnamed.uRadius;\n    let _e287 = sum;\n    fragColor = clamp((1f - (((2f * _e285) * _e287) / 12f)), 0f, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) f32 {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const AMBIENTOCCLUSION_BINDINGS = {
  "AO_BLUR_FRAG": {
    "uniforms": 1,
    "uniformSize": 32,
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
      }
    },
    "textures": {
      "uAo": {
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
  },
  "AO_FRAG": {
    "uniforms": 1,
    "uniformSize": 96,
    "fields": {
      "uProjScale": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uInvProjection": {
        "offset": 16,
        "size": 64,
        "type": "mat4"
      },
      "uRadius": {
        "offset": 80,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uDepth": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  }
} as const;
