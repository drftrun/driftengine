/*
 * Generated from ../particle.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const PARTICLE_MOTE_FRAG_WGSL = "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uFogEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vAlpha_1: f32;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAge_1: f32;\nvar<private> vSeed_1: f32;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e72 = (*c);\n    low = (_e72 * 12.92f);\n    let _e74 = (*c);\n    high = ((pow(max(_e74, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e80 = high;\n    let _e81 = low;\n    let _e82 = (*c);\n    return mix(_e80, _e81, step(_e82, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e72 = (*v);\n    let _e73 = (*v);\n    a = ((_e72 * (_e73 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e79 = (*v);\n    let _e80 = (*v);\n    b = ((_e79 * ((_e80 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e87 = a;\n    let _e88 = b;\n    return (_e87 / _e88);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e72 = unnamed.uOutputExposure;\n    let _e73 = (*x);\n    (*x) = (_e73 * _e72);\n    let _e75 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e75);\n    let _e77 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e77), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n\n    let _e73 = unnamed.uOutputTransform;\n    if (_e73 == 0i) {\n        let _e75 = (*c_1);\n        return _e75;\n    }\n    let _e77 = unnamed.uOutputTransform;\n    if (_e77 == 2i) {\n        let _e79 = (*c_1);\n        param_1 = _e79;\n        let _e80 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_1) = _e80;\n    }\n    let _e81 = (*c_1);\n    param_2 = _e81;\n    let _e82 = linearToSrgb_u0028_vf3_u003b((&param_2));\n    return _e82;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e70 = unnamed.uFogColor;\n    let _e72 = unnamed.uUnderwaterColor;\n    let _e74 = unnamed.uUnderwaterFactor;\n    return mix(_e70, _e72, vec3(_e74));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e79 = unnamed.uFogMode;\n    if (_e79 == 1i) {\n        let _e82 = unnamed.uFogFar;\n        let _e84 = unnamed.uFogNear;\n        span = max((_e82 - _e84), 0.0001f);\n        let _e87 = (*dist);\n        let _e89 = unnamed.uFogNear;\n        let _e91 = span;\n        ramp = clamp(((_e87 - _e89) / _e91), 0f, 1f);\n        let _e95 = unnamed.uUnderwaterFactor;\n        if (_e95 <= 0f) {\n            let _e97 = ramp;\n            return _e97;\n        }\n        let _e99 = unnamed.uUnderwaterFogDensity;\n        let _e100 = (*dist);\n        wetLinear = (_e99 * _e100);\n        let _e102 = ramp;\n        let _e103 = wetLinear;\n        let _e105 = wetLinear;\n        let _e111 = unnamed.uUnderwaterFactor;\n        return mix(_e102, (1f - exp2(((-(_e103) * _e105) * 1.442695f))), _e111);\n    }\n    let _e113 = (*pointY);\n    let _e115 = unnamed.uFogEyeY;\n    let _e118 = unnamed.uFogHeightFalloff;\n    t = ((_e113 - _e115) * _e118);\n    let _e120 = t;\n    let _e123 = t;\n    denom = select(_e123, 0.0001f, (abs(_e120) < 0.0001f));\n    let _e126 = unnamed.uFogDensity;\n    let _e128 = (*dist);\n    let _e130 = denom;\n    let _e135 = denom;\n    air = (1f - exp((((-(_e126) * _e128) * (1f - exp(-(_e130)))) / _e135)));\n    let _e140 = unnamed.uUnderwaterFactor;\n    if (_e140 <= 0f) {\n        let _e142 = air;\n        return _e142;\n    }\n    let _e144 = unnamed.uUnderwaterFogDensity;\n    let _e145 = (*dist);\n    wet = (_e144 * _e145);\n    let _e147 = air;\n    let _e148 = wet;\n    let _e150 = wet;\n    let _e156 = unnamed.uUnderwaterFactor;\n    return mix(_e147, (1f - exp2(((-(_e148) * _e150) * 1.442695f))), _e156);\n}\n\nfn main_1() {\n    var r: f32;\n    var body: f32;\n    var alpha: f32;\n    var color: vec3<f32>;\n    var fog: f32;\n    var param_3: f32;\n    var param_4: f32;\n    var param_5: vec3<f32>;\n\n    let _e77 = vUv_1;\n    r = length(_e77);\n    let _e79 = r;\n    body = (1f - smoothstep(0.4f, 1f, _e79));\n    let _e82 = body;\n    if (_e82 <= 0f) {\n        discard;\n    }\n    let _e84 = body;\n    let _e85 = body;\n    let _e87 = vAlpha_1;\n    alpha = ((_e84 * _e85) * _e87);\n    let _e89 = alpha;\n    if (_e89 <= 0.002f) {\n        discard;\n    }\n    let _e91 = vColor_1;\n    color = _e91;\n    let _e93 = unnamed.uFogEnabled;\n    if (_e93 != 0i) {\n        let _e95 = vWorldPos_1;\n        let _e97 = unnamed.uCameraPos;\n        param_3 = distance(_e95, _e97);\n        let _e100 = vWorldPos_1[1u];\n        param_4 = _e100;\n        let _e101 = mediumFog_u0028_f1_u003b_f1_u003b((&param_3), (&param_4));\n        fog = _e101;\n        let _e102 = color;\n        let _e103 = mediumColor_u0028_();\n        let _e104 = fog;\n        color = mix(_e102, _e103, vec3(_e104));\n    }\n    let _e107 = color;\n    param_5 = _e107;\n    let _e108 = applyOutputTransform_u0028_vf3_u003b((&param_5));\n    let _e109 = alpha;\n    outColor = vec4<f32>(_e108.x, _e108.y, _e108.z, _e109);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(2) vAlpha: f32, @location(1) vColor: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(3) vAge: f32, @location(4) vSeed: f32, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vAlpha_1 = vAlpha;\n    vColor_1 = vColor;\n    vWorldPos_1 = vWorldPos;\n    vAge_1 = vAge;\n    vSeed_1 = vSeed;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SMOKE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uCameraPos: vec3<f32>,\n    uNoiseOctaves: i32,\n    uErosion: f32,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vAge_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAlpha_1: f32;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e107 = (*c);\n    low = (_e107 * 12.92f);\n    let _e109 = (*c);\n    high = ((pow(max(_e109, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e115 = high;\n    let _e116 = low;\n    let _e117 = (*c);\n    return mix(_e115, _e116, step(_e117, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e107 = (*v);\n    let _e108 = (*v);\n    a = ((_e107 * (_e108 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e114 = (*v);\n    let _e115 = (*v);\n    b = ((_e114 * ((_e115 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e122 = a;\n    let _e123 = b;\n    return (_e122 / _e123);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e107 = unnamed.uOutputExposure;\n    let _e108 = (*x);\n    (*x) = (_e108 * _e107);\n    let _e110 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e110);\n    let _e112 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e112), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n\n    let _e108 = unnamed.uOutputTransform;\n    if (_e108 == 0i) {\n        let _e110 = (*c_1);\n        return _e110;\n    }\n    let _e112 = unnamed.uOutputTransform;\n    if (_e112 == 2i) {\n        let _e114 = (*c_1);\n        param_1 = _e114;\n        let _e115 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_1) = _e115;\n    }\n    let _e116 = (*c_1);\n    param_2 = _e116;\n    let _e117 = linearToSrgb_u0028_vf3_u003b((&param_2));\n    return _e117;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e105 = unnamed.uFogColor;\n    let _e107 = unnamed.uUnderwaterColor;\n    let _e109 = unnamed.uUnderwaterFactor;\n    return mix(_e105, _e107, vec3(_e109));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e114 = unnamed.uFogMode;\n    if (_e114 == 1i) {\n        let _e117 = unnamed.uFogFar;\n        let _e119 = unnamed.uFogNear;\n        span = max((_e117 - _e119), 0.0001f);\n        let _e122 = (*dist);\n        let _e124 = unnamed.uFogNear;\n        let _e126 = span;\n        ramp = clamp(((_e122 - _e124) / _e126), 0f, 1f);\n        let _e130 = unnamed.uUnderwaterFactor;\n        if (_e130 <= 0f) {\n            let _e132 = ramp;\n            return _e132;\n        }\n        let _e134 = unnamed.uUnderwaterFogDensity;\n        let _e135 = (*dist);\n        wetLinear = (_e134 * _e135);\n        let _e137 = ramp;\n        let _e138 = wetLinear;\n        let _e140 = wetLinear;\n        let _e146 = unnamed.uUnderwaterFactor;\n        return mix(_e137, (1f - exp2(((-(_e138) * _e140) * 1.442695f))), _e146);\n    }\n    let _e148 = (*pointY);\n    let _e150 = unnamed.uFogEyeY;\n    let _e153 = unnamed.uFogHeightFalloff;\n    t = ((_e148 - _e150) * _e153);\n    let _e155 = t;\n    let _e158 = t;\n    denom = select(_e158, 0.0001f, (abs(_e155) < 0.0001f));\n    let _e161 = unnamed.uFogDensity;\n    let _e163 = (*dist);\n    let _e165 = denom;\n    let _e170 = denom;\n    air = (1f - exp((((-(_e161) * _e163) * (1f - exp(-(_e165)))) / _e170)));\n    let _e175 = unnamed.uUnderwaterFactor;\n    if (_e175 <= 0f) {\n        let _e177 = air;\n        return _e177;\n    }\n    let _e179 = unnamed.uUnderwaterFogDensity;\n    let _e180 = (*dist);\n    wet = (_e179 * _e180);\n    let _e182 = air;\n    let _e183 = wet;\n    let _e185 = wet;\n    let _e191 = unnamed.uUnderwaterFactor;\n    return mix(_e182, (1f - exp2(((-(_e183) * _e185) * 1.442695f))), _e191);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e105 = (*p);\n    return fract((sin(dot(_e105, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_3: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n\n    let _e112 = (*p_1);\n    i = floor(_e112);\n    let _e114 = (*p_1);\n    f = fract(_e114);\n    let _e116 = f;\n    let _e117 = f;\n    let _e119 = f;\n    u = ((_e116 * _e117) * (vec2(3f) - (_e119 * 2f)));\n    let _e124 = i;\n    param_3 = _e124;\n    let _e125 = hash21_u0028_vf2_u003b((&param_3));\n    let _e126 = i;\n    param_4 = (_e126 + vec2<f32>(1f, 0f));\n    let _e128 = hash21_u0028_vf2_u003b((&param_4));\n    let _e130 = u[0u];\n    let _e132 = i;\n    param_5 = (_e132 + vec2<f32>(0f, 1f));\n    let _e134 = hash21_u0028_vf2_u003b((&param_5));\n    let _e135 = i;\n    param_6 = (_e135 + vec2<f32>(1f, 1f));\n    let _e137 = hash21_u0028_vf2_u003b((&param_6));\n    let _e139 = u[0u];\n    let _e142 = u[1u];\n    return mix(mix(_e125, _e128, _e130), mix(_e134, _e137, _e139), _e142);\n}\n\nfn billow_u0028_vf2_u003b_f1_u003b_i1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>, octaves: ptr<function, i32>) -> f32 {\n    var v_1: f32;\n    var param_7: vec2<f32>;\n    var param_8: vec2<f32>;\n\n    let _e110 = (*p_2);\n    let _e112 = (*t_1);\n    param_7 = ((_e110 * 2.4f) + vec2<f32>(0f, (-(_e112) * 0.5f)));\n    let _e117 = valueNoise_u0028_vf2_u003b((&param_7));\n    v_1 = (_e117 * 0.62f);\n    let _e119 = (*octaves);\n    if (_e119 == 1i) {\n        let _e121 = v_1;\n        return (_e121 / 0.62f);\n    }\n    let _e123 = (*p_2);\n    let _e125 = (*t_1);\n    let _e127 = (*t_1);\n    param_8 = ((_e123 * 5.1f) + vec2<f32>((_e125 * 0.15f), (-(_e127) * 0.8f)));\n    let _e132 = valueNoise_u0028_vf2_u003b((&param_8));\n    let _e134 = v_1;\n    v_1 = (_e134 + (_e132 * 0.38f));\n    let _e136 = v_1;\n    return (_e136 / 1f);\n}\n\nfn main_1() {\n    var r: f32;\n    var body: f32;\n    var t_2: f32;\n    var n: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var param_11: i32;\n    var erode: f32;\n    var mask: f32;\n    var n3_: vec3<f32>;\n    var ndl: f32;\n    var lit: vec3<f32>;\n    var i_1: i32;\n    var toLight: vec3<f32>;\n    var dist_1: f32;\n    var radius: f32;\n    var falloff: f32;\n    var wrapped: f32;\n    var shaded: vec3<f32>;\n    var fog: f32;\n    var param_12: f32;\n    var param_13: f32;\n    var param_14: vec3<f32>;\n\n    let _e127 = vUv_1;\n    r = length(_e127);\n    let _e129 = r;\n    body = (1f - smoothstep(0.35f, 1f, _e129));\n    let _e132 = body;\n    if (_e132 <= 0f) {\n        discard;\n    }\n    let _e135 = unnamed.uTime;\n    let _e137 = vSeed_1;\n    t_2 = ((_e135 * 0.55f) + (_e137 * 7.31f));\n    let _e140 = vUv_1;\n    let _e141 = vAge_1;\n    let _e145 = vSeed_1;\n    param_9 = ((_e140 * (0.9f + (_e141 * 1.4f))) + vec2<f32>((_e145 * 3.7f), 0f));\n    let _e149 = t_2;\n    param_10 = _e149;\n    let _e151 = unnamed.uNoiseOctaves;\n    param_11 = _e151;\n    let _e152 = billow_u0028_vf2_u003b_f1_u003b_i1_u003b((&param_9), (&param_10), (&param_11));\n    n = _e152;\n    let _e153 = n;\n    let _e155 = unnamed.uErosion;\n    let _e156 = vAge_1;\n    erode = mix(1f, _e153, (_e155 * (0.35f + (_e156 * 0.65f))));\n    let _e161 = body;\n    let _e162 = erode;\n    mask = clamp((_e161 * _e162), 0f, 1f);\n    let _e165 = mask;\n    let _e167 = mask;\n    mask = (_e167 * smoothstep(0f, 0.25f, _e165));\n    let _e169 = mask;\n    if (_e169 <= 0.002f) {\n        discard;\n    }\n    let _e171 = vNormal_1;\n    n3_ = normalize(_e171);\n    let _e173 = n3_;\n    let _e175 = unnamed.uDirectionalDir;\n    ndl = ((dot(_e173, _e175) * 0.5f) + 0.5f);\n    let _e180 = unnamed.uAmbient;\n    let _e182 = unnamed.uDirectionalColor;\n    let _e183 = ndl;\n    lit = (_e180 + (_e182 * _e183));\n    i_1 = 0i;\n    loop {\n        let _e186 = i_1;\n        if (_e186 < 16i) {\n            let _e188 = i_1;\n            let _e190 = unnamed.uLightCount;\n            if (_e188 >= _e190) {\n                break;\n            }\n            let _e192 = i_1;\n            let _e195 = unnamed.uLightPos[_e192];\n            let _e196 = vWorldPos_1;\n            toLight = (_e195 - _e196);\n            let _e198 = toLight;\n            dist_1 = length(_e198);\n            let _e200 = i_1;\n            let _e204 = unnamed.uLightRadius[_e200][0u];\n            radius = _e204;\n            let _e205 = radius;\n            let _e207 = dist_1;\n            let _e208 = radius;\n            if ((_e205 <= 0f) || (_e207 >= _e208)) {\n                continue;\n            }\n            let _e211 = dist_1;\n            let _e212 = radius;\n            falloff = (1f - (_e211 / _e212));\n            let _e215 = n3_;\n            let _e216 = toLight;\n            let _e217 = dist_1;\n            wrapped = ((dot(_e215, (_e216 / vec3(max(_e217, 0.0001f)))) * 0.5f) + 0.5f);\n            let _e224 = i_1;\n            let _e227 = unnamed.uLightColor[_e224];\n            let _e228 = falloff;\n            let _e230 = falloff;\n            let _e232 = wrapped;\n            let _e234 = i_1;\n            let _e238 = unnamed.uLightWeight[_e234][0u];\n            let _e240 = lit;\n            lit = (_e240 + ((((_e227 * _e228) * _e230) * _e232) * _e238));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e242 = i_1;\n            i_1 = (_e242 + 1i);\n        }\n    }\n    let _e244 = vColor_1;\n    let _e245 = lit;\n    shaded = (_e244 * _e245);\n    let _e247 = vWorldPos_1;\n    let _e249 = unnamed.uCameraPos;\n    param_12 = distance(_e247, _e249);\n    let _e252 = vWorldPos_1[1u];\n    param_13 = _e252;\n    let _e253 = mediumFog_u0028_f1_u003b_f1_u003b((&param_12), (&param_13));\n    fog = _e253;\n    let _e254 = shaded;\n    let _e255 = mediumColor_u0028_();\n    let _e256 = fog;\n    param_14 = mix(_e254, _e255, vec3(_e256));\n    let _e259 = applyOutputTransform_u0028_vf3_u003b((&param_14));\n    let _e260 = mask;\n    let _e261 = vAlpha_1;\n    outColor = vec4<f32>(_e259.x, _e259.y, _e259.z, (_e260 * _e261));\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(4) vSeed: f32, @location(3) vAge: f32, @location(6) vNormal: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(1) vColor: vec3<f32>, @location(2) vAlpha: f32) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vAge_1 = vAge;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vColor_1 = vColor;\n    vAlpha_1 = vAlpha;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SPARK_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uCameraPos: vec3<f32>,\n    uCoreGain: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vAge_1: f32;\nvar<private> vAlpha_1: f32;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e86 = (*c);\n    low = (_e86 * 12.92f);\n    let _e88 = (*c);\n    high = ((pow(max(_e88, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e94 = high;\n    let _e95 = low;\n    let _e96 = (*c);\n    return mix(_e94, _e95, step(_e96, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e86 = (*v);\n    let _e87 = (*v);\n    a = ((_e86 * (_e87 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e93 = (*v);\n    let _e94 = (*v);\n    b = ((_e93 * ((_e94 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e101 = a;\n    let _e102 = b;\n    return (_e101 / _e102);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e86 = unnamed.uOutputExposure;\n    let _e87 = (*x);\n    (*x) = (_e87 * _e86);\n    let _e89 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e89);\n    let _e91 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e91), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n\n    let _e87 = unnamed.uOutputTransform;\n    if (_e87 == 0i) {\n        let _e89 = (*c_1);\n        return _e89;\n    }\n    let _e91 = unnamed.uOutputTransform;\n    if (_e91 == 2i) {\n        let _e93 = (*c_1);\n        param_1 = _e93;\n        let _e94 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_1) = _e94;\n    }\n    let _e95 = (*c_1);\n    param_2 = _e95;\n    let _e96 = linearToSrgb_u0028_vf3_u003b((&param_2));\n    return _e96;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e93 = unnamed.uFogMode;\n    if (_e93 == 1i) {\n        let _e96 = unnamed.uFogFar;\n        let _e98 = unnamed.uFogNear;\n        span = max((_e96 - _e98), 0.0001f);\n        let _e101 = (*dist);\n        let _e103 = unnamed.uFogNear;\n        let _e105 = span;\n        ramp = clamp(((_e101 - _e103) / _e105), 0f, 1f);\n        let _e109 = unnamed.uUnderwaterFactor;\n        if (_e109 <= 0f) {\n            let _e111 = ramp;\n            return _e111;\n        }\n        let _e113 = unnamed.uUnderwaterFogDensity;\n        let _e114 = (*dist);\n        wetLinear = (_e113 * _e114);\n        let _e116 = ramp;\n        let _e117 = wetLinear;\n        let _e119 = wetLinear;\n        let _e125 = unnamed.uUnderwaterFactor;\n        return mix(_e116, (1f - exp2(((-(_e117) * _e119) * 1.442695f))), _e125);\n    }\n    let _e127 = (*pointY);\n    let _e129 = unnamed.uFogEyeY;\n    let _e132 = unnamed.uFogHeightFalloff;\n    t = ((_e127 - _e129) * _e132);\n    let _e134 = t;\n    let _e137 = t;\n    denom = select(_e137, 0.0001f, (abs(_e134) < 0.0001f));\n    let _e140 = unnamed.uFogDensity;\n    let _e142 = (*dist);\n    let _e144 = denom;\n    let _e149 = denom;\n    air = (1f - exp((((-(_e140) * _e142) * (1f - exp(-(_e144)))) / _e149)));\n    let _e154 = unnamed.uUnderwaterFactor;\n    if (_e154 <= 0f) {\n        let _e156 = air;\n        return _e156;\n    }\n    let _e158 = unnamed.uUnderwaterFogDensity;\n    let _e159 = (*dist);\n    wet = (_e158 * _e159);\n    let _e161 = air;\n    let _e162 = wet;\n    let _e164 = wet;\n    let _e170 = unnamed.uUnderwaterFactor;\n    return mix(_e161, (1f - exp2(((-(_e162) * _e164) * 1.442695f))), _e170);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e84 = (*p);\n    return fract((sin(dot(_e84, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_3: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n\n    let _e91 = (*p_1);\n    i = floor(_e91);\n    let _e93 = (*p_1);\n    f = fract(_e93);\n    let _e95 = f;\n    let _e96 = f;\n    let _e98 = f;\n    u = ((_e95 * _e96) * (vec2(3f) - (_e98 * 2f)));\n    let _e103 = i;\n    param_3 = _e103;\n    let _e104 = hash21_u0028_vf2_u003b((&param_3));\n    let _e105 = i;\n    param_4 = (_e105 + vec2<f32>(1f, 0f));\n    let _e107 = hash21_u0028_vf2_u003b((&param_4));\n    let _e109 = u[0u];\n    let _e111 = i;\n    param_5 = (_e111 + vec2<f32>(0f, 1f));\n    let _e113 = hash21_u0028_vf2_u003b((&param_5));\n    let _e114 = i;\n    param_6 = (_e114 + vec2<f32>(1f, 1f));\n    let _e116 = hash21_u0028_vf2_u003b((&param_6));\n    let _e118 = u[0u];\n    let _e121 = u[1u];\n    return mix(mix(_e104, _e107, _e109), mix(_e113, _e116, _e118), _e121);\n}\n\nfn main_1() {\n    var r: f32;\n    var core: f32;\n    var halo: f32;\n    var flick: f32;\n    var param_7: vec2<f32>;\n    var cool: f32;\n    var energy: f32;\n    var fog: f32;\n    var param_8: f32;\n    var param_9: f32;\n    var param_10: vec3<f32>;\n\n    let _e94 = vUv_1;\n    r = length(_e94);\n    let _e96 = r;\n    if (_e96 > 1f) {\n        discard;\n    }\n    let _e98 = r;\n    core = pow((1f - clamp(_e98, 0f, 1f)), 6f);\n    let _e102 = r;\n    halo = pow((1f - clamp(_e102, 0f, 1f)), 1.6f);\n    let _e107 = unnamed.uTime;\n    let _e109 = vSeed_1;\n    let _e112 = vSeed_1;\n    param_7 = vec2<f32>(((_e107 * 9f) + (_e109 * 13f)), _e112);\n    let _e114 = valueNoise_u0028_vf2_u003b((&param_7));\n    flick = (0.7f + (0.3f * _e114));\n    let _e117 = vAge_1;\n    let _e118 = vAge_1;\n    cool = (1f - (_e117 * _e118));\n    let _e121 = halo;\n    let _e123 = core;\n    let _e125 = unnamed.uCoreGain;\n    let _e128 = flick;\n    let _e130 = cool;\n    let _e132 = vAlpha_1;\n    energy = (((((_e121 * 0.55f) + (_e123 * _e125)) * _e128) * _e130) * _e132);\n    let _e134 = vWorldPos_1;\n    let _e136 = unnamed.uCameraPos;\n    param_8 = distance(_e134, _e136);\n    let _e139 = vWorldPos_1[1u];\n    param_9 = _e139;\n    let _e140 = mediumFog_u0028_f1_u003b_f1_u003b((&param_8), (&param_9));\n    fog = _e140;\n    let _e141 = fog;\n    let _e143 = energy;\n    energy = (_e143 * (1f - _e141));\n    let _e145 = vColor_1;\n    let _e146 = energy;\n    param_10 = (_e145 * _e146);\n    let _e148 = applyOutputTransform_u0028_vf3_u003b((&param_10));\n    outColor = vec4<f32>(_e148.x, _e148.y, _e148.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(4) vSeed: f32, @location(3) vAge: f32, @location(2) vAlpha: f32, @location(5) vWorldPos: vec3<f32>, @location(1) vColor: vec3<f32>, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vAge_1 = vAge;\n    vAlpha_1 = vAlpha;\n    vWorldPos_1 = vWorldPos;\n    vColor_1 = vColor;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uStretchSec: f32,\n    uCameraFacing: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) member_2: f32,\n    @location(3) member_3: f32,\n    @location(4) member_4: f32,\n    @location(5) member_5: vec3<f32>,\n    @location(6) member_6: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aSpin_1: f32;\nvar<private> aCorner_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPos_1: vec3<f32>;\nvar<private> aBlade_1: f32;\nvar<private> aSize_1: f32;\nvar<private> aVelocity_1: vec3<f32>;\nvar<private> vUv: vec2<f32>;\nvar<private> vColor: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vAlpha: f32;\nvar<private> aAlpha_1: f32;\nvar<private> vAge: f32;\nvar<private> aAge_1: f32;\nvar<private> vSeed: f32;\nvar<private> aSeed_1: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var s: f32;\n    var c: f32;\n    var rolled: vec2<f32>;\n    var toCamera: vec3<f32>;\n    var reference: vec3<f32>;\n    var across: vec3<f32>;\n    var up: vec3<f32>;\n    var bladeGain: f32;\n    var offset: vec3<f32>;\n    var travel: vec3<f32>;\n    var along: f32;\n    var world: vec3<f32>;\n    var face: vec3<f32>;\n    var toEye: vec3<f32>;\n    var local: vec3<f32>;\n\n    let _e49 = aSpin_1;\n    s = sin(_e49);\n    let _e51 = aSpin_1;\n    c = cos(_e51);\n    let _e54 = aCorner_1[0u];\n    let _e55 = c;\n    let _e58 = aCorner_1[1u];\n    let _e59 = s;\n    let _e63 = aCorner_1[0u];\n    let _e64 = s;\n    let _e67 = aCorner_1[1u];\n    let _e68 = c;\n    rolled = vec2<f32>(((_e54 * _e55) - (_e58 * _e59)), ((_e63 * _e64) + (_e67 * _e68)));\n    let _e73 = unnamed.uCameraFacing;\n    if (_e73 > 0.5f) {\n        let _e76 = unnamed.uCameraPos;\n        let _e77 = aPos_1;\n        toCamera = normalize((_e76 - _e77));\n        let _e81 = toCamera[1u];\n        reference = select(vec3<f32>(0f, 1f, 0f), vec3<f32>(0f, 0f, 1f), vec3((abs(_e81) > 0.999f)));\n        let _e86 = reference;\n        let _e87 = toCamera;\n        across = normalize(cross(_e86, _e87));\n        let _e90 = toCamera;\n        let _e91 = across;\n        up = cross(_e90, _e91);\n        let _e93 = aBlade_1;\n        bladeGain = select(0f, 1f, (_e93 < 0.5f));\n    } else {\n        let _e96 = aBlade_1;\n        across = select(vec3<f32>(0f, 0f, 1f), vec3<f32>(1f, 0f, 0f), vec3((_e96 < 0.5f)));\n        up = vec3<f32>(0f, 1f, 0f);\n        bladeGain = 1f;\n    }\n    let _e100 = across;\n    let _e102 = rolled[0u];\n    let _e104 = up;\n    let _e106 = rolled[1u];\n    let _e109 = aSize_1;\n    offset = (((_e100 * _e102) + (_e104 * _e106)) * _e109);\n    let _e112 = unnamed.uStretchSec;\n    if (_e112 > 0f) {\n        let _e114 = aVelocity_1;\n        let _e116 = unnamed.uStretchSec;\n        travel = (_e114 * _e116);\n        let _e118 = offset;\n        let _e121 = travel;\n        along = dot(normalize((_e118 + vec3<f32>(0.000001f, 0.000001f, 0.000001f))), normalize((_e121 + vec3<f32>(0.000001f, 0.000001f, 0.000001f))));\n        let _e125 = travel;\n        let _e126 = along;\n        let _e129 = offset;\n        offset = (_e129 + ((_e125 * _e126) * 0.5f));\n    }\n    let _e131 = aPos_1;\n    let _e132 = offset;\n    let _e133 = bladeGain;\n    world = (_e131 + (_e132 * _e133));\n    let _e136 = aCorner_1;\n    vUv = _e136;\n    let _e137 = aColor_1;\n    vColor = _e137;\n    let _e138 = aAlpha_1;\n    vAlpha = _e138;\n    let _e139 = aAge_1;\n    vAge = _e139;\n    let _e140 = aSeed_1;\n    vSeed = _e140;\n    let _e141 = world;\n    vWorldPos = _e141;\n    let _e142 = across;\n    let _e143 = up;\n    face = cross(_e142, _e143);\n    let _e146 = unnamed.uCameraPos;\n    let _e147 = world;\n    toEye = normalize((_e146 - _e147));\n    let _e150 = face;\n    let _e151 = toEye;\n    if (dot(_e150, _e151) < 0f) {\n        let _e154 = face;\n        local = -(_e154);\n    } else {\n        let _e156 = face;\n        local = _e156;\n    }\n    let _e157 = local;\n    vNormal = _e157;\n    let _e159 = unnamed.uViewProj;\n    let _e160 = world;\n    unnamed_1.gl_Position = (_e159 * vec4<f32>(_e160.x, _e160.y, _e160.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(4) aSpin: f32, @location(0) aCorner: vec2<f32>, @location(2) aPos: vec3<f32>, @location(1) aBlade: f32, @location(3) aSize: f32, @location(9) aVelocity: vec3<f32>, @location(5) aColor: vec3<f32>, @location(6) aAlpha: f32, @location(7) aAge: f32, @location(8) aSeed: f32) -> VertexOutput {\n    aSpin_1 = aSpin;\n    aCorner_1 = aCorner;\n    aPos_1 = aPos;\n    aBlade_1 = aBlade;\n    aSize_1 = aSize;\n    aVelocity_1 = aVelocity;\n    aColor_1 = aColor;\n    aAlpha_1 = aAlpha;\n    aAge_1 = aAge;\n    aSeed_1 = aSeed;\n    main_1();\n    let _e30 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e30);\n    let _e32 = vUv;\n    let _e33 = vColor;\n    let _e34 = vAlpha;\n    let _e35 = vAge;\n    let _e36 = vSeed;\n    let _e37 = vWorldPos;\n    let _e38 = vNormal;\n    let _e39 = unnamed_1.gl_Position;\n    return VertexOutput(_e32, _e33, _e34, _e35, _e36, _e37, _e38, _e39);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const PARTICLE_BINDINGS = {
  "PARTICLE_MOTE_FRAG": {
    "uniforms": 1,
    "uniformSize": 96,
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
      "uFogDensity": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 32,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 36,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 60,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 68,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 72,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 80,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 84,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PARTICLE_SMOKE_FRAG": {
    "uniforms": 1,
    "uniformSize": 1200,
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
      "uFogDensity": {
        "offset": 1132,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 1136,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 1140,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 1152,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 1164,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 1168,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 1172,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 1176,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 1180,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 1184,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 1188,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PARTICLE_SPARK_FRAG": {
    "uniforms": 1,
    "uniformSize": 112,
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
      "uFogDensity": {
        "offset": 44,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 48,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 52,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 84,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 88,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 96,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 100,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
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
      }
    },
    "textures": {}
  }
} as const;
