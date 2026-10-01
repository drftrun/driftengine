/*
 * Generated from ../rush.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const RUSH_FRAG_WGSL = "struct Uniforms {\n    uStrength: f32,\n    uReach: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uReprojection: mat4x4<f32>,\n    uMotionStrength: f32,\n    uMotionMax: f32,\n    uAoStrength: f32,\n    uAoOffset: vec2<f32>,\n    uBloomStrength: f32,\n    uVeilColor: vec3<f32>,\n    uVeilAlpha: f32,\n    uVignette: f32,\n    uGrain: vec2<f32>,\n    uAutoExposure: f32,\n    uLocalExposure: f32,\n    uGradeStrength: f32,\n    uGradeSize: f32,\n    uFocusDistance: f32,\n    uFocusRange: f32,\n    uDofStrength: f32,\n    uDofAspect: vec2<f32>,\n    uDepthToView: vec4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(40) \nvar uExposureHeld_t: texture_2d<f32>;\n@group(0) @binding(42) \nvar uExposureLocal_t: texture_2d<f32>;\n@group(0) @binding(43) \nvar uExposureLocal_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\n@group(0) @binding(38) \nvar uBloom_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uBloom_s: sampler;\n@group(0) @binding(44) \nvar uGradeLut_t: texture_3d<f32>;\n@group(0) @binding(45) \nvar uGradeLut_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(36) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uAo_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(41) \nvar uExposureHeld_s: sampler;\n\nfn grainNoise_u0028_vu2_u003b_u1_u003b(p: ptr<function, vec2<u32>>, seed: ptr<function, u32>) -> f32 {\n    var h: u32;\n\n    let _e153 = (*p)[0u];\n    let _e156 = (*p)[1u];\n    let _e159 = (*seed);\n    h = (((_e153 * 1664525u) + (_e156 * 1013904223u)) + (_e159 * 2654435769u));\n    let _e162 = h;\n    let _e165 = h;\n    h = (_e165 ^ (_e162 >> bitcast<u32>(16u)));\n    let _e167 = h;\n    h = (_e167 * 2246822519u);\n    let _e169 = h;\n    let _e172 = h;\n    h = (_e172 ^ (_e169 >> bitcast<u32>(13u)));\n    let _e174 = h;\n    h = (_e174 * 3266489917u);\n    let _e176 = h;\n    let _e179 = h;\n    h = (_e179 ^ (_e176 >> bitcast<u32>(16u)));\n    let _e181 = h;\n    return (f32(_e181) * 0.00000000023283064f);\n}\n\nfn withGrain_u0028_vf3_u003b_vf2_u003b(c: ptr<function, vec3<f32>>, fragCoord: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var luma: f32;\n    var weight: f32;\n    var n: f32;\n    var param: vec2<u32>;\n    var param_1: u32;\n\n    let _e158 = unnamed.uGrain[0u];\n    if (_e158 <= 0f) {\n        let _e160 = (*c);\n        return _e160;\n    }\n    let _e161 = (*c);\n    luma = dot(clamp(_e161, vec3(0f), vec3(1f)), vec3<f32>(0.2126f, 0.7152f, 0.0722f));\n    let _e166 = luma;\n    let _e168 = luma;\n    weight = (0.25f + ((3f * _e166) * (1f - _e168)));\n    let _e172 = (*fragCoord);\n    let _e176 = unnamed.uGrain[1u];\n    param = vec2<u32>(_e172);\n    param_1 = u32(_e176);\n    let _e178 = grainNoise_u0028_vu2_u003b_u1_u003b((&param), (&param_1));\n    n = (_e178 - 0.5f);\n    let _e180 = (*c);\n    let _e181 = n;\n    let _e185 = unnamed.uGrain[0u];\n    let _e187 = weight;\n    return (_e180 + vec3((((2f * _e181) * _e185) * _e187)));\n}\n\nfn withVeil_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e151 = unnamed.uVeilAlpha;\n    if (_e151 <= 0f) {\n        let _e153 = (*c_1);\n        return _e153;\n    }\n    let _e154 = (*c_1);\n    let _e156 = unnamed.uVeilColor;\n    let _e158 = unnamed.uVeilAlpha;\n    return mix(_e154, _e156, vec3(_e158));\n}\n\nfn applyColourGrade_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var clamped: vec3<f32>;\n    var uvw: vec3<f32>;\n\n    let _e153 = unnamed.uGradeStrength;\n    if (_e153 <= 0f) {\n        let _e155 = (*c_2);\n        return _e155;\n    }\n    let _e156 = (*c_2);\n    clamped = clamp(_e156, vec3(0f), vec3(1f));\n    let _e160 = clamped;\n    let _e162 = unnamed.uGradeSize;\n    let _e168 = unnamed.uGradeSize;\n    uvw = (((_e160 * (_e162 - 1f)) + vec3(0.5f)) / vec3(_e168));\n    let _e171 = (*c_2);\n    let _e172 = uvw;\n    let _e173 = textureSampleLevel(uGradeLut_t, uGradeLut_s, _e172, 0f);\n    let _e176 = unnamed.uGradeStrength;\n    return mix(_e171, _e173.xyz, vec3(_e176));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c_3: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e152 = (*c_3);\n    low = (_e152 * 12.92f);\n    let _e154 = (*c_3);\n    high = ((pow(max(_e154, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e160 = low;\n    let _e161 = high;\n    let _e162 = (*c_3);\n    return mix(_e160, _e161, step(vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f), _e162));\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var v: vec3<f32>;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e154 = unnamed.uOutputExposure;\n    let _e155 = (*x);\n    (*x) = (_e155 * _e154);\n    let _e157 = (*x);\n    v = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e157);\n    let _e159 = v;\n    let _e160 = v;\n    a = ((_e159 * (_e160 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e166 = v;\n    let _e167 = v;\n    b = ((_e166 * ((_e167 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e174 = a;\n    let _e175 = b;\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * (_e174 / _e175)), vec3(0f), vec3(1f));\n}\n\nfn grade_u0028_vf3_u003b(c_4: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e153 = unnamed.uOutputTransform;\n    if (_e153 == 0i) {\n        let _e155 = (*c_4);\n        return _e155;\n    }\n    let _e157 = unnamed.uOutputTransform;\n    if (_e157 == 2i) {\n        let _e159 = (*c_4);\n        param_2 = _e159;\n        let _e160 = acesFilmic_u0028_vf3_u003b((&param_2));\n        (*c_4) = _e160;\n    }\n    let _e161 = (*c_4);\n    param_3 = _e161;\n    let _e162 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e162;\n}\n\nfn withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b(c_5: ptr<function, vec3<f32>>, uv: ptr<function, vec2<f32>>, size: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var d: vec2<f32>;\n    var corner: vec2<f32>;\n    var r2_: f32;\n    var falloff: f32;\n\n    let _e157 = unnamed.uVignette;\n    if (_e157 <= 0f) {\n        let _e159 = (*c_5);\n        return _e159;\n    }\n    let _e160 = (*uv);\n    let _e163 = (*size);\n    d = ((_e160 - vec2(0.5f)) * _e163);\n    let _e165 = (*size);\n    corner = (_e165 * 0.5f);\n    let _e167 = d;\n    let _e168 = d;\n    let _e170 = corner;\n    let _e171 = corner;\n    r2_ = (dot(_e167, _e168) / dot(_e170, _e171));\n    let _e175 = unnamed.uVignette;\n    let _e176 = r2_;\n    falloff = (1f + (_e175 * _e176));\n    let _e179 = (*c_5);\n    let _e180 = falloff;\n    let _e181 = falloff;\n    return (_e179 / vec3((_e180 * _e181)));\n}\n\nfn autoExposureGain_u0028_() -> f32 {\n    var held: f32;\n    var stops: f32;\n\n    let _e152 = unnamed.uAutoExposure;\n    if (_e152 <= 0f) {\n        return 1f;\n    }\n    let _e154 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held = _e154.x;\n    let _e157 = unnamed.uAutoExposure;\n    let _e158 = held;\n    stops = (_e157 * (-2.473931f - _e158));\n    let _e161 = stops;\n    return exp2(clamp(_e161, -6f, 6f));\n}\n\nfn localBlock_u0028_vf2_u003b_f1_u003b(uv_1: ptr<function, vec2<f32>>, block: ptr<function, f32>) -> vec2<f32> {\n    var inside: vec2<f32>;\n\n    let _e152 = (*uv_1);\n    inside = clamp(_e152, vec2<f32>(0.015625f, 0.015625f), vec2<f32>(0.984375f, 0.984375f));\n    let _e154 = (*block);\n    let _e156 = inside[0u];\n    let _e160 = inside[1u];\n    let _e162 = textureSampleLevel(uExposureLocal_t, uExposureLocal_s, vec2<f32>(((_e154 + _e156) / 11f), _e160), 0f);\n    return _e162.xy;\n}\n\nfn localExposureGain_u0028_vf2_u003b_vf3_u003b(uv_2: ptr<function, vec2<f32>>, light: ptr<function, vec3<f32>>) -> f32 {\n    var held_1: f32;\n    var pixel: f32;\n    var b_1: f32;\n    var lower: f32;\n    var upper: f32;\n    var banded: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: f32;\n    var param_6: vec2<f32>;\n    var param_7: f32;\n    var tileMean: f32;\n    var param_8: vec2<f32>;\n    var param_9: f32;\n    var bilateral: f32;\n    var local: f32;\n    var local_1: f32;\n    var stops_1: f32;\n\n    let _e169 = unnamed.uLocalExposure;\n    if (_e169 <= 0f) {\n        return 1f;\n    }\n    let _e171 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held_1 = _e171.x;\n    let _e173 = (*light);\n    pixel = clamp(log2(max(dot(_e173, vec3<f32>(0.2126f, 0.7152f, 0.0722f)), 0.00000001f)), -12f, 8f);\n    let _e178 = pixel;\n    b_1 = (((_e178 - -12f) / 2f) - 0.5f);\n    let _e182 = b_1;\n    lower = clamp(floor(_e182), 0f, 9f);\n    let _e185 = lower;\n    upper = min((_e185 + 1f), 9f);\n    let _e188 = (*uv_2);\n    param_4 = _e188;\n    let _e189 = lower;\n    param_5 = _e189;\n    let _e190 = localBlock_u0028_vf2_u003b_f1_u003b((&param_4), (&param_5));\n    let _e191 = (*uv_2);\n    param_6 = _e191;\n    let _e192 = upper;\n    param_7 = _e192;\n    let _e193 = localBlock_u0028_vf2_u003b_f1_u003b((&param_6), (&param_7));\n    let _e194 = b_1;\n    let _e195 = lower;\n    banded = mix(_e190, _e193, vec2(clamp((_e194 - _e195), 0f, 1f)));\n    let _e200 = (*uv_2);\n    param_8 = _e200;\n    param_9 = 10f;\n    let _e201 = localBlock_u0028_vf2_u003b_f1_u003b((&param_8), (&param_9));\n    tileMean = _e201.x;\n    let _e204 = banded[1u];\n    if (_e204 > 0.001f) {\n        let _e207 = banded[0u];\n        let _e209 = banded[1u];\n        local = (_e207 / _e209);\n    } else {\n        let _e211 = tileMean;\n        local = _e211;\n    }\n    let _e212 = local;\n    bilateral = _e212;\n    let _e213 = bilateral;\n    let _e214 = tileMean;\n    local_1 = mix(_e213, _e214, 0.4f);\n    let _e217 = unnamed.uLocalExposure;\n    let _e218 = held_1;\n    let _e219 = local_1;\n    stops_1 = (_e217 * (_e218 - _e219));\n    let _e222 = stops_1;\n    return exp2(clamp(_e222, -3f, 3f));\n}\n\nfn finish_u0028_vf3_u003b(light_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var local_2: f32;\n    var param_10: vec2<f32>;\n    var param_11: vec3<f32>;\n    var lensed: vec3<f32>;\n    var param_12: vec3<f32>;\n    var param_13: vec2<f32>;\n    var param_14: vec2<f32>;\n    var param_15: vec3<f32>;\n    var param_16: vec3<f32>;\n    var param_17: vec3<f32>;\n    var param_18: vec3<f32>;\n    var param_19: vec2<f32>;\n\n    let _e162 = vUv_1;\n    param_10 = _e162;\n    let _e163 = (*light_1);\n    param_11 = _e163;\n    let _e164 = localExposureGain_u0028_vf2_u003b_vf3_u003b((&param_10), (&param_11));\n    local_2 = _e164;\n    let _e165 = autoExposureGain_u0028_();\n    let _e166 = local_2;\n    let _e168 = (*light_1);\n    (*light_1) = (_e168 * (_e165 * _e166));\n    let _e170 = textureDimensions(uScene_t, 0i);\n    let _e173 = (*light_1);\n    param_12 = _e173;\n    let _e174 = vUv_1;\n    param_13 = _e174;\n    param_14 = vec2<f32>(vec2<i32>(_e170));\n    let _e175 = withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b((&param_12), (&param_13), (&param_14));\n    lensed = _e175;\n    let _e176 = lensed;\n    param_15 = _e176;\n    let _e177 = grade_u0028_vf3_u003b((&param_15));\n    param_16 = _e177;\n    let _e178 = applyColourGrade_u0028_vf3_u003b((&param_16));\n    param_17 = _e178;\n    let _e179 = withVeil_u0028_vf3_u003b((&param_17));\n    param_18 = _e179;\n    let _e180 = gl_FragCoord_1;\n    param_19 = _e180.xy;\n    let _e182 = withGrain_u0028_vf3_u003b_vf2_u003b((&param_18), (&param_19));\n    return _e182;\n}\n\nfn withBloom_u0028_vf3_u003b(c_6: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e151 = unnamed.uBloomStrength;\n    if (_e151 <= 0f) {\n        let _e153 = (*c_6);\n        return _e153;\n    }\n    let _e154 = (*c_6);\n    let _e155 = vUv_1;\n    let _e156 = textureSampleLevel(uBloom_t, uBloom_s, _e155, 0f);\n    let _e159 = unnamed.uBloomStrength;\n    return (_e154 + (_e156.xyz * _e159));\n}\n\nfn circleOfConfusion_u0028_f1_u003b(viewDepth: ptr<function, f32>) -> f32 {\n    var offPlane: f32;\n\n    let _e151 = (*viewDepth);\n    let _e153 = unnamed.uFocusDistance;\n    let _e157 = unnamed.uFocusRange;\n    offPlane = (abs((_e151 - _e153)) - _e157);\n    let _e159 = offPlane;\n    let _e161 = unnamed.uFocusRange;\n    return clamp((_e159 / _e161), 0f, 1f);\n}\n\nfn viewDepthOf_u0028_vf2_u003b(uv_3: ptr<function, vec2<f32>>) -> f32 {\n    var z: f32;\n\n    let _e151 = (*uv_3);\n    let _e152 = textureSampleLevel(uDepth_t, uDepth_s, _e151, 0f);\n    z = (1f - (_e152.x * 2f));\n    let _e158 = unnamed.uDepthToView[0u];\n    let _e159 = z;\n    let _e163 = unnamed.uDepthToView[1u];\n    let _e168 = unnamed.uDepthToView[2u];\n    let _e169 = z;\n    let _e173 = unnamed.uDepthToView[3u];\n    return (-(((_e158 * _e159) + _e163)) / ((_e168 * _e169) + _e173));\n}\n\nfn dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b(direction: ptr<function, vec2<f32>>, radius: ptr<function, f32>, centreDepth: ptr<function, f32>) -> vec4<f32> {\n    var uv_4: vec2<f32>;\n    var depth: f32;\n    var param_20: vec2<f32>;\n    var weight_1: f32;\n    var local_3: f32;\n    var param_21: f32;\n\n    let _e158 = vUv_1;\n    let _e159 = (*direction);\n    let _e160 = (*radius);\n    let _e163 = unnamed.uDofAspect;\n    uv_4 = (_e158 + ((_e159 * _e160) * _e163));\n    let _e166 = uv_4;\n    param_20 = _e166;\n    let _e167 = viewDepthOf_u0028_vf2_u003b((&param_20));\n    depth = _e167;\n    let _e168 = depth;\n    let _e169 = (*centreDepth);\n    if (_e168 >= _e169) {\n        local_3 = 1f;\n    } else {\n        let _e171 = depth;\n        param_21 = _e171;\n        let _e172 = circleOfConfusion_u0028_f1_u003b((&param_21));\n        local_3 = _e172;\n    }\n    let _e173 = local_3;\n    weight_1 = _e173;\n    let _e174 = uv_4;\n    let _e175 = textureSampleLevel(uScene_t, uScene_s, _e174, 0f);\n    let _e177 = weight_1;\n    let _e178 = (_e175.xyz * _e177);\n    let _e179 = weight_1;\n    return vec4<f32>(_e178.x, _e178.y, _e178.z, _e179);\n}\n\nfn depthOfField_u0028_vf3_u003b(centre: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_1: f32;\n    var param_22: vec2<f32>;\n    var coc: f32;\n    var param_23: f32;\n    var radius_1: f32;\n    var sum: vec4<f32>;\n    var param_24: vec2<f32>;\n    var param_25: f32;\n    var param_26: f32;\n    var param_27: vec2<f32>;\n    var param_28: f32;\n    var param_29: f32;\n    var param_30: vec2<f32>;\n    var param_31: f32;\n    var param_32: f32;\n    var param_33: vec2<f32>;\n    var param_34: f32;\n    var param_35: f32;\n    var param_36: vec2<f32>;\n    var param_37: f32;\n    var param_38: f32;\n    var param_39: vec2<f32>;\n    var param_40: f32;\n    var param_41: f32;\n    var param_42: vec2<f32>;\n    var param_43: f32;\n    var param_44: f32;\n    var param_45: vec2<f32>;\n    var param_46: f32;\n    var param_47: f32;\n\n    let _e180 = vUv_1;\n    param_22 = _e180;\n    let _e181 = viewDepthOf_u0028_vf2_u003b((&param_22));\n    depth_1 = _e181;\n    let _e182 = depth_1;\n    param_23 = _e182;\n    let _e183 = circleOfConfusion_u0028_f1_u003b((&param_23));\n    coc = _e183;\n    let _e184 = coc;\n    if (_e184 <= 0f) {\n        let _e186 = (*centre);\n        return _e186;\n    }\n    let _e187 = coc;\n    let _e189 = unnamed.uDofStrength;\n    radius_1 = (_e187 * _e189);\n    let _e191 = (*centre);\n    sum = vec4<f32>(_e191.x, _e191.y, _e191.z, 1f);\n    param_24 = vec2<f32>(0.25f, 0f);\n    let _e196 = radius_1;\n    param_25 = _e196;\n    let _e197 = depth_1;\n    param_26 = _e197;\n    let _e198 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_24), (&param_25), (&param_26));\n    let _e199 = sum;\n    sum = (_e199 + _e198);\n    param_27 = vec2<f32>(-0.31929f, 0.292496f);\n    let _e201 = radius_1;\n    param_28 = _e201;\n    let _e202 = depth_1;\n    param_29 = _e202;\n    let _e203 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_27), (&param_28), (&param_29));\n    let _e204 = sum;\n    sum = (_e204 + _e203);\n    param_30 = vec2<f32>(0.048872f, -0.556877f);\n    let _e206 = radius_1;\n    param_31 = _e206;\n    let _e207 = depth_1;\n    param_32 = _e207;\n    let _e208 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_30), (&param_31), (&param_32));\n    let _e209 = sum;\n    sum = (_e209 + _e208);\n    param_33 = vec2<f32>(0.402444f, 0.524918f);\n    let _e211 = radius_1;\n    param_34 = _e211;\n    let _e212 = depth_1;\n    param_35 = _e212;\n    let _e213 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_33), (&param_34), (&param_35));\n    let _e214 = sum;\n    sum = (_e214 + _e213);\n    param_36 = vec2<f32>(-0.738535f, -0.130636f);\n    let _e216 = radius_1;\n    param_37 = _e216;\n    let _e217 = depth_1;\n    param_38 = _e217;\n    let _e218 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_36), (&param_37), (&param_38));\n    let _e219 = sum;\n    sum = (_e219 + _e218);\n    param_39 = vec2<f32>(0.699605f, -0.445031f);\n    let _e221 = radius_1;\n    param_40 = _e221;\n    let _e222 = depth_1;\n    param_41 = _e222;\n    let _e223 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_39), (&param_40), (&param_41));\n    let _e224 = sum;\n    sum = (_e224 + _e223);\n    param_42 = vec2<f32>(-0.234004f, 0.870484f);\n    let _e226 = radius_1;\n    param_43 = _e226;\n    let _e227 = depth_1;\n    param_44 = _e227;\n    let _e228 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_42), (&param_43), (&param_44));\n    let _e229 = sum;\n    sum = (_e229 + _e228);\n    param_45 = vec2<f32>(-0.446271f, -0.859268f);\n    let _e231 = radius_1;\n    param_46 = _e231;\n    let _e232 = depth_1;\n    param_47 = _e232;\n    let _e233 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_45), (&param_46), (&param_47));\n    let _e234 = sum;\n    sum = (_e234 + _e233);\n    let _e236 = sum;\n    let _e239 = sum[3u];\n    return (_e236.xyz / vec3(_e239));\n}\n\nfn cameraBlur_u0028_vf3_u003b(scene: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_2: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var velocity: vec2<f32>;\n    var distance_: f32;\n    var sum_1: vec3<f32>;\n    var i: i32;\n    var t: f32;\n\n    let _e159 = vUv_1;\n    let _e160 = textureSampleLevel(uDepth_t, uDepth_s, _e159, 0f);\n    depth_2 = _e160.x;\n    let _e162 = vUv_1;\n    let _e165 = ((_e162 * 2f) - vec2(1f));\n    let _e166 = depth_2;\n    clip = vec4<f32>(_e165.x, _e165.y, (1f - (_e166 * 2f)), 1f);\n    let _e173 = unnamed.uReprojection;\n    let _e174 = clip;\n    previous = (_e173 * _e174);\n    let _e177 = previous[3u];\n    if (_e177 <= 0f) {\n        let _e179 = (*scene);\n        return _e179;\n    }\n    let _e180 = previous;\n    let _e183 = previous[3u];\n    wasUv = (((_e180.xy / vec2(_e183)) * 0.5f) + vec2(0.5f));\n    let _e189 = vUv_1;\n    let _e190 = wasUv;\n    let _e193 = unnamed.uMotionStrength;\n    velocity = ((_e189 - _e190) * _e193);\n    let _e195 = velocity;\n    distance_ = length(_e195);\n    let _e197 = distance_;\n    if (_e197 < 0.0001f) {\n        let _e199 = (*scene);\n        return _e199;\n    }\n    let _e200 = distance_;\n    let _e202 = unnamed.uMotionMax;\n    if (_e200 > _e202) {\n        let _e205 = unnamed.uMotionMax;\n        let _e206 = distance_;\n        let _e208 = velocity;\n        velocity = (_e208 * (_e205 / _e206));\n    }\n    let _e210 = (*scene);\n    sum_1 = _e210;\n    i = 1i;\n    loop {\n        let _e211 = i;\n        if (_e211 <= 4i) {\n            let _e213 = i;\n            t = ((f32(_e213) / 4f) * 0.5f);\n            let _e217 = vUv_1;\n            let _e218 = velocity;\n            let _e219 = t;\n            let _e222 = textureSampleLevel(uScene_t, uScene_s, (_e217 + (_e218 * _e219)), 0f);\n            let _e224 = sum_1;\n            sum_1 = (_e224 + _e222.xyz);\n            let _e226 = vUv_1;\n            let _e227 = velocity;\n            let _e228 = t;\n            let _e231 = textureSampleLevel(uScene_t, uScene_s, (_e226 - (_e227 * _e228)), 0f);\n            let _e233 = sum_1;\n            sum_1 = (_e233 + _e231.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e235 = i;\n            i = (_e235 + 1i);\n        }\n    }\n    let _e237 = sum_1;\n    return (_e237 / vec3(9f));\n}\n\nfn main_1() {\n    var scene_1: vec3<f32>;\n    var param_48: vec3<f32>;\n    var param_49: vec3<f32>;\n    var ao: f32;\n    var fromCentre: vec2<f32>;\n    var radius_2: f32;\n    var inner: f32;\n    var edge: f32;\n    var amount: f32;\n    var param_50: vec3<f32>;\n    var param_51: vec3<f32>;\n    var step_: vec2<f32>;\n    var sum_2: vec3<f32>;\n    var i_1: i32;\n    var blurred: vec3<f32>;\n    var param_52: vec3<f32>;\n    var param_53: vec3<f32>;\n\n    let _e166 = vUv_1;\n    let _e167 = textureSampleLevel(uScene_t, uScene_s, _e166, 0f);\n    scene_1 = _e167.xyz;\n    let _e170 = unnamed.uMotionStrength;\n    if (_e170 > 0f) {\n        let _e172 = scene_1;\n        param_48 = _e172;\n        let _e173 = cameraBlur_u0028_vf3_u003b((&param_48));\n        scene_1 = _e173;\n    }\n    let _e175 = unnamed.uDofStrength;\n    if (_e175 > 0f) {\n        let _e177 = scene_1;\n        param_49 = _e177;\n        let _e178 = depthOfField_u0028_vf3_u003b((&param_49));\n        scene_1 = _e178;\n    }\n    let _e179 = vUv_1;\n    let _e181 = unnamed.uAoOffset;\n    let _e183 = textureSampleLevel(uAo_t, uAo_s, (_e179 + _e181), 0f);\n    let _e186 = unnamed.uAoStrength;\n    ao = mix(1f, _e183.x, _e186);\n    let _e188 = vUv_1;\n    fromCentre = (_e188 - vec2(0.5f));\n    let _e191 = fromCentre;\n    radius_2 = (length((_e191 * vec2<f32>(1f, 0.62f))) * 2f);\n    let _e196 = unnamed.uStrength;\n    inner = mix(0.62f, 0.3f, _e196);\n    let _e198 = inner;\n    let _e199 = radius_2;\n    edge = smoothstep(_e198, 1f, _e199);\n    let _e201 = edge;\n    let _e203 = unnamed.uStrength;\n    amount = (_e201 * _e203);\n    let _e205 = amount;\n    if (_e205 <= 0f) {\n        let _e207 = scene_1;\n        let _e208 = ao;\n        param_50 = (_e207 * _e208);\n        let _e210 = withBloom_u0028_vf3_u003b((&param_50));\n        param_51 = _e210;\n        let _e211 = finish_u0028_vf3_u003b((&param_51));\n        fragColor = vec4<f32>(_e211.x, _e211.y, _e211.z, 1f);\n        return;\n    }\n    let _e216 = fromCentre;\n    let _e220 = unnamed.uReach;\n    let _e222 = amount;\n    step_ = ((normalize((_e216 + vec2<f32>(0.000001f, 0.000001f))) * _e220) * _e222);\n    let _e224 = scene_1;\n    sum_2 = _e224;\n    i_1 = 1i;\n    loop {\n        let _e225 = i_1;\n        if (_e225 <= 6i) {\n            let _e227 = vUv_1;\n            let _e228 = step_;\n            let _e229 = i_1;\n            let _e234 = textureSampleLevel(uScene_t, uScene_s, (_e227 + (_e228 * (f32(_e229) / 6f))), 0f);\n            let _e236 = sum_2;\n            sum_2 = (_e236 + _e234.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e238 = i_1;\n            i_1 = (_e238 + 1i);\n        }\n    }\n    let _e240 = sum_2;\n    blurred = (_e240 / vec3(7f));\n    let _e243 = scene_1;\n    let _e244 = blurred;\n    let _e245 = amount;\n    let _e248 = ao;\n    param_52 = (mix(_e243, _e244, vec3(_e245)) * _e248);\n    let _e250 = withBloom_u0028_vf3_u003b((&param_52));\n    param_53 = _e250;\n    let _e251 = finish_u0028_vf3_u003b((&param_53));\n    fragColor = vec4<f32>(_e251.x, _e251.y, _e251.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const RUSH_BINDINGS = {
  "RUSH_FRAG": {
    "uniforms": 1,
    "uniformSize": 208,
    "fields": {
      "uStrength": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uReach": {
        "offset": 4,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 8,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 12,
        "size": 4,
        "type": "float"
      },
      "uReprojection": {
        "offset": 16,
        "size": 64,
        "type": "mat4"
      },
      "uMotionStrength": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uMotionMax": {
        "offset": 84,
        "size": 4,
        "type": "float"
      },
      "uAoStrength": {
        "offset": 88,
        "size": 4,
        "type": "float"
      },
      "uAoOffset": {
        "offset": 96,
        "size": 8,
        "type": "vec2"
      },
      "uBloomStrength": {
        "offset": 104,
        "size": 4,
        "type": "float"
      },
      "uVeilColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uVeilAlpha": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uVignette": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uGrain": {
        "offset": 136,
        "size": 8,
        "type": "vec2"
      },
      "uAutoExposure": {
        "offset": 144,
        "size": 4,
        "type": "float"
      },
      "uLocalExposure": {
        "offset": 148,
        "size": 4,
        "type": "float"
      },
      "uGradeStrength": {
        "offset": 152,
        "size": 4,
        "type": "float"
      },
      "uGradeSize": {
        "offset": 156,
        "size": 4,
        "type": "float"
      },
      "uFocusDistance": {
        "offset": 160,
        "size": 4,
        "type": "float"
      },
      "uFocusRange": {
        "offset": 164,
        "size": 4,
        "type": "float"
      },
      "uDofStrength": {
        "offset": 168,
        "size": 4,
        "type": "float"
      },
      "uDofAspect": {
        "offset": 176,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToView": {
        "offset": 192,
        "size": 16,
        "type": "vec4"
      }
    },
    "textures": {
      "uScene": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uAo": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      },
      "uBloom": {
        "texture": 38,
        "sampler": 39,
        "type": "sampler2D"
      },
      "uExposureHeld": {
        "texture": 40,
        "sampler": 41,
        "type": "sampler2D"
      },
      "uExposureLocal": {
        "texture": 42,
        "sampler": 43,
        "type": "sampler2D"
      },
      "uGradeLut": {
        "texture": 44,
        "sampler": 45,
        "type": "sampler3D"
      }
    }
  }
} as const;
