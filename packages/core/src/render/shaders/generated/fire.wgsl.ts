/*
 * Generated from ../fire.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FIRE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e110 = (*c);\n    low = (_e110 * 12.92f);\n    let _e112 = (*c);\n    high = ((pow(max(_e112, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e118 = high;\n    let _e119 = low;\n    let _e120 = (*c);\n    return mix(_e118, _e119, step(_e120, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e111 = (*c_1)[0u];\n    let _e113 = (*c_1)[1u];\n    let _e115 = (*c_1)[2u];\n    m = max(_e111, max(_e113, _e115));\n    let _e118 = m;\n    if (_e118 <= 0.8f) {\n        let _e120 = (*c_1);\n        return _e120;\n    }\n    let _e121 = m;\n    e = (_e121 - 0.8f);\n    let _e123 = (*c_1);\n    let _e124 = e;\n    let _e126 = e;\n    let _e130 = m;\n    return (_e123 * ((0.8f + ((0.2f * _e124) / (_e126 + 0.2f))) / _e130));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e110 = (*v);\n    let _e111 = (*v);\n    a = ((_e110 * (_e111 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e117 = (*v);\n    let _e118 = (*v);\n    b = ((_e117 * ((_e118 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e125 = a;\n    let _e126 = b;\n    return (_e125 / _e126);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e110 = unnamed.uOutputExposure;\n    let _e111 = (*x);\n    (*x) = (_e111 * _e110);\n    let _e113 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e113);\n    let _e115 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e115), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e112 = unnamed.uOutputTransform;\n    if (_e112 == 0i) {\n        let _e114 = (*c_2);\n        return _e114;\n    }\n    let _e116 = unnamed.uOutputTransform;\n    if (_e116 == 2i) {\n        let _e118 = (*c_2);\n        param_1 = _e118;\n        let _e119 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e119;\n    }\n    let _e121 = unnamed.uOutputTransform;\n    if (_e121 == 3i) {\n        let _e123 = (*c_2);\n        let _e125 = unnamed.uOutputExposure;\n        param_2 = (_e123 * _e125);\n        let _e127 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e127;\n    }\n    let _e128 = (*c_2);\n    param_3 = _e128;\n    let _e129 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e129;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e108 = unnamed.uFogColor;\n    let _e110 = unnamed.uUnderwaterColor;\n    let _e112 = unnamed.uUnderwaterFactor;\n    return mix(_e108, _e110, vec3(_e112));\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e121 = unnamed.uFogRange[0u];\n    let _e122 = (*dist);\n    start = min(_e121, _e122);\n    let _e124 = (*dist);\n    if (_e124 > 0f) {\n        let _e126 = start;\n        let _e127 = (*dist);\n        local = (_e126 / _e127);\n    } else {\n        local = 0f;\n    }\n    let _e129 = local;\n    before = _e129;\n    let _e130 = (*pointY);\n    let _e133 = unnamed.uFogMedium[2u];\n    let _e137 = unnamed.uFogMedium[1u];\n    t = ((_e130 - _e133) * _e137);\n    let _e139 = t;\n    let _e140 = before;\n    rest = (_e139 * (1f - _e140));\n    let _e143 = rest;\n    let _e146 = rest;\n    denom = select(_e146, 0.0001f, (abs(_e143) < 0.0001f));\n    let _e150 = unnamed.uFogMedium[0u];\n    let _e151 = t;\n    let _e153 = before;\n    let _e157 = (*dist);\n    let _e158 = start;\n    let _e161 = denom;\n    let _e166 = denom;\n    depth = ((((_e150 * exp((-(_e151) * _e153))) * (_e157 - _e158)) * (1f - exp(-(_e161)))) / _e166);\n    let _e170 = unnamed.uFogLayer2_[0u];\n    if (_e170 > 0f) {\n        let _e172 = (*pointY);\n        let _e175 = unnamed.uFogMedium[2u];\n        let _e179 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e172 - _e175) * _e179);\n        let _e181 = t2_;\n        let _e182 = before;\n        rest2_ = (_e181 * (1f - _e182));\n        let _e185 = rest2_;\n        let _e188 = rest2_;\n        denom2_ = select(_e188, 0.0001f, (abs(_e185) < 0.0001f));\n        let _e192 = unnamed.uFogLayer2_[0u];\n        let _e193 = t2_;\n        let _e195 = before;\n        let _e199 = (*dist);\n        let _e200 = start;\n        let _e203 = denom2_;\n        let _e208 = denom2_;\n        let _e210 = depth;\n        depth = (_e210 + ((((_e192 * exp((-(_e193) * _e195))) * (_e199 - _e200)) * (1f - exp(-(_e203)))) / _e208));\n    }\n    let _e212 = depth;\n    return _e212;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var wet: f32;\n    var phi_198_: bool;\n\n    let _e121 = unnamed.uFogLayer2_[3u];\n    let _e122 = (_e121 > 0f);\n    phi_198_ = _e122;\n    if _e122 {\n        let _e123 = (*dist_1);\n        let _e126 = unnamed.uFogLayer2_[3u];\n        phi_198_ = (_e123 > _e126);\n    }\n    let _e129 = phi_198_;\n    cut = _e129;\n    let _e132 = unnamed.uFogRange[2u];\n    if (_e132 == 1f) {\n        let _e136 = unnamed.uFogRange[1u];\n        let _e139 = unnamed.uFogRange[0u];\n        span = max((_e136 - _e139), 0.0001f);\n        let _e142 = cut;\n        if _e142 {\n            local_1 = 0f;\n        } else {\n            let _e143 = (*dist_1);\n            let _e146 = unnamed.uFogRange[0u];\n            let _e148 = span;\n            let _e153 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e143 - _e146) / _e148), 0f, 1f), (1f - _e153));\n        }\n        let _e156 = local_1;\n        ramp = _e156;\n        let _e158 = unnamed.uUnderwaterFactor;\n        if (_e158 <= 0f) {\n            let _e160 = ramp;\n            return _e160;\n        }\n        let _e163 = unnamed.uFogMedium[3u];\n        let _e164 = (*dist_1);\n        wetLinear = (_e163 * _e164);\n        let _e166 = ramp;\n        let _e167 = wetLinear;\n        let _e169 = wetLinear;\n        let _e175 = unnamed.uUnderwaterFactor;\n        return mix(_e166, (1f - exp2(((-(_e167) * _e169) * 1.442695f))), _e175);\n    }\n    let _e177 = cut;\n    if _e177 {\n        local_2 = 0f;\n    } else {\n        let _e178 = (*dist_1);\n        param_4 = _e178;\n        let _e179 = (*pointY_1);\n        param_5 = _e179;\n        let _e180 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        let _e185 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e180)), _e185));\n    }\n    let _e188 = local_2;\n    air = _e188;\n    let _e190 = unnamed.uUnderwaterFactor;\n    if (_e190 <= 0f) {\n        let _e192 = air;\n        return _e192;\n    }\n    let _e195 = unnamed.uFogMedium[3u];\n    let _e196 = (*dist_1);\n    wet = (_e195 * _e196);\n    let _e198 = air;\n    let _e199 = wet;\n    let _e201 = wet;\n    let _e207 = unnamed.uUnderwaterFactor;\n    return mix(_e198, (1f - exp2(((-(_e199) * _e201) * 1.442695f))), _e207);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e108 = (*p);\n    return fract((sin(dot(_e108, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n\n    let _e115 = (*p_1);\n    i = floor(_e115);\n    let _e117 = (*p_1);\n    f = fract(_e117);\n    let _e119 = f;\n    let _e120 = f;\n    let _e122 = f;\n    u = ((_e119 * _e120) * (vec2(3f) - (_e122 * 2f)));\n    let _e127 = i;\n    param_6 = _e127;\n    let _e128 = hash21_u0028_vf2_u003b((&param_6));\n    let _e129 = i;\n    param_7 = (_e129 + vec2<f32>(1f, 0f));\n    let _e131 = hash21_u0028_vf2_u003b((&param_7));\n    let _e133 = u[0u];\n    let _e135 = i;\n    param_8 = (_e135 + vec2<f32>(0f, 1f));\n    let _e137 = hash21_u0028_vf2_u003b((&param_8));\n    let _e138 = i;\n    param_9 = (_e138 + vec2<f32>(1f, 1f));\n    let _e140 = hash21_u0028_vf2_u003b((&param_9));\n    let _e142 = u[0u];\n    let _e145 = u[1u];\n    return mix(mix(_e128, _e131, _e133), mix(_e137, _e140, _e142), _e145);\n}\n\nfn turbulence_u0028_vf2_u003b_f1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>) -> f32 {\n    var v_1: f32;\n    var param_10: vec2<f32>;\n    var param_11: vec2<f32>;\n    var param_12: vec2<f32>;\n\n    let _e113 = (*p_2);\n    let _e115 = (*t_1);\n    param_10 = ((_e113 * 3f) + vec2<f32>(0f, (-(_e115) * 1.9f)));\n    let _e120 = valueNoise_u0028_vf2_u003b((&param_10));\n    v_1 = (_e120 * 0.55f);\n    let _e123 = unnamed.uNoiseOctaves;\n    if (_e123 == 1i) {\n        let _e125 = v_1;\n        return (_e125 / 0.55f);\n    }\n    let _e127 = (*p_2);\n    let _e129 = (*t_1);\n    let _e131 = (*t_1);\n    param_11 = ((_e127 * 6.5f) + vec2<f32>((_e129 * 0.3f), (-(_e131) * 3.1f)));\n    let _e136 = valueNoise_u0028_vf2_u003b((&param_11));\n    let _e138 = v_1;\n    v_1 = (_e138 + (_e136 * 0.28f));\n    let _e141 = unnamed.uNoiseOctaves;\n    if (_e141 == 2i) {\n        let _e143 = v_1;\n        return (_e143 / 0.83f);\n    }\n    let _e145 = v_1;\n    let _e146 = (*p_2);\n    let _e148 = (*t_1);\n    let _e151 = (*t_1);\n    param_12 = ((_e146 * 13f) + vec2<f32>((-(_e148) * 0.2f), (-(_e151) * 4.6f)));\n    let _e156 = valueNoise_u0028_vf2_u003b((&param_12));\n    return (_e145 + (_e156 * 0.17f));\n}\n\nfn main_1() {\n    var uv: vec2<f32>;\n    var t_2: f32;\n    var sides: f32;\n    var taper: f32;\n    var sway: f32;\n    var param_13: vec2<f32>;\n    var p_3: vec2<f32>;\n    var n: f32;\n    var param_14: vec2<f32>;\n    var param_15: f32;\n    var body: f32;\n    var heat: f32;\n    var col: vec3<f32>;\n    var alpha: f32;\n    var fog: f32;\n    var param_16: f32;\n    var param_17: f32;\n    var param_18: vec3<f32>;\n    var phi_602_: bool;\n\n    let _e126 = unnamed.uClipEnabled;\n    let _e127 = (_e126 != 0i);\n    phi_602_ = _e127;\n    if _e127 {\n        let _e128 = vWorldPos_1;\n        let _e134 = unnamed.uClipPlane;\n        phi_602_ = (dot(vec4<f32>(_e128.x, _e128.y, _e128.z, 1f), _e134) < 0f);\n    }\n    let _e138 = phi_602_;\n    if _e138 {\n        discard;\n    }\n    let _e139 = vUv_1;\n    uv = _e139;\n    let _e141 = unnamed.uTime;\n    let _e142 = vSeed_1;\n    t_2 = (_e141 + (_e142 * 37f));\n    let _e146 = uv[0u];\n    sides = (1f - (abs((_e146 - 0.5f)) * 2f));\n    let _e151 = sides;\n    let _e153 = uv[1u];\n    taper = (_e151 * (1f - (_e153 * 0.72f)));\n    let _e157 = taper;\n    if (_e157 <= 0f) {\n        discard;\n    }\n    let _e159 = t_2;\n    let _e161 = vSeed_1;\n    param_13 = vec2<f32>((_e159 * 0.55f), (_e161 * 11f));\n    let _e164 = valueNoise_u0028_vf2_u003b((&param_13));\n    let _e168 = uv[1u];\n    sway = (((_e164 - 0.5f) * 0.34f) * _e168);\n    let _e171 = uv[0u];\n    let _e172 = sway;\n    let _e175 = uv[1u];\n    p_3 = vec2<f32>((_e171 + _e172), _e175);\n    let _e177 = p_3;\n    param_14 = _e177;\n    let _e178 = t_2;\n    param_15 = _e178;\n    let _e179 = turbulence_u0028_vf2_u003b_f1_u003b((&param_14), (&param_15));\n    n = _e179;\n    let _e180 = n;\n    let _e181 = taper;\n    let _e185 = uv[1u];\n    body = (((_e180 * _e181) * 1.9f) - (_e185 * 0.55f));\n    let _e188 = body;\n    if (_e188 <= 0.02f) {\n        discard;\n    }\n    let _e190 = body;\n    heat = clamp((_e190 * 1.5f), 0f, 1f);\n    let _e193 = heat;\n    col = mix(vec3<f32>(0.62f, 0.06f, 0.02f), vec3<f32>(1f, 0.45f, 0.06f), vec3(smoothstep(0f, 0.45f, _e193)));\n    let _e197 = col;\n    let _e198 = heat;\n    col = mix(_e197, vec3<f32>(1f, 0.85f, 0.35f), vec3(smoothstep(0.45f, 0.75f, _e198)));\n    let _e202 = col;\n    let _e203 = heat;\n    col = mix(_e202, vec3<f32>(1f, 0.98f, 0.88f), vec3(smoothstep(0.78f, 1f, _e203)));\n    let _e207 = body;\n    let _e211 = uv[1u];\n    alpha = (clamp((_e207 * 2.2f), 0f, 1f) * (1f - smoothstep(0.72f, 1f, _e211)));\n    let _e215 = vDistance_1;\n    param_16 = _e215;\n    let _e217 = vWorldPos_1[1u];\n    param_17 = _e217;\n    let _e218 = mediumFog_u0028_f1_u003b_f1_u003b((&param_16), (&param_17));\n    fog = _e218;\n    let _e219 = col;\n    let _e220 = mediumColor_u0028_();\n    let _e221 = fog;\n    col = mix(_e219, _e220, vec3(_e221));\n    let _e224 = fog;\n    let _e226 = alpha;\n    alpha = (_e226 * (1f - _e224));\n    let _e228 = col;\n    param_18 = _e228;\n    let _e229 = applyOutputTransform_u0028_vf3_u003b((&param_18));\n    let _e230 = alpha;\n    outColor = vec4<f32>(_e229.x, _e229.y, _e229.z, _e230);\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(0) vUv: vec2<f32>, @location(1) vSeed: f32, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

export const PLUME_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uSizePulse: f32,\n    uWind: vec2<f32>,\n    uOrigin: vec3<f32>,\n    uWindResponse: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: f32,\n    @location(2) member_2: f32,\n    @location(3) member_3: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCenter_1: vec3<f32>;\nvar<private> aSeed_1: f32;\nvar<private> aBlade_1: f32;\nvar<private> aSize_1: vec2<f32>;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vUv: vec2<f32>;\nvar<private> vSeed: f32;\nvar<private> vDistance: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn sizePulse_u0028_f1_u003b(seed: ptr<function, f32>) -> f32 {\n    let _e35 = unnamed.uSizePulse;\n    let _e37 = unnamed.uTime;\n    let _e39 = (*seed);\n    let _e45 = unnamed.uTime;\n    let _e47 = (*seed);\n    return (1f + (_e35 * ((sin(((_e37 * 1.7f) + (_e39 * 9.1f))) * 0.62f) + (sin(((_e45 * 3.3f) + (_e47 * 4.7f))) * 0.38f))));\n}\n\nfn main_1() {\n    var anchor: vec3<f32>;\n    var up: vec3<f32>;\n    var yaw: f32;\n    var right: vec3<f32>;\n    var pulse: f32;\n    var param: f32;\n    var size: vec2<f32>;\n    var rise: f32;\n    var world: vec3<f32>;\n\n    let _e42 = aCenter_1;\n    let _e44 = unnamed.uOrigin;\n    anchor = (_e42 + _e44);\n    up = vec3<f32>(0f, 1f, 0f);\n    let _e46 = aSeed_1;\n    let _e48 = aBlade_1;\n    yaw = ((_e46 * 6.2831855f) + (_e48 * 1.5707964f));\n    let _e51 = yaw;\n    let _e53 = yaw;\n    right = vec3<f32>(cos(_e51), 0f, sin(_e53));\n    let _e56 = aSeed_1;\n    param = _e56;\n    let _e57 = sizePulse_u0028_f1_u003b((&param));\n    pulse = _e57;\n    let _e59 = aSize_1[0u];\n    let _e60 = pulse;\n    let _e64 = aSize_1[1u];\n    let _e65 = pulse;\n    size = vec2<f32>((_e59 * mix(1f, _e60, 0.55f)), (_e64 * _e65));\n    let _e69 = aCorner_1[1u];\n    rise = ((_e69 * 0.5f) + 0.5f);\n    let _e72 = anchor;\n    let _e73 = right;\n    let _e75 = aCorner_1[0u];\n    let _e77 = size[0u];\n    let _e81 = up;\n    let _e82 = rise;\n    let _e84 = size[1u];\n    world = ((_e72 + (_e73 * (_e75 * _e77))) + (_e81 * (_e82 * _e84)));\n    let _e89 = unnamed.uWind;\n    let _e91 = unnamed.uWindResponse;\n    let _e92 = rise;\n    let _e94 = rise;\n    let _e97 = size[1u];\n    let _e100 = world;\n    let _e102 = (_e100.xz + (_e89 * (((_e91 * _e92) * _e94) * _e97)));\n    let _e103 = world;\n    world = vec3<f32>(_e102.x, _e103.y, _e102.y);\n    let _e109 = aCorner_1[0u];\n    let _e113 = aCorner_1[1u];\n    vUv = vec2<f32>(((_e109 * 0.5f) + 0.5f), ((_e113 * 0.5f) + 0.5f));\n    let _e117 = aSeed_1;\n    vSeed = _e117;\n    let _e118 = world;\n    let _e120 = unnamed.uCameraPos;\n    vDistance = distance(_e118, _e120);\n    let _e122 = world;\n    vWorldPos = _e122;\n    let _e124 = unnamed.uViewProj;\n    let _e125 = world;\n    unnamed_1.gl_Position = (_e124 * vec4<f32>(_e125.x, _e125.y, _e125.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aCenter: vec3<f32>, @location(3) aSeed: f32, @location(4) aBlade: f32, @location(2) aSize: vec2<f32>, @location(1) aCorner: vec2<f32>) -> VertexOutput {\n    aCenter_1 = aCenter;\n    aSeed_1 = aSeed;\n    aBlade_1 = aBlade;\n    aSize_1 = aSize;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e17 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e17);\n    let _e19 = vUv;\n    let _e20 = vSeed;\n    let _e21 = vDistance;\n    let _e22 = vWorldPos;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e19, _e20, _e21, _e22, _e23);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FIRE_BINDINGS = {
  "FIRE_FRAG": {
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
  },
  "PLUME_VERT": {
    "uniforms": 0,
    "uniformSize": 112,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uTime": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uSizePulse": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uWind": {
        "offset": 88,
        "size": 8,
        "type": "vec2"
      },
      "uOrigin": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uWindResponse": {
        "offset": 108,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
