/*
 * Generated from ../particle.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const PARTICLE_MOTE_FRAG_WGSL = "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uFogEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vAlpha_1: f32;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAge_1: f32;\nvar<private> vSeed_1: f32;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e75 = (*c);\n    low = (_e75 * 12.92f);\n    let _e77 = (*c);\n    high = ((pow(max(_e77, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e83 = high;\n    let _e84 = low;\n    let _e85 = (*c);\n    return mix(_e83, _e84, step(_e85, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e76 = (*c_1)[0u];\n    let _e78 = (*c_1)[1u];\n    let _e80 = (*c_1)[2u];\n    m = max(_e76, max(_e78, _e80));\n    let _e83 = m;\n    if (_e83 <= 0.8f) {\n        let _e85 = (*c_1);\n        return _e85;\n    }\n    let _e86 = m;\n    e = (_e86 - 0.8f);\n    let _e88 = (*c_1);\n    let _e89 = e;\n    let _e91 = e;\n    let _e95 = m;\n    return (_e88 * ((0.8f + ((0.2f * _e89) / (_e91 + 0.2f))) / _e95));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e75 = (*v);\n    let _e76 = (*v);\n    a = ((_e75 * (_e76 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e82 = (*v);\n    let _e83 = (*v);\n    b = ((_e82 * ((_e83 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e90 = a;\n    let _e91 = b;\n    return (_e90 / _e91);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e75 = unnamed.uOutputExposure;\n    let _e76 = (*x);\n    (*x) = (_e76 * _e75);\n    let _e78 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e78);\n    let _e80 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e80), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e77 = unnamed.uOutputTransform;\n    if (_e77 == 0i) {\n        let _e79 = (*c_2);\n        return _e79;\n    }\n    let _e81 = unnamed.uOutputTransform;\n    if (_e81 == 2i) {\n        let _e83 = (*c_2);\n        param_1 = _e83;\n        let _e84 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e84;\n    }\n    let _e86 = unnamed.uOutputTransform;\n    if (_e86 == 3i) {\n        let _e88 = (*c_2);\n        let _e90 = unnamed.uOutputExposure;\n        param_2 = (_e88 * _e90);\n        let _e92 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e92;\n    }\n    let _e93 = (*c_2);\n    param_3 = _e93;\n    let _e94 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e94;\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e86 = unnamed.uFogRange[0u];\n    let _e87 = (*dist);\n    start = min(_e86, _e87);\n    let _e89 = (*dist);\n    if (_e89 > 0f) {\n        let _e91 = start;\n        let _e92 = (*dist);\n        local = (_e91 / _e92);\n    } else {\n        local = 0f;\n    }\n    let _e94 = local;\n    before = _e94;\n    let _e95 = (*pointY);\n    let _e98 = unnamed.uFogMedium[2u];\n    let _e102 = unnamed.uFogMedium[1u];\n    t = ((_e95 - _e98) * _e102);\n    let _e104 = t;\n    let _e105 = before;\n    rest = (_e104 * (1f - _e105));\n    let _e108 = rest;\n    let _e111 = rest;\n    denom = select(_e111, 0.0001f, (abs(_e108) < 0.0001f));\n    let _e115 = unnamed.uFogMedium[0u];\n    let _e116 = t;\n    let _e118 = before;\n    let _e122 = (*dist);\n    let _e123 = start;\n    let _e126 = denom;\n    let _e131 = denom;\n    depth = ((((_e115 * exp((-(_e116) * _e118))) * (_e122 - _e123)) * (1f - exp(-(_e126)))) / _e131);\n    let _e135 = unnamed.uFogLayer2_[0u];\n    if (_e135 > 0f) {\n        let _e137 = (*pointY);\n        let _e140 = unnamed.uFogMedium[2u];\n        let _e144 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e137 - _e140) * _e144);\n        let _e146 = t2_;\n        let _e147 = before;\n        rest2_ = (_e146 * (1f - _e147));\n        let _e150 = rest2_;\n        let _e153 = rest2_;\n        denom2_ = select(_e153, 0.0001f, (abs(_e150) < 0.0001f));\n        let _e157 = unnamed.uFogLayer2_[0u];\n        let _e158 = t2_;\n        let _e160 = before;\n        let _e164 = (*dist);\n        let _e165 = start;\n        let _e168 = denom2_;\n        let _e173 = denom2_;\n        let _e175 = depth;\n        depth = (_e175 + ((((_e157 * exp((-(_e158) * _e160))) * (_e164 - _e165)) * (1f - exp(-(_e168)))) / _e173));\n    }\n    let _e177 = depth;\n    return _e177;\n}\n\nfn mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>, toPoint: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var span: f32;\n    var perMetre: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var hidden: f32;\n    var lobe: f32;\n    var phi_305_: bool;\n    var phi_319_: bool;\n\n    let _e83 = unnamed.uFogRange[2u];\n    let _e84 = (_e83 == 1f);\n    phi_305_ = _e84;\n    if !(_e84) {\n        let _e88 = unnamed.uFogGlow[0u];\n        let _e91 = unnamed.uFogGlow[1u];\n        let _e95 = unnamed.uFogGlow[2u];\n        phi_305_ = (max(max(_e88, _e91), _e95) <= 0f);\n    }\n    let _e99 = phi_305_;\n    if _e99 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e102 = unnamed.uFogLayer2_[3u];\n    let _e103 = (_e102 > 0f);\n    phi_319_ = _e103;\n    if _e103 {\n        let _e104 = (*dist_1);\n        let _e107 = unnamed.uFogLayer2_[3u];\n        phi_319_ = (_e104 > _e107);\n    }\n    let _e110 = phi_319_;\n    if _e110 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e111 = (*dist_1);\n    let _e114 = unnamed.uFogRange[0u];\n    let _e115 = (*dist_1);\n    span = (_e111 - min(_e114, _e115));\n    let _e118 = span;\n    if (_e118 <= 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e120 = (*dist_1);\n    param_4 = _e120;\n    let _e121 = (*pointY_1);\n    param_5 = _e121;\n    let _e122 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    let _e123 = span;\n    perMetre = (_e122 / _e123);\n    let _e125 = perMetre;\n    let _e127 = span;\n    let _e130 = unnamed.uFogGlowDir[3u];\n    hidden = (1f - exp((-(_e125) * max((_e127 - _e130), 0f))));\n    let _e136 = (*toPoint);\n    let _e138 = unnamed.uFogGlowDir;\n    let _e144 = unnamed.uFogGlow[3u];\n    lobe = pow(clamp(dot(_e136, _e138.xyz), 0f, 1f), _e144);\n    let _e147 = unnamed.uFogGlow;\n    let _e149 = lobe;\n    let _e150 = hidden;\n    let _e153 = unnamed.uUnderwaterFactor;\n    return (_e147.xyz * ((_e149 * _e150) * (1f - _e153)));\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e73 = unnamed.uFogColor;\n    let _e75 = unnamed.uUnderwaterColor;\n    let _e77 = unnamed.uUnderwaterFactor;\n    return mix(_e73, _e75, vec3(_e77));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_2: ptr<function, f32>, pointY_2: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span_1: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var wet: f32;\n    var phi_190_: bool;\n\n    let _e86 = unnamed.uFogLayer2_[3u];\n    let _e87 = (_e86 > 0f);\n    phi_190_ = _e87;\n    if _e87 {\n        let _e88 = (*dist_2);\n        let _e91 = unnamed.uFogLayer2_[3u];\n        phi_190_ = (_e88 > _e91);\n    }\n    let _e94 = phi_190_;\n    cut = _e94;\n    let _e97 = unnamed.uFogRange[2u];\n    if (_e97 == 1f) {\n        let _e101 = unnamed.uFogRange[1u];\n        let _e104 = unnamed.uFogRange[0u];\n        span_1 = max((_e101 - _e104), 0.0001f);\n        let _e107 = cut;\n        if _e107 {\n            local_1 = 0f;\n        } else {\n            let _e108 = (*dist_2);\n            let _e111 = unnamed.uFogRange[0u];\n            let _e113 = span_1;\n            let _e118 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e108 - _e111) / _e113), 0f, 1f), (1f - _e118));\n        }\n        let _e121 = local_1;\n        ramp = _e121;\n        let _e123 = unnamed.uUnderwaterFactor;\n        if (_e123 <= 0f) {\n            let _e125 = ramp;\n            return _e125;\n        }\n        let _e128 = unnamed.uFogMedium[3u];\n        let _e129 = (*dist_2);\n        wetLinear = (_e128 * _e129);\n        let _e131 = ramp;\n        let _e132 = wetLinear;\n        let _e134 = wetLinear;\n        let _e140 = unnamed.uUnderwaterFactor;\n        return mix(_e131, (1f - exp2(((-(_e132) * _e134) * 1.442695f))), _e140);\n    }\n    let _e142 = cut;\n    if _e142 {\n        local_2 = 0f;\n    } else {\n        let _e143 = (*dist_2);\n        param_6 = _e143;\n        let _e144 = (*pointY_2);\n        param_7 = _e144;\n        let _e145 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_6), (&param_7));\n        let _e150 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e145)), _e150));\n    }\n    let _e153 = local_2;\n    air = _e153;\n    let _e155 = unnamed.uUnderwaterFactor;\n    if (_e155 <= 0f) {\n        let _e157 = air;\n        return _e157;\n    }\n    let _e160 = unnamed.uFogMedium[3u];\n    let _e161 = (*dist_2);\n    wet = (_e160 * _e161);\n    let _e163 = air;\n    let _e164 = wet;\n    let _e166 = wet;\n    let _e172 = unnamed.uUnderwaterFactor;\n    return mix(_e163, (1f - exp2(((-(_e164) * _e166) * 1.442695f))), _e172);\n}\n\nfn main_1() {\n    var r: f32;\n    var body: f32;\n    var alpha: f32;\n    var color: vec3<f32>;\n    var dist_3: f32;\n    var fog: f32;\n    var param_8: f32;\n    var param_9: f32;\n    var param_10: f32;\n    var param_11: f32;\n    var param_12: vec3<f32>;\n    var param_13: vec3<f32>;\n\n    let _e84 = vUv_1;\n    r = length(_e84);\n    let _e86 = r;\n    body = (1f - smoothstep(0.4f, 1f, _e86));\n    let _e89 = body;\n    if (_e89 <= 0f) {\n        discard;\n    }\n    let _e91 = body;\n    let _e92 = body;\n    let _e94 = vAlpha_1;\n    alpha = ((_e91 * _e92) * _e94);\n    let _e96 = alpha;\n    if (_e96 <= 0.002f) {\n        discard;\n    }\n    let _e98 = vColor_1;\n    color = _e98;\n    let _e100 = unnamed.uFogEnabled;\n    if (_e100 != 0i) {\n        let _e102 = vWorldPos_1;\n        let _e104 = unnamed.uCameraPos;\n        dist_3 = distance(_e102, _e104);\n        let _e106 = dist_3;\n        param_8 = _e106;\n        let _e108 = vWorldPos_1[1u];\n        param_9 = _e108;\n        let _e109 = mediumFog_u0028_f1_u003b_f1_u003b((&param_8), (&param_9));\n        fog = _e109;\n        let _e110 = color;\n        let _e111 = mediumColor_u0028_();\n        let _e112 = fog;\n        let _e115 = vWorldPos_1;\n        let _e117 = unnamed.uCameraPos;\n        let _e120 = dist_3;\n        param_10 = _e120;\n        let _e122 = vWorldPos_1[1u];\n        param_11 = _e122;\n        param_12 = normalize((_e115 - _e117));\n        let _e123 = mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_10), (&param_11), (&param_12));\n        color = (mix(_e110, _e111, vec3(_e112)) + _e123);\n    }\n    let _e125 = color;\n    param_13 = _e125;\n    let _e126 = applyOutputTransform_u0028_vf3_u003b((&param_13));\n    let _e127 = alpha;\n    outColor = vec4<f32>(_e126.x, _e126.y, _e126.z, _e127);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(2) vAlpha: f32, @location(1) vColor: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(3) vAge: f32, @location(4) vSeed: f32, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vAlpha_1 = vAlpha;\n    vColor_1 = vColor;\n    vWorldPos_1 = vWorldPos;\n    vAge_1 = vAge;\n    vSeed_1 = vSeed;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SMOKE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uCameraPos: vec3<f32>,\n    uNoiseOctaves: i32,\n    uErosion: f32,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vAge_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAlpha_1: f32;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e108 = (*c);\n    low = (_e108 * 12.92f);\n    let _e110 = (*c);\n    high = ((pow(max(_e110, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e116 = high;\n    let _e117 = low;\n    let _e118 = (*c);\n    return mix(_e116, _e117, step(_e118, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e109 = (*c_1)[0u];\n    let _e111 = (*c_1)[1u];\n    let _e113 = (*c_1)[2u];\n    m = max(_e109, max(_e111, _e113));\n    let _e116 = m;\n    if (_e116 <= 0.8f) {\n        let _e118 = (*c_1);\n        return _e118;\n    }\n    let _e119 = m;\n    e = (_e119 - 0.8f);\n    let _e121 = (*c_1);\n    let _e122 = e;\n    let _e124 = e;\n    let _e128 = m;\n    return (_e121 * ((0.8f + ((0.2f * _e122) / (_e124 + 0.2f))) / _e128));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e108 = (*v);\n    let _e109 = (*v);\n    a = ((_e108 * (_e109 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e115 = (*v);\n    let _e116 = (*v);\n    b = ((_e115 * ((_e116 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e123 = a;\n    let _e124 = b;\n    return (_e123 / _e124);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e108 = unnamed.uOutputExposure;\n    let _e109 = (*x);\n    (*x) = (_e109 * _e108);\n    let _e111 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e111);\n    let _e113 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e113), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e110 = unnamed.uOutputTransform;\n    if (_e110 == 0i) {\n        let _e112 = (*c_2);\n        return _e112;\n    }\n    let _e114 = unnamed.uOutputTransform;\n    if (_e114 == 2i) {\n        let _e116 = (*c_2);\n        param_1 = _e116;\n        let _e117 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e117;\n    }\n    let _e119 = unnamed.uOutputTransform;\n    if (_e119 == 3i) {\n        let _e121 = (*c_2);\n        let _e123 = unnamed.uOutputExposure;\n        param_2 = (_e121 * _e123);\n        let _e125 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e125;\n    }\n    let _e126 = (*c_2);\n    param_3 = _e126;\n    let _e127 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e127;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e106 = unnamed.uFogColor;\n    let _e108 = unnamed.uUnderwaterColor;\n    let _e110 = unnamed.uUnderwaterFactor;\n    return mix(_e106, _e108, vec3(_e110));\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e119 = unnamed.uFogRange[0u];\n    let _e120 = (*dist);\n    start = min(_e119, _e120);\n    let _e122 = (*dist);\n    if (_e122 > 0f) {\n        let _e124 = start;\n        let _e125 = (*dist);\n        local = (_e124 / _e125);\n    } else {\n        local = 0f;\n    }\n    let _e127 = local;\n    before = _e127;\n    let _e128 = (*pointY);\n    let _e131 = unnamed.uFogMedium[2u];\n    let _e135 = unnamed.uFogMedium[1u];\n    t = ((_e128 - _e131) * _e135);\n    let _e137 = t;\n    let _e138 = before;\n    rest = (_e137 * (1f - _e138));\n    let _e141 = rest;\n    let _e144 = rest;\n    denom = select(_e144, 0.0001f, (abs(_e141) < 0.0001f));\n    let _e148 = unnamed.uFogMedium[0u];\n    let _e149 = t;\n    let _e151 = before;\n    let _e155 = (*dist);\n    let _e156 = start;\n    let _e159 = denom;\n    let _e164 = denom;\n    depth = ((((_e148 * exp((-(_e149) * _e151))) * (_e155 - _e156)) * (1f - exp(-(_e159)))) / _e164);\n    let _e168 = unnamed.uFogLayer2_[0u];\n    if (_e168 > 0f) {\n        let _e170 = (*pointY);\n        let _e173 = unnamed.uFogMedium[2u];\n        let _e177 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e170 - _e173) * _e177);\n        let _e179 = t2_;\n        let _e180 = before;\n        rest2_ = (_e179 * (1f - _e180));\n        let _e183 = rest2_;\n        let _e186 = rest2_;\n        denom2_ = select(_e186, 0.0001f, (abs(_e183) < 0.0001f));\n        let _e190 = unnamed.uFogLayer2_[0u];\n        let _e191 = t2_;\n        let _e193 = before;\n        let _e197 = (*dist);\n        let _e198 = start;\n        let _e201 = denom2_;\n        let _e206 = denom2_;\n        let _e208 = depth;\n        depth = (_e208 + ((((_e190 * exp((-(_e191) * _e193))) * (_e197 - _e198)) * (1f - exp(-(_e201)))) / _e206));\n    }\n    let _e210 = depth;\n    return _e210;\n}\n\nfn mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>, toPoint: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var span: f32;\n    var perMetre: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var hidden: f32;\n    var lobe: f32;\n    var phi_326_: bool;\n    var phi_340_: bool;\n\n    let _e116 = unnamed.uFogRange[2u];\n    let _e117 = (_e116 == 1f);\n    phi_326_ = _e117;\n    if !(_e117) {\n        let _e121 = unnamed.uFogGlow[0u];\n        let _e124 = unnamed.uFogGlow[1u];\n        let _e128 = unnamed.uFogGlow[2u];\n        phi_326_ = (max(max(_e121, _e124), _e128) <= 0f);\n    }\n    let _e132 = phi_326_;\n    if _e132 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e135 = unnamed.uFogLayer2_[3u];\n    let _e136 = (_e135 > 0f);\n    phi_340_ = _e136;\n    if _e136 {\n        let _e137 = (*dist_1);\n        let _e140 = unnamed.uFogLayer2_[3u];\n        phi_340_ = (_e137 > _e140);\n    }\n    let _e143 = phi_340_;\n    if _e143 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e144 = (*dist_1);\n    let _e147 = unnamed.uFogRange[0u];\n    let _e148 = (*dist_1);\n    span = (_e144 - min(_e147, _e148));\n    let _e151 = span;\n    if (_e151 <= 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e153 = (*dist_1);\n    param_4 = _e153;\n    let _e154 = (*pointY_1);\n    param_5 = _e154;\n    let _e155 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    let _e156 = span;\n    perMetre = (_e155 / _e156);\n    let _e158 = perMetre;\n    let _e160 = span;\n    let _e163 = unnamed.uFogGlowDir[3u];\n    hidden = (1f - exp((-(_e158) * max((_e160 - _e163), 0f))));\n    let _e169 = (*toPoint);\n    let _e171 = unnamed.uFogGlowDir;\n    let _e177 = unnamed.uFogGlow[3u];\n    lobe = pow(clamp(dot(_e169, _e171.xyz), 0f, 1f), _e177);\n    let _e180 = unnamed.uFogGlow;\n    let _e182 = lobe;\n    let _e183 = hidden;\n    let _e186 = unnamed.uUnderwaterFactor;\n    return (_e180.xyz * ((_e182 * _e183) * (1f - _e186)));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_2: ptr<function, f32>, pointY_2: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span_1: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var wet: f32;\n    var phi_211_: bool;\n\n    let _e119 = unnamed.uFogLayer2_[3u];\n    let _e120 = (_e119 > 0f);\n    phi_211_ = _e120;\n    if _e120 {\n        let _e121 = (*dist_2);\n        let _e124 = unnamed.uFogLayer2_[3u];\n        phi_211_ = (_e121 > _e124);\n    }\n    let _e127 = phi_211_;\n    cut = _e127;\n    let _e130 = unnamed.uFogRange[2u];\n    if (_e130 == 1f) {\n        let _e134 = unnamed.uFogRange[1u];\n        let _e137 = unnamed.uFogRange[0u];\n        span_1 = max((_e134 - _e137), 0.0001f);\n        let _e140 = cut;\n        if _e140 {\n            local_1 = 0f;\n        } else {\n            let _e141 = (*dist_2);\n            let _e144 = unnamed.uFogRange[0u];\n            let _e146 = span_1;\n            let _e151 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e141 - _e144) / _e146), 0f, 1f), (1f - _e151));\n        }\n        let _e154 = local_1;\n        ramp = _e154;\n        let _e156 = unnamed.uUnderwaterFactor;\n        if (_e156 <= 0f) {\n            let _e158 = ramp;\n            return _e158;\n        }\n        let _e161 = unnamed.uFogMedium[3u];\n        let _e162 = (*dist_2);\n        wetLinear = (_e161 * _e162);\n        let _e164 = ramp;\n        let _e165 = wetLinear;\n        let _e167 = wetLinear;\n        let _e173 = unnamed.uUnderwaterFactor;\n        return mix(_e164, (1f - exp2(((-(_e165) * _e167) * 1.442695f))), _e173);\n    }\n    let _e175 = cut;\n    if _e175 {\n        local_2 = 0f;\n    } else {\n        let _e176 = (*dist_2);\n        param_6 = _e176;\n        let _e177 = (*pointY_2);\n        param_7 = _e177;\n        let _e178 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_6), (&param_7));\n        let _e183 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e178)), _e183));\n    }\n    let _e186 = local_2;\n    air = _e186;\n    let _e188 = unnamed.uUnderwaterFactor;\n    if (_e188 <= 0f) {\n        let _e190 = air;\n        return _e190;\n    }\n    let _e193 = unnamed.uFogMedium[3u];\n    let _e194 = (*dist_2);\n    wet = (_e193 * _e194);\n    let _e196 = air;\n    let _e197 = wet;\n    let _e199 = wet;\n    let _e205 = unnamed.uUnderwaterFactor;\n    return mix(_e196, (1f - exp2(((-(_e197) * _e199) * 1.442695f))), _e205);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e106 = (*p);\n    return fract((sin(dot(_e106, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n    var param_10: vec2<f32>;\n    var param_11: vec2<f32>;\n\n    let _e113 = (*p_1);\n    i = floor(_e113);\n    let _e115 = (*p_1);\n    f = fract(_e115);\n    let _e117 = f;\n    let _e118 = f;\n    let _e120 = f;\n    u = ((_e117 * _e118) * (vec2(3f) - (_e120 * 2f)));\n    let _e125 = i;\n    param_8 = _e125;\n    let _e126 = hash21_u0028_vf2_u003b((&param_8));\n    let _e127 = i;\n    param_9 = (_e127 + vec2<f32>(1f, 0f));\n    let _e129 = hash21_u0028_vf2_u003b((&param_9));\n    let _e131 = u[0u];\n    let _e133 = i;\n    param_10 = (_e133 + vec2<f32>(0f, 1f));\n    let _e135 = hash21_u0028_vf2_u003b((&param_10));\n    let _e136 = i;\n    param_11 = (_e136 + vec2<f32>(1f, 1f));\n    let _e138 = hash21_u0028_vf2_u003b((&param_11));\n    let _e140 = u[0u];\n    let _e143 = u[1u];\n    return mix(mix(_e126, _e129, _e131), mix(_e135, _e138, _e140), _e143);\n}\n\nfn billow_u0028_vf2_u003b_f1_u003b_i1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>, octaves: ptr<function, i32>) -> f32 {\n    var v_1: f32;\n    var param_12: vec2<f32>;\n    var param_13: vec2<f32>;\n\n    let _e111 = (*p_2);\n    let _e113 = (*t_1);\n    param_12 = ((_e111 * 2.4f) + vec2<f32>(0f, (-(_e113) * 0.5f)));\n    let _e118 = valueNoise_u0028_vf2_u003b((&param_12));\n    v_1 = (_e118 * 0.62f);\n    let _e120 = (*octaves);\n    if (_e120 == 1i) {\n        let _e122 = v_1;\n        return (_e122 / 0.62f);\n    }\n    let _e124 = (*p_2);\n    let _e126 = (*t_1);\n    let _e128 = (*t_1);\n    param_13 = ((_e124 * 5.1f) + vec2<f32>((_e126 * 0.15f), (-(_e128) * 0.8f)));\n    let _e133 = valueNoise_u0028_vf2_u003b((&param_13));\n    let _e135 = v_1;\n    v_1 = (_e135 + (_e133 * 0.38f));\n    let _e137 = v_1;\n    return (_e137 / 1f);\n}\n\nfn main_1() {\n    var r: f32;\n    var body: f32;\n    var t_2: f32;\n    var n: f32;\n    var param_14: vec2<f32>;\n    var param_15: f32;\n    var param_16: i32;\n    var erode: f32;\n    var mask: f32;\n    var n3_: vec3<f32>;\n    var ndl: f32;\n    var lit: vec3<f32>;\n    var i_1: i32;\n    var toLight: vec3<f32>;\n    var dist_3: f32;\n    var radius: f32;\n    var falloff: f32;\n    var wrapped: f32;\n    var shaded: vec3<f32>;\n    var dist_4: f32;\n    var fog: f32;\n    var param_17: f32;\n    var param_18: f32;\n    var glow: vec3<f32>;\n    var param_19: f32;\n    var param_20: f32;\n    var param_21: vec3<f32>;\n    var param_22: vec3<f32>;\n\n    let _e133 = vUv_1;\n    r = length(_e133);\n    let _e135 = r;\n    body = (1f - smoothstep(0.35f, 1f, _e135));\n    let _e138 = body;\n    if (_e138 <= 0f) {\n        discard;\n    }\n    let _e141 = unnamed.uTime;\n    let _e143 = vSeed_1;\n    t_2 = ((_e141 * 0.55f) + (_e143 * 7.31f));\n    let _e146 = vUv_1;\n    let _e147 = vAge_1;\n    let _e151 = vSeed_1;\n    param_14 = ((_e146 * (0.9f + (_e147 * 1.4f))) + vec2<f32>((_e151 * 3.7f), 0f));\n    let _e155 = t_2;\n    param_15 = _e155;\n    let _e157 = unnamed.uNoiseOctaves;\n    param_16 = _e157;\n    let _e158 = billow_u0028_vf2_u003b_f1_u003b_i1_u003b((&param_14), (&param_15), (&param_16));\n    n = _e158;\n    let _e159 = n;\n    let _e161 = unnamed.uErosion;\n    let _e162 = vAge_1;\n    erode = mix(1f, _e159, (_e161 * (0.35f + (_e162 * 0.65f))));\n    let _e167 = body;\n    let _e168 = erode;\n    mask = clamp((_e167 * _e168), 0f, 1f);\n    let _e171 = mask;\n    let _e173 = mask;\n    mask = (_e173 * smoothstep(0f, 0.25f, _e171));\n    let _e175 = mask;\n    if (_e175 <= 0.002f) {\n        discard;\n    }\n    let _e177 = vNormal_1;\n    n3_ = normalize(_e177);\n    let _e179 = n3_;\n    let _e181 = unnamed.uDirectionalDir;\n    ndl = ((dot(_e179, _e181) * 0.5f) + 0.5f);\n    let _e186 = unnamed.uAmbient;\n    let _e188 = unnamed.uDirectionalColor;\n    let _e189 = ndl;\n    lit = (_e186 + (_e188 * _e189));\n    i_1 = 0i;\n    loop {\n        let _e192 = i_1;\n        if (_e192 < 16i) {\n            let _e194 = i_1;\n            let _e196 = unnamed.uLightCount;\n            if (_e194 >= _e196) {\n                break;\n            }\n            let _e198 = i_1;\n            let _e201 = unnamed.uLightPos[_e198];\n            let _e202 = vWorldPos_1;\n            toLight = (_e201 - _e202);\n            let _e204 = toLight;\n            dist_3 = length(_e204);\n            let _e206 = i_1;\n            let _e210 = unnamed.uLightRadius[_e206][0u];\n            radius = _e210;\n            let _e211 = radius;\n            let _e213 = dist_3;\n            let _e214 = radius;\n            if ((_e211 <= 0f) || (_e213 >= _e214)) {\n                continue;\n            }\n            let _e217 = dist_3;\n            let _e218 = radius;\n            falloff = (1f - (_e217 / _e218));\n            let _e221 = n3_;\n            let _e222 = toLight;\n            let _e223 = dist_3;\n            wrapped = ((dot(_e221, (_e222 / vec3(max(_e223, 0.0001f)))) * 0.5f) + 0.5f);\n            let _e230 = i_1;\n            let _e233 = unnamed.uLightColor[_e230];\n            let _e234 = falloff;\n            let _e236 = falloff;\n            let _e238 = wrapped;\n            let _e240 = i_1;\n            let _e244 = unnamed.uLightWeight[_e240][0u];\n            let _e246 = lit;\n            lit = (_e246 + ((((_e233 * _e234) * _e236) * _e238) * _e244));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e248 = i_1;\n            i_1 = (_e248 + 1i);\n        }\n    }\n    let _e250 = vColor_1;\n    let _e251 = lit;\n    shaded = (_e250 * _e251);\n    let _e253 = vWorldPos_1;\n    let _e255 = unnamed.uCameraPos;\n    dist_4 = distance(_e253, _e255);\n    let _e257 = dist_4;\n    param_17 = _e257;\n    let _e259 = vWorldPos_1[1u];\n    param_18 = _e259;\n    let _e260 = mediumFog_u0028_f1_u003b_f1_u003b((&param_17), (&param_18));\n    fog = _e260;\n    let _e261 = vWorldPos_1;\n    let _e263 = unnamed.uCameraPos;\n    let _e266 = dist_4;\n    param_19 = _e266;\n    let _e268 = vWorldPos_1[1u];\n    param_20 = _e268;\n    param_21 = normalize((_e261 - _e263));\n    let _e269 = mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_19), (&param_20), (&param_21));\n    glow = _e269;\n    let _e270 = shaded;\n    let _e271 = mediumColor_u0028_();\n    let _e272 = fog;\n    let _e275 = glow;\n    param_22 = (mix(_e270, _e271, vec3(_e272)) + _e275);\n    let _e277 = applyOutputTransform_u0028_vf3_u003b((&param_22));\n    let _e278 = mask;\n    let _e279 = vAlpha_1;\n    outColor = vec4<f32>(_e277.x, _e277.y, _e277.z, (_e278 * _e279));\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(4) vSeed: f32, @location(3) vAge: f32, @location(6) vNormal: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(1) vColor: vec3<f32>, @location(2) vAlpha: f32) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vAge_1 = vAge;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vColor_1 = vColor;\n    vAlpha_1 = vAlpha;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SPARK_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uCameraPos: vec3<f32>,\n    uCoreGain: f32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vAge_1: f32;\nvar<private> vAlpha_1: f32;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e87 = (*c);\n    low = (_e87 * 12.92f);\n    let _e89 = (*c);\n    high = ((pow(max(_e89, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e95 = high;\n    let _e96 = low;\n    let _e97 = (*c);\n    return mix(_e95, _e96, step(_e97, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e88 = (*c_1)[0u];\n    let _e90 = (*c_1)[1u];\n    let _e92 = (*c_1)[2u];\n    m = max(_e88, max(_e90, _e92));\n    let _e95 = m;\n    if (_e95 <= 0.8f) {\n        let _e97 = (*c_1);\n        return _e97;\n    }\n    let _e98 = m;\n    e = (_e98 - 0.8f);\n    let _e100 = (*c_1);\n    let _e101 = e;\n    let _e103 = e;\n    let _e107 = m;\n    return (_e100 * ((0.8f + ((0.2f * _e101) / (_e103 + 0.2f))) / _e107));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e87 = (*v);\n    let _e88 = (*v);\n    a = ((_e87 * (_e88 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e94 = (*v);\n    let _e95 = (*v);\n    b = ((_e94 * ((_e95 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e102 = a;\n    let _e103 = b;\n    return (_e102 / _e103);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e87 = unnamed.uOutputExposure;\n    let _e88 = (*x);\n    (*x) = (_e88 * _e87);\n    let _e90 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e90);\n    let _e92 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e92), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e89 = unnamed.uOutputTransform;\n    if (_e89 == 0i) {\n        let _e91 = (*c_2);\n        return _e91;\n    }\n    let _e93 = unnamed.uOutputTransform;\n    if (_e93 == 2i) {\n        let _e95 = (*c_2);\n        param_1 = _e95;\n        let _e96 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e96;\n    }\n    let _e98 = unnamed.uOutputTransform;\n    if (_e98 == 3i) {\n        let _e100 = (*c_2);\n        let _e102 = unnamed.uOutputExposure;\n        param_2 = (_e100 * _e102);\n        let _e104 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e104;\n    }\n    let _e105 = (*c_2);\n    param_3 = _e105;\n    let _e106 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e106;\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e98 = unnamed.uFogRange[0u];\n    let _e99 = (*dist);\n    start = min(_e98, _e99);\n    let _e101 = (*dist);\n    if (_e101 > 0f) {\n        let _e103 = start;\n        let _e104 = (*dist);\n        local = (_e103 / _e104);\n    } else {\n        local = 0f;\n    }\n    let _e106 = local;\n    before = _e106;\n    let _e107 = (*pointY);\n    let _e110 = unnamed.uFogMedium[2u];\n    let _e114 = unnamed.uFogMedium[1u];\n    t = ((_e107 - _e110) * _e114);\n    let _e116 = t;\n    let _e117 = before;\n    rest = (_e116 * (1f - _e117));\n    let _e120 = rest;\n    let _e123 = rest;\n    denom = select(_e123, 0.0001f, (abs(_e120) < 0.0001f));\n    let _e127 = unnamed.uFogMedium[0u];\n    let _e128 = t;\n    let _e130 = before;\n    let _e134 = (*dist);\n    let _e135 = start;\n    let _e138 = denom;\n    let _e143 = denom;\n    depth = ((((_e127 * exp((-(_e128) * _e130))) * (_e134 - _e135)) * (1f - exp(-(_e138)))) / _e143);\n    let _e147 = unnamed.uFogLayer2_[0u];\n    if (_e147 > 0f) {\n        let _e149 = (*pointY);\n        let _e152 = unnamed.uFogMedium[2u];\n        let _e156 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e149 - _e152) * _e156);\n        let _e158 = t2_;\n        let _e159 = before;\n        rest2_ = (_e158 * (1f - _e159));\n        let _e162 = rest2_;\n        let _e165 = rest2_;\n        denom2_ = select(_e165, 0.0001f, (abs(_e162) < 0.0001f));\n        let _e169 = unnamed.uFogLayer2_[0u];\n        let _e170 = t2_;\n        let _e172 = before;\n        let _e176 = (*dist);\n        let _e177 = start;\n        let _e180 = denom2_;\n        let _e185 = denom2_;\n        let _e187 = depth;\n        depth = (_e187 + ((((_e169 * exp((-(_e170) * _e172))) * (_e176 - _e177)) * (1f - exp(-(_e180)))) / _e185));\n    }\n    let _e189 = depth;\n    return _e189;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var wet: f32;\n    var phi_176_: bool;\n\n    let _e98 = unnamed.uFogLayer2_[3u];\n    let _e99 = (_e98 > 0f);\n    phi_176_ = _e99;\n    if _e99 {\n        let _e100 = (*dist_1);\n        let _e103 = unnamed.uFogLayer2_[3u];\n        phi_176_ = (_e100 > _e103);\n    }\n    let _e106 = phi_176_;\n    cut = _e106;\n    let _e109 = unnamed.uFogRange[2u];\n    if (_e109 == 1f) {\n        let _e113 = unnamed.uFogRange[1u];\n        let _e116 = unnamed.uFogRange[0u];\n        span = max((_e113 - _e116), 0.0001f);\n        let _e119 = cut;\n        if _e119 {\n            local_1 = 0f;\n        } else {\n            let _e120 = (*dist_1);\n            let _e123 = unnamed.uFogRange[0u];\n            let _e125 = span;\n            let _e130 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e120 - _e123) / _e125), 0f, 1f), (1f - _e130));\n        }\n        let _e133 = local_1;\n        ramp = _e133;\n        let _e135 = unnamed.uUnderwaterFactor;\n        if (_e135 <= 0f) {\n            let _e137 = ramp;\n            return _e137;\n        }\n        let _e140 = unnamed.uFogMedium[3u];\n        let _e141 = (*dist_1);\n        wetLinear = (_e140 * _e141);\n        let _e143 = ramp;\n        let _e144 = wetLinear;\n        let _e146 = wetLinear;\n        let _e152 = unnamed.uUnderwaterFactor;\n        return mix(_e143, (1f - exp2(((-(_e144) * _e146) * 1.442695f))), _e152);\n    }\n    let _e154 = cut;\n    if _e154 {\n        local_2 = 0f;\n    } else {\n        let _e155 = (*dist_1);\n        param_4 = _e155;\n        let _e156 = (*pointY_1);\n        param_5 = _e156;\n        let _e157 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        let _e162 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e157)), _e162));\n    }\n    let _e165 = local_2;\n    air = _e165;\n    let _e167 = unnamed.uUnderwaterFactor;\n    if (_e167 <= 0f) {\n        let _e169 = air;\n        return _e169;\n    }\n    let _e172 = unnamed.uFogMedium[3u];\n    let _e173 = (*dist_1);\n    wet = (_e172 * _e173);\n    let _e175 = air;\n    let _e176 = wet;\n    let _e178 = wet;\n    let _e184 = unnamed.uUnderwaterFactor;\n    return mix(_e175, (1f - exp2(((-(_e176) * _e178) * 1.442695f))), _e184);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e85 = (*p);\n    return fract((sin(dot(_e85, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n\n    let _e92 = (*p_1);\n    i = floor(_e92);\n    let _e94 = (*p_1);\n    f = fract(_e94);\n    let _e96 = f;\n    let _e97 = f;\n    let _e99 = f;\n    u = ((_e96 * _e97) * (vec2(3f) - (_e99 * 2f)));\n    let _e104 = i;\n    param_6 = _e104;\n    let _e105 = hash21_u0028_vf2_u003b((&param_6));\n    let _e106 = i;\n    param_7 = (_e106 + vec2<f32>(1f, 0f));\n    let _e108 = hash21_u0028_vf2_u003b((&param_7));\n    let _e110 = u[0u];\n    let _e112 = i;\n    param_8 = (_e112 + vec2<f32>(0f, 1f));\n    let _e114 = hash21_u0028_vf2_u003b((&param_8));\n    let _e115 = i;\n    param_9 = (_e115 + vec2<f32>(1f, 1f));\n    let _e117 = hash21_u0028_vf2_u003b((&param_9));\n    let _e119 = u[0u];\n    let _e122 = u[1u];\n    return mix(mix(_e105, _e108, _e110), mix(_e114, _e117, _e119), _e122);\n}\n\nfn main_1() {\n    var r: f32;\n    var core: f32;\n    var halo: f32;\n    var flick: f32;\n    var param_10: vec2<f32>;\n    var cool: f32;\n    var energy: f32;\n    var fog: f32;\n    var param_11: f32;\n    var param_12: f32;\n    var param_13: vec3<f32>;\n\n    let _e95 = vUv_1;\n    r = length(_e95);\n    let _e97 = r;\n    if (_e97 > 1f) {\n        discard;\n    }\n    let _e99 = r;\n    core = pow((1f - clamp(_e99, 0f, 1f)), 6f);\n    let _e103 = r;\n    halo = pow((1f - clamp(_e103, 0f, 1f)), 1.6f);\n    let _e108 = unnamed.uTime;\n    let _e110 = vSeed_1;\n    let _e113 = vSeed_1;\n    param_10 = vec2<f32>(((_e108 * 9f) + (_e110 * 13f)), _e113);\n    let _e115 = valueNoise_u0028_vf2_u003b((&param_10));\n    flick = (0.7f + (0.3f * _e115));\n    let _e118 = vAge_1;\n    let _e119 = vAge_1;\n    cool = (1f - (_e118 * _e119));\n    let _e122 = halo;\n    let _e124 = core;\n    let _e126 = unnamed.uCoreGain;\n    let _e129 = flick;\n    let _e131 = cool;\n    let _e133 = vAlpha_1;\n    energy = (((((_e122 * 0.55f) + (_e124 * _e126)) * _e129) * _e131) * _e133);\n    let _e135 = vWorldPos_1;\n    let _e137 = unnamed.uCameraPos;\n    param_11 = distance(_e135, _e137);\n    let _e140 = vWorldPos_1[1u];\n    param_12 = _e140;\n    let _e141 = mediumFog_u0028_f1_u003b_f1_u003b((&param_11), (&param_12));\n    fog = _e141;\n    let _e142 = fog;\n    let _e144 = energy;\n    energy = (_e144 * (1f - _e142));\n    let _e146 = vColor_1;\n    let _e147 = energy;\n    param_13 = (_e146 * _e147);\n    let _e149 = applyOutputTransform_u0028_vf3_u003b((&param_13));\n    outColor = vec4<f32>(_e149.x, _e149.y, _e149.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(4) vSeed: f32, @location(3) vAge: f32, @location(2) vAlpha: f32, @location(5) vWorldPos: vec3<f32>, @location(1) vColor: vec3<f32>, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vAge_1 = vAge;\n    vAlpha_1 = vAlpha;\n    vWorldPos_1 = vWorldPos;\n    vColor_1 = vColor;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SPRITE_FRAG_WGSL = "struct Uniforms {\n    uCells: vec4<f32>,\n    uFade: vec4<f32>,\n    uDepthToViewZ: vec4<f32>,\n    uViewport: vec2<f32>,\n    uCameraPos: vec3<f32>,\n    uFogEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vFrame_1: f32;\n@group(0) @binding(32) \nvar uSprite_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uSprite_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\nvar<private> vViewDepth_1: f32;\nvar<private> vAlpha_1: f32;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAge_1: f32;\nvar<private> vSeed_1: f32;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e87 = (*c);\n    low = (_e87 * 12.92f);\n    let _e89 = (*c);\n    high = ((pow(max(_e89, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e95 = high;\n    let _e96 = low;\n    let _e97 = (*c);\n    return mix(_e95, _e96, step(_e97, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e88 = (*c_1)[0u];\n    let _e90 = (*c_1)[1u];\n    let _e92 = (*c_1)[2u];\n    m = max(_e88, max(_e90, _e92));\n    let _e95 = m;\n    if (_e95 <= 0.8f) {\n        let _e97 = (*c_1);\n        return _e97;\n    }\n    let _e98 = m;\n    e = (_e98 - 0.8f);\n    let _e100 = (*c_1);\n    let _e101 = e;\n    let _e103 = e;\n    let _e107 = m;\n    return (_e100 * ((0.8f + ((0.2f * _e101) / (_e103 + 0.2f))) / _e107));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e87 = (*v);\n    let _e88 = (*v);\n    a = ((_e87 * (_e88 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e94 = (*v);\n    let _e95 = (*v);\n    b = ((_e94 * ((_e95 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e102 = a;\n    let _e103 = b;\n    return (_e102 / _e103);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e87 = unnamed.uOutputExposure;\n    let _e88 = (*x);\n    (*x) = (_e88 * _e87);\n    let _e90 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e90);\n    let _e92 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e92), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e89 = unnamed.uOutputTransform;\n    if (_e89 == 0i) {\n        let _e91 = (*c_2);\n        return _e91;\n    }\n    let _e93 = unnamed.uOutputTransform;\n    if (_e93 == 2i) {\n        let _e95 = (*c_2);\n        param_1 = _e95;\n        let _e96 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e96;\n    }\n    let _e98 = unnamed.uOutputTransform;\n    if (_e98 == 3i) {\n        let _e100 = (*c_2);\n        let _e102 = unnamed.uOutputExposure;\n        param_2 = (_e100 * _e102);\n        let _e104 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e104;\n    }\n    let _e105 = (*c_2);\n    param_3 = _e105;\n    let _e106 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e106;\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e98 = unnamed.uFogRange[0u];\n    let _e99 = (*dist);\n    start = min(_e98, _e99);\n    let _e101 = (*dist);\n    if (_e101 > 0f) {\n        let _e103 = start;\n        let _e104 = (*dist);\n        local = (_e103 / _e104);\n    } else {\n        local = 0f;\n    }\n    let _e106 = local;\n    before = _e106;\n    let _e107 = (*pointY);\n    let _e110 = unnamed.uFogMedium[2u];\n    let _e114 = unnamed.uFogMedium[1u];\n    t = ((_e107 - _e110) * _e114);\n    let _e116 = t;\n    let _e117 = before;\n    rest = (_e116 * (1f - _e117));\n    let _e120 = rest;\n    let _e123 = rest;\n    denom = select(_e123, 0.0001f, (abs(_e120) < 0.0001f));\n    let _e127 = unnamed.uFogMedium[0u];\n    let _e128 = t;\n    let _e130 = before;\n    let _e134 = (*dist);\n    let _e135 = start;\n    let _e138 = denom;\n    let _e143 = denom;\n    depth = ((((_e127 * exp((-(_e128) * _e130))) * (_e134 - _e135)) * (1f - exp(-(_e138)))) / _e143);\n    let _e147 = unnamed.uFogLayer2_[0u];\n    if (_e147 > 0f) {\n        let _e149 = (*pointY);\n        let _e152 = unnamed.uFogMedium[2u];\n        let _e156 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e149 - _e152) * _e156);\n        let _e158 = t2_;\n        let _e159 = before;\n        rest2_ = (_e158 * (1f - _e159));\n        let _e162 = rest2_;\n        let _e165 = rest2_;\n        denom2_ = select(_e165, 0.0001f, (abs(_e162) < 0.0001f));\n        let _e169 = unnamed.uFogLayer2_[0u];\n        let _e170 = t2_;\n        let _e172 = before;\n        let _e176 = (*dist);\n        let _e177 = start;\n        let _e180 = denom2_;\n        let _e185 = denom2_;\n        let _e187 = depth;\n        depth = (_e187 + ((((_e169 * exp((-(_e170) * _e172))) * (_e176 - _e177)) * (1f - exp(-(_e180)))) / _e185));\n    }\n    let _e189 = depth;\n    return _e189;\n}\n\nfn mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>, toPoint: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var span: f32;\n    var perMetre: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var hidden: f32;\n    var lobe: f32;\n    var phi_317_: bool;\n    var phi_331_: bool;\n\n    let _e95 = unnamed.uFogRange[2u];\n    let _e96 = (_e95 == 1f);\n    phi_317_ = _e96;\n    if !(_e96) {\n        let _e100 = unnamed.uFogGlow[0u];\n        let _e103 = unnamed.uFogGlow[1u];\n        let _e107 = unnamed.uFogGlow[2u];\n        phi_317_ = (max(max(_e100, _e103), _e107) <= 0f);\n    }\n    let _e111 = phi_317_;\n    if _e111 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e114 = unnamed.uFogLayer2_[3u];\n    let _e115 = (_e114 > 0f);\n    phi_331_ = _e115;\n    if _e115 {\n        let _e116 = (*dist_1);\n        let _e119 = unnamed.uFogLayer2_[3u];\n        phi_331_ = (_e116 > _e119);\n    }\n    let _e122 = phi_331_;\n    if _e122 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e123 = (*dist_1);\n    let _e126 = unnamed.uFogRange[0u];\n    let _e127 = (*dist_1);\n    span = (_e123 - min(_e126, _e127));\n    let _e130 = span;\n    if (_e130 <= 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e132 = (*dist_1);\n    param_4 = _e132;\n    let _e133 = (*pointY_1);\n    param_5 = _e133;\n    let _e134 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    let _e135 = span;\n    perMetre = (_e134 / _e135);\n    let _e137 = perMetre;\n    let _e139 = span;\n    let _e142 = unnamed.uFogGlowDir[3u];\n    hidden = (1f - exp((-(_e137) * max((_e139 - _e142), 0f))));\n    let _e148 = (*toPoint);\n    let _e150 = unnamed.uFogGlowDir;\n    let _e156 = unnamed.uFogGlow[3u];\n    lobe = pow(clamp(dot(_e148, _e150.xyz), 0f, 1f), _e156);\n    let _e159 = unnamed.uFogGlow;\n    let _e161 = lobe;\n    let _e162 = hidden;\n    let _e165 = unnamed.uUnderwaterFactor;\n    return (_e159.xyz * ((_e161 * _e162) * (1f - _e165)));\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e85 = unnamed.uFogColor;\n    let _e87 = unnamed.uUnderwaterColor;\n    let _e89 = unnamed.uUnderwaterFactor;\n    return mix(_e85, _e87, vec3(_e89));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_2: ptr<function, f32>, pointY_2: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span_1: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var wet: f32;\n    var phi_202_: bool;\n\n    let _e98 = unnamed.uFogLayer2_[3u];\n    let _e99 = (_e98 > 0f);\n    phi_202_ = _e99;\n    if _e99 {\n        let _e100 = (*dist_2);\n        let _e103 = unnamed.uFogLayer2_[3u];\n        phi_202_ = (_e100 > _e103);\n    }\n    let _e106 = phi_202_;\n    cut = _e106;\n    let _e109 = unnamed.uFogRange[2u];\n    if (_e109 == 1f) {\n        let _e113 = unnamed.uFogRange[1u];\n        let _e116 = unnamed.uFogRange[0u];\n        span_1 = max((_e113 - _e116), 0.0001f);\n        let _e119 = cut;\n        if _e119 {\n            local_1 = 0f;\n        } else {\n            let _e120 = (*dist_2);\n            let _e123 = unnamed.uFogRange[0u];\n            let _e125 = span_1;\n            let _e130 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e120 - _e123) / _e125), 0f, 1f), (1f - _e130));\n        }\n        let _e133 = local_1;\n        ramp = _e133;\n        let _e135 = unnamed.uUnderwaterFactor;\n        if (_e135 <= 0f) {\n            let _e137 = ramp;\n            return _e137;\n        }\n        let _e140 = unnamed.uFogMedium[3u];\n        let _e141 = (*dist_2);\n        wetLinear = (_e140 * _e141);\n        let _e143 = ramp;\n        let _e144 = wetLinear;\n        let _e146 = wetLinear;\n        let _e152 = unnamed.uUnderwaterFactor;\n        return mix(_e143, (1f - exp2(((-(_e144) * _e146) * 1.442695f))), _e152);\n    }\n    let _e154 = cut;\n    if _e154 {\n        local_2 = 0f;\n    } else {\n        let _e155 = (*dist_2);\n        param_6 = _e155;\n        let _e156 = (*pointY_2);\n        param_7 = _e156;\n        let _e157 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_6), (&param_7));\n        let _e162 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e157)), _e162));\n    }\n    let _e165 = local_2;\n    air = _e165;\n    let _e167 = unnamed.uUnderwaterFactor;\n    if (_e167 <= 0f) {\n        let _e169 = air;\n        return _e169;\n    }\n    let _e172 = unnamed.uFogMedium[3u];\n    let _e173 = (*dist_2);\n    wet = (_e172 * _e173);\n    let _e175 = air;\n    let _e176 = wet;\n    let _e178 = wet;\n    let _e184 = unnamed.uUnderwaterFactor;\n    return mix(_e175, (1f - exp2(((-(_e176) * _e178) * 1.442695f))), _e184);\n}\n\nfn viewZ_u0028_f1_u003b(depth_1: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e86 = (*depth_1);\n    ndc = (1f - (_e86 * 2f));\n    let _e91 = unnamed.uDepthToViewZ[0u];\n    let _e92 = ndc;\n    let _e96 = unnamed.uDepthToViewZ[1u];\n    let _e100 = unnamed.uDepthToViewZ[2u];\n    let _e101 = ndc;\n    let _e105 = unnamed.uDepthToViewZ[3u];\n    return (((_e91 * _e92) + _e96) / ((_e100 * _e101) + _e105));\n}\n\nfn cellUv_u0028_i1_u003b_vf2_u003b(cell: ptr<function, i32>, uv: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var columns: i32;\n    var rows: i32;\n    var wrapped: i32;\n    var column: i32;\n    var row: i32;\n\n    let _e93 = unnamed.uCells[0u];\n    columns = max(i32((_e93 + 0.5f)), 1i);\n    let _e99 = unnamed.uCells[1u];\n    rows = max(i32((_e99 + 0.5f)), 1i);\n    let _e103 = (*cell);\n    let _e104 = columns;\n    let _e105 = rows;\n    let _e106 = (_e104 * _e105);\n    wrapped = (_e103 - (i32(floor((f32(_e103) / f32(_e106)))) * _e106));\n    let _e114 = wrapped;\n    let _e115 = columns;\n    column = (_e114 - (i32(floor((f32(_e114) / f32(_e115)))) * _e115));\n    let _e123 = wrapped;\n    let _e124 = columns;\n    row = (_e123 / _e124);\n    let _e126 = column;\n    let _e128 = row;\n    let _e131 = (*uv);\n    let _e133 = columns;\n    let _e135 = rows;\n    return ((vec2<f32>(f32(_e126), f32(_e128)) + _e131) / vec2<f32>(f32(_e133), f32(_e135)));\n}\n\nfn main_1() {\n    var uv_1: vec2<f32>;\n    var frame: f32;\n    var first: i32;\n    var image: vec4<f32>;\n    var param_8: i32;\n    var param_9: vec2<f32>;\n    var next: vec4<f32>;\n    var param_10: i32;\n    var param_11: vec2<f32>;\n    var fade: f32;\n    var depth_2: f32;\n    var param_12: f32;\n    var alpha: f32;\n    var color: vec3<f32>;\n    var dist_3: f32;\n    var fog: f32;\n    var param_13: f32;\n    var param_14: f32;\n    var param_15: f32;\n    var param_16: f32;\n    var param_17: vec3<f32>;\n    var param_18: vec3<f32>;\n    var phi_693_: bool;\n\n    let _e107 = vUv_1[0u];\n    let _e111 = vUv_1[1u];\n    uv_1 = vec2<f32>(((_e107 * 0.5f) + 0.5f), (0.5f - (_e111 * 0.5f)));\n    let _e115 = vFrame_1;\n    frame = max(_e115, 0f);\n    let _e117 = frame;\n    first = i32(floor(_e117));\n    let _e120 = first;\n    param_8 = _e120;\n    let _e121 = uv_1;\n    param_9 = _e121;\n    let _e122 = cellUv_u0028_i1_u003b_vf2_u003b((&param_8), (&param_9));\n    let _e125 = vec3<f32>(_e122.x, _e122.y, 0f);\n    let _e131 = textureSample(uSprite_t, uSprite_s, vec2<f32>(_e125.x, _e125.y), i32(_e125.z));\n    image = _e131;\n    let _e134 = unnamed.uCells[2u];\n    if (_e134 > 0.5f) {\n        let _e136 = first;\n        param_10 = (_e136 + 1i);\n        let _e138 = uv_1;\n        param_11 = _e138;\n        let _e139 = cellUv_u0028_i1_u003b_vf2_u003b((&param_10), (&param_11));\n        let _e142 = vec3<f32>(_e139.x, _e139.y, 0f);\n        let _e148 = textureSample(uSprite_t, uSprite_s, vec2<f32>(_e142.x, _e142.y), i32(_e142.z));\n        next = _e148;\n        let _e149 = image;\n        let _e150 = next;\n        let _e151 = frame;\n        image = mix(_e149, _e150, vec4(fract(_e151)));\n    }\n    fade = 1f;\n    let _e157 = unnamed.uFade[2u];\n    let _e158 = (_e157 > 0.5f);\n    phi_693_ = _e158;\n    if _e158 {\n        let _e161 = unnamed.uFade[0u];\n        phi_693_ = (_e161 > 0f);\n    }\n    let _e164 = phi_693_;\n    if _e164 {\n        let _e165 = gl_FragCoord_1;\n        let _e168 = unnamed.uViewport;\n        let _e170 = textureSampleLevel(uDepth_t, uDepth_s, (_e165.xy / _e168), 0f);\n        depth_2 = _e170.x;\n        let _e172 = depth_2;\n        if !((_e172 <= 0f)) {\n            let _e175 = depth_2;\n            param_12 = _e175;\n            let _e176 = viewZ_u0028_f1_u003b((&param_12));\n            let _e178 = vViewDepth_1;\n            let _e182 = unnamed.uFade[0u];\n            fade = clamp(((abs(_e176) - _e178) / _e182), 0f, 1f);\n        }\n    }\n    let _e187 = unnamed.uFade[1u];\n    if (_e187 > 0f) {\n        let _e189 = vViewDepth_1;\n        let _e192 = unnamed.uFade[1u];\n        let _e195 = fade;\n        fade = (_e195 * clamp((_e189 / _e192), 0f, 1f));\n    }\n    let _e197 = vAlpha_1;\n    let _e199 = image[3u];\n    let _e201 = fade;\n    alpha = ((_e197 * _e199) * _e201);\n    let _e203 = alpha;\n    if (_e203 <= 0.001f) {\n        discard;\n    }\n    let _e205 = vColor_1;\n    let _e206 = image;\n    color = (_e205 * _e206.xyz);\n    let _e210 = unnamed.uFogEnabled;\n    if (_e210 != 0i) {\n        let _e212 = vWorldPos_1;\n        let _e214 = unnamed.uCameraPos;\n        dist_3 = distance(_e212, _e214);\n        let _e216 = dist_3;\n        param_13 = _e216;\n        let _e218 = vWorldPos_1[1u];\n        param_14 = _e218;\n        let _e219 = mediumFog_u0028_f1_u003b_f1_u003b((&param_13), (&param_14));\n        fog = _e219;\n        let _e220 = color;\n        let _e221 = mediumColor_u0028_();\n        let _e222 = fog;\n        let _e225 = vWorldPos_1;\n        let _e227 = unnamed.uCameraPos;\n        let _e230 = dist_3;\n        param_15 = _e230;\n        let _e232 = vWorldPos_1[1u];\n        param_16 = _e232;\n        param_17 = normalize((_e225 - _e227));\n        let _e233 = mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_15), (&param_16), (&param_17));\n        color = (mix(_e220, _e221, vec3(_e222)) + _e233);\n    }\n    let _e235 = color;\n    param_18 = _e235;\n    let _e236 = applyOutputTransform_u0028_vf3_u003b((&param_18));\n    let _e237 = alpha;\n    outColor = vec4<f32>(_e236.x, _e236.y, _e236.z, _e237);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(7) vFrame: f32, @builtin(position) gl_FragCoord: vec4<f32>, @location(8) vViewDepth: f32, @location(2) vAlpha: f32, @location(1) vColor: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(3) vAge: f32, @location(4) vSeed: f32, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vFrame_1 = vFrame;\n    gl_FragCoord_1 = gl_FragCoord;\n    vViewDepth_1 = vViewDepth;\n    vAlpha_1 = vAlpha;\n    vColor_1 = vColor;\n    vWorldPos_1 = vWorldPos;\n    vAge_1 = vAge;\n    vSeed_1 = vSeed;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e21 = outColor;\n    return _e21;\n}\n";

export const PARTICLE_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uStretchSec: f32,\n    uCameraFacing: f32,\n    uCameraOffset: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(7) member_1: f32,\n    @location(1) member_2: vec3<f32>,\n    @location(2) member_3: f32,\n    @location(3) member_4: f32,\n    @location(4) member_5: f32,\n    @location(5) member_6: vec3<f32>,\n    @location(6) member_7: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(8) member_8: f32,\n}\n\nvar<private> aSpin_1: f32;\nvar<private> aCorner_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPos_1: vec3<f32>;\nvar<private> aVelocity_1: vec3<f32>;\nvar<private> aBlade_1: f32;\nvar<private> aSize_1: f32;\nvar<private> aSprite_1: vec2<f32>;\nvar<private> vUv: vec2<f32>;\nvar<private> vFrame: f32;\nvar<private> vColor: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vAlpha: f32;\nvar<private> aAlpha_1: f32;\nvar<private> vAge: f32;\nvar<private> aAge_1: f32;\nvar<private> vSeed: f32;\nvar<private> aSeed_1: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vViewDepth: f32;\n\nfn main_1() {\n    var s: f32;\n    var c: f32;\n    var rolled: vec2<f32>;\n    var viewer: vec3<f32>;\n    var alongView: vec3<f32>;\n    var up: vec3<f32>;\n    var across: vec3<f32>;\n    var bladeGain: f32;\n    var toCamera: vec3<f32>;\n    var reference: vec3<f32>;\n    var offset: vec3<f32>;\n    var extent: vec2<f32>;\n    var turned: vec2<f32>;\n    var travel: vec3<f32>;\n    var along: f32;\n    var world: vec3<f32>;\n    var face: vec3<f32>;\n    var toEye: vec3<f32>;\n    var local: vec3<f32>;\n    var phi_84_: bool;\n\n    let _e60 = aSpin_1;\n    s = sin(_e60);\n    let _e62 = aSpin_1;\n    c = cos(_e62);\n    let _e65 = aCorner_1[0u];\n    let _e66 = c;\n    let _e69 = aCorner_1[1u];\n    let _e70 = s;\n    let _e74 = aCorner_1[0u];\n    let _e75 = s;\n    let _e78 = aCorner_1[1u];\n    let _e79 = c;\n    rolled = vec2<f32>(((_e65 * _e66) - (_e69 * _e70)), ((_e74 * _e75) + (_e78 * _e79)));\n    let _e84 = unnamed.uCameraPos;\n    let _e85 = aPos_1;\n    viewer = normalize((_e84 - _e85));\n    let _e88 = aVelocity_1;\n    let _e89 = viewer;\n    let _e90 = aVelocity_1;\n    let _e91 = viewer;\n    alongView = (_e88 - (_e89 * dot(_e90, _e91)));\n    let _e96 = unnamed.uCameraFacing;\n    let _e97 = (_e96 > 1.5f);\n    phi_84_ = _e97;\n    if _e97 {\n        let _e98 = alongView;\n        let _e99 = alongView;\n        phi_84_ = (dot(_e98, _e99) > 0.0000000001f);\n    }\n    let _e103 = phi_84_;\n    if _e103 {\n        let _e104 = alongView;\n        up = normalize(_e104);\n        let _e106 = up;\n        let _e107 = viewer;\n        across = cross(_e106, _e107);\n        let _e109 = aBlade_1;\n        bladeGain = select(0f, 1f, (_e109 < 0.5f));\n    } else {\n        let _e113 = unnamed.uCameraFacing;\n        if (_e113 > 0.5f) {\n            let _e116 = unnamed.uCameraPos;\n            let _e117 = aPos_1;\n            toCamera = normalize((_e116 - _e117));\n            let _e121 = toCamera[1u];\n            reference = select(vec3<f32>(0f, 1f, 0f), vec3<f32>(0f, 0f, 1f), vec3((abs(_e121) > 0.999f)));\n            let _e126 = reference;\n            let _e127 = toCamera;\n            across = normalize(cross(_e126, _e127));\n            let _e130 = toCamera;\n            let _e131 = across;\n            up = cross(_e130, _e131);\n            let _e133 = aBlade_1;\n            bladeGain = select(0f, 1f, (_e133 < 0.5f));\n        } else {\n            let _e136 = aBlade_1;\n            across = select(vec3<f32>(0f, 0f, 1f), vec3<f32>(1f, 0f, 0f), vec3((_e136 < 0.5f)));\n            up = vec3<f32>(0f, 1f, 0f);\n            bladeGain = 1f;\n        }\n    }\n    let _e140 = across;\n    let _e142 = rolled[0u];\n    let _e144 = up;\n    let _e146 = rolled[1u];\n    let _e149 = aSize_1;\n    offset = (((_e140 * _e142) + (_e144 * _e146)) * _e149);\n    let _e152 = aSprite_1[1u];\n    if (_e152 > 0f) {\n        let _e155 = aCorner_1[0u];\n        let _e156 = aSize_1;\n        let _e159 = aCorner_1[1u];\n        let _e161 = aSprite_1[1u];\n        extent = vec2<f32>((_e155 * _e156), (_e159 * _e161));\n        let _e165 = extent[0u];\n        let _e166 = c;\n        let _e169 = extent[1u];\n        let _e170 = s;\n        let _e174 = extent[0u];\n        let _e175 = s;\n        let _e178 = extent[1u];\n        let _e179 = c;\n        turned = vec2<f32>(((_e165 * _e166) - (_e169 * _e170)), ((_e174 * _e175) + (_e178 * _e179)));\n        let _e183 = across;\n        let _e185 = turned[0u];\n        let _e187 = up;\n        let _e189 = turned[1u];\n        offset = ((_e183 * _e185) + (_e187 * _e189));\n    }\n    let _e193 = unnamed.uStretchSec;\n    if (_e193 > 0f) {\n        let _e195 = aVelocity_1;\n        let _e197 = unnamed.uStretchSec;\n        travel = (_e195 * _e197);\n        let _e199 = offset;\n        let _e202 = travel;\n        along = dot(normalize((_e199 + vec3<f32>(0.000001f, 0.000001f, 0.000001f))), normalize((_e202 + vec3<f32>(0.000001f, 0.000001f, 0.000001f))));\n        let _e206 = travel;\n        let _e207 = along;\n        let _e210 = offset;\n        offset = (_e210 + ((_e206 * _e207) * 0.5f));\n    }\n    let _e212 = aPos_1;\n    let _e213 = offset;\n    let _e214 = bladeGain;\n    world = (_e212 + (_e213 * _e214));\n    let _e217 = viewer;\n    let _e219 = unnamed.uCameraOffset;\n    let _e221 = bladeGain;\n    let _e223 = world;\n    world = (_e223 + ((_e217 * _e219) * _e221));\n    let _e225 = aCorner_1;\n    vUv = _e225;\n    let _e227 = aSprite_1[0u];\n    vFrame = _e227;\n    let _e228 = aColor_1;\n    vColor = _e228;\n    let _e229 = aAlpha_1;\n    vAlpha = _e229;\n    let _e230 = aAge_1;\n    vAge = _e230;\n    let _e231 = aSeed_1;\n    vSeed = _e231;\n    let _e232 = world;\n    vWorldPos = _e232;\n    let _e233 = across;\n    let _e234 = up;\n    face = cross(_e233, _e234);\n    let _e237 = unnamed.uCameraPos;\n    let _e238 = world;\n    toEye = normalize((_e237 - _e238));\n    let _e241 = face;\n    let _e242 = toEye;\n    if (dot(_e241, _e242) < 0f) {\n        let _e245 = face;\n        local = -(_e245);\n    } else {\n        let _e247 = face;\n        local = _e247;\n    }\n    let _e248 = local;\n    vNormal = _e248;\n    let _e250 = unnamed.uViewProj;\n    let _e251 = world;\n    unnamed_1.gl_Position = (_e250 * vec4<f32>(_e251.x, _e251.y, _e251.z, 1f));\n    let _e260 = unnamed_1.gl_Position[3u];\n    vViewDepth = _e260;\n    return;\n}\n\n@vertex \nfn main(@location(4) aSpin: f32, @location(0) aCorner: vec2<f32>, @location(2) aPos: vec3<f32>, @location(9) aVelocity: vec3<f32>, @location(1) aBlade: f32, @location(3) aSize: f32, @location(10) aSprite: vec2<f32>, @location(5) aColor: vec3<f32>, @location(6) aAlpha: f32, @location(7) aAge: f32, @location(8) aSeed: f32) -> VertexOutput {\n    aSpin_1 = aSpin;\n    aCorner_1 = aCorner;\n    aPos_1 = aPos;\n    aVelocity_1 = aVelocity;\n    aBlade_1 = aBlade;\n    aSize_1 = aSize;\n    aSprite_1 = aSprite;\n    aColor_1 = aColor;\n    aAlpha_1 = aAlpha;\n    aAge_1 = aAge;\n    aSeed_1 = aSeed;\n    main_1();\n    let _e34 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e34);\n    let _e36 = vUv;\n    let _e37 = vFrame;\n    let _e38 = vColor;\n    let _e39 = vAlpha;\n    let _e40 = vAge;\n    let _e41 = vSeed;\n    let _e42 = vWorldPos;\n    let _e43 = vNormal;\n    let _e44 = unnamed_1.gl_Position;\n    let _e45 = vViewDepth;\n    return VertexOutput(_e36, _e37, _e38, _e39, _e40, _e41, _e42, _e43, _e44, _e45);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const PARTICLE_BINDINGS = {
  "PARTICLE_MOTE_FRAG": {
    "uniforms": 1,
    "uniformSize": 144,
    "fields": {
      "uCameraPos": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uFogEnabled": {
        "offset": 12,
        "size": 4,
        "type": "int"
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
      "uOutputTransform": {
        "offset": 128,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 132,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PARTICLE_SMOKE_FRAG": {
    "uniforms": 1,
    "uniformSize": 1248,
    "fields": {
      "uTime": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uDirectionalDir": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uDirectionalColor": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uAmbient": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uNoiseOctaves": {
        "offset": 76,
        "size": 4,
        "type": "int"
      },
      "uErosion": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uLightCount": {
        "offset": 84,
        "size": 4,
        "type": "int"
      },
      "uLightPos": {
        "offset": 96,
        "size": 256,
        "type": "vec3",
        "length": 16,
        "stride": 16
      },
      "uLightColor": {
        "offset": 352,
        "size": 256,
        "type": "vec3",
        "length": 16,
        "stride": 16
      },
      "uLightRadius": {
        "offset": 608,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLightWeight": {
        "offset": 864,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uFogColor": {
        "offset": 1120,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 1136,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 1152,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 1168,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 1180,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 1184,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 1200,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 1216,
        "size": 16,
        "type": "vec4"
      },
      "uOutputTransform": {
        "offset": 1232,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 1236,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PARTICLE_SPARK_FRAG": {
    "uniforms": 1,
    "uniformSize": 160,
    "fields": {
      "uTime": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uCoreGain": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 48,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 64,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 112,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 128,
        "size": 16,
        "type": "vec4"
      },
      "uOutputTransform": {
        "offset": 144,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 148,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PARTICLE_SPRITE_FRAG": {
    "uniforms": 1,
    "uniformSize": 208,
    "fields": {
      "uCells": {
        "offset": 0,
        "size": 16,
        "type": "vec4"
      },
      "uFade": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      },
      "uDepthToViewZ": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uViewport": {
        "offset": 48,
        "size": 8,
        "type": "vec2"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uFogEnabled": {
        "offset": 76,
        "size": 4,
        "type": "int"
      },
      "uFogColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 112,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 144,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 160,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 176,
        "size": 16,
        "type": "vec4"
      },
      "uOutputTransform": {
        "offset": 192,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 196,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSprite": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2DArray"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      }
    }
  },
  "PARTICLE_VERT": {
    "uniforms": 0,
    "uniformSize": 96,
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
      "uStretchSec": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uCameraFacing": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uCameraOffset": {
        "offset": 84,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
