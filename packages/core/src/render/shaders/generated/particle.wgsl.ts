/*
 * Generated from ../particle.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const PARTICLE_MOTE_FRAG_WGSL = "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uFogEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vAlpha_1: f32;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAge_1: f32;\nvar<private> vSeed_1: f32;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e76 = (*c);\n    low = (_e76 * 12.92f);\n    let _e78 = (*c);\n    high = ((pow(max(_e78, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e84 = high;\n    let _e85 = low;\n    let _e86 = (*c);\n    return mix(_e84, _e85, step(_e86, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e77 = (*c_1)[0u];\n    let _e79 = (*c_1)[1u];\n    let _e81 = (*c_1)[2u];\n    m = max(_e77, max(_e79, _e81));\n    let _e84 = m;\n    if (_e84 <= 0.8f) {\n        let _e86 = (*c_1);\n        return _e86;\n    }\n    let _e87 = m;\n    e = (_e87 - 0.8f);\n    let _e89 = (*c_1);\n    let _e90 = e;\n    let _e92 = e;\n    let _e96 = m;\n    return (_e89 * ((0.8f + ((0.2f * _e90) / (_e92 + 0.2f))) / _e96));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e76 = (*v);\n    let _e77 = (*v);\n    a = ((_e76 * (_e77 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e83 = (*v);\n    let _e84 = (*v);\n    b = ((_e83 * ((_e84 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e91 = a;\n    let _e92 = b;\n    return (_e91 / _e92);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e76 = unnamed.uOutputExposure;\n    let _e77 = (*x);\n    (*x) = (_e77 * _e76);\n    let _e79 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e79);\n    let _e81 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e81), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e78 = unnamed.uOutputTransform;\n    if (_e78 == 0i) {\n        let _e80 = (*c_2);\n        return _e80;\n    }\n    let _e82 = unnamed.uOutputTransform;\n    if (_e82 == 2i) {\n        let _e84 = (*c_2);\n        param_1 = _e84;\n        let _e85 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e85;\n    }\n    let _e87 = unnamed.uOutputTransform;\n    if (_e87 == 3i) {\n        let _e89 = (*c_2);\n        let _e91 = unnamed.uOutputExposure;\n        param_2 = (_e89 * _e91);\n        let _e93 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e93;\n    }\n    let _e94 = (*c_2);\n    param_3 = _e94;\n    let _e95 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e95;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e74 = unnamed.uFogColor;\n    let _e76 = unnamed.uUnderwaterColor;\n    let _e78 = unnamed.uUnderwaterFactor;\n    return mix(_e74, _e76, vec3(_e78));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e83 = unnamed.uFogMode;\n    if (_e83 == 1i) {\n        let _e86 = unnamed.uFogFar;\n        let _e88 = unnamed.uFogNear;\n        span = max((_e86 - _e88), 0.0001f);\n        let _e91 = (*dist);\n        let _e93 = unnamed.uFogNear;\n        let _e95 = span;\n        ramp = clamp(((_e91 - _e93) / _e95), 0f, 1f);\n        let _e99 = unnamed.uUnderwaterFactor;\n        if (_e99 <= 0f) {\n            let _e101 = ramp;\n            return _e101;\n        }\n        let _e103 = unnamed.uUnderwaterFogDensity;\n        let _e104 = (*dist);\n        wetLinear = (_e103 * _e104);\n        let _e106 = ramp;\n        let _e107 = wetLinear;\n        let _e109 = wetLinear;\n        let _e115 = unnamed.uUnderwaterFactor;\n        return mix(_e106, (1f - exp2(((-(_e107) * _e109) * 1.442695f))), _e115);\n    }\n    let _e117 = (*pointY);\n    let _e119 = unnamed.uFogEyeY;\n    let _e122 = unnamed.uFogHeightFalloff;\n    t = ((_e117 - _e119) * _e122);\n    let _e124 = t;\n    let _e127 = t;\n    denom = select(_e127, 0.0001f, (abs(_e124) < 0.0001f));\n    let _e130 = unnamed.uFogDensity;\n    let _e132 = (*dist);\n    let _e134 = denom;\n    let _e139 = denom;\n    air = (1f - exp((((-(_e130) * _e132) * (1f - exp(-(_e134)))) / _e139)));\n    let _e144 = unnamed.uUnderwaterFactor;\n    if (_e144 <= 0f) {\n        let _e146 = air;\n        return _e146;\n    }\n    let _e148 = unnamed.uUnderwaterFogDensity;\n    let _e149 = (*dist);\n    wet = (_e148 * _e149);\n    let _e151 = air;\n    let _e152 = wet;\n    let _e154 = wet;\n    let _e160 = unnamed.uUnderwaterFactor;\n    return mix(_e151, (1f - exp2(((-(_e152) * _e154) * 1.442695f))), _e160);\n}\n\nfn main_1() {\n    var r: f32;\n    var body: f32;\n    var alpha: f32;\n    var color: vec3<f32>;\n    var fog: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var param_6: vec3<f32>;\n\n    let _e81 = vUv_1;\n    r = length(_e81);\n    let _e83 = r;\n    body = (1f - smoothstep(0.4f, 1f, _e83));\n    let _e86 = body;\n    if (_e86 <= 0f) {\n        discard;\n    }\n    let _e88 = body;\n    let _e89 = body;\n    let _e91 = vAlpha_1;\n    alpha = ((_e88 * _e89) * _e91);\n    let _e93 = alpha;\n    if (_e93 <= 0.002f) {\n        discard;\n    }\n    let _e95 = vColor_1;\n    color = _e95;\n    let _e97 = unnamed.uFogEnabled;\n    if (_e97 != 0i) {\n        let _e99 = vWorldPos_1;\n        let _e101 = unnamed.uCameraPos;\n        param_4 = distance(_e99, _e101);\n        let _e104 = vWorldPos_1[1u];\n        param_5 = _e104;\n        let _e105 = mediumFog_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        fog = _e105;\n        let _e106 = color;\n        let _e107 = mediumColor_u0028_();\n        let _e108 = fog;\n        color = mix(_e106, _e107, vec3(_e108));\n    }\n    let _e111 = color;\n    param_6 = _e111;\n    let _e112 = applyOutputTransform_u0028_vf3_u003b((&param_6));\n    let _e113 = alpha;\n    outColor = vec4<f32>(_e112.x, _e112.y, _e112.z, _e113);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(2) vAlpha: f32, @location(1) vColor: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(3) vAge: f32, @location(4) vSeed: f32, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vAlpha_1 = vAlpha;\n    vColor_1 = vColor;\n    vWorldPos_1 = vWorldPos;\n    vAge_1 = vAge;\n    vSeed_1 = vSeed;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SMOKE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uCameraPos: vec3<f32>,\n    uNoiseOctaves: i32,\n    uErosion: f32,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vAge_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAlpha_1: f32;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e109 = (*c);\n    low = (_e109 * 12.92f);\n    let _e111 = (*c);\n    high = ((pow(max(_e111, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e117 = high;\n    let _e118 = low;\n    let _e119 = (*c);\n    return mix(_e117, _e118, step(_e119, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e110 = (*c_1)[0u];\n    let _e112 = (*c_1)[1u];\n    let _e114 = (*c_1)[2u];\n    m = max(_e110, max(_e112, _e114));\n    let _e117 = m;\n    if (_e117 <= 0.8f) {\n        let _e119 = (*c_1);\n        return _e119;\n    }\n    let _e120 = m;\n    e = (_e120 - 0.8f);\n    let _e122 = (*c_1);\n    let _e123 = e;\n    let _e125 = e;\n    let _e129 = m;\n    return (_e122 * ((0.8f + ((0.2f * _e123) / (_e125 + 0.2f))) / _e129));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e109 = (*v);\n    let _e110 = (*v);\n    a = ((_e109 * (_e110 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e116 = (*v);\n    let _e117 = (*v);\n    b = ((_e116 * ((_e117 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e124 = a;\n    let _e125 = b;\n    return (_e124 / _e125);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e109 = unnamed.uOutputExposure;\n    let _e110 = (*x);\n    (*x) = (_e110 * _e109);\n    let _e112 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e112);\n    let _e114 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e114), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e111 = unnamed.uOutputTransform;\n    if (_e111 == 0i) {\n        let _e113 = (*c_2);\n        return _e113;\n    }\n    let _e115 = unnamed.uOutputTransform;\n    if (_e115 == 2i) {\n        let _e117 = (*c_2);\n        param_1 = _e117;\n        let _e118 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e118;\n    }\n    let _e120 = unnamed.uOutputTransform;\n    if (_e120 == 3i) {\n        let _e122 = (*c_2);\n        let _e124 = unnamed.uOutputExposure;\n        param_2 = (_e122 * _e124);\n        let _e126 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e126;\n    }\n    let _e127 = (*c_2);\n    param_3 = _e127;\n    let _e128 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e128;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e107 = unnamed.uFogColor;\n    let _e109 = unnamed.uUnderwaterColor;\n    let _e111 = unnamed.uUnderwaterFactor;\n    return mix(_e107, _e109, vec3(_e111));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e116 = unnamed.uFogMode;\n    if (_e116 == 1i) {\n        let _e119 = unnamed.uFogFar;\n        let _e121 = unnamed.uFogNear;\n        span = max((_e119 - _e121), 0.0001f);\n        let _e124 = (*dist);\n        let _e126 = unnamed.uFogNear;\n        let _e128 = span;\n        ramp = clamp(((_e124 - _e126) / _e128), 0f, 1f);\n        let _e132 = unnamed.uUnderwaterFactor;\n        if (_e132 <= 0f) {\n            let _e134 = ramp;\n            return _e134;\n        }\n        let _e136 = unnamed.uUnderwaterFogDensity;\n        let _e137 = (*dist);\n        wetLinear = (_e136 * _e137);\n        let _e139 = ramp;\n        let _e140 = wetLinear;\n        let _e142 = wetLinear;\n        let _e148 = unnamed.uUnderwaterFactor;\n        return mix(_e139, (1f - exp2(((-(_e140) * _e142) * 1.442695f))), _e148);\n    }\n    let _e150 = (*pointY);\n    let _e152 = unnamed.uFogEyeY;\n    let _e155 = unnamed.uFogHeightFalloff;\n    t = ((_e150 - _e152) * _e155);\n    let _e157 = t;\n    let _e160 = t;\n    denom = select(_e160, 0.0001f, (abs(_e157) < 0.0001f));\n    let _e163 = unnamed.uFogDensity;\n    let _e165 = (*dist);\n    let _e167 = denom;\n    let _e172 = denom;\n    air = (1f - exp((((-(_e163) * _e165) * (1f - exp(-(_e167)))) / _e172)));\n    let _e177 = unnamed.uUnderwaterFactor;\n    if (_e177 <= 0f) {\n        let _e179 = air;\n        return _e179;\n    }\n    let _e181 = unnamed.uUnderwaterFogDensity;\n    let _e182 = (*dist);\n    wet = (_e181 * _e182);\n    let _e184 = air;\n    let _e185 = wet;\n    let _e187 = wet;\n    let _e193 = unnamed.uUnderwaterFactor;\n    return mix(_e184, (1f - exp2(((-(_e185) * _e187) * 1.442695f))), _e193);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e107 = (*p);\n    return fract((sin(dot(_e107, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n\n    let _e114 = (*p_1);\n    i = floor(_e114);\n    let _e116 = (*p_1);\n    f = fract(_e116);\n    let _e118 = f;\n    let _e119 = f;\n    let _e121 = f;\n    u = ((_e118 * _e119) * (vec2(3f) - (_e121 * 2f)));\n    let _e126 = i;\n    param_4 = _e126;\n    let _e127 = hash21_u0028_vf2_u003b((&param_4));\n    let _e128 = i;\n    param_5 = (_e128 + vec2<f32>(1f, 0f));\n    let _e130 = hash21_u0028_vf2_u003b((&param_5));\n    let _e132 = u[0u];\n    let _e134 = i;\n    param_6 = (_e134 + vec2<f32>(0f, 1f));\n    let _e136 = hash21_u0028_vf2_u003b((&param_6));\n    let _e137 = i;\n    param_7 = (_e137 + vec2<f32>(1f, 1f));\n    let _e139 = hash21_u0028_vf2_u003b((&param_7));\n    let _e141 = u[0u];\n    let _e144 = u[1u];\n    return mix(mix(_e127, _e130, _e132), mix(_e136, _e139, _e141), _e144);\n}\n\nfn billow_u0028_vf2_u003b_f1_u003b_i1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>, octaves: ptr<function, i32>) -> f32 {\n    var v_1: f32;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n\n    let _e112 = (*p_2);\n    let _e114 = (*t_1);\n    param_8 = ((_e112 * 2.4f) + vec2<f32>(0f, (-(_e114) * 0.5f)));\n    let _e119 = valueNoise_u0028_vf2_u003b((&param_8));\n    v_1 = (_e119 * 0.62f);\n    let _e121 = (*octaves);\n    if (_e121 == 1i) {\n        let _e123 = v_1;\n        return (_e123 / 0.62f);\n    }\n    let _e125 = (*p_2);\n    let _e127 = (*t_1);\n    let _e129 = (*t_1);\n    param_9 = ((_e125 * 5.1f) + vec2<f32>((_e127 * 0.15f), (-(_e129) * 0.8f)));\n    let _e134 = valueNoise_u0028_vf2_u003b((&param_9));\n    let _e136 = v_1;\n    v_1 = (_e136 + (_e134 * 0.38f));\n    let _e138 = v_1;\n    return (_e138 / 1f);\n}\n\nfn main_1() {\n    var r: f32;\n    var body: f32;\n    var t_2: f32;\n    var n: f32;\n    var param_10: vec2<f32>;\n    var param_11: f32;\n    var param_12: i32;\n    var erode: f32;\n    var mask: f32;\n    var n3_: vec3<f32>;\n    var ndl: f32;\n    var lit: vec3<f32>;\n    var i_1: i32;\n    var toLight: vec3<f32>;\n    var dist_1: f32;\n    var radius: f32;\n    var falloff: f32;\n    var wrapped: f32;\n    var shaded: vec3<f32>;\n    var fog: f32;\n    var param_13: f32;\n    var param_14: f32;\n    var param_15: vec3<f32>;\n\n    let _e129 = vUv_1;\n    r = length(_e129);\n    let _e131 = r;\n    body = (1f - smoothstep(0.35f, 1f, _e131));\n    let _e134 = body;\n    if (_e134 <= 0f) {\n        discard;\n    }\n    let _e137 = unnamed.uTime;\n    let _e139 = vSeed_1;\n    t_2 = ((_e137 * 0.55f) + (_e139 * 7.31f));\n    let _e142 = vUv_1;\n    let _e143 = vAge_1;\n    let _e147 = vSeed_1;\n    param_10 = ((_e142 * (0.9f + (_e143 * 1.4f))) + vec2<f32>((_e147 * 3.7f), 0f));\n    let _e151 = t_2;\n    param_11 = _e151;\n    let _e153 = unnamed.uNoiseOctaves;\n    param_12 = _e153;\n    let _e154 = billow_u0028_vf2_u003b_f1_u003b_i1_u003b((&param_10), (&param_11), (&param_12));\n    n = _e154;\n    let _e155 = n;\n    let _e157 = unnamed.uErosion;\n    let _e158 = vAge_1;\n    erode = mix(1f, _e155, (_e157 * (0.35f + (_e158 * 0.65f))));\n    let _e163 = body;\n    let _e164 = erode;\n    mask = clamp((_e163 * _e164), 0f, 1f);\n    let _e167 = mask;\n    let _e169 = mask;\n    mask = (_e169 * smoothstep(0f, 0.25f, _e167));\n    let _e171 = mask;\n    if (_e171 <= 0.002f) {\n        discard;\n    }\n    let _e173 = vNormal_1;\n    n3_ = normalize(_e173);\n    let _e175 = n3_;\n    let _e177 = unnamed.uDirectionalDir;\n    ndl = ((dot(_e175, _e177) * 0.5f) + 0.5f);\n    let _e182 = unnamed.uAmbient;\n    let _e184 = unnamed.uDirectionalColor;\n    let _e185 = ndl;\n    lit = (_e182 + (_e184 * _e185));\n    i_1 = 0i;\n    loop {\n        let _e188 = i_1;\n        if (_e188 < 16i) {\n            let _e190 = i_1;\n            let _e192 = unnamed.uLightCount;\n            if (_e190 >= _e192) {\n                break;\n            }\n            let _e194 = i_1;\n            let _e197 = unnamed.uLightPos[_e194];\n            let _e198 = vWorldPos_1;\n            toLight = (_e197 - _e198);\n            let _e200 = toLight;\n            dist_1 = length(_e200);\n            let _e202 = i_1;\n            let _e206 = unnamed.uLightRadius[_e202][0u];\n            radius = _e206;\n            let _e207 = radius;\n            let _e209 = dist_1;\n            let _e210 = radius;\n            if ((_e207 <= 0f) || (_e209 >= _e210)) {\n                continue;\n            }\n            let _e213 = dist_1;\n            let _e214 = radius;\n            falloff = (1f - (_e213 / _e214));\n            let _e217 = n3_;\n            let _e218 = toLight;\n            let _e219 = dist_1;\n            wrapped = ((dot(_e217, (_e218 / vec3(max(_e219, 0.0001f)))) * 0.5f) + 0.5f);\n            let _e226 = i_1;\n            let _e229 = unnamed.uLightColor[_e226];\n            let _e230 = falloff;\n            let _e232 = falloff;\n            let _e234 = wrapped;\n            let _e236 = i_1;\n            let _e240 = unnamed.uLightWeight[_e236][0u];\n            let _e242 = lit;\n            lit = (_e242 + ((((_e229 * _e230) * _e232) * _e234) * _e240));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e244 = i_1;\n            i_1 = (_e244 + 1i);\n        }\n    }\n    let _e246 = vColor_1;\n    let _e247 = lit;\n    shaded = (_e246 * _e247);\n    let _e249 = vWorldPos_1;\n    let _e251 = unnamed.uCameraPos;\n    param_13 = distance(_e249, _e251);\n    let _e254 = vWorldPos_1[1u];\n    param_14 = _e254;\n    let _e255 = mediumFog_u0028_f1_u003b_f1_u003b((&param_13), (&param_14));\n    fog = _e255;\n    let _e256 = shaded;\n    let _e257 = mediumColor_u0028_();\n    let _e258 = fog;\n    param_15 = mix(_e256, _e257, vec3(_e258));\n    let _e261 = applyOutputTransform_u0028_vf3_u003b((&param_15));\n    let _e262 = mask;\n    let _e263 = vAlpha_1;\n    outColor = vec4<f32>(_e261.x, _e261.y, _e261.z, (_e262 * _e263));\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(4) vSeed: f32, @location(3) vAge: f32, @location(6) vNormal: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(1) vColor: vec3<f32>, @location(2) vAlpha: f32) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vAge_1 = vAge;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vColor_1 = vColor;\n    vAlpha_1 = vAlpha;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SPARK_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uCameraPos: vec3<f32>,\n    uCoreGain: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vAge_1: f32;\nvar<private> vAlpha_1: f32;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e90 = (*c);\n    low = (_e90 * 12.92f);\n    let _e92 = (*c);\n    high = ((pow(max(_e92, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e98 = high;\n    let _e99 = low;\n    let _e100 = (*c);\n    return mix(_e98, _e99, step(_e100, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e91 = (*c_1)[0u];\n    let _e93 = (*c_1)[1u];\n    let _e95 = (*c_1)[2u];\n    m = max(_e91, max(_e93, _e95));\n    let _e98 = m;\n    if (_e98 <= 0.8f) {\n        let _e100 = (*c_1);\n        return _e100;\n    }\n    let _e101 = m;\n    e = (_e101 - 0.8f);\n    let _e103 = (*c_1);\n    let _e104 = e;\n    let _e106 = e;\n    let _e110 = m;\n    return (_e103 * ((0.8f + ((0.2f * _e104) / (_e106 + 0.2f))) / _e110));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e90 = (*v);\n    let _e91 = (*v);\n    a = ((_e90 * (_e91 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e97 = (*v);\n    let _e98 = (*v);\n    b = ((_e97 * ((_e98 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e105 = a;\n    let _e106 = b;\n    return (_e105 / _e106);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e90 = unnamed.uOutputExposure;\n    let _e91 = (*x);\n    (*x) = (_e91 * _e90);\n    let _e93 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e93);\n    let _e95 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e95), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e92 = unnamed.uOutputTransform;\n    if (_e92 == 0i) {\n        let _e94 = (*c_2);\n        return _e94;\n    }\n    let _e96 = unnamed.uOutputTransform;\n    if (_e96 == 2i) {\n        let _e98 = (*c_2);\n        param_1 = _e98;\n        let _e99 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e99;\n    }\n    let _e101 = unnamed.uOutputTransform;\n    if (_e101 == 3i) {\n        let _e103 = (*c_2);\n        let _e105 = unnamed.uOutputExposure;\n        param_2 = (_e103 * _e105);\n        let _e107 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e107;\n    }\n    let _e108 = (*c_2);\n    param_3 = _e108;\n    let _e109 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e109;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e97 = unnamed.uFogMode;\n    if (_e97 == 1i) {\n        let _e100 = unnamed.uFogFar;\n        let _e102 = unnamed.uFogNear;\n        span = max((_e100 - _e102), 0.0001f);\n        let _e105 = (*dist);\n        let _e107 = unnamed.uFogNear;\n        let _e109 = span;\n        ramp = clamp(((_e105 - _e107) / _e109), 0f, 1f);\n        let _e113 = unnamed.uUnderwaterFactor;\n        if (_e113 <= 0f) {\n            let _e115 = ramp;\n            return _e115;\n        }\n        let _e117 = unnamed.uUnderwaterFogDensity;\n        let _e118 = (*dist);\n        wetLinear = (_e117 * _e118);\n        let _e120 = ramp;\n        let _e121 = wetLinear;\n        let _e123 = wetLinear;\n        let _e129 = unnamed.uUnderwaterFactor;\n        return mix(_e120, (1f - exp2(((-(_e121) * _e123) * 1.442695f))), _e129);\n    }\n    let _e131 = (*pointY);\n    let _e133 = unnamed.uFogEyeY;\n    let _e136 = unnamed.uFogHeightFalloff;\n    t = ((_e131 - _e133) * _e136);\n    let _e138 = t;\n    let _e141 = t;\n    denom = select(_e141, 0.0001f, (abs(_e138) < 0.0001f));\n    let _e144 = unnamed.uFogDensity;\n    let _e146 = (*dist);\n    let _e148 = denom;\n    let _e153 = denom;\n    air = (1f - exp((((-(_e144) * _e146) * (1f - exp(-(_e148)))) / _e153)));\n    let _e158 = unnamed.uUnderwaterFactor;\n    if (_e158 <= 0f) {\n        let _e160 = air;\n        return _e160;\n    }\n    let _e162 = unnamed.uUnderwaterFogDensity;\n    let _e163 = (*dist);\n    wet = (_e162 * _e163);\n    let _e165 = air;\n    let _e166 = wet;\n    let _e168 = wet;\n    let _e174 = unnamed.uUnderwaterFactor;\n    return mix(_e165, (1f - exp2(((-(_e166) * _e168) * 1.442695f))), _e174);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e88 = (*p);\n    return fract((sin(dot(_e88, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n\n    let _e95 = (*p_1);\n    i = floor(_e95);\n    let _e97 = (*p_1);\n    f = fract(_e97);\n    let _e99 = f;\n    let _e100 = f;\n    let _e102 = f;\n    u = ((_e99 * _e100) * (vec2(3f) - (_e102 * 2f)));\n    let _e107 = i;\n    param_4 = _e107;\n    let _e108 = hash21_u0028_vf2_u003b((&param_4));\n    let _e109 = i;\n    param_5 = (_e109 + vec2<f32>(1f, 0f));\n    let _e111 = hash21_u0028_vf2_u003b((&param_5));\n    let _e113 = u[0u];\n    let _e115 = i;\n    param_6 = (_e115 + vec2<f32>(0f, 1f));\n    let _e117 = hash21_u0028_vf2_u003b((&param_6));\n    let _e118 = i;\n    param_7 = (_e118 + vec2<f32>(1f, 1f));\n    let _e120 = hash21_u0028_vf2_u003b((&param_7));\n    let _e122 = u[0u];\n    let _e125 = u[1u];\n    return mix(mix(_e108, _e111, _e113), mix(_e117, _e120, _e122), _e125);\n}\n\nfn main_1() {\n    var r: f32;\n    var core: f32;\n    var halo: f32;\n    var flick: f32;\n    var param_8: vec2<f32>;\n    var cool: f32;\n    var energy: f32;\n    var fog: f32;\n    var param_9: f32;\n    var param_10: f32;\n    var param_11: vec3<f32>;\n\n    let _e98 = vUv_1;\n    r = length(_e98);\n    let _e100 = r;\n    if (_e100 > 1f) {\n        discard;\n    }\n    let _e102 = r;\n    core = pow((1f - clamp(_e102, 0f, 1f)), 6f);\n    let _e106 = r;\n    halo = pow((1f - clamp(_e106, 0f, 1f)), 1.6f);\n    let _e111 = unnamed.uTime;\n    let _e113 = vSeed_1;\n    let _e116 = vSeed_1;\n    param_8 = vec2<f32>(((_e111 * 9f) + (_e113 * 13f)), _e116);\n    let _e118 = valueNoise_u0028_vf2_u003b((&param_8));\n    flick = (0.7f + (0.3f * _e118));\n    let _e121 = vAge_1;\n    let _e122 = vAge_1;\n    cool = (1f - (_e121 * _e122));\n    let _e125 = halo;\n    let _e127 = core;\n    let _e129 = unnamed.uCoreGain;\n    let _e132 = flick;\n    let _e134 = cool;\n    let _e136 = vAlpha_1;\n    energy = (((((_e125 * 0.55f) + (_e127 * _e129)) * _e132) * _e134) * _e136);\n    let _e138 = vWorldPos_1;\n    let _e140 = unnamed.uCameraPos;\n    param_9 = distance(_e138, _e140);\n    let _e143 = vWorldPos_1[1u];\n    param_10 = _e143;\n    let _e144 = mediumFog_u0028_f1_u003b_f1_u003b((&param_9), (&param_10));\n    fog = _e144;\n    let _e145 = fog;\n    let _e147 = energy;\n    energy = (_e147 * (1f - _e145));\n    let _e149 = vColor_1;\n    let _e150 = energy;\n    param_11 = (_e149 * _e150);\n    let _e152 = applyOutputTransform_u0028_vf3_u003b((&param_11));\n    outColor = vec4<f32>(_e152.x, _e152.y, _e152.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(4) vSeed: f32, @location(3) vAge: f32, @location(2) vAlpha: f32, @location(5) vWorldPos: vec3<f32>, @location(1) vColor: vec3<f32>, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vAge_1 = vAge;\n    vAlpha_1 = vAlpha;\n    vWorldPos_1 = vWorldPos;\n    vColor_1 = vColor;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e15 = outColor;\n    return _e15;\n}\n";

export const PARTICLE_SPRITE_FRAG_WGSL = "struct Uniforms {\n    uCells: vec4<f32>,\n    uFade: vec4<f32>,\n    uDepthToViewZ: vec4<f32>,\n    uViewport: vec2<f32>,\n    uCameraPos: vec3<f32>,\n    uFogEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vFrame_1: f32;\n@group(0) @binding(32) \nvar uSprite_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uSprite_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\nvar<private> vViewDepth_1: f32;\nvar<private> vAlpha_1: f32;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\nvar<private> vAge_1: f32;\nvar<private> vSeed_1: f32;\nvar<private> vNormal_1: vec3<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e89 = (*c);\n    low = (_e89 * 12.92f);\n    let _e91 = (*c);\n    high = ((pow(max(_e91, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e97 = high;\n    let _e98 = low;\n    let _e99 = (*c);\n    return mix(_e97, _e98, step(_e99, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e90 = (*c_1)[0u];\n    let _e92 = (*c_1)[1u];\n    let _e94 = (*c_1)[2u];\n    m = max(_e90, max(_e92, _e94));\n    let _e97 = m;\n    if (_e97 <= 0.8f) {\n        let _e99 = (*c_1);\n        return _e99;\n    }\n    let _e100 = m;\n    e = (_e100 - 0.8f);\n    let _e102 = (*c_1);\n    let _e103 = e;\n    let _e105 = e;\n    let _e109 = m;\n    return (_e102 * ((0.8f + ((0.2f * _e103) / (_e105 + 0.2f))) / _e109));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e89 = (*v);\n    let _e90 = (*v);\n    a = ((_e89 * (_e90 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e96 = (*v);\n    let _e97 = (*v);\n    b = ((_e96 * ((_e97 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e104 = a;\n    let _e105 = b;\n    return (_e104 / _e105);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e89 = unnamed.uOutputExposure;\n    let _e90 = (*x);\n    (*x) = (_e90 * _e89);\n    let _e92 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e92);\n    let _e94 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e94), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e91 = unnamed.uOutputTransform;\n    if (_e91 == 0i) {\n        let _e93 = (*c_2);\n        return _e93;\n    }\n    let _e95 = unnamed.uOutputTransform;\n    if (_e95 == 2i) {\n        let _e97 = (*c_2);\n        param_1 = _e97;\n        let _e98 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e98;\n    }\n    let _e100 = unnamed.uOutputTransform;\n    if (_e100 == 3i) {\n        let _e102 = (*c_2);\n        let _e104 = unnamed.uOutputExposure;\n        param_2 = (_e102 * _e104);\n        let _e106 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e106;\n    }\n    let _e107 = (*c_2);\n    param_3 = _e107;\n    let _e108 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e108;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e87 = unnamed.uFogColor;\n    let _e89 = unnamed.uUnderwaterColor;\n    let _e91 = unnamed.uUnderwaterFactor;\n    return mix(_e87, _e89, vec3(_e91));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e96 = unnamed.uFogMode;\n    if (_e96 == 1i) {\n        let _e99 = unnamed.uFogFar;\n        let _e101 = unnamed.uFogNear;\n        span = max((_e99 - _e101), 0.0001f);\n        let _e104 = (*dist);\n        let _e106 = unnamed.uFogNear;\n        let _e108 = span;\n        ramp = clamp(((_e104 - _e106) / _e108), 0f, 1f);\n        let _e112 = unnamed.uUnderwaterFactor;\n        if (_e112 <= 0f) {\n            let _e114 = ramp;\n            return _e114;\n        }\n        let _e116 = unnamed.uUnderwaterFogDensity;\n        let _e117 = (*dist);\n        wetLinear = (_e116 * _e117);\n        let _e119 = ramp;\n        let _e120 = wetLinear;\n        let _e122 = wetLinear;\n        let _e128 = unnamed.uUnderwaterFactor;\n        return mix(_e119, (1f - exp2(((-(_e120) * _e122) * 1.442695f))), _e128);\n    }\n    let _e130 = (*pointY);\n    let _e132 = unnamed.uFogEyeY;\n    let _e135 = unnamed.uFogHeightFalloff;\n    t = ((_e130 - _e132) * _e135);\n    let _e137 = t;\n    let _e140 = t;\n    denom = select(_e140, 0.0001f, (abs(_e137) < 0.0001f));\n    let _e143 = unnamed.uFogDensity;\n    let _e145 = (*dist);\n    let _e147 = denom;\n    let _e152 = denom;\n    air = (1f - exp((((-(_e143) * _e145) * (1f - exp(-(_e147)))) / _e152)));\n    let _e157 = unnamed.uUnderwaterFactor;\n    if (_e157 <= 0f) {\n        let _e159 = air;\n        return _e159;\n    }\n    let _e161 = unnamed.uUnderwaterFogDensity;\n    let _e162 = (*dist);\n    wet = (_e161 * _e162);\n    let _e164 = air;\n    let _e165 = wet;\n    let _e167 = wet;\n    let _e173 = unnamed.uUnderwaterFactor;\n    return mix(_e164, (1f - exp2(((-(_e165) * _e167) * 1.442695f))), _e173);\n}\n\nfn viewZ_u0028_f1_u003b(depth: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e88 = (*depth);\n    ndc = (1f - (_e88 * 2f));\n    let _e93 = unnamed.uDepthToViewZ[0u];\n    let _e94 = ndc;\n    let _e98 = unnamed.uDepthToViewZ[1u];\n    let _e102 = unnamed.uDepthToViewZ[2u];\n    let _e103 = ndc;\n    let _e107 = unnamed.uDepthToViewZ[3u];\n    return (((_e93 * _e94) + _e98) / ((_e102 * _e103) + _e107));\n}\n\nfn cellUv_u0028_i1_u003b_vf2_u003b(cell: ptr<function, i32>, uv: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var columns: i32;\n    var rows: i32;\n    var wrapped: i32;\n    var column: i32;\n    var row: i32;\n\n    let _e95 = unnamed.uCells[0u];\n    columns = max(i32((_e95 + 0.5f)), 1i);\n    let _e101 = unnamed.uCells[1u];\n    rows = max(i32((_e101 + 0.5f)), 1i);\n    let _e105 = (*cell);\n    let _e106 = columns;\n    let _e107 = rows;\n    let _e108 = (_e106 * _e107);\n    wrapped = (_e105 - (i32(floor((f32(_e105) / f32(_e108)))) * _e108));\n    let _e116 = wrapped;\n    let _e117 = columns;\n    column = (_e116 - (i32(floor((f32(_e116) / f32(_e117)))) * _e117));\n    let _e125 = wrapped;\n    let _e126 = columns;\n    row = (_e125 / _e126);\n    let _e128 = column;\n    let _e130 = row;\n    let _e133 = (*uv);\n    let _e135 = columns;\n    let _e137 = rows;\n    return ((vec2<f32>(f32(_e128), f32(_e130)) + _e133) / vec2<f32>(f32(_e135), f32(_e137)));\n}\n\nfn main_1() {\n    var uv_1: vec2<f32>;\n    var frame: f32;\n    var first: i32;\n    var image: vec4<f32>;\n    var param_4: i32;\n    var param_5: vec2<f32>;\n    var next: vec4<f32>;\n    var param_6: i32;\n    var param_7: vec2<f32>;\n    var fade: f32;\n    var depth_1: f32;\n    var param_8: f32;\n    var alpha: f32;\n    var color: vec3<f32>;\n    var fog: f32;\n    var param_9: f32;\n    var param_10: f32;\n    var param_11: vec3<f32>;\n    var phi_484_: bool;\n\n    let _e105 = vUv_1[0u];\n    let _e109 = vUv_1[1u];\n    uv_1 = vec2<f32>(((_e105 * 0.5f) + 0.5f), (0.5f - (_e109 * 0.5f)));\n    let _e113 = vFrame_1;\n    frame = max(_e113, 0f);\n    let _e115 = frame;\n    first = i32(floor(_e115));\n    let _e118 = first;\n    param_4 = _e118;\n    let _e119 = uv_1;\n    param_5 = _e119;\n    let _e120 = cellUv_u0028_i1_u003b_vf2_u003b((&param_4), (&param_5));\n    let _e123 = vec3<f32>(_e120.x, _e120.y, 0f);\n    let _e129 = textureSample(uSprite_t, uSprite_s, vec2<f32>(_e123.x, _e123.y), i32(_e123.z));\n    image = _e129;\n    let _e132 = unnamed.uCells[2u];\n    if (_e132 > 0.5f) {\n        let _e134 = first;\n        param_6 = (_e134 + 1i);\n        let _e136 = uv_1;\n        param_7 = _e136;\n        let _e137 = cellUv_u0028_i1_u003b_vf2_u003b((&param_6), (&param_7));\n        let _e140 = vec3<f32>(_e137.x, _e137.y, 0f);\n        let _e146 = textureSample(uSprite_t, uSprite_s, vec2<f32>(_e140.x, _e140.y), i32(_e140.z));\n        next = _e146;\n        let _e147 = image;\n        let _e148 = next;\n        let _e149 = frame;\n        image = mix(_e147, _e148, vec4(fract(_e149)));\n    }\n    fade = 1f;\n    let _e155 = unnamed.uFade[2u];\n    let _e156 = (_e155 > 0.5f);\n    phi_484_ = _e156;\n    if _e156 {\n        let _e159 = unnamed.uFade[0u];\n        phi_484_ = (_e159 > 0f);\n    }\n    let _e162 = phi_484_;\n    if _e162 {\n        let _e163 = gl_FragCoord_1;\n        let _e166 = unnamed.uViewport;\n        let _e168 = textureSampleLevel(uDepth_t, uDepth_s, (_e163.xy / _e166), 0f);\n        depth_1 = _e168.x;\n        let _e170 = depth_1;\n        if !((_e170 <= 0f)) {\n            let _e173 = depth_1;\n            param_8 = _e173;\n            let _e174 = viewZ_u0028_f1_u003b((&param_8));\n            let _e176 = vViewDepth_1;\n            let _e180 = unnamed.uFade[0u];\n            fade = clamp(((abs(_e174) - _e176) / _e180), 0f, 1f);\n        }\n    }\n    let _e185 = unnamed.uFade[1u];\n    if (_e185 > 0f) {\n        let _e187 = vViewDepth_1;\n        let _e190 = unnamed.uFade[1u];\n        let _e193 = fade;\n        fade = (_e193 * clamp((_e187 / _e190), 0f, 1f));\n    }\n    let _e195 = vAlpha_1;\n    let _e197 = image[3u];\n    let _e199 = fade;\n    alpha = ((_e195 * _e197) * _e199);\n    let _e201 = alpha;\n    if (_e201 <= 0.001f) {\n        discard;\n    }\n    let _e203 = vColor_1;\n    let _e204 = image;\n    color = (_e203 * _e204.xyz);\n    let _e208 = unnamed.uFogEnabled;\n    if (_e208 != 0i) {\n        let _e210 = vWorldPos_1;\n        let _e212 = unnamed.uCameraPos;\n        param_9 = distance(_e210, _e212);\n        let _e215 = vWorldPos_1[1u];\n        param_10 = _e215;\n        let _e216 = mediumFog_u0028_f1_u003b_f1_u003b((&param_9), (&param_10));\n        fog = _e216;\n        let _e217 = color;\n        let _e218 = mediumColor_u0028_();\n        let _e219 = fog;\n        color = mix(_e217, _e218, vec3(_e219));\n    }\n    let _e222 = color;\n    param_11 = _e222;\n    let _e223 = applyOutputTransform_u0028_vf3_u003b((&param_11));\n    let _e224 = alpha;\n    outColor = vec4<f32>(_e223.x, _e223.y, _e223.z, _e224);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @location(7) vFrame: f32, @builtin(position) gl_FragCoord: vec4<f32>, @location(8) vViewDepth: f32, @location(2) vAlpha: f32, @location(1) vColor: vec3<f32>, @location(5) vWorldPos: vec3<f32>, @location(3) vAge: f32, @location(4) vSeed: f32, @location(6) vNormal: vec3<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vFrame_1 = vFrame;\n    gl_FragCoord_1 = gl_FragCoord;\n    vViewDepth_1 = vViewDepth;\n    vAlpha_1 = vAlpha;\n    vColor_1 = vColor;\n    vWorldPos_1 = vWorldPos;\n    vAge_1 = vAge;\n    vSeed_1 = vSeed;\n    vNormal_1 = vNormal;\n    main_1();\n    let _e21 = outColor;\n    return _e21;\n}\n";

export const PARTICLE_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uStretchSec: f32,\n    uCameraFacing: f32,\n    uCameraOffset: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(7) member_1: f32,\n    @location(1) member_2: vec3<f32>,\n    @location(2) member_3: f32,\n    @location(3) member_4: f32,\n    @location(4) member_5: f32,\n    @location(5) member_6: vec3<f32>,\n    @location(6) member_7: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(8) member_8: f32,\n}\n\nvar<private> aSpin_1: f32;\nvar<private> aCorner_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPos_1: vec3<f32>;\nvar<private> aVelocity_1: vec3<f32>;\nvar<private> aBlade_1: f32;\nvar<private> aSize_1: f32;\nvar<private> aSprite_1: vec2<f32>;\nvar<private> vUv: vec2<f32>;\nvar<private> vFrame: f32;\nvar<private> vColor: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vAlpha: f32;\nvar<private> aAlpha_1: f32;\nvar<private> vAge: f32;\nvar<private> aAge_1: f32;\nvar<private> vSeed: f32;\nvar<private> aSeed_1: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vViewDepth: f32;\n\nfn main_1() {\n    var s: f32;\n    var c: f32;\n    var rolled: vec2<f32>;\n    var viewer: vec3<f32>;\n    var alongView: vec3<f32>;\n    var up: vec3<f32>;\n    var across: vec3<f32>;\n    var bladeGain: f32;\n    var toCamera: vec3<f32>;\n    var reference: vec3<f32>;\n    var offset: vec3<f32>;\n    var extent: vec2<f32>;\n    var turned: vec2<f32>;\n    var travel: vec3<f32>;\n    var along: f32;\n    var world: vec3<f32>;\n    var face: vec3<f32>;\n    var toEye: vec3<f32>;\n    var local: vec3<f32>;\n    var phi_84_: bool;\n\n    let _e60 = aSpin_1;\n    s = sin(_e60);\n    let _e62 = aSpin_1;\n    c = cos(_e62);\n    let _e65 = aCorner_1[0u];\n    let _e66 = c;\n    let _e69 = aCorner_1[1u];\n    let _e70 = s;\n    let _e74 = aCorner_1[0u];\n    let _e75 = s;\n    let _e78 = aCorner_1[1u];\n    let _e79 = c;\n    rolled = vec2<f32>(((_e65 * _e66) - (_e69 * _e70)), ((_e74 * _e75) + (_e78 * _e79)));\n    let _e84 = unnamed.uCameraPos;\n    let _e85 = aPos_1;\n    viewer = normalize((_e84 - _e85));\n    let _e88 = aVelocity_1;\n    let _e89 = viewer;\n    let _e90 = aVelocity_1;\n    let _e91 = viewer;\n    alongView = (_e88 - (_e89 * dot(_e90, _e91)));\n    let _e96 = unnamed.uCameraFacing;\n    let _e97 = (_e96 > 1.5f);\n    phi_84_ = _e97;\n    if _e97 {\n        let _e98 = alongView;\n        let _e99 = alongView;\n        phi_84_ = (dot(_e98, _e99) > 0.0000000001f);\n    }\n    let _e103 = phi_84_;\n    if _e103 {\n        let _e104 = alongView;\n        up = normalize(_e104);\n        let _e106 = up;\n        let _e107 = viewer;\n        across = cross(_e106, _e107);\n        let _e109 = aBlade_1;\n        bladeGain = select(0f, 1f, (_e109 < 0.5f));\n    } else {\n        let _e113 = unnamed.uCameraFacing;\n        if (_e113 > 0.5f) {\n            let _e116 = unnamed.uCameraPos;\n            let _e117 = aPos_1;\n            toCamera = normalize((_e116 - _e117));\n            let _e121 = toCamera[1u];\n            reference = select(vec3<f32>(0f, 1f, 0f), vec3<f32>(0f, 0f, 1f), vec3((abs(_e121) > 0.999f)));\n            let _e126 = reference;\n            let _e127 = toCamera;\n            across = normalize(cross(_e126, _e127));\n            let _e130 = toCamera;\n            let _e131 = across;\n            up = cross(_e130, _e131);\n            let _e133 = aBlade_1;\n            bladeGain = select(0f, 1f, (_e133 < 0.5f));\n        } else {\n            let _e136 = aBlade_1;\n            across = select(vec3<f32>(0f, 0f, 1f), vec3<f32>(1f, 0f, 0f), vec3((_e136 < 0.5f)));\n            up = vec3<f32>(0f, 1f, 0f);\n            bladeGain = 1f;\n        }\n    }\n    let _e140 = across;\n    let _e142 = rolled[0u];\n    let _e144 = up;\n    let _e146 = rolled[1u];\n    let _e149 = aSize_1;\n    offset = (((_e140 * _e142) + (_e144 * _e146)) * _e149);\n    let _e152 = aSprite_1[1u];\n    if (_e152 > 0f) {\n        let _e155 = aCorner_1[0u];\n        let _e156 = aSize_1;\n        let _e159 = aCorner_1[1u];\n        let _e161 = aSprite_1[1u];\n        extent = vec2<f32>((_e155 * _e156), (_e159 * _e161));\n        let _e165 = extent[0u];\n        let _e166 = c;\n        let _e169 = extent[1u];\n        let _e170 = s;\n        let _e174 = extent[0u];\n        let _e175 = s;\n        let _e178 = extent[1u];\n        let _e179 = c;\n        turned = vec2<f32>(((_e165 * _e166) - (_e169 * _e170)), ((_e174 * _e175) + (_e178 * _e179)));\n        let _e183 = across;\n        let _e185 = turned[0u];\n        let _e187 = up;\n        let _e189 = turned[1u];\n        offset = ((_e183 * _e185) + (_e187 * _e189));\n    }\n    let _e193 = unnamed.uStretchSec;\n    if (_e193 > 0f) {\n        let _e195 = aVelocity_1;\n        let _e197 = unnamed.uStretchSec;\n        travel = (_e195 * _e197);\n        let _e199 = offset;\n        let _e202 = travel;\n        along = dot(normalize((_e199 + vec3<f32>(0.000001f, 0.000001f, 0.000001f))), normalize((_e202 + vec3<f32>(0.000001f, 0.000001f, 0.000001f))));\n        let _e206 = travel;\n        let _e207 = along;\n        let _e210 = offset;\n        offset = (_e210 + ((_e206 * _e207) * 0.5f));\n    }\n    let _e212 = aPos_1;\n    let _e213 = offset;\n    let _e214 = bladeGain;\n    world = (_e212 + (_e213 * _e214));\n    let _e217 = viewer;\n    let _e219 = unnamed.uCameraOffset;\n    let _e221 = bladeGain;\n    let _e223 = world;\n    world = (_e223 + ((_e217 * _e219) * _e221));\n    let _e225 = aCorner_1;\n    vUv = _e225;\n    let _e227 = aSprite_1[0u];\n    vFrame = _e227;\n    let _e228 = aColor_1;\n    vColor = _e228;\n    let _e229 = aAlpha_1;\n    vAlpha = _e229;\n    let _e230 = aAge_1;\n    vAge = _e230;\n    let _e231 = aSeed_1;\n    vSeed = _e231;\n    let _e232 = world;\n    vWorldPos = _e232;\n    let _e233 = across;\n    let _e234 = up;\n    face = cross(_e233, _e234);\n    let _e237 = unnamed.uCameraPos;\n    let _e238 = world;\n    toEye = normalize((_e237 - _e238));\n    let _e241 = face;\n    let _e242 = toEye;\n    if (dot(_e241, _e242) < 0f) {\n        let _e245 = face;\n        local = -(_e245);\n    } else {\n        let _e247 = face;\n        local = _e247;\n    }\n    let _e248 = local;\n    vNormal = _e248;\n    let _e250 = unnamed.uViewProj;\n    let _e251 = world;\n    unnamed_1.gl_Position = (_e250 * vec4<f32>(_e251.x, _e251.y, _e251.z, 1f));\n    let _e260 = unnamed_1.gl_Position[3u];\n    vViewDepth = _e260;\n    return;\n}\n\n@vertex \nfn main(@location(4) aSpin: f32, @location(0) aCorner: vec2<f32>, @location(2) aPos: vec3<f32>, @location(9) aVelocity: vec3<f32>, @location(1) aBlade: f32, @location(3) aSize: f32, @location(10) aSprite: vec2<f32>, @location(5) aColor: vec3<f32>, @location(6) aAlpha: f32, @location(7) aAge: f32, @location(8) aSeed: f32) -> VertexOutput {\n    aSpin_1 = aSpin;\n    aCorner_1 = aCorner;\n    aPos_1 = aPos;\n    aVelocity_1 = aVelocity;\n    aBlade_1 = aBlade;\n    aSize_1 = aSize;\n    aSprite_1 = aSprite;\n    aColor_1 = aColor;\n    aAlpha_1 = aAlpha;\n    aAge_1 = aAge;\n    aSeed_1 = aSeed;\n    main_1();\n    let _e34 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e34);\n    let _e36 = vUv;\n    let _e37 = vFrame;\n    let _e38 = vColor;\n    let _e39 = vAlpha;\n    let _e40 = vAge;\n    let _e41 = vSeed;\n    let _e42 = vWorldPos;\n    let _e43 = vNormal;\n    let _e44 = unnamed_1.gl_Position;\n    let _e45 = vViewDepth;\n    return VertexOutput(_e36, _e37, _e38, _e39, _e40, _e41, _e42, _e43, _e44, _e45);\n}\n";

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
  "PARTICLE_SPRITE_FRAG": {
    "uniforms": 1,
    "uniformSize": 160,
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
      "uFogDensity": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 96,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 100,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 132,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 140,
        "size": 4,
        "type": "float"
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
