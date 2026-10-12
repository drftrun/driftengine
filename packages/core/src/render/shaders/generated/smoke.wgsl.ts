/*
 * Generated from ../smoke.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SMOKE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e110 = (*c);\n    low = (_e110 * 12.92f);\n    let _e112 = (*c);\n    high = ((pow(max(_e112, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e118 = high;\n    let _e119 = low;\n    let _e120 = (*c);\n    return mix(_e118, _e119, step(_e120, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e111 = (*c_1)[0u];\n    let _e113 = (*c_1)[1u];\n    let _e115 = (*c_1)[2u];\n    m = max(_e111, max(_e113, _e115));\n    let _e118 = m;\n    if (_e118 <= 0.8f) {\n        let _e120 = (*c_1);\n        return _e120;\n    }\n    let _e121 = m;\n    e = (_e121 - 0.8f);\n    let _e123 = (*c_1);\n    let _e124 = e;\n    let _e126 = e;\n    let _e130 = m;\n    return (_e123 * ((0.8f + ((0.2f * _e124) / (_e126 + 0.2f))) / _e130));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e110 = (*v);\n    let _e111 = (*v);\n    a = ((_e110 * (_e111 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e117 = (*v);\n    let _e118 = (*v);\n    b = ((_e117 * ((_e118 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e125 = a;\n    let _e126 = b;\n    return (_e125 / _e126);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e110 = unnamed.uOutputExposure;\n    let _e111 = (*x);\n    (*x) = (_e111 * _e110);\n    let _e113 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e113);\n    let _e115 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e115), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e112 = unnamed.uOutputTransform;\n    if (_e112 == 0i) {\n        let _e114 = (*c_2);\n        return _e114;\n    }\n    let _e116 = unnamed.uOutputTransform;\n    if (_e116 == 2i) {\n        let _e118 = (*c_2);\n        param_1 = _e118;\n        let _e119 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e119;\n    }\n    let _e121 = unnamed.uOutputTransform;\n    if (_e121 == 3i) {\n        let _e123 = (*c_2);\n        let _e125 = unnamed.uOutputExposure;\n        param_2 = (_e123 * _e125);\n        let _e127 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e127;\n    }\n    let _e128 = (*c_2);\n    param_3 = _e128;\n    let _e129 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e129;\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e121 = unnamed.uFogRange[0u];\n    let _e122 = (*dist);\n    start = min(_e121, _e122);\n    let _e124 = (*dist);\n    if (_e124 > 0f) {\n        let _e126 = start;\n        let _e127 = (*dist);\n        local = (_e126 / _e127);\n    } else {\n        local = 0f;\n    }\n    let _e129 = local;\n    before = _e129;\n    let _e130 = (*pointY);\n    let _e133 = unnamed.uFogMedium[2u];\n    let _e137 = unnamed.uFogMedium[1u];\n    t = ((_e130 - _e133) * _e137);\n    let _e139 = t;\n    let _e140 = before;\n    rest = (_e139 * (1f - _e140));\n    let _e143 = rest;\n    let _e146 = rest;\n    denom = select(_e146, 0.0001f, (abs(_e143) < 0.0001f));\n    let _e150 = unnamed.uFogMedium[0u];\n    let _e151 = t;\n    let _e153 = before;\n    let _e157 = (*dist);\n    let _e158 = start;\n    let _e161 = denom;\n    let _e166 = denom;\n    depth = ((((_e150 * exp((-(_e151) * _e153))) * (_e157 - _e158)) * (1f - exp(-(_e161)))) / _e166);\n    let _e170 = unnamed.uFogLayer2_[0u];\n    if (_e170 > 0f) {\n        let _e172 = (*pointY);\n        let _e175 = unnamed.uFogMedium[2u];\n        let _e179 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e172 - _e175) * _e179);\n        let _e181 = t2_;\n        let _e182 = before;\n        rest2_ = (_e181 * (1f - _e182));\n        let _e185 = rest2_;\n        let _e188 = rest2_;\n        denom2_ = select(_e188, 0.0001f, (abs(_e185) < 0.0001f));\n        let _e192 = unnamed.uFogLayer2_[0u];\n        let _e193 = t2_;\n        let _e195 = before;\n        let _e199 = (*dist);\n        let _e200 = start;\n        let _e203 = denom2_;\n        let _e208 = denom2_;\n        let _e210 = depth;\n        depth = (_e210 + ((((_e192 * exp((-(_e193) * _e195))) * (_e199 - _e200)) * (1f - exp(-(_e203)))) / _e208));\n    }\n    let _e212 = depth;\n    return _e212;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var wet: f32;\n    var phi_198_: bool;\n\n    let _e121 = unnamed.uFogLayer2_[3u];\n    let _e122 = (_e121 > 0f);\n    phi_198_ = _e122;\n    if _e122 {\n        let _e123 = (*dist_1);\n        let _e126 = unnamed.uFogLayer2_[3u];\n        phi_198_ = (_e123 > _e126);\n    }\n    let _e129 = phi_198_;\n    cut = _e129;\n    let _e132 = unnamed.uFogRange[2u];\n    if (_e132 == 1f) {\n        let _e136 = unnamed.uFogRange[1u];\n        let _e139 = unnamed.uFogRange[0u];\n        span = max((_e136 - _e139), 0.0001f);\n        let _e142 = cut;\n        if _e142 {\n            local_1 = 0f;\n        } else {\n            let _e143 = (*dist_1);\n            let _e146 = unnamed.uFogRange[0u];\n            let _e148 = span;\n            let _e153 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e143 - _e146) / _e148), 0f, 1f), (1f - _e153));\n        }\n        let _e156 = local_1;\n        ramp = _e156;\n        let _e158 = unnamed.uUnderwaterFactor;\n        if (_e158 <= 0f) {\n            let _e160 = ramp;\n            return _e160;\n        }\n        let _e163 = unnamed.uFogMedium[3u];\n        let _e164 = (*dist_1);\n        wetLinear = (_e163 * _e164);\n        let _e166 = ramp;\n        let _e167 = wetLinear;\n        let _e169 = wetLinear;\n        let _e175 = unnamed.uUnderwaterFactor;\n        return mix(_e166, (1f - exp2(((-(_e167) * _e169) * 1.442695f))), _e175);\n    }\n    let _e177 = cut;\n    if _e177 {\n        local_2 = 0f;\n    } else {\n        let _e178 = (*dist_1);\n        param_4 = _e178;\n        let _e179 = (*pointY_1);\n        param_5 = _e179;\n        let _e180 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        let _e185 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e180)), _e185));\n    }\n    let _e188 = local_2;\n    air = _e188;\n    let _e190 = unnamed.uUnderwaterFactor;\n    if (_e190 <= 0f) {\n        let _e192 = air;\n        return _e192;\n    }\n    let _e195 = unnamed.uFogMedium[3u];\n    let _e196 = (*dist_1);\n    wet = (_e195 * _e196);\n    let _e198 = air;\n    let _e199 = wet;\n    let _e201 = wet;\n    let _e207 = unnamed.uUnderwaterFactor;\n    return mix(_e198, (1f - exp2(((-(_e199) * _e201) * 1.442695f))), _e207);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e108 = unnamed.uFogColor;\n    let _e110 = unnamed.uUnderwaterColor;\n    let _e112 = unnamed.uUnderwaterFactor;\n    return mix(_e108, _e110, vec3(_e112));\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e108 = (*p);\n    return fract((sin(dot(_e108, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n\n    let _e115 = (*p_1);\n    i = floor(_e115);\n    let _e117 = (*p_1);\n    f = fract(_e117);\n    let _e119 = f;\n    let _e120 = f;\n    let _e122 = f;\n    u = ((_e119 * _e120) * (vec2(3f) - (_e122 * 2f)));\n    let _e127 = i;\n    param_6 = _e127;\n    let _e128 = hash21_u0028_vf2_u003b((&param_6));\n    let _e129 = i;\n    param_7 = (_e129 + vec2<f32>(1f, 0f));\n    let _e131 = hash21_u0028_vf2_u003b((&param_7));\n    let _e133 = u[0u];\n    let _e135 = i;\n    param_8 = (_e135 + vec2<f32>(0f, 1f));\n    let _e137 = hash21_u0028_vf2_u003b((&param_8));\n    let _e138 = i;\n    param_9 = (_e138 + vec2<f32>(1f, 1f));\n    let _e140 = hash21_u0028_vf2_u003b((&param_9));\n    let _e142 = u[0u];\n    let _e145 = u[1u];\n    return mix(mix(_e128, _e131, _e133), mix(_e137, _e140, _e142), _e145);\n}\n\nfn billow_u0028_vf2_u003b_f1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>) -> f32 {\n    var v_1: f32;\n    var param_10: vec2<f32>;\n    var param_11: vec2<f32>;\n    var param_12: vec2<f32>;\n\n    let _e113 = (*p_2);\n    let _e115 = (*t_1);\n    param_10 = ((_e113 * 2.2f) + vec2<f32>(0f, (-(_e115) * 0.55f)));\n    let _e120 = valueNoise_u0028_vf2_u003b((&param_10));\n    v_1 = (_e120 * 0.55f);\n    let _e123 = unnamed.uNoiseOctaves;\n    if (_e123 == 1i) {\n        let _e125 = v_1;\n        return (_e125 / 0.55f);\n    }\n    let _e127 = (*p_2);\n    let _e129 = (*t_1);\n    let _e131 = (*t_1);\n    param_11 = ((_e127 * 4.7f) + vec2<f32>((_e129 * 0.12f), (-(_e131) * 0.9f)));\n    let _e136 = valueNoise_u0028_vf2_u003b((&param_11));\n    let _e138 = v_1;\n    v_1 = (_e138 + (_e136 * 0.29f));\n    let _e141 = unnamed.uNoiseOctaves;\n    if (_e141 == 2i) {\n        let _e143 = v_1;\n        return (_e143 / 0.84f);\n    }\n    let _e145 = v_1;\n    let _e146 = (*p_2);\n    let _e148 = (*t_1);\n    let _e151 = (*t_1);\n    param_12 = ((_e146 * 9.3f) + vec2<f32>((-(_e148) * 0.09f), (-(_e151) * 1.4f)));\n    let _e156 = valueNoise_u0028_vf2_u003b((&param_12));\n    return (_e145 + (_e156 * 0.16f));\n}\n\nfn main_1() {\n    var t_2: f32;\n    var height: f32;\n    var spread: f32;\n    var centred: f32;\n    var sides: f32;\n    var drift: f32;\n    var param_13: vec2<f32>;\n    var n: f32;\n    var param_14: vec2<f32>;\n    var param_15: f32;\n    var density: f32;\n    var col: vec3<f32>;\n    var atmosphereColor: vec3<f32>;\n    var emerge: f32;\n    var dissipate: f32;\n    var fog: f32;\n    var param_16: f32;\n    var param_17: f32;\n    var alpha: f32;\n    var param_18: vec3<f32>;\n    var phi_603_: bool;\n\n    let _e128 = unnamed.uClipEnabled;\n    let _e129 = (_e128 != 0i);\n    phi_603_ = _e129;\n    if _e129 {\n        let _e130 = vWorldPos_1;\n        let _e136 = unnamed.uClipPlane;\n        phi_603_ = (dot(vec4<f32>(_e130.x, _e130.y, _e130.z, 1f), _e136) < 0f);\n    }\n    let _e140 = phi_603_;\n    if _e140 {\n        discard;\n    }\n    let _e142 = unnamed.uTime;\n    let _e143 = vSeed_1;\n    t_2 = (_e142 + (_e143 * 53f));\n    let _e147 = vUv_1[1u];\n    height = _e147;\n    let _e148 = height;\n    spread = mix(0.5f, 1f, _e148);\n    let _e151 = vUv_1[0u];\n    let _e153 = spread;\n    centred = (((_e151 - 0.5f) / _e153) + 0.5f);\n    let _e156 = centred;\n    sides = smoothstep(0f, 0.55f, (1f - clamp((abs((_e156 - 0.5f)) * 2f), 0f, 1f)));\n    let _e163 = sides;\n    if (_e163 <= 0.001f) {\n        discard;\n    }\n    let _e165 = t_2;\n    let _e167 = vSeed_1;\n    param_13 = vec2<f32>((_e165 * 0.21f), (_e167 * 7f));\n    let _e170 = valueNoise_u0028_vf2_u003b((&param_13));\n    let _e173 = height;\n    let _e175 = height;\n    drift = ((((_e170 - 0.5f) * 0.6f) * _e173) * _e175);\n    let _e177 = centred;\n    let _e178 = drift;\n    let _e180 = height;\n    param_14 = vec2<f32>((_e177 + _e178), _e180);\n    let _e182 = t_2;\n    param_15 = _e182;\n    let _e183 = billow_u0028_vf2_u003b_f1_u003b((&param_14), (&param_15));\n    n = _e183;\n    let _e184 = n;\n    let _e185 = sides;\n    let _e188 = height;\n    density = (((_e184 * _e185) * 1.35f) - (_e188 * 0.88f));\n    let _e191 = density;\n    if (_e191 <= 0.02f) {\n        discard;\n    }\n    let _e193 = height;\n    col = mix(vec3<f32>(0.9f, 0.42f, 0.16f), vec3<f32>(0.11f, 0.1f, 0.1f), vec3(smoothstep(0f, 0.34f, _e193)));\n    let _e197 = mediumColor_u0028_();\n    atmosphereColor = _e197;\n    let _e198 = col;\n    let _e199 = atmosphereColor;\n    let _e200 = height;\n    col = mix(_e198, _e199, vec3(smoothstep(0.3f, 0.95f, _e200)));\n    let _e204 = height;\n    emerge = smoothstep(0f, 0.3f, _e204);\n    let _e206 = height;\n    dissipate = (1f - smoothstep(0.22f, 0.75f, _e206));\n    let _e209 = vDistance_1;\n    param_16 = _e209;\n    let _e211 = vWorldPos_1[1u];\n    param_17 = _e211;\n    let _e212 = mediumFog_u0028_f1_u003b_f1_u003b((&param_16), (&param_17));\n    fog = _e212;\n    let _e213 = col;\n    let _e214 = atmosphereColor;\n    let _e215 = fog;\n    col = mix(_e213, _e214, vec3(_e215));\n    let _e218 = density;\n    let _e221 = emerge;\n    let _e223 = dissipate;\n    alpha = (((clamp((_e218 * 0.95f), 0f, 1f) * _e221) * _e223) * 0.13f);\n    let _e226 = col;\n    param_18 = _e226;\n    let _e227 = applyOutputTransform_u0028_vf3_u003b((&param_18));\n    let _e228 = alpha;\n    let _e229 = fog;\n    outColor = vec4<f32>(_e227.x, _e227.y, _e227.z, (_e228 * (1f - _e229)));\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(1) vSeed: f32, @location(0) vUv: vec2<f32>, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vSeed_1 = vSeed;\n    vUv_1 = vUv;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SMOKE_BINDINGS = {
  "SMOKE_FRAG": {
    "uniforms": 1,
    "uniformSize": 176,
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
      }
    },
    "textures": {}
  }
} as const;
