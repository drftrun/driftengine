/*
 * Generated from ../rush.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const RUSH_FRAG_WGSL = "struct Uniforms {\n    uStrength: f32,\n    uReach: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uReprojection: mat4x4<f32>,\n    uMotionStrength: f32,\n    uMotionMax: f32,\n    uAoStrength: f32,\n    uAoOffset: vec2<f32>,\n    uBloomStrength: f32,\n    uVeilColor: vec3<f32>,\n    uVeilAlpha: f32,\n    uVignette: f32,\n    uGrain: vec2<f32>,\n    uAutoExposure: f32,\n    uLocalExposure: f32,\n    uGradeStrength: f32,\n    uGradeSize: f32,\n    uFocusDistance: f32,\n    uFocusRange: f32,\n    uDofStrength: f32,\n    uDofAspect: vec2<f32>,\n    uDepthToView: vec4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(40) \nvar uExposureHeld_t: texture_2d<f32>;\n@group(0) @binding(42) \nvar uExposureLocal_t: texture_2d<f32>;\n@group(0) @binding(43) \nvar uExposureLocal_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\n@group(0) @binding(38) \nvar uBloom_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uBloom_s: sampler;\n@group(0) @binding(44) \nvar uGradeLut_t: texture_3d<f32>;\n@group(0) @binding(45) \nvar uGradeLut_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(36) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uAo_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(41) \nvar uExposureHeld_s: sampler;\n\nfn grainNoise_u0028_vu2_u003b_u1_u003b(p: ptr<function, vec2<u32>>, seed: ptr<function, u32>) -> f32 {\n    var h: u32;\n\n    let _e155 = (*p)[0u];\n    let _e158 = (*p)[1u];\n    let _e161 = (*seed);\n    h = (((_e155 * 1664525u) + (_e158 * 1013904223u)) + (_e161 * 2654435769u));\n    let _e164 = h;\n    let _e167 = h;\n    h = (_e167 ^ (_e164 >> bitcast<u32>(16u)));\n    let _e169 = h;\n    h = (_e169 * 2246822519u);\n    let _e171 = h;\n    let _e174 = h;\n    h = (_e174 ^ (_e171 >> bitcast<u32>(13u)));\n    let _e176 = h;\n    h = (_e176 * 3266489917u);\n    let _e178 = h;\n    let _e181 = h;\n    h = (_e181 ^ (_e178 >> bitcast<u32>(16u)));\n    let _e183 = h;\n    return (f32(_e183) * 0.00000000023283064f);\n}\n\nfn withGrain_u0028_vf3_u003b_vf2_u003b(c: ptr<function, vec3<f32>>, fragCoord: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var luma: f32;\n    var weight: f32;\n    var n: f32;\n    var param: vec2<u32>;\n    var param_1: u32;\n\n    let _e160 = unnamed.uGrain[0u];\n    if (_e160 <= 0f) {\n        let _e162 = (*c);\n        return _e162;\n    }\n    let _e163 = (*c);\n    luma = dot(clamp(_e163, vec3(0f), vec3(1f)), vec3<f32>(0.2126f, 0.7152f, 0.0722f));\n    let _e168 = luma;\n    let _e170 = luma;\n    weight = (0.25f + ((3f * _e168) * (1f - _e170)));\n    let _e174 = (*fragCoord);\n    let _e178 = unnamed.uGrain[1u];\n    param = vec2<u32>(_e174);\n    param_1 = u32(_e178);\n    let _e180 = grainNoise_u0028_vu2_u003b_u1_u003b((&param), (&param_1));\n    n = (_e180 - 0.5f);\n    let _e182 = (*c);\n    let _e183 = n;\n    let _e187 = unnamed.uGrain[0u];\n    let _e189 = weight;\n    return (_e182 + vec3((((2f * _e183) * _e187) * _e189)));\n}\n\nfn withVeil_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e153 = unnamed.uVeilAlpha;\n    if (_e153 <= 0f) {\n        let _e155 = (*c_1);\n        return _e155;\n    }\n    let _e156 = (*c_1);\n    let _e158 = unnamed.uVeilColor;\n    let _e160 = unnamed.uVeilAlpha;\n    return mix(_e156, _e158, vec3(_e160));\n}\n\nfn applyColourGrade_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var clamped: vec3<f32>;\n    var uvw: vec3<f32>;\n\n    let _e155 = unnamed.uGradeStrength;\n    if (_e155 <= 0f) {\n        let _e157 = (*c_2);\n        return _e157;\n    }\n    let _e158 = (*c_2);\n    clamped = clamp(_e158, vec3(0f), vec3(1f));\n    let _e162 = clamped;\n    let _e164 = unnamed.uGradeSize;\n    let _e170 = unnamed.uGradeSize;\n    uvw = (((_e162 * (_e164 - 1f)) + vec3(0.5f)) / vec3(_e170));\n    let _e173 = (*c_2);\n    let _e174 = uvw;\n    let _e175 = textureSampleLevel(uGradeLut_t, uGradeLut_s, _e174, 0f);\n    let _e178 = unnamed.uGradeStrength;\n    return mix(_e173, _e175.xyz, vec3(_e178));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c_3: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e154 = (*c_3);\n    low = (_e154 * 12.92f);\n    let _e156 = (*c_3);\n    high = ((pow(max(_e156, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e162 = low;\n    let _e163 = high;\n    let _e164 = (*c_3);\n    return mix(_e162, _e163, step(vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f), _e164));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_4: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e155 = (*c_4)[0u];\n    let _e157 = (*c_4)[1u];\n    let _e159 = (*c_4)[2u];\n    m = max(_e155, max(_e157, _e159));\n    let _e162 = m;\n    if (_e162 <= 0.8f) {\n        let _e164 = (*c_4);\n        return _e164;\n    }\n    let _e165 = m;\n    e = (_e165 - 0.8f);\n    let _e167 = (*c_4);\n    let _e168 = e;\n    let _e170 = e;\n    let _e174 = m;\n    return (_e167 * ((0.8f + ((0.2f * _e168) / (_e170 + 0.2f))) / _e174));\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var v: vec3<f32>;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e156 = unnamed.uOutputExposure;\n    let _e157 = (*x);\n    (*x) = (_e157 * _e156);\n    let _e159 = (*x);\n    v = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e159);\n    let _e161 = v;\n    let _e162 = v;\n    a = ((_e161 * (_e162 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e168 = v;\n    let _e169 = v;\n    b = ((_e168 * ((_e169 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e176 = a;\n    let _e177 = b;\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * (_e176 / _e177)), vec3(0f), vec3(1f));\n}\n\nfn grade_u0028_vf3_u003b(c_5: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec3<f32>;\n\n    let _e156 = unnamed.uOutputTransform;\n    if (_e156 == 0i) {\n        let _e158 = (*c_5);\n        return _e158;\n    }\n    let _e160 = unnamed.uOutputTransform;\n    if (_e160 == 2i) {\n        let _e162 = (*c_5);\n        param_2 = _e162;\n        let _e163 = acesFilmic_u0028_vf3_u003b((&param_2));\n        (*c_5) = _e163;\n    }\n    let _e165 = unnamed.uOutputTransform;\n    if (_e165 == 3i) {\n        let _e167 = (*c_5);\n        let _e169 = unnamed.uOutputExposure;\n        param_3 = (_e167 * _e169);\n        let _e171 = highlightShoulder_u0028_vf3_u003b((&param_3));\n        (*c_5) = _e171;\n    }\n    let _e172 = (*c_5);\n    param_4 = _e172;\n    let _e173 = linearToSrgb_u0028_vf3_u003b((&param_4));\n    return _e173;\n}\n\nfn withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b(c_6: ptr<function, vec3<f32>>, uv: ptr<function, vec2<f32>>, size: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var d: vec2<f32>;\n    var corner: vec2<f32>;\n    var r2_: f32;\n    var falloff: f32;\n\n    let _e159 = unnamed.uVignette;\n    if (_e159 <= 0f) {\n        let _e161 = (*c_6);\n        return _e161;\n    }\n    let _e162 = (*uv);\n    let _e165 = (*size);\n    d = ((_e162 - vec2(0.5f)) * _e165);\n    let _e167 = (*size);\n    corner = (_e167 * 0.5f);\n    let _e169 = d;\n    let _e170 = d;\n    let _e172 = corner;\n    let _e173 = corner;\n    r2_ = (dot(_e169, _e170) / dot(_e172, _e173));\n    let _e177 = unnamed.uVignette;\n    let _e178 = r2_;\n    falloff = (1f + (_e177 * _e178));\n    let _e181 = (*c_6);\n    let _e182 = falloff;\n    let _e183 = falloff;\n    return (_e181 / vec3((_e182 * _e183)));\n}\n\nfn autoExposureGain_u0028_() -> f32 {\n    var held: f32;\n    var stops: f32;\n\n    let _e154 = unnamed.uAutoExposure;\n    if (_e154 <= 0f) {\n        return 1f;\n    }\n    let _e156 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held = _e156.x;\n    let _e159 = unnamed.uAutoExposure;\n    let _e160 = held;\n    stops = (_e159 * (-2.473931f - _e160));\n    let _e163 = stops;\n    return exp2(clamp(_e163, -6f, 6f));\n}\n\nfn localBlock_u0028_vf2_u003b_f1_u003b(uv_1: ptr<function, vec2<f32>>, block: ptr<function, f32>) -> vec2<f32> {\n    var inside: vec2<f32>;\n\n    let _e154 = (*uv_1);\n    inside = clamp(_e154, vec2<f32>(0.015625f, 0.015625f), vec2<f32>(0.984375f, 0.984375f));\n    let _e156 = (*block);\n    let _e158 = inside[0u];\n    let _e162 = inside[1u];\n    let _e164 = textureSampleLevel(uExposureLocal_t, uExposureLocal_s, vec2<f32>(((_e156 + _e158) / 11f), _e162), 0f);\n    return _e164.xy;\n}\n\nfn localExposureGain_u0028_vf2_u003b_vf3_u003b(uv_2: ptr<function, vec2<f32>>, light: ptr<function, vec3<f32>>) -> f32 {\n    var held_1: f32;\n    var pixel: f32;\n    var b_1: f32;\n    var lower: f32;\n    var upper: f32;\n    var banded: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n    var param_7: vec2<f32>;\n    var param_8: f32;\n    var tileMean: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var bilateral: f32;\n    var local: f32;\n    var local_1: f32;\n    var stops_1: f32;\n\n    let _e171 = unnamed.uLocalExposure;\n    if (_e171 <= 0f) {\n        return 1f;\n    }\n    let _e173 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held_1 = _e173.x;\n    let _e175 = (*light);\n    pixel = clamp(log2(max(dot(_e175, vec3<f32>(0.2126f, 0.7152f, 0.0722f)), 0.00000001f)), -12f, 8f);\n    let _e180 = pixel;\n    b_1 = (((_e180 - -12f) / 2f) - 0.5f);\n    let _e184 = b_1;\n    lower = clamp(floor(_e184), 0f, 9f);\n    let _e187 = lower;\n    upper = min((_e187 + 1f), 9f);\n    let _e190 = (*uv_2);\n    param_5 = _e190;\n    let _e191 = lower;\n    param_6 = _e191;\n    let _e192 = localBlock_u0028_vf2_u003b_f1_u003b((&param_5), (&param_6));\n    let _e193 = (*uv_2);\n    param_7 = _e193;\n    let _e194 = upper;\n    param_8 = _e194;\n    let _e195 = localBlock_u0028_vf2_u003b_f1_u003b((&param_7), (&param_8));\n    let _e196 = b_1;\n    let _e197 = lower;\n    banded = mix(_e192, _e195, vec2(clamp((_e196 - _e197), 0f, 1f)));\n    let _e202 = (*uv_2);\n    param_9 = _e202;\n    param_10 = 10f;\n    let _e203 = localBlock_u0028_vf2_u003b_f1_u003b((&param_9), (&param_10));\n    tileMean = _e203.x;\n    let _e206 = banded[1u];\n    if (_e206 > 0.001f) {\n        let _e209 = banded[0u];\n        let _e211 = banded[1u];\n        local = (_e209 / _e211);\n    } else {\n        let _e213 = tileMean;\n        local = _e213;\n    }\n    let _e214 = local;\n    bilateral = _e214;\n    let _e215 = bilateral;\n    let _e216 = tileMean;\n    local_1 = mix(_e215, _e216, 0.4f);\n    let _e219 = unnamed.uLocalExposure;\n    let _e220 = held_1;\n    let _e221 = local_1;\n    stops_1 = (_e219 * (_e220 - _e221));\n    let _e224 = stops_1;\n    return exp2(clamp(_e224, -3f, 3f));\n}\n\nfn finish_u0028_vf3_u003b(light_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var local_2: f32;\n    var param_11: vec2<f32>;\n    var param_12: vec3<f32>;\n    var lensed: vec3<f32>;\n    var param_13: vec3<f32>;\n    var param_14: vec2<f32>;\n    var param_15: vec2<f32>;\n    var param_16: vec3<f32>;\n    var param_17: vec3<f32>;\n    var param_18: vec3<f32>;\n    var param_19: vec3<f32>;\n    var param_20: vec2<f32>;\n\n    let _e164 = vUv_1;\n    param_11 = _e164;\n    let _e165 = (*light_1);\n    param_12 = _e165;\n    let _e166 = localExposureGain_u0028_vf2_u003b_vf3_u003b((&param_11), (&param_12));\n    local_2 = _e166;\n    let _e167 = autoExposureGain_u0028_();\n    let _e168 = local_2;\n    let _e170 = (*light_1);\n    (*light_1) = (_e170 * (_e167 * _e168));\n    let _e172 = textureDimensions(uScene_t, 0i);\n    let _e175 = (*light_1);\n    param_13 = _e175;\n    let _e176 = vUv_1;\n    param_14 = _e176;\n    param_15 = vec2<f32>(vec2<i32>(_e172));\n    let _e177 = withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b((&param_13), (&param_14), (&param_15));\n    lensed = _e177;\n    let _e178 = lensed;\n    param_16 = _e178;\n    let _e179 = grade_u0028_vf3_u003b((&param_16));\n    param_17 = _e179;\n    let _e180 = applyColourGrade_u0028_vf3_u003b((&param_17));\n    param_18 = _e180;\n    let _e181 = withVeil_u0028_vf3_u003b((&param_18));\n    param_19 = _e181;\n    let _e182 = gl_FragCoord_1;\n    param_20 = _e182.xy;\n    let _e184 = withGrain_u0028_vf3_u003b_vf2_u003b((&param_19), (&param_20));\n    return _e184;\n}\n\nfn withBloom_u0028_vf3_u003b(c_7: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e153 = unnamed.uBloomStrength;\n    if (_e153 <= 0f) {\n        let _e155 = (*c_7);\n        return _e155;\n    }\n    let _e156 = (*c_7);\n    let _e157 = vUv_1;\n    let _e158 = textureSampleLevel(uBloom_t, uBloom_s, _e157, 0f);\n    let _e161 = unnamed.uBloomStrength;\n    return (_e156 + (_e158.xyz * _e161));\n}\n\nfn circleOfConfusion_u0028_f1_u003b(viewDepth: ptr<function, f32>) -> f32 {\n    var offPlane: f32;\n\n    let _e153 = (*viewDepth);\n    let _e155 = unnamed.uFocusDistance;\n    let _e159 = unnamed.uFocusRange;\n    offPlane = (abs((_e153 - _e155)) - _e159);\n    let _e161 = offPlane;\n    let _e163 = unnamed.uFocusRange;\n    return clamp((_e161 / _e163), 0f, 1f);\n}\n\nfn viewDepthOf_u0028_vf2_u003b(uv_3: ptr<function, vec2<f32>>) -> f32 {\n    var z: f32;\n\n    let _e153 = (*uv_3);\n    let _e154 = textureSampleLevel(uDepth_t, uDepth_s, _e153, 0f);\n    z = (1f - (_e154.x * 2f));\n    let _e160 = unnamed.uDepthToView[0u];\n    let _e161 = z;\n    let _e165 = unnamed.uDepthToView[1u];\n    let _e170 = unnamed.uDepthToView[2u];\n    let _e171 = z;\n    let _e175 = unnamed.uDepthToView[3u];\n    return (-(((_e160 * _e161) + _e165)) / ((_e170 * _e171) + _e175));\n}\n\nfn dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b(direction: ptr<function, vec2<f32>>, radius: ptr<function, f32>, centreDepth: ptr<function, f32>) -> vec4<f32> {\n    var uv_4: vec2<f32>;\n    var depth: f32;\n    var param_21: vec2<f32>;\n    var weight_1: f32;\n    var local_3: f32;\n    var param_22: f32;\n\n    let _e160 = vUv_1;\n    let _e161 = (*direction);\n    let _e162 = (*radius);\n    let _e165 = unnamed.uDofAspect;\n    uv_4 = (_e160 + ((_e161 * _e162) * _e165));\n    let _e168 = uv_4;\n    param_21 = _e168;\n    let _e169 = viewDepthOf_u0028_vf2_u003b((&param_21));\n    depth = _e169;\n    let _e170 = depth;\n    let _e171 = (*centreDepth);\n    if (_e170 >= _e171) {\n        local_3 = 1f;\n    } else {\n        let _e173 = depth;\n        param_22 = _e173;\n        let _e174 = circleOfConfusion_u0028_f1_u003b((&param_22));\n        local_3 = _e174;\n    }\n    let _e175 = local_3;\n    weight_1 = _e175;\n    let _e176 = uv_4;\n    let _e177 = textureSampleLevel(uScene_t, uScene_s, _e176, 0f);\n    let _e179 = weight_1;\n    let _e180 = (_e177.xyz * _e179);\n    let _e181 = weight_1;\n    return vec4<f32>(_e180.x, _e180.y, _e180.z, _e181);\n}\n\nfn depthOfField_u0028_vf3_u003b(centre: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_1: f32;\n    var param_23: vec2<f32>;\n    var coc: f32;\n    var param_24: f32;\n    var radius_1: f32;\n    var sum: vec4<f32>;\n    var param_25: vec2<f32>;\n    var param_26: f32;\n    var param_27: f32;\n    var param_28: vec2<f32>;\n    var param_29: f32;\n    var param_30: f32;\n    var param_31: vec2<f32>;\n    var param_32: f32;\n    var param_33: f32;\n    var param_34: vec2<f32>;\n    var param_35: f32;\n    var param_36: f32;\n    var param_37: vec2<f32>;\n    var param_38: f32;\n    var param_39: f32;\n    var param_40: vec2<f32>;\n    var param_41: f32;\n    var param_42: f32;\n    var param_43: vec2<f32>;\n    var param_44: f32;\n    var param_45: f32;\n    var param_46: vec2<f32>;\n    var param_47: f32;\n    var param_48: f32;\n\n    let _e182 = vUv_1;\n    param_23 = _e182;\n    let _e183 = viewDepthOf_u0028_vf2_u003b((&param_23));\n    depth_1 = _e183;\n    let _e184 = depth_1;\n    param_24 = _e184;\n    let _e185 = circleOfConfusion_u0028_f1_u003b((&param_24));\n    coc = _e185;\n    let _e186 = coc;\n    if (_e186 <= 0f) {\n        let _e188 = (*centre);\n        return _e188;\n    }\n    let _e189 = coc;\n    let _e191 = unnamed.uDofStrength;\n    radius_1 = (_e189 * _e191);\n    let _e193 = (*centre);\n    sum = vec4<f32>(_e193.x, _e193.y, _e193.z, 1f);\n    param_25 = vec2<f32>(0.25f, 0f);\n    let _e198 = radius_1;\n    param_26 = _e198;\n    let _e199 = depth_1;\n    param_27 = _e199;\n    let _e200 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_25), (&param_26), (&param_27));\n    let _e201 = sum;\n    sum = (_e201 + _e200);\n    param_28 = vec2<f32>(-0.31929f, 0.292496f);\n    let _e203 = radius_1;\n    param_29 = _e203;\n    let _e204 = depth_1;\n    param_30 = _e204;\n    let _e205 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_28), (&param_29), (&param_30));\n    let _e206 = sum;\n    sum = (_e206 + _e205);\n    param_31 = vec2<f32>(0.048872f, -0.556877f);\n    let _e208 = radius_1;\n    param_32 = _e208;\n    let _e209 = depth_1;\n    param_33 = _e209;\n    let _e210 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_31), (&param_32), (&param_33));\n    let _e211 = sum;\n    sum = (_e211 + _e210);\n    param_34 = vec2<f32>(0.402444f, 0.524918f);\n    let _e213 = radius_1;\n    param_35 = _e213;\n    let _e214 = depth_1;\n    param_36 = _e214;\n    let _e215 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_34), (&param_35), (&param_36));\n    let _e216 = sum;\n    sum = (_e216 + _e215);\n    param_37 = vec2<f32>(-0.738535f, -0.130636f);\n    let _e218 = radius_1;\n    param_38 = _e218;\n    let _e219 = depth_1;\n    param_39 = _e219;\n    let _e220 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_37), (&param_38), (&param_39));\n    let _e221 = sum;\n    sum = (_e221 + _e220);\n    param_40 = vec2<f32>(0.699605f, -0.445031f);\n    let _e223 = radius_1;\n    param_41 = _e223;\n    let _e224 = depth_1;\n    param_42 = _e224;\n    let _e225 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_40), (&param_41), (&param_42));\n    let _e226 = sum;\n    sum = (_e226 + _e225);\n    param_43 = vec2<f32>(-0.234004f, 0.870484f);\n    let _e228 = radius_1;\n    param_44 = _e228;\n    let _e229 = depth_1;\n    param_45 = _e229;\n    let _e230 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_43), (&param_44), (&param_45));\n    let _e231 = sum;\n    sum = (_e231 + _e230);\n    param_46 = vec2<f32>(-0.446271f, -0.859268f);\n    let _e233 = radius_1;\n    param_47 = _e233;\n    let _e234 = depth_1;\n    param_48 = _e234;\n    let _e235 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_46), (&param_47), (&param_48));\n    let _e236 = sum;\n    sum = (_e236 + _e235);\n    let _e238 = sum;\n    let _e241 = sum[3u];\n    return (_e238.xyz / vec3(_e241));\n}\n\nfn cameraBlur_u0028_vf3_u003b(scene: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_2: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var velocity: vec2<f32>;\n    var distance_: f32;\n    var sum_1: vec3<f32>;\n    var i: i32;\n    var t: f32;\n\n    let _e161 = vUv_1;\n    let _e162 = textureSampleLevel(uDepth_t, uDepth_s, _e161, 0f);\n    depth_2 = _e162.x;\n    let _e164 = vUv_1;\n    let _e167 = ((_e164 * 2f) - vec2(1f));\n    let _e168 = depth_2;\n    clip = vec4<f32>(_e167.x, _e167.y, (1f - (_e168 * 2f)), 1f);\n    let _e175 = unnamed.uReprojection;\n    let _e176 = clip;\n    previous = (_e175 * _e176);\n    let _e179 = previous[3u];\n    if (_e179 <= 0f) {\n        let _e181 = (*scene);\n        return _e181;\n    }\n    let _e182 = previous;\n    let _e185 = previous[3u];\n    wasUv = (((_e182.xy / vec2(_e185)) * 0.5f) + vec2(0.5f));\n    let _e191 = vUv_1;\n    let _e192 = wasUv;\n    let _e195 = unnamed.uMotionStrength;\n    velocity = ((_e191 - _e192) * _e195);\n    let _e197 = velocity;\n    distance_ = length(_e197);\n    let _e199 = distance_;\n    if (_e199 < 0.0001f) {\n        let _e201 = (*scene);\n        return _e201;\n    }\n    let _e202 = distance_;\n    let _e204 = unnamed.uMotionMax;\n    if (_e202 > _e204) {\n        let _e207 = unnamed.uMotionMax;\n        let _e208 = distance_;\n        let _e210 = velocity;\n        velocity = (_e210 * (_e207 / _e208));\n    }\n    let _e212 = (*scene);\n    sum_1 = _e212;\n    i = 1i;\n    loop {\n        let _e213 = i;\n        if (_e213 <= 4i) {\n            let _e215 = i;\n            t = ((f32(_e215) / 4f) * 0.5f);\n            let _e219 = vUv_1;\n            let _e220 = velocity;\n            let _e221 = t;\n            let _e224 = textureSampleLevel(uScene_t, uScene_s, (_e219 + (_e220 * _e221)), 0f);\n            let _e226 = sum_1;\n            sum_1 = (_e226 + _e224.xyz);\n            let _e228 = vUv_1;\n            let _e229 = velocity;\n            let _e230 = t;\n            let _e233 = textureSampleLevel(uScene_t, uScene_s, (_e228 - (_e229 * _e230)), 0f);\n            let _e235 = sum_1;\n            sum_1 = (_e235 + _e233.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e237 = i;\n            i = (_e237 + 1i);\n        }\n    }\n    let _e239 = sum_1;\n    return (_e239 / vec3(9f));\n}\n\nfn main_1() {\n    var sampled: vec4<f32>;\n    var scene_1: vec3<f32>;\n    var param_49: vec3<f32>;\n    var param_50: vec3<f32>;\n    var share: f32;\n    var ao: f32;\n    var fromCentre: vec2<f32>;\n    var radius_2: f32;\n    var inner: f32;\n    var edge: f32;\n    var amount: f32;\n    var param_51: vec3<f32>;\n    var param_52: vec3<f32>;\n    var step_: vec2<f32>;\n    var sum_2: vec3<f32>;\n    var i_1: i32;\n    var blurred: vec3<f32>;\n    var param_53: vec3<f32>;\n    var param_54: vec3<f32>;\n\n    let _e170 = vUv_1;\n    let _e171 = textureSampleLevel(uScene_t, uScene_s, _e170, 0f);\n    sampled = _e171;\n    let _e172 = sampled;\n    scene_1 = _e172.xyz;\n    let _e175 = unnamed.uMotionStrength;\n    if (_e175 > 0f) {\n        let _e177 = scene_1;\n        param_49 = _e177;\n        let _e178 = cameraBlur_u0028_vf3_u003b((&param_49));\n        scene_1 = _e178;\n    }\n    let _e180 = unnamed.uDofStrength;\n    if (_e180 > 0f) {\n        let _e182 = scene_1;\n        param_50 = _e182;\n        let _e183 = depthOfField_u0028_vf3_u003b((&param_50));\n        scene_1 = _e183;\n    }\n    let _e185 = sampled[3u];\n    share = clamp(_e185, 0f, 1f);\n    let _e187 = vUv_1;\n    let _e189 = unnamed.uAoOffset;\n    let _e191 = textureSampleLevel(uAo_t, uAo_s, (_e187 + _e189), 0f);\n    let _e194 = unnamed.uAoStrength;\n    let _e195 = share;\n    ao = mix(1f, _e191.x, (_e194 * _e195));\n    let _e198 = vUv_1;\n    fromCentre = (_e198 - vec2(0.5f));\n    let _e201 = fromCentre;\n    radius_2 = (length((_e201 * vec2<f32>(1f, 0.62f))) * 2f);\n    let _e206 = unnamed.uStrength;\n    inner = mix(0.62f, 0.3f, _e206);\n    let _e208 = inner;\n    let _e209 = radius_2;\n    edge = smoothstep(_e208, 1f, _e209);\n    let _e211 = edge;\n    let _e213 = unnamed.uStrength;\n    amount = (_e211 * _e213);\n    let _e215 = amount;\n    if (_e215 <= 0f) {\n        let _e217 = scene_1;\n        let _e218 = ao;\n        param_51 = (_e217 * _e218);\n        let _e220 = withBloom_u0028_vf3_u003b((&param_51));\n        param_52 = _e220;\n        let _e221 = finish_u0028_vf3_u003b((&param_52));\n        fragColor = vec4<f32>(_e221.x, _e221.y, _e221.z, 1f);\n        return;\n    }\n    let _e226 = fromCentre;\n    let _e230 = unnamed.uReach;\n    let _e232 = amount;\n    step_ = ((normalize((_e226 + vec2<f32>(0.000001f, 0.000001f))) * _e230) * _e232);\n    let _e234 = scene_1;\n    sum_2 = _e234;\n    i_1 = 1i;\n    loop {\n        let _e235 = i_1;\n        if (_e235 <= 6i) {\n            let _e237 = vUv_1;\n            let _e238 = step_;\n            let _e239 = i_1;\n            let _e244 = textureSampleLevel(uScene_t, uScene_s, (_e237 + (_e238 * (f32(_e239) / 6f))), 0f);\n            let _e246 = sum_2;\n            sum_2 = (_e246 + _e244.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e248 = i_1;\n            i_1 = (_e248 + 1i);\n        }\n    }\n    let _e250 = sum_2;\n    blurred = (_e250 / vec3(7f));\n    let _e253 = scene_1;\n    let _e254 = blurred;\n    let _e255 = amount;\n    let _e258 = ao;\n    param_53 = (mix(_e253, _e254, vec3(_e255)) * _e258);\n    let _e260 = withBloom_u0028_vf3_u003b((&param_53));\n    param_54 = _e260;\n    let _e261 = finish_u0028_vf3_u003b((&param_54));\n    fragColor = vec4<f32>(_e261.x, _e261.y, _e261.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

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
