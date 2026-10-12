/*
 * Generated from ../arcane.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const ARCANE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uTint: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e102 = (*c);\n    low = (_e102 * 12.92f);\n    let _e104 = (*c);\n    high = ((pow(max(_e104, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e110 = high;\n    let _e111 = low;\n    let _e112 = (*c);\n    return mix(_e110, _e111, step(_e112, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e103 = (*c_1)[0u];\n    let _e105 = (*c_1)[1u];\n    let _e107 = (*c_1)[2u];\n    m = max(_e103, max(_e105, _e107));\n    let _e110 = m;\n    if (_e110 <= 0.8f) {\n        let _e112 = (*c_1);\n        return _e112;\n    }\n    let _e113 = m;\n    e = (_e113 - 0.8f);\n    let _e115 = (*c_1);\n    let _e116 = e;\n    let _e118 = e;\n    let _e122 = m;\n    return (_e115 * ((0.8f + ((0.2f * _e116) / (_e118 + 0.2f))) / _e122));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e102 = (*v);\n    let _e103 = (*v);\n    a = ((_e102 * (_e103 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e109 = (*v);\n    let _e110 = (*v);\n    b = ((_e109 * ((_e110 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e117 = a;\n    let _e118 = b;\n    return (_e117 / _e118);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e102 = unnamed.uOutputExposure;\n    let _e103 = (*x);\n    (*x) = (_e103 * _e102);\n    let _e105 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e105);\n    let _e107 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e107), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e104 = unnamed.uOutputTransform;\n    if (_e104 == 0i) {\n        let _e106 = (*c_2);\n        return _e106;\n    }\n    let _e108 = unnamed.uOutputTransform;\n    if (_e108 == 2i) {\n        let _e110 = (*c_2);\n        param_1 = _e110;\n        let _e111 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e111;\n    }\n    let _e113 = unnamed.uOutputTransform;\n    if (_e113 == 3i) {\n        let _e115 = (*c_2);\n        let _e117 = unnamed.uOutputExposure;\n        param_2 = (_e115 * _e117);\n        let _e119 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e119;\n    }\n    let _e120 = (*c_2);\n    param_3 = _e120;\n    let _e121 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e121;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e100 = unnamed.uFogColor;\n    let _e102 = unnamed.uUnderwaterColor;\n    let _e104 = unnamed.uUnderwaterFactor;\n    return mix(_e100, _e102, vec3(_e104));\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e113 = unnamed.uFogRange[0u];\n    let _e114 = (*dist);\n    start = min(_e113, _e114);\n    let _e116 = (*dist);\n    if (_e116 > 0f) {\n        let _e118 = start;\n        let _e119 = (*dist);\n        local = (_e118 / _e119);\n    } else {\n        local = 0f;\n    }\n    let _e121 = local;\n    before = _e121;\n    let _e122 = (*pointY);\n    let _e125 = unnamed.uFogMedium[2u];\n    let _e129 = unnamed.uFogMedium[1u];\n    t = ((_e122 - _e125) * _e129);\n    let _e131 = t;\n    let _e132 = before;\n    rest = (_e131 * (1f - _e132));\n    let _e135 = rest;\n    let _e138 = rest;\n    denom = select(_e138, 0.0001f, (abs(_e135) < 0.0001f));\n    let _e142 = unnamed.uFogMedium[0u];\n    let _e143 = t;\n    let _e145 = before;\n    let _e149 = (*dist);\n    let _e150 = start;\n    let _e153 = denom;\n    let _e158 = denom;\n    depth = ((((_e142 * exp((-(_e143) * _e145))) * (_e149 - _e150)) * (1f - exp(-(_e153)))) / _e158);\n    let _e162 = unnamed.uFogLayer2_[0u];\n    if (_e162 > 0f) {\n        let _e164 = (*pointY);\n        let _e167 = unnamed.uFogMedium[2u];\n        let _e171 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e164 - _e167) * _e171);\n        let _e173 = t2_;\n        let _e174 = before;\n        rest2_ = (_e173 * (1f - _e174));\n        let _e177 = rest2_;\n        let _e180 = rest2_;\n        denom2_ = select(_e180, 0.0001f, (abs(_e177) < 0.0001f));\n        let _e184 = unnamed.uFogLayer2_[0u];\n        let _e185 = t2_;\n        let _e187 = before;\n        let _e191 = (*dist);\n        let _e192 = start;\n        let _e195 = denom2_;\n        let _e200 = denom2_;\n        let _e202 = depth;\n        depth = (_e202 + ((((_e184 * exp((-(_e185) * _e187))) * (_e191 - _e192)) * (1f - exp(-(_e195)))) / _e200));\n    }\n    let _e204 = depth;\n    return _e204;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var wet: f32;\n    var phi_193_: bool;\n\n    let _e113 = unnamed.uFogLayer2_[3u];\n    let _e114 = (_e113 > 0f);\n    phi_193_ = _e114;\n    if _e114 {\n        let _e115 = (*dist_1);\n        let _e118 = unnamed.uFogLayer2_[3u];\n        phi_193_ = (_e115 > _e118);\n    }\n    let _e121 = phi_193_;\n    cut = _e121;\n    let _e124 = unnamed.uFogRange[2u];\n    if (_e124 == 1f) {\n        let _e128 = unnamed.uFogRange[1u];\n        let _e131 = unnamed.uFogRange[0u];\n        span = max((_e128 - _e131), 0.0001f);\n        let _e134 = cut;\n        if _e134 {\n            local_1 = 0f;\n        } else {\n            let _e135 = (*dist_1);\n            let _e138 = unnamed.uFogRange[0u];\n            let _e140 = span;\n            let _e145 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e135 - _e138) / _e140), 0f, 1f), (1f - _e145));\n        }\n        let _e148 = local_1;\n        ramp = _e148;\n        let _e150 = unnamed.uUnderwaterFactor;\n        if (_e150 <= 0f) {\n            let _e152 = ramp;\n            return _e152;\n        }\n        let _e155 = unnamed.uFogMedium[3u];\n        let _e156 = (*dist_1);\n        wetLinear = (_e155 * _e156);\n        let _e158 = ramp;\n        let _e159 = wetLinear;\n        let _e161 = wetLinear;\n        let _e167 = unnamed.uUnderwaterFactor;\n        return mix(_e158, (1f - exp2(((-(_e159) * _e161) * 1.442695f))), _e167);\n    }\n    let _e169 = cut;\n    if _e169 {\n        local_2 = 0f;\n    } else {\n        let _e170 = (*dist_1);\n        param_4 = _e170;\n        let _e171 = (*pointY_1);\n        param_5 = _e171;\n        let _e172 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        let _e177 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e172)), _e177));\n    }\n    let _e180 = local_2;\n    air = _e180;\n    let _e182 = unnamed.uUnderwaterFactor;\n    if (_e182 <= 0f) {\n        let _e184 = air;\n        return _e184;\n    }\n    let _e187 = unnamed.uFogMedium[3u];\n    let _e188 = (*dist_1);\n    wet = (_e187 * _e188);\n    let _e190 = air;\n    let _e191 = wet;\n    let _e193 = wet;\n    let _e199 = unnamed.uUnderwaterFactor;\n    return mix(_e190, (1f - exp2(((-(_e191) * _e193) * 1.442695f))), _e199);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e100 = (*p);\n    return fract((sin(dot(_e100, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n\n    let _e107 = (*p_1);\n    i = floor(_e107);\n    let _e109 = (*p_1);\n    f = fract(_e109);\n    let _e111 = f;\n    let _e112 = f;\n    let _e114 = f;\n    u = ((_e111 * _e112) * (vec2(3f) - (_e114 * 2f)));\n    let _e119 = i;\n    param_6 = _e119;\n    let _e120 = hash21_u0028_vf2_u003b((&param_6));\n    let _e121 = i;\n    param_7 = (_e121 + vec2<f32>(1f, 0f));\n    let _e123 = hash21_u0028_vf2_u003b((&param_7));\n    let _e125 = u[0u];\n    let _e127 = i;\n    param_8 = (_e127 + vec2<f32>(0f, 1f));\n    let _e129 = hash21_u0028_vf2_u003b((&param_8));\n    let _e130 = i;\n    param_9 = (_e130 + vec2<f32>(1f, 1f));\n    let _e132 = hash21_u0028_vf2_u003b((&param_9));\n    let _e134 = u[0u];\n    let _e137 = u[1u];\n    return mix(mix(_e120, _e123, _e125), mix(_e129, _e132, _e134), _e137);\n}\n\nfn main_1() {\n    var radius: f32;\n    var d: vec2<f32>;\n    var angle: f32;\n    var t_1: f32;\n    var inner: f32;\n    var param_10: vec2<f32>;\n    var outer: f32;\n    var param_11: vec2<f32>;\n    var swirl: f32;\n    var param_12: vec2<f32>;\n    var core: f32;\n    var corona: f32;\n    var body: f32;\n    var col: vec3<f32>;\n    var alpha: f32;\n    var fog: f32;\n    var param_13: f32;\n    var param_14: f32;\n    var param_15: vec3<f32>;\n    var phi_528_: bool;\n\n    let _e119 = unnamed.uClipEnabled;\n    let _e120 = (_e119 != 0i);\n    phi_528_ = _e120;\n    if _e120 {\n        let _e121 = vWorldPos_1;\n        let _e127 = unnamed.uClipPlane;\n        phi_528_ = (dot(vec4<f32>(_e121.x, _e121.y, _e121.z, 1f), _e127) < 0f);\n    }\n    let _e131 = phi_528_;\n    if _e131 {\n        discard;\n    }\n    let _e132 = vUv_1;\n    radius = (length((_e132 - vec2(0.5f))) * 2f);\n    let _e137 = radius;\n    if (_e137 >= 1f) {\n        discard;\n    }\n    let _e139 = vUv_1;\n    d = (_e139 - vec2(0.5f));\n    let _e143 = d[1u];\n    let _e145 = d[0u];\n    angle = atan2(_e143, _e145);\n    let _e148 = unnamed.uTime;\n    let _e149 = vSeed_1;\n    t_1 = (_e148 + (_e149 * 37f));\n    let _e152 = angle;\n    let _e154 = t_1;\n    let _e157 = radius;\n    param_10 = vec2<f32>(((_e152 * 1.9f) + (_e154 * 0.55f)), (_e157 * 4.2f));\n    let _e160 = valueNoise_u0028_vf2_u003b((&param_10));\n    inner = _e160;\n    let _e161 = angle;\n    let _e163 = t_1;\n    let _e166 = radius;\n    param_11 = vec2<f32>(((_e161 * 3.1f) - (_e163 * 0.34f)), (_e166 * 2.6f));\n    let _e169 = valueNoise_u0028_vf2_u003b((&param_11));\n    outer = _e169;\n    let _e170 = inner;\n    let _e172 = outer;\n    swirl = ((_e170 * 0.62f) + (_e172 * 0.38f));\n    let _e176 = unnamed.uNoiseOctaves;\n    if (_e176 > 1i) {\n        let _e178 = swirl;\n        let _e179 = swirl;\n        let _e180 = angle;\n        let _e182 = t_1;\n        let _e185 = radius;\n        param_12 = vec2<f32>(((_e180 * 6.3f) + (_e182 * 0.9f)), (_e185 * 8f));\n        let _e188 = valueNoise_u0028_vf2_u003b((&param_12));\n        swirl = mix(_e178, ((_e179 * _e188) * 2f), 0.35f);\n    }\n    let _e192 = radius;\n    core = (1f - smoothstep(0f, 0.28f, _e192));\n    let _e195 = radius;\n    let _e198 = swirl;\n    corona = ((1f - smoothstep(0.18f, 1f, _e195)) * (0.35f + (_e198 * 0.65f)));\n    let _e202 = core;\n    let _e204 = corona;\n    body = ((_e202 * 0.9f) + _e204);\n    let _e206 = body;\n    if (_e206 <= 0.02f) {\n        discard;\n    }\n    let _e209 = unnamed.uTint;\n    let _e212 = unnamed.uTint;\n    let _e213 = body;\n    col = mix((_e209 * 0.35f), _e212, vec3(smoothstep(0f, 0.55f, _e213)));\n    let _e217 = col;\n    let _e218 = body;\n    col = mix(_e217, vec3<f32>(1f, 1f, 1f), vec3(smoothstep(0.82f, 1.4f, _e218)));\n    let _e223 = unnamed.uTint;\n    let _e224 = col;\n    col = (_e224 * _e223);\n    let _e226 = body;\n    alpha = clamp((_e226 * 1.6f), 0f, 1f);\n    let _e229 = vDistance_1;\n    param_13 = _e229;\n    let _e231 = vWorldPos_1[1u];\n    param_14 = _e231;\n    let _e232 = mediumFog_u0028_f1_u003b_f1_u003b((&param_13), (&param_14));\n    fog = _e232;\n    let _e233 = col;\n    let _e234 = mediumColor_u0028_();\n    let _e235 = fog;\n    col = mix(_e233, _e234, vec3(_e235));\n    let _e238 = fog;\n    let _e240 = alpha;\n    alpha = (_e240 * (1f - _e238));\n    let _e242 = col;\n    param_15 = _e242;\n    let _e243 = applyOutputTransform_u0028_vf3_u003b((&param_15));\n    let _e244 = alpha;\n    outColor = vec4<f32>(_e243.x, _e243.y, _e243.z, _e244);\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(0) vUv: vec2<f32>, @location(1) vSeed: f32, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const ARCANE_BINDINGS = {
  "ARCANE_FRAG": {
    "uniforms": 1,
    "uniformSize": 192,
    "fields": {
      "uTime": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 48,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 80,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 112,
        "size": 16,
        "type": "vec4"
      },
      "uNoiseOctaves": {
        "offset": 128,
        "size": 4,
        "type": "int"
      },
      "uClipPlane": {
        "offset": 144,
        "size": 16,
        "type": "vec4"
      },
      "uClipEnabled": {
        "offset": 160,
        "size": 4,
        "type": "int"
      },
      "uOutputTransform": {
        "offset": 164,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 168,
        "size": 4,
        "type": "float"
      },
      "uTint": {
        "offset": 176,
        "size": 12,
        "type": "vec3"
      }
    },
    "textures": {}
  }
} as const;
