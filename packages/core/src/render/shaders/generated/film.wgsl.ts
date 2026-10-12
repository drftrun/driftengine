/*
 * Generated from ../film.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FILM_FRAG_WGSL = "struct Uniforms {\n    uReflectionEnabled: i32,\n    uReflectionStrength: f32,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uSheen: f32,\n    uFilmRoughness: f32,\n    uFilmRoughnessCycles: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorld_1: vec3<f32>;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vTint_1: vec3<f32>;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vCoverage_1: f32;\nvar<private> fragColor: vec4<f32>;\n\nfn filmHash_u0028_vf3_u003b(p: ptr<function, vec3<f32>>) -> f32 {\n    let _e113 = (*p);\n    (*p) = fract((_e113 * 0.1031f));\n    let _e116 = (*p);\n    let _e117 = (*p);\n    let _e122 = (*p);\n    (*p) = (_e122 + vec3(dot(_e116, (_e117.zyx + vec3(31.32f)))));\n    let _e126 = (*p)[0u];\n    let _e128 = (*p)[1u];\n    let _e131 = (*p)[2u];\n    return fract(((_e126 + _e128) * _e131));\n}\n\nfn filmNoise_u0028_vf3_u003b(p_1: ptr<function, vec3<f32>>) -> f32 {\n    var i: vec3<f32>;\n    var f: vec3<f32>;\n    var u: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec3<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n\n    let _e124 = (*p_1);\n    i = floor(_e124);\n    let _e126 = (*p_1);\n    f = fract(_e126);\n    let _e128 = f;\n    let _e129 = f;\n    let _e131 = f;\n    u = ((_e128 * _e129) * (vec3(3f) - (_e131 * 2f)));\n    let _e136 = i;\n    param = (_e136 + vec3<f32>(0f, 0f, 0f));\n    let _e138 = filmHash_u0028_vf3_u003b((&param));\n    let _e139 = i;\n    param_1 = (_e139 + vec3<f32>(1f, 0f, 0f));\n    let _e141 = filmHash_u0028_vf3_u003b((&param_1));\n    let _e143 = u[0u];\n    let _e145 = i;\n    param_2 = (_e145 + vec3<f32>(0f, 1f, 0f));\n    let _e147 = filmHash_u0028_vf3_u003b((&param_2));\n    let _e148 = i;\n    param_3 = (_e148 + vec3<f32>(1f, 1f, 0f));\n    let _e150 = filmHash_u0028_vf3_u003b((&param_3));\n    let _e152 = u[0u];\n    let _e155 = u[1u];\n    let _e157 = i;\n    param_4 = (_e157 + vec3<f32>(0f, 0f, 1f));\n    let _e159 = filmHash_u0028_vf3_u003b((&param_4));\n    let _e160 = i;\n    param_5 = (_e160 + vec3<f32>(1f, 0f, 1f));\n    let _e162 = filmHash_u0028_vf3_u003b((&param_5));\n    let _e164 = u[0u];\n    let _e166 = i;\n    param_6 = (_e166 + vec3<f32>(0f, 1f, 1f));\n    let _e168 = filmHash_u0028_vf3_u003b((&param_6));\n    let _e169 = i;\n    param_7 = (_e169 + vec3<f32>(1f, 1f, 1f));\n    let _e171 = filmHash_u0028_vf3_u003b((&param_7));\n    let _e173 = u[0u];\n    let _e176 = u[1u];\n    let _e179 = u[2u];\n    return mix(mix(mix(_e138, _e141, _e143), mix(_e147, _e150, _e152), _e155), mix(mix(_e159, _e162, _e164), mix(_e168, _e171, _e173), _e176), _e179);\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e115 = (*c);\n    low = (_e115 * 12.92f);\n    let _e117 = (*c);\n    high = ((pow(max(_e117, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e123 = high;\n    let _e124 = low;\n    let _e125 = (*c);\n    return mix(_e123, _e124, step(_e125, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e116 = (*c_1)[0u];\n    let _e118 = (*c_1)[1u];\n    let _e120 = (*c_1)[2u];\n    m = max(_e116, max(_e118, _e120));\n    let _e123 = m;\n    if (_e123 <= 0.8f) {\n        let _e125 = (*c_1);\n        return _e125;\n    }\n    let _e126 = m;\n    e = (_e126 - 0.8f);\n    let _e128 = (*c_1);\n    let _e129 = e;\n    let _e131 = e;\n    let _e135 = m;\n    return (_e128 * ((0.8f + ((0.2f * _e129) / (_e131 + 0.2f))) / _e135));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e115 = (*v);\n    let _e116 = (*v);\n    a = ((_e115 * (_e116 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e122 = (*v);\n    let _e123 = (*v);\n    b = ((_e122 * ((_e123 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e130 = a;\n    let _e131 = b;\n    return (_e130 / _e131);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_8: vec3<f32>;\n\n    let _e115 = unnamed.uOutputExposure;\n    let _e116 = (*x);\n    (*x) = (_e116 * _e115);\n    let _e118 = (*x);\n    param_8 = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e118);\n    let _e120 = rrtAndOdtFit_u0028_vf3_u003b((&param_8));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e120), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_9: vec3<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n\n    let _e117 = unnamed.uOutputTransform;\n    if (_e117 == 0i) {\n        let _e119 = (*c_2);\n        return _e119;\n    }\n    let _e121 = unnamed.uOutputTransform;\n    if (_e121 == 2i) {\n        let _e123 = (*c_2);\n        param_9 = _e123;\n        let _e124 = acesFilmic_u0028_vf3_u003b((&param_9));\n        (*c_2) = _e124;\n    }\n    let _e126 = unnamed.uOutputTransform;\n    if (_e126 == 3i) {\n        let _e128 = (*c_2);\n        let _e130 = unnamed.uOutputExposure;\n        param_10 = (_e128 * _e130);\n        let _e132 = highlightShoulder_u0028_vf3_u003b((&param_10));\n        (*c_2) = _e132;\n    }\n    let _e133 = (*c_2);\n    param_11 = _e133;\n    let _e134 = linearToSrgb_u0028_vf3_u003b((&param_11));\n    return _e134;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e113 = unnamed.uFogColor;\n    let _e115 = unnamed.uUnderwaterColor;\n    let _e117 = unnamed.uUnderwaterFactor;\n    return mix(_e113, _e115, vec3(_e117));\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e126 = unnamed.uFogRange[0u];\n    let _e127 = (*dist);\n    start = min(_e126, _e127);\n    let _e129 = (*dist);\n    if (_e129 > 0f) {\n        let _e131 = start;\n        let _e132 = (*dist);\n        local = (_e131 / _e132);\n    } else {\n        local = 0f;\n    }\n    let _e134 = local;\n    before = _e134;\n    let _e135 = (*pointY);\n    let _e138 = unnamed.uFogMedium[2u];\n    let _e142 = unnamed.uFogMedium[1u];\n    t = ((_e135 - _e138) * _e142);\n    let _e144 = t;\n    let _e145 = before;\n    rest = (_e144 * (1f - _e145));\n    let _e148 = rest;\n    let _e151 = rest;\n    denom = select(_e151, 0.0001f, (abs(_e148) < 0.0001f));\n    let _e155 = unnamed.uFogMedium[0u];\n    let _e156 = t;\n    let _e158 = before;\n    let _e162 = (*dist);\n    let _e163 = start;\n    let _e166 = denom;\n    let _e171 = denom;\n    depth = ((((_e155 * exp((-(_e156) * _e158))) * (_e162 - _e163)) * (1f - exp(-(_e166)))) / _e171);\n    let _e175 = unnamed.uFogLayer2_[0u];\n    if (_e175 > 0f) {\n        let _e177 = (*pointY);\n        let _e180 = unnamed.uFogMedium[2u];\n        let _e184 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e177 - _e180) * _e184);\n        let _e186 = t2_;\n        let _e187 = before;\n        rest2_ = (_e186 * (1f - _e187));\n        let _e190 = rest2_;\n        let _e193 = rest2_;\n        denom2_ = select(_e193, 0.0001f, (abs(_e190) < 0.0001f));\n        let _e197 = unnamed.uFogLayer2_[0u];\n        let _e198 = t2_;\n        let _e200 = before;\n        let _e204 = (*dist);\n        let _e205 = start;\n        let _e208 = denom2_;\n        let _e213 = denom2_;\n        let _e215 = depth;\n        depth = (_e215 + ((((_e197 * exp((-(_e198) * _e200))) * (_e204 - _e205)) * (1f - exp(-(_e208)))) / _e213));\n    }\n    let _e217 = depth;\n    return _e217;\n}\n\nfn mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>, toPoint: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var span: f32;\n    var perMetre: f32;\n    var param_12: f32;\n    var param_13: f32;\n    var hidden: f32;\n    var lobe: f32;\n    var phi_316_: bool;\n    var phi_330_: bool;\n\n    let _e123 = unnamed.uFogRange[2u];\n    let _e124 = (_e123 == 1f);\n    phi_316_ = _e124;\n    if !(_e124) {\n        let _e128 = unnamed.uFogGlow[0u];\n        let _e131 = unnamed.uFogGlow[1u];\n        let _e135 = unnamed.uFogGlow[2u];\n        phi_316_ = (max(max(_e128, _e131), _e135) <= 0f);\n    }\n    let _e139 = phi_316_;\n    if _e139 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e142 = unnamed.uFogLayer2_[3u];\n    let _e143 = (_e142 > 0f);\n    phi_330_ = _e143;\n    if _e143 {\n        let _e144 = (*dist_1);\n        let _e147 = unnamed.uFogLayer2_[3u];\n        phi_330_ = (_e144 > _e147);\n    }\n    let _e150 = phi_330_;\n    if _e150 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e151 = (*dist_1);\n    let _e154 = unnamed.uFogRange[0u];\n    let _e155 = (*dist_1);\n    span = (_e151 - min(_e154, _e155));\n    let _e158 = span;\n    if (_e158 <= 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e160 = (*dist_1);\n    param_12 = _e160;\n    let _e161 = (*pointY_1);\n    param_13 = _e161;\n    let _e162 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_12), (&param_13));\n    let _e163 = span;\n    perMetre = (_e162 / _e163);\n    let _e165 = perMetre;\n    let _e167 = span;\n    let _e170 = unnamed.uFogGlowDir[3u];\n    hidden = (1f - exp((-(_e165) * max((_e167 - _e170), 0f))));\n    let _e176 = (*toPoint);\n    let _e178 = unnamed.uFogGlowDir;\n    let _e184 = unnamed.uFogGlow[3u];\n    lobe = pow(clamp(dot(_e176, _e178.xyz), 0f, 1f), _e184);\n    let _e187 = unnamed.uFogGlow;\n    let _e189 = lobe;\n    let _e190 = hidden;\n    let _e193 = unnamed.uUnderwaterFactor;\n    return (_e187.xyz * ((_e189 * _e190) * (1f - _e193)));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_2: ptr<function, f32>, pointY_2: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span_1: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_14: f32;\n    var param_15: f32;\n    var wet: f32;\n    var phi_201_: bool;\n\n    let _e126 = unnamed.uFogLayer2_[3u];\n    let _e127 = (_e126 > 0f);\n    phi_201_ = _e127;\n    if _e127 {\n        let _e128 = (*dist_2);\n        let _e131 = unnamed.uFogLayer2_[3u];\n        phi_201_ = (_e128 > _e131);\n    }\n    let _e134 = phi_201_;\n    cut = _e134;\n    let _e137 = unnamed.uFogRange[2u];\n    if (_e137 == 1f) {\n        let _e141 = unnamed.uFogRange[1u];\n        let _e144 = unnamed.uFogRange[0u];\n        span_1 = max((_e141 - _e144), 0.0001f);\n        let _e147 = cut;\n        if _e147 {\n            local_1 = 0f;\n        } else {\n            let _e148 = (*dist_2);\n            let _e151 = unnamed.uFogRange[0u];\n            let _e153 = span_1;\n            let _e158 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e148 - _e151) / _e153), 0f, 1f), (1f - _e158));\n        }\n        let _e161 = local_1;\n        ramp = _e161;\n        let _e163 = unnamed.uUnderwaterFactor;\n        if (_e163 <= 0f) {\n            let _e165 = ramp;\n            return _e165;\n        }\n        let _e168 = unnamed.uFogMedium[3u];\n        let _e169 = (*dist_2);\n        wetLinear = (_e168 * _e169);\n        let _e171 = ramp;\n        let _e172 = wetLinear;\n        let _e174 = wetLinear;\n        let _e180 = unnamed.uUnderwaterFactor;\n        return mix(_e171, (1f - exp2(((-(_e172) * _e174) * 1.442695f))), _e180);\n    }\n    let _e182 = cut;\n    if _e182 {\n        local_2 = 0f;\n    } else {\n        let _e183 = (*dist_2);\n        param_14 = _e183;\n        let _e184 = (*pointY_2);\n        param_15 = _e184;\n        let _e185 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_14), (&param_15));\n        let _e190 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e185)), _e190));\n    }\n    let _e193 = local_2;\n    air = _e193;\n    let _e195 = unnamed.uUnderwaterFactor;\n    if (_e195 <= 0f) {\n        let _e197 = air;\n        return _e197;\n    }\n    let _e200 = unnamed.uFogMedium[3u];\n    let _e201 = (*dist_2);\n    wet = (_e200 * _e201);\n    let _e203 = air;\n    let _e204 = wet;\n    let _e206 = wet;\n    let _e212 = unnamed.uUnderwaterFactor;\n    return mix(_e203, (1f - exp2(((-(_e204) * _e206) * 1.442695f))), _e212);\n}\n\nfn hue_u0028_f1_u003b(h: ptr<function, f32>) -> vec3<f32> {\n    var c_3: vec3<f32>;\n\n    let _e114 = (*h);\n    (*h) = (fract(_e114) * 6f);\n    let _e117 = (*h);\n    let _e121 = (*h);\n    let _e125 = (*h);\n    c_3 = clamp(vec3<f32>((abs((_e117 - 3f)) - 1f), (2f - abs((_e121 - 2f))), (2f - abs((_e125 - 4f)))), vec3(0f), vec3(1f));\n    let _e133 = c_3;\n    return _e133;\n}\n\nfn main_1() {\n    var view: vec3<f32>;\n    var facing: f32;\n    var grazing: f32;\n    var ripple: f32;\n    var sheen: vec3<f32>;\n    var param_16: f32;\n    var base: vec3<f32>;\n    var color: vec3<f32>;\n    var fog: f32;\n    var param_17: f32;\n    var param_18: f32;\n    var glow: vec3<f32>;\n    var param_19: f32;\n    var param_20: f32;\n    var param_21: vec3<f32>;\n    var gradedAir: vec3<f32>;\n    var param_22: vec3<f32>;\n    var graded: vec3<f32>;\n    var param_23: vec3<f32>;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var valid: f32;\n    var at: vec3<f32>;\n    var here: f32;\n    var param_24: vec3<f32>;\n    var slope: vec2<f32>;\n    var param_25: vec3<f32>;\n    var param_26: vec3<f32>;\n    var along: vec2<f32>;\n    var smear: vec2<f32>;\n    var movedBorder: vec2<f32>;\n    var mirrored: vec3<f32>;\n    var coverage: f32;\n    var alpha: f32;\n    var phi_698_: bool;\n    var phi_833_: bool;\n    var phi_841_: bool;\n\n    let _e147 = unnamed.uClipEnabled;\n    let _e148 = (_e147 != 0i);\n    phi_698_ = _e148;\n    if _e148 {\n        let _e149 = vWorld_1;\n        let _e155 = unnamed.uClipPlane;\n        phi_698_ = (dot(vec4<f32>(_e149.x, _e149.y, _e149.z, 1f), _e155) < 0f);\n    }\n    let _e159 = phi_698_;\n    if _e159 {\n        discard;\n    }\n    let _e161 = unnamed.uCameraPos;\n    let _e162 = vWorld_1;\n    view = normalize((_e161 - _e162));\n    let _e165 = vNormal_1;\n    let _e167 = view;\n    facing = max(dot(normalize(_e165), _e167), 0f);\n    let _e170 = facing;\n    grazing = pow((1f - _e170), 3f);\n    let _e174 = vWorld_1[0u];\n    let _e177 = vWorld_1[2u];\n    let _e181 = unnamed.uTime;\n    let _e186 = vWorld_1[2u];\n    let _e189 = vWorld_1[0u];\n    let _e193 = unnamed.uTime;\n    ripple = (sin((((_e174 * 0.73f) + (_e177 * 0.41f)) + (_e181 * 0.55f))) * cos((((_e186 * 0.91f) - (_e189 * 0.29f)) - (_e193 * 0.37f))));\n    let _e198 = grazing;\n    let _e200 = ripple;\n    param_16 = (((_e198 * 1.35f) + (_e200 * 0.14f)) + 0.55f);\n    let _e204 = hue_u0028_f1_u003b((&param_16));\n    sheen = _e204;\n    let _e205 = vTint_1;\n    base = (_e205 * 0.9f);\n    let _e207 = base;\n    let _e208 = sheen;\n    let _e210 = unnamed.uSheen;\n    let _e212 = grazing;\n    color = (_e207 + ((_e208 * _e210) * (0.22f + (_e212 * 0.75f))));\n    let _e218 = unnamed.uCameraPos;\n    let _e219 = vWorld_1;\n    param_17 = length((_e218 - _e219));\n    let _e223 = vWorld_1[1u];\n    param_18 = _e223;\n    let _e224 = mediumFog_u0028_f1_u003b_f1_u003b((&param_17), (&param_18));\n    fog = _e224;\n    let _e226 = unnamed.uCameraPos;\n    let _e227 = vWorld_1;\n    let _e230 = vWorld_1;\n    let _e232 = unnamed.uCameraPos;\n    param_19 = length((_e226 - _e227));\n    let _e236 = vWorld_1[1u];\n    param_20 = _e236;\n    param_21 = normalize((_e230 - _e232));\n    let _e237 = mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_19), (&param_20), (&param_21));\n    glow = _e237;\n    let _e238 = mediumColor_u0028_();\n    param_22 = _e238;\n    let _e239 = applyOutputTransform_u0028_vf3_u003b((&param_22));\n    gradedAir = _e239;\n    let _e240 = color;\n    let _e241 = mediumColor_u0028_();\n    let _e242 = fog;\n    let _e245 = glow;\n    param_23 = (mix(_e240, _e241, vec3(_e242)) + _e245);\n    let _e247 = applyOutputTransform_u0028_vf3_u003b((&param_23));\n    graded = _e247;\n    let _e249 = unnamed.uReflectionEnabled;\n    let _e250 = (_e249 != 0i);\n    phi_833_ = _e250;\n    if _e250 {\n        let _e252 = unnamed.uReflectionStrength;\n        phi_833_ = (_e252 > 0f);\n    }\n    let _e255 = phi_833_;\n    phi_841_ = _e255;\n    if _e255 {\n        let _e257 = vReflectionClip_1[3u];\n        phi_841_ = (_e257 > 0f);\n    }\n    let _e260 = phi_841_;\n    if _e260 {\n        let _e261 = vReflectionClip_1;\n        let _e264 = vReflectionClip_1[3u];\n        reflectionUv = (((_e261.xy / vec2(_e264)) * 0.5f) + vec2(0.5f));\n        let _e270 = reflectionUv;\n        let _e271 = reflectionUv;\n        border = min(_e270, (vec2(1f) - _e271));\n        let _e276 = border[0u];\n        let _e278 = border[1u];\n        valid = smoothstep(0f, 0.025f, min(_e276, _e278));\n        let _e282 = unnamed.uFilmRoughness;\n        if (_e282 > 0f) {\n            let _e284 = vWorld_1;\n            let _e286 = unnamed.uFilmRoughnessCycles;\n            at = (_e284 * _e286);\n            let _e288 = at;\n            param_24 = _e288;\n            let _e289 = filmNoise_u0028_vf3_u003b((&param_24));\n            here = _e289;\n            let _e290 = at;\n            param_25 = (_e290 + vec3<f32>(0.5f, 0f, 0f));\n            let _e292 = filmNoise_u0028_vf3_u003b((&param_25));\n            let _e293 = here;\n            let _e295 = at;\n            param_26 = (_e295 + vec3<f32>(0f, 0f, 0.5f));\n            let _e297 = filmNoise_u0028_vf3_u003b((&param_26));\n            let _e298 = here;\n            slope = vec2<f32>((_e292 - _e293), (_e297 - _e298));\n            let _e302 = view[0u];\n            let _e304 = view[2u];\n            along = normalize((vec2<f32>(_e302, _e304) + vec2<f32>(0.00001f, 0f)));\n            let _e308 = along;\n            let _e309 = slope;\n            let _e310 = along;\n            let _e314 = slope;\n            smear = (((_e308 * dot(_e309, _e310)) * 3f) + (_e314 * 0.35f));\n            let _e317 = smear;\n            let _e319 = unnamed.uFilmRoughness;\n            let _e322 = grazing;\n            let _e326 = reflectionUv;\n            reflectionUv = (_e326 + (((_e317 * _e319) * 0.016f) * (0.2f + (_e322 * 0.8f))));\n            let _e328 = reflectionUv;\n            let _e329 = reflectionUv;\n            movedBorder = min(_e328, (vec2(1f) - _e329));\n            let _e333 = valid;\n            let _e335 = movedBorder[0u];\n            let _e337 = movedBorder[1u];\n            valid = min(_e333, smoothstep(0f, 0.025f, min(_e335, _e337)));\n        }\n        let _e341 = reflectionUv;\n        let _e345 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e341, vec2(0f), vec2(1f)), 0f);\n        mirrored = _e345.xyz;\n        let _e347 = graded;\n        let _e348 = mirrored;\n        let _e349 = gradedAir;\n        let _e350 = fog;\n        let _e353 = valid;\n        let _e355 = unnamed.uReflectionStrength;\n        let _e357 = grazing;\n        graded = mix(_e347, mix(_e348, _e349, vec3(_e350)), vec3(((_e353 * _e355) * (0.25f + (_e357 * 0.75f)))));\n    }\n    let _e363 = vCoverage_1;\n    coverage = clamp(_e363, 0f, 1f);\n    let _e365 = coverage;\n    let _e366 = coverage;\n    let _e368 = coverage;\n    alpha = (mix((_e365 * _e366), _e368, 0.65f) * 0.92f);\n    let _e371 = graded;\n    let _e372 = alpha;\n    fragColor = vec4<f32>(_e371.x, _e371.y, _e371.z, _e372);\n    return;\n}\n\n@fragment \nfn main(@location(0) vWorld: vec3<f32>, @location(1) vNormal: vec3<f32>, @location(2) vTint: vec3<f32>, @location(3) vReflectionClip: vec4<f32>, @location(4) vCoverage: f32) -> @location(0) vec4<f32> {\n    vWorld_1 = vWorld;\n    vNormal_1 = vNormal;\n    vTint_1 = vTint;\n    vReflectionClip_1 = vReflectionClip;\n    vCoverage_1 = vCoverage;\n    main_1();\n    let _e11 = fragColor;\n    return _e11;\n}\n";

export const FILM_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) member_2: vec3<f32>,\n    @location(4) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vWorld: vec3<f32>;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vTint: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vCoverage: f32;\nvar<private> aCoverage_1: f32;\nvar<private> vReflectionClip: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    let _e14 = aPosition_1;\n    vWorld = _e14;\n    let _e15 = aNormal_1;\n    vNormal = normalize(_e15);\n    let _e17 = aColor_1;\n    vTint = _e17;\n    let _e18 = aCoverage_1;\n    vCoverage = _e18;\n    let _e20 = unnamed.uReflectionViewProj;\n    let _e21 = aPosition_1;\n    vReflectionClip = (_e20 * vec4<f32>(_e21.x, _e21.y, _e21.z, 1f));\n    let _e28 = unnamed.uViewProj;\n    let _e29 = aPosition_1;\n    unnamed_1.gl_Position = (_e28 * vec4<f32>(_e29.x, _e29.y, _e29.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(1) aNormal: vec3<f32>, @location(2) aColor: vec3<f32>, @location(3) aCoverage: f32) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aNormal_1 = aNormal;\n    aColor_1 = aColor;\n    aCoverage_1 = aCoverage;\n    main_1();\n    let _e16 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e16);\n    let _e18 = vWorld;\n    let _e19 = vNormal;\n    let _e20 = vTint;\n    let _e21 = vCoverage;\n    let _e22 = vReflectionClip;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e18, _e19, _e20, _e21, _e22, _e23);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FILM_BINDINGS = {
  "FILM_FRAG": {
    "uniforms": 1,
    "uniformSize": 208,
    "fields": {
      "uReflectionEnabled": {
        "offset": 0,
        "size": 4,
        "type": "int"
      },
      "uReflectionStrength": {
        "offset": 4,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uTime": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uClipPlane": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uClipEnabled": {
        "offset": 48,
        "size": 4,
        "type": "int"
      },
      "uFogColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 80,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 128,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 144,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 160,
        "size": 16,
        "type": "vec4"
      },
      "uSheen": {
        "offset": 176,
        "size": 4,
        "type": "float"
      },
      "uFilmRoughness": {
        "offset": 180,
        "size": 4,
        "type": "float"
      },
      "uFilmRoughnessCycles": {
        "offset": 184,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 188,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 192,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uReflectionMap": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "FILM_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uReflectionViewProj": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
