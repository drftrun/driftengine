/*
 * Generated from ../rush.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const RUSH_FRAG_WGSL = "struct Uniforms {\n    uStrength: f32,\n    uReach: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uFilmA: vec4<f32>,\n    uFilmB: vec4<f32>,\n    uDisplayHeadroom: f32,\n    uReprojection: mat4x4<f32>,\n    uMotionStrength: f32,\n    uMotionMax: f32,\n    uObjectMotion: f32,\n    uAoStrength: f32,\n    uAoOffset: vec2<f32>,\n    uBloomStrength: f32,\n    uVeilColor: vec3<f32>,\n    uVeilAlpha: f32,\n    uVignette: f32,\n    uGrain: vec2<f32>,\n    uAutoExposure: f32,\n    uLocalExposure: f32,\n    uGradeStrength: f32,\n    uGradeSize: f32,\n    uFocusDistance: f32,\n    uFocusRange: f32,\n    uDofStrength: f32,\n    uDofAspect: vec2<f32>,\n    uDepthToView: vec4<f32>,\n    uFringe: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(42) \nvar uExposureHeld_t: texture_2d<f32>;\n@group(0) @binding(44) \nvar uExposureLocal_t: texture_2d<f32>;\n@group(0) @binding(45) \nvar uExposureLocal_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\n@group(0) @binding(40) \nvar uBloom_t: texture_2d<f32>;\n@group(0) @binding(41) \nvar uBloom_s: sampler;\n@group(0) @binding(46) \nvar uGradeLut_t: texture_3d<f32>;\n@group(0) @binding(47) \nvar uGradeLut_s: sampler;\n@group(0) @binding(36) \nvar uMotion_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uMotion_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(38) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uAo_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(43) \nvar uExposureHeld_s: sampler;\n\nfn grainNoise_u0028_vu2_u003b_u1_u003b(p: ptr<function, vec2<u32>>, seed: ptr<function, u32>) -> f32 {\n    var h: u32;\n\n    let _e234 = (*p)[0u];\n    let _e237 = (*p)[1u];\n    let _e240 = (*seed);\n    h = (((_e234 * 1664525u) + (_e237 * 1013904223u)) + (_e240 * 2654435769u));\n    let _e243 = h;\n    let _e246 = h;\n    h = (_e246 ^ (_e243 >> bitcast<u32>(16u)));\n    let _e248 = h;\n    h = (_e248 * 2246822519u);\n    let _e250 = h;\n    let _e253 = h;\n    h = (_e253 ^ (_e250 >> bitcast<u32>(13u)));\n    let _e255 = h;\n    h = (_e255 * 3266489917u);\n    let _e257 = h;\n    let _e260 = h;\n    h = (_e260 ^ (_e257 >> bitcast<u32>(16u)));\n    let _e262 = h;\n    return (f32(_e262) * 0.00000000023283064f);\n}\n\nfn withGrain_u0028_vf3_u003b_vf2_u003b(c: ptr<function, vec3<f32>>, fragCoord: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var luma: f32;\n    var weight: f32;\n    var n: f32;\n    var param: vec2<u32>;\n    var param_1: u32;\n\n    let _e239 = unnamed.uGrain[0u];\n    if (_e239 <= 0f) {\n        let _e241 = (*c);\n        return _e241;\n    }\n    let _e242 = (*c);\n    luma = dot(clamp(_e242, vec3(0f), vec3(1f)), vec3<f32>(0.2126f, 0.7152f, 0.0722f));\n    let _e247 = luma;\n    let _e249 = luma;\n    weight = (0.25f + ((3f * _e247) * (1f - _e249)));\n    let _e253 = (*fragCoord);\n    let _e257 = unnamed.uGrain[1u];\n    param = vec2<u32>(_e253);\n    param_1 = u32(_e257);\n    let _e259 = grainNoise_u0028_vu2_u003b_u1_u003b((&param), (&param_1));\n    n = (_e259 - 0.5f);\n    let _e261 = (*c);\n    let _e262 = n;\n    let _e266 = unnamed.uGrain[0u];\n    let _e268 = weight;\n    return (_e261 + vec3((((2f * _e262) * _e266) * _e268)));\n}\n\nfn withVeil_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e232 = unnamed.uVeilAlpha;\n    if (_e232 <= 0f) {\n        let _e234 = (*c_1);\n        return _e234;\n    }\n    let _e235 = (*c_1);\n    let _e237 = unnamed.uVeilColor;\n    let _e239 = unnamed.uVeilAlpha;\n    return mix(_e235, _e237, vec3(_e239));\n}\n\nfn applyColourGrade_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var over: f32;\n    var local: f32;\n    var clamped: vec3<f32>;\n    var uvw: vec3<f32>;\n\n    let _e236 = unnamed.uGradeStrength;\n    if (_e236 <= 0f) {\n        let _e238 = (*c_2);\n        return _e238;\n    }\n    let _e240 = unnamed.uDisplayHeadroom;\n    if (_e240 > 1f) {\n        let _e243 = (*c_2)[0u];\n        let _e245 = (*c_2)[1u];\n        let _e247 = (*c_2)[2u];\n        local = max(max(_e243, max(_e245, _e247)), 1f);\n    } else {\n        local = 1f;\n    }\n    let _e251 = local;\n    over = _e251;\n    let _e252 = (*c_2);\n    let _e253 = over;\n    clamped = clamp((_e252 / vec3(_e253)), vec3(0f), vec3(1f));\n    let _e259 = clamped;\n    let _e261 = unnamed.uGradeSize;\n    let _e267 = unnamed.uGradeSize;\n    uvw = (((_e259 * (_e261 - 1f)) + vec3(0.5f)) / vec3(_e267));\n    let _e270 = (*c_2);\n    let _e271 = uvw;\n    let _e272 = textureSampleLevel(uGradeLut_t, uGradeLut_s, _e271, 0f);\n    let _e274 = over;\n    let _e277 = unnamed.uGradeStrength;\n    return mix(_e270, (_e272.xyz * _e274), vec3(_e277));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c_3: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e233 = (*c_3);\n    low = (_e233 * 12.92f);\n    let _e235 = (*c_3);\n    high = ((pow(max(_e235, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e241 = low;\n    let _e242 = high;\n    let _e243 = (*c_3);\n    return mix(_e241, _e242, step(vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f), _e243));\n}\n\nfn filmCentredHue_u0028_vf3_u003b(c_4: ptr<function, vec3<f32>>) -> f32 {\n    var y: f32;\n    var x: f32;\n    var phi_889_: bool;\n\n    let _e234 = (*c_4)[1u];\n    let _e236 = (*c_4)[2u];\n    y = (1.7320508f * (_e234 - _e236));\n    let _e240 = (*c_4)[0u];\n    let _e243 = (*c_4)[1u];\n    let _e246 = (*c_4)[2u];\n    x = (((2f * _e240) - _e243) - _e246);\n    let _e248 = x;\n    let _e250 = (abs(_e248) < 0.0000000001f);\n    phi_889_ = _e250;\n    if _e250 {\n        let _e251 = y;\n        phi_889_ = (abs(_e251) < 0.0000000001f);\n    }\n    let _e255 = phi_889_;\n    if _e255 {\n        return 0f;\n    }\n    let _e256 = y;\n    let _e257 = x;\n    return degrees(atan2(_e256, _e257));\n}\n\nfn filmGlow_u0028_f1_u003b_f1_u003b_f1_u003b(yc: ptr<function, f32>, gain: ptr<function, f32>, mid: ptr<function, f32>) -> f32 {\n    let _e233 = (*yc);\n    let _e234 = (*mid);\n    if (_e233 <= (0.6666667f * _e234)) {\n        let _e237 = (*gain);\n        return _e237;\n    }\n    let _e238 = (*yc);\n    let _e239 = (*mid);\n    if (_e238 >= (2f * _e239)) {\n        return 0f;\n    }\n    let _e242 = (*gain);\n    let _e243 = (*mid);\n    let _e244 = (*yc);\n    return (_e242 * ((_e243 / _e244) - 0.5f));\n}\n\nfn filmSigmoid_u0028_f1_u003b(x_1: ptr<function, f32>) -> f32 {\n    var t: f32;\n\n    let _e232 = (*x_1);\n    t = max((1f - abs((_e232 / 2f))), 0f);\n    let _e237 = (*x_1);\n    let _e239 = t;\n    let _e240 = t;\n    return ((1f + (sign(_e237) * (1f - (_e239 * _e240)))) / 2f);\n}\n\nfn filmYc_u0028_vf3_u003b(c_5: ptr<function, vec3<f32>>) -> f32 {\n    var chroma: f32;\n\n    let _e233 = (*c_5)[2u];\n    let _e235 = (*c_5)[2u];\n    let _e237 = (*c_5)[1u];\n    let _e241 = (*c_5)[1u];\n    let _e243 = (*c_5)[1u];\n    let _e245 = (*c_5)[0u];\n    let _e250 = (*c_5)[0u];\n    let _e252 = (*c_5)[0u];\n    let _e254 = (*c_5)[2u];\n    chroma = sqrt(max((((_e233 * (_e235 - _e237)) + (_e241 * (_e243 - _e245))) + (_e250 * (_e252 - _e254))), 0f));\n    let _e261 = (*c_5)[2u];\n    let _e263 = (*c_5)[1u];\n    let _e266 = (*c_5)[0u];\n    let _e268 = chroma;\n    return ((((_e261 + _e263) + _e266) + (1.75f * _e268)) / 3f);\n}\n\nfn filmSaturation_u0028_vf3_u003b(c_6: ptr<function, vec3<f32>>) -> f32 {\n    var hi: f32;\n    var lo: f32;\n\n    let _e234 = (*c_6)[0u];\n    let _e236 = (*c_6)[1u];\n    let _e238 = (*c_6)[2u];\n    hi = max(_e234, max(_e236, _e238));\n    let _e242 = (*c_6)[0u];\n    let _e244 = (*c_6)[1u];\n    let _e246 = (*c_6)[2u];\n    lo = min(_e242, min(_e244, _e246));\n    let _e249 = hi;\n    let _e251 = lo;\n    let _e254 = hi;\n    return ((max(_e249, 0.0000000001f) - max(_e251, 0.0000000001f)) / max(_e254, 0.01f));\n}\n\nfn filmicCurve_u0028_vf3_u003b(linear: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var ap0_: vec3<f32>;\n    var saturation: f32;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: f32;\n    var param_5: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var weight_1: f32;\n    var param_8: vec3<f32>;\n    var work: vec3<f32>;\n    var slope: f32;\n    var black: f32;\n    var white: f32;\n    var toeScale: f32;\n    var shoulderScale: f32;\n    var toeMatch: f32;\n    var straightMatch: f32;\n    var shoulderMatch: f32;\n    var logc: vec3<f32>;\n    var straight: vec3<f32>;\n    var toeC: vec3<f32>;\n    var shoulderC: vec3<f32>;\n    var t_1: vec3<f32>;\n    var tone: vec3<f32>;\n    var ceiling: f32;\n    var local_1: f32;\n\n    let _e258 = (*linear);\n    ap0_ = (mat3x3<f32>(vec3<f32>(0.6954522f, 0.044794563f, -0.005525883f), vec3<f32>(0.1406787f, 0.8596711f, 0.00402521f), vec3<f32>(0.16386907f, 0.09553432f, 1.0015007f)) * (mat3x3<f32>(vec3<f32>(0.61319f, 0.07021f, 0.02062f), vec3<f32>(0.33951f, 0.91634f, 0.10957f), vec3<f32>(0.04737f, 0.01345f, 0.86961f)) * _e258));\n    let _e261 = ap0_;\n    param_2 = _e261;\n    let _e262 = filmSaturation_u0028_vf3_u003b((&param_2));\n    saturation = _e262;\n    let _e263 = ap0_;\n    param_3 = _e263;\n    let _e264 = filmYc_u0028_vf3_u003b((&param_3));\n    let _e265 = saturation;\n    param_4 = ((_e265 - 0.4f) / 0.2f);\n    let _e268 = filmSigmoid_u0028_f1_u003b((&param_4));\n    param_5 = _e264;\n    param_6 = (0.05f * _e268);\n    param_7 = 0.08f;\n    let _e270 = filmGlow_u0028_f1_u003b_f1_u003b_f1_u003b((&param_5), (&param_6), (&param_7));\n    let _e272 = ap0_;\n    ap0_ = (_e272 * (1f + _e270));\n    let _e274 = ap0_;\n    param_8 = _e274;\n    let _e275 = filmCentredHue_u0028_vf3_u003b((&param_8));\n    weight_1 = smoothstep(0f, 1f, (1f - abs(((2f * _e275) / 135f))));\n    let _e281 = weight_1;\n    let _e282 = weight_1;\n    let _e284 = saturation;\n    let _e287 = ap0_[0u];\n    let _e292 = ap0_[0u];\n    ap0_[0u] = (_e292 + ((((_e281 * _e282) * _e284) * (0.03f - _e287)) * 0.18f));\n    let _e295 = ap0_;\n    work = max((mat3x3<f32>(vec3<f32>(1.4514393f, -0.07655378f, 0.008316148f), vec3<f32>(-0.23651075f, 1.1762297f, -0.0060324497f), vec3<f32>(-0.21492857f, -0.09967592f, 0.9977163f)) * _e295), vec3<f32>(0f, 0f, 0f));\n    let _e298 = work;\n    let _e301 = work;\n    work = mix(vec3(dot(_e298, vec3<f32>(0.27222872f, 0.67408174f, 0.053689517f))), _e301, vec3(0.96f));\n    let _e306 = unnamed.uFilmA[0u];\n    slope = _e306;\n    let _e309 = unnamed.uFilmA[1u];\n    black = _e309;\n    let _e312 = unnamed.uFilmA[2u];\n    white = _e312;\n    let _e315 = unnamed.uFilmA[3u];\n    toeScale = _e315;\n    let _e318 = unnamed.uFilmB[0u];\n    shoulderScale = _e318;\n    let _e321 = unnamed.uFilmB[1u];\n    toeMatch = _e321;\n    let _e324 = unnamed.uFilmB[2u];\n    straightMatch = _e324;\n    let _e327 = unnamed.uFilmB[3u];\n    shoulderMatch = _e327;\n    let _e328 = work;\n    logc = (log2(max(_e328, vec3<f32>(0.0000000001f, 0.0000000001f, 0.0000000001f))) * 0.30103f);\n    let _e332 = slope;\n    let _e333 = logc;\n    let _e334 = straightMatch;\n    straight = ((_e333 + vec3(_e334)) * _e332);\n    let _e338 = black;\n    let _e340 = toeScale;\n    let _e342 = slope;\n    let _e344 = toeScale;\n    let _e346 = logc;\n    let _e347 = toeMatch;\n    toeC = (vec3(-(_e338)) + (vec3((2f * _e340)) / (vec3(1f) + exp(((_e346 - vec3(_e347)) * ((-2f * _e342) / _e344))))));\n    let _e358 = white;\n    let _e360 = shoulderScale;\n    let _e362 = slope;\n    let _e364 = shoulderScale;\n    let _e366 = logc;\n    let _e367 = shoulderMatch;\n    shoulderC = (vec3((1f + _e358)) - (vec3((2f * _e360)) / (vec3(1f) + exp(((_e366 - vec3(_e367)) * ((2f * _e362) / _e364))))));\n    let _e378 = straight;\n    let _e379 = toeC;\n    let _e380 = logc;\n    let _e381 = toeMatch;\n    toeC = mix(_e378, _e379, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e380 < vec3(_e381))));\n    let _e386 = straight;\n    let _e387 = shoulderC;\n    let _e388 = logc;\n    let _e389 = shoulderMatch;\n    shoulderC = mix(_e386, _e387, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e388 > vec3(_e389))));\n    let _e394 = logc;\n    let _e395 = toeMatch;\n    let _e398 = shoulderMatch;\n    let _e399 = toeMatch;\n    t_1 = clamp(((_e394 - vec3(_e395)) / vec3((_e398 - _e399))), vec3(0f), vec3(1f));\n    let _e406 = shoulderMatch;\n    let _e407 = toeMatch;\n    if (_e406 < _e407) {\n        let _e409 = t_1;\n        t_1 = (vec3(1f) - _e409);\n    }\n    let _e412 = t_1;\n    let _e416 = t_1;\n    let _e418 = t_1;\n    t_1 = (((vec3(3f) - (_e412 * 2f)) * _e416) * _e418);\n    let _e420 = toeC;\n    let _e421 = shoulderC;\n    let _e422 = t_1;\n    tone = mix(_e420, _e421, _e422);\n    let _e424 = tone;\n    let _e427 = tone;\n    tone = mix(vec3(dot(_e424, vec3<f32>(0.27222872f, 0.67408174f, 0.053689517f))), _e427, vec3(0.93f));\n    let _e431 = unnamed.uDisplayHeadroom;\n    if (_e431 > 1f) {\n        let _e433 = white;\n        local_1 = (1f + _e433);\n    } else {\n        local_1 = 1f;\n    }\n    let _e435 = local_1;\n    ceiling = _e435;\n    let _e436 = tone;\n    let _e439 = ceiling;\n    return clamp((mat3x3<f32>(vec3<f32>(1.7048f, -0.13027f, -0.02401f), vec3<f32>(-0.62168f, 1.14082f, -0.129f), vec3<f32>(-0.08325f, -0.01055f, 1.15324f)) * max(_e436, vec3<f32>(0f, 0f, 0f))), vec3(0f), vec3(_e439));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_7: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e234 = (*c_7)[0u];\n    let _e236 = (*c_7)[1u];\n    let _e238 = (*c_7)[2u];\n    m = max(_e234, max(_e236, _e238));\n    let _e241 = m;\n    if (_e241 <= 0.8f) {\n        let _e243 = (*c_7);\n        return _e243;\n    }\n    let _e244 = m;\n    e = (_e244 - 0.8f);\n    let _e246 = (*c_7);\n    let _e247 = e;\n    let _e249 = e;\n    let _e253 = m;\n    return (_e246 * ((0.8f + ((0.2f * _e247) / (_e249 + 0.2f))) / _e253));\n}\n\nfn acesFilmic_u0028_vf3_u003b(x_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var v: vec3<f32>;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e235 = unnamed.uOutputExposure;\n    let _e236 = (*x_2);\n    (*x_2) = (_e236 * _e235);\n    let _e238 = (*x_2);\n    v = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e238);\n    let _e240 = v;\n    let _e241 = v;\n    a = ((_e240 * (_e241 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e247 = v;\n    let _e248 = v;\n    b = ((_e247 * ((_e248 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e255 = a;\n    let _e256 = b;\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * (_e255 / _e256)), vec3(0f), vec3(1f));\n}\n\nfn grade_u0028_vf3_u003b(c_8: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_9: vec3<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var param_12: vec3<f32>;\n\n    let _e236 = unnamed.uOutputTransform;\n    if (_e236 == 0i) {\n        let _e238 = (*c_8);\n        return _e238;\n    }\n    let _e240 = unnamed.uOutputTransform;\n    if (_e240 == 2i) {\n        let _e242 = (*c_8);\n        param_9 = _e242;\n        let _e243 = acesFilmic_u0028_vf3_u003b((&param_9));\n        (*c_8) = _e243;\n    }\n    let _e245 = unnamed.uOutputTransform;\n    if (_e245 == 3i) {\n        let _e247 = (*c_8);\n        let _e249 = unnamed.uOutputExposure;\n        param_10 = (_e247 * _e249);\n        let _e251 = highlightShoulder_u0028_vf3_u003b((&param_10));\n        (*c_8) = _e251;\n    }\n    let _e253 = unnamed.uOutputTransform;\n    if (_e253 == 4i) {\n        let _e255 = (*c_8);\n        let _e257 = unnamed.uOutputExposure;\n        param_11 = (_e255 * _e257);\n        let _e259 = filmicCurve_u0028_vf3_u003b((&param_11));\n        (*c_8) = _e259;\n    }\n    let _e260 = (*c_8);\n    param_12 = _e260;\n    let _e261 = linearToSrgb_u0028_vf3_u003b((&param_12));\n    return _e261;\n}\n\nfn withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b(c_9: ptr<function, vec3<f32>>, uv: ptr<function, vec2<f32>>, size: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var d: vec2<f32>;\n    var corner: vec2<f32>;\n    var r2_: f32;\n    var falloff: f32;\n\n    let _e238 = unnamed.uVignette;\n    if (_e238 <= 0f) {\n        let _e240 = (*c_9);\n        return _e240;\n    }\n    let _e241 = (*uv);\n    let _e244 = (*size);\n    d = ((_e241 - vec2(0.5f)) * _e244);\n    let _e246 = (*size);\n    corner = (_e246 * 0.5f);\n    let _e248 = d;\n    let _e249 = d;\n    let _e251 = corner;\n    let _e252 = corner;\n    r2_ = (dot(_e248, _e249) / dot(_e251, _e252));\n    let _e256 = unnamed.uVignette;\n    let _e257 = r2_;\n    falloff = (1f + (_e256 * _e257));\n    let _e260 = (*c_9);\n    let _e261 = falloff;\n    let _e262 = falloff;\n    return (_e260 / vec3((_e261 * _e262)));\n}\n\nfn autoExposureGain_u0028_() -> f32 {\n    var held: f32;\n    var stops: f32;\n\n    let _e233 = unnamed.uAutoExposure;\n    if (_e233 <= 0f) {\n        return 1f;\n    }\n    let _e235 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held = _e235.x;\n    let _e238 = unnamed.uAutoExposure;\n    let _e239 = held;\n    stops = (_e238 * (-2.473931f - _e239));\n    let _e242 = stops;\n    return exp2(clamp(_e242, -6f, 6f));\n}\n\nfn localBlock_u0028_vf2_u003b_f1_u003b(uv_1: ptr<function, vec2<f32>>, block: ptr<function, f32>) -> vec2<f32> {\n    var inside: vec2<f32>;\n\n    let _e233 = (*uv_1);\n    inside = clamp(_e233, vec2<f32>(0.015625f, 0.015625f), vec2<f32>(0.984375f, 0.984375f));\n    let _e235 = (*block);\n    let _e237 = inside[0u];\n    let _e241 = inside[1u];\n    let _e243 = textureSampleLevel(uExposureLocal_t, uExposureLocal_s, vec2<f32>(((_e235 + _e237) / 11f), _e241), 0f);\n    return _e243.xy;\n}\n\nfn localExposureGain_u0028_vf2_u003b_vf3_u003b(uv_2: ptr<function, vec2<f32>>, light: ptr<function, vec3<f32>>) -> f32 {\n    var held_1: f32;\n    var pixel: f32;\n    var b_1: f32;\n    var lower: f32;\n    var upper: f32;\n    var banded: vec2<f32>;\n    var param_13: vec2<f32>;\n    var param_14: f32;\n    var param_15: vec2<f32>;\n    var param_16: f32;\n    var tileMean: f32;\n    var param_17: vec2<f32>;\n    var param_18: f32;\n    var bilateral: f32;\n    var local_2: f32;\n    var local_3: f32;\n    var stops_1: f32;\n\n    let _e250 = unnamed.uLocalExposure;\n    if (_e250 <= 0f) {\n        return 1f;\n    }\n    let _e252 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held_1 = _e252.x;\n    let _e254 = (*light);\n    pixel = clamp(log2(max(dot(_e254, vec3<f32>(0.2126f, 0.7152f, 0.0722f)), 0.00000001f)), -12f, 8f);\n    let _e259 = pixel;\n    b_1 = (((_e259 - -12f) / 2f) - 0.5f);\n    let _e263 = b_1;\n    lower = clamp(floor(_e263), 0f, 9f);\n    let _e266 = lower;\n    upper = min((_e266 + 1f), 9f);\n    let _e269 = (*uv_2);\n    param_13 = _e269;\n    let _e270 = lower;\n    param_14 = _e270;\n    let _e271 = localBlock_u0028_vf2_u003b_f1_u003b((&param_13), (&param_14));\n    let _e272 = (*uv_2);\n    param_15 = _e272;\n    let _e273 = upper;\n    param_16 = _e273;\n    let _e274 = localBlock_u0028_vf2_u003b_f1_u003b((&param_15), (&param_16));\n    let _e275 = b_1;\n    let _e276 = lower;\n    banded = mix(_e271, _e274, vec2(clamp((_e275 - _e276), 0f, 1f)));\n    let _e281 = (*uv_2);\n    param_17 = _e281;\n    param_18 = 10f;\n    let _e282 = localBlock_u0028_vf2_u003b_f1_u003b((&param_17), (&param_18));\n    tileMean = _e282.x;\n    let _e285 = banded[1u];\n    if (_e285 > 0.001f) {\n        let _e288 = banded[0u];\n        let _e290 = banded[1u];\n        local_2 = (_e288 / _e290);\n    } else {\n        let _e292 = tileMean;\n        local_2 = _e292;\n    }\n    let _e293 = local_2;\n    bilateral = _e293;\n    let _e294 = bilateral;\n    let _e295 = tileMean;\n    local_3 = mix(_e294, _e295, 0.4f);\n    let _e298 = unnamed.uLocalExposure;\n    let _e299 = held_1;\n    let _e300 = local_3;\n    stops_1 = (_e298 * (_e299 - _e300));\n    let _e303 = stops_1;\n    return exp2(clamp(_e303, -3f, 3f));\n}\n\nfn finish_u0028_vf3_u003b(light_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var local_4: f32;\n    var param_19: vec2<f32>;\n    var param_20: vec3<f32>;\n    var lensed: vec3<f32>;\n    var param_21: vec3<f32>;\n    var param_22: vec2<f32>;\n    var param_23: vec2<f32>;\n    var param_24: vec3<f32>;\n    var param_25: vec3<f32>;\n    var param_26: vec3<f32>;\n    var param_27: vec3<f32>;\n    var param_28: vec2<f32>;\n\n    let _e243 = vUv_1;\n    param_19 = _e243;\n    let _e244 = (*light_1);\n    param_20 = _e244;\n    let _e245 = localExposureGain_u0028_vf2_u003b_vf3_u003b((&param_19), (&param_20));\n    local_4 = _e245;\n    let _e246 = autoExposureGain_u0028_();\n    let _e247 = local_4;\n    let _e249 = (*light_1);\n    (*light_1) = (_e249 * (_e246 * _e247));\n    let _e251 = textureDimensions(uScene_t, 0i);\n    let _e254 = (*light_1);\n    param_21 = _e254;\n    let _e255 = vUv_1;\n    param_22 = _e255;\n    param_23 = vec2<f32>(vec2<i32>(_e251));\n    let _e256 = withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b((&param_21), (&param_22), (&param_23));\n    lensed = _e256;\n    let _e257 = lensed;\n    param_24 = _e257;\n    let _e258 = grade_u0028_vf3_u003b((&param_24));\n    param_25 = _e258;\n    let _e259 = applyColourGrade_u0028_vf3_u003b((&param_25));\n    param_26 = _e259;\n    let _e260 = withVeil_u0028_vf3_u003b((&param_26));\n    param_27 = _e260;\n    let _e261 = gl_FragCoord_1;\n    param_28 = _e261.xy;\n    let _e263 = withGrain_u0028_vf3_u003b_vf2_u003b((&param_27), (&param_28));\n    return _e263;\n}\n\nfn withBloom_u0028_vf3_u003b(c_10: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e232 = unnamed.uBloomStrength;\n    if (_e232 <= 0f) {\n        let _e234 = (*c_10);\n        return _e234;\n    }\n    let _e235 = (*c_10);\n    let _e236 = vUv_1;\n    let _e237 = textureSampleLevel(uBloom_t, uBloom_s, _e236, 0f);\n    let _e240 = unnamed.uBloomStrength;\n    return (_e235 + (_e237.xyz * _e240));\n}\n\nfn circleOfConfusion_u0028_f1_u003b(viewDepth: ptr<function, f32>) -> f32 {\n    var offPlane: f32;\n\n    let _e232 = (*viewDepth);\n    let _e234 = unnamed.uFocusDistance;\n    let _e238 = unnamed.uFocusRange;\n    offPlane = (abs((_e232 - _e234)) - _e238);\n    let _e240 = offPlane;\n    let _e242 = unnamed.uFocusRange;\n    return clamp((_e240 / _e242), 0f, 1f);\n}\n\nfn viewDepthOf_u0028_vf2_u003b(uv_3: ptr<function, vec2<f32>>) -> f32 {\n    var z: f32;\n\n    let _e232 = (*uv_3);\n    let _e233 = textureSampleLevel(uDepth_t, uDepth_s, _e232, 0f);\n    z = (1f - (_e233.x * 2f));\n    let _e239 = unnamed.uDepthToView[0u];\n    let _e240 = z;\n    let _e244 = unnamed.uDepthToView[1u];\n    let _e249 = unnamed.uDepthToView[2u];\n    let _e250 = z;\n    let _e254 = unnamed.uDepthToView[3u];\n    return (-(((_e239 * _e240) + _e244)) / ((_e249 * _e250) + _e254));\n}\n\nfn dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b(direction: ptr<function, vec2<f32>>, radius: ptr<function, f32>, centreDepth: ptr<function, f32>) -> vec4<f32> {\n    var uv_4: vec2<f32>;\n    var depth: f32;\n    var param_29: vec2<f32>;\n    var weight_2: f32;\n    var local_5: f32;\n    var param_30: f32;\n\n    let _e239 = vUv_1;\n    let _e240 = (*direction);\n    let _e241 = (*radius);\n    let _e244 = unnamed.uDofAspect;\n    uv_4 = (_e239 + ((_e240 * _e241) * _e244));\n    let _e247 = uv_4;\n    param_29 = _e247;\n    let _e248 = viewDepthOf_u0028_vf2_u003b((&param_29));\n    depth = _e248;\n    let _e249 = depth;\n    let _e250 = (*centreDepth);\n    if (_e249 >= _e250) {\n        local_5 = 1f;\n    } else {\n        let _e252 = depth;\n        param_30 = _e252;\n        let _e253 = circleOfConfusion_u0028_f1_u003b((&param_30));\n        local_5 = _e253;\n    }\n    let _e254 = local_5;\n    weight_2 = _e254;\n    let _e255 = uv_4;\n    let _e256 = textureSampleLevel(uScene_t, uScene_s, _e255, 0f);\n    let _e258 = weight_2;\n    let _e259 = (_e256.xyz * _e258);\n    let _e260 = weight_2;\n    return vec4<f32>(_e259.x, _e259.y, _e259.z, _e260);\n}\n\nfn depthOfField_u0028_vf3_u003b(centre: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_1: f32;\n    var param_31: vec2<f32>;\n    var coc: f32;\n    var param_32: f32;\n    var radius_1: f32;\n    var sum: vec4<f32>;\n    var param_33: vec2<f32>;\n    var param_34: f32;\n    var param_35: f32;\n    var param_36: vec2<f32>;\n    var param_37: f32;\n    var param_38: f32;\n    var param_39: vec2<f32>;\n    var param_40: f32;\n    var param_41: f32;\n    var param_42: vec2<f32>;\n    var param_43: f32;\n    var param_44: f32;\n    var param_45: vec2<f32>;\n    var param_46: f32;\n    var param_47: f32;\n    var param_48: vec2<f32>;\n    var param_49: f32;\n    var param_50: f32;\n    var param_51: vec2<f32>;\n    var param_52: f32;\n    var param_53: f32;\n    var param_54: vec2<f32>;\n    var param_55: f32;\n    var param_56: f32;\n\n    let _e261 = vUv_1;\n    param_31 = _e261;\n    let _e262 = viewDepthOf_u0028_vf2_u003b((&param_31));\n    depth_1 = _e262;\n    let _e263 = depth_1;\n    param_32 = _e263;\n    let _e264 = circleOfConfusion_u0028_f1_u003b((&param_32));\n    coc = _e264;\n    let _e265 = coc;\n    if (_e265 <= 0f) {\n        let _e267 = (*centre);\n        return _e267;\n    }\n    let _e268 = coc;\n    let _e270 = unnamed.uDofStrength;\n    radius_1 = (_e268 * _e270);\n    let _e272 = (*centre);\n    sum = vec4<f32>(_e272.x, _e272.y, _e272.z, 1f);\n    param_33 = vec2<f32>(0.25f, 0f);\n    let _e277 = radius_1;\n    param_34 = _e277;\n    let _e278 = depth_1;\n    param_35 = _e278;\n    let _e279 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_33), (&param_34), (&param_35));\n    let _e280 = sum;\n    sum = (_e280 + _e279);\n    param_36 = vec2<f32>(-0.31929f, 0.292496f);\n    let _e282 = radius_1;\n    param_37 = _e282;\n    let _e283 = depth_1;\n    param_38 = _e283;\n    let _e284 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_36), (&param_37), (&param_38));\n    let _e285 = sum;\n    sum = (_e285 + _e284);\n    param_39 = vec2<f32>(0.048872f, -0.556877f);\n    let _e287 = radius_1;\n    param_40 = _e287;\n    let _e288 = depth_1;\n    param_41 = _e288;\n    let _e289 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_39), (&param_40), (&param_41));\n    let _e290 = sum;\n    sum = (_e290 + _e289);\n    param_42 = vec2<f32>(0.402444f, 0.524918f);\n    let _e292 = radius_1;\n    param_43 = _e292;\n    let _e293 = depth_1;\n    param_44 = _e293;\n    let _e294 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_42), (&param_43), (&param_44));\n    let _e295 = sum;\n    sum = (_e295 + _e294);\n    param_45 = vec2<f32>(-0.738535f, -0.130636f);\n    let _e297 = radius_1;\n    param_46 = _e297;\n    let _e298 = depth_1;\n    param_47 = _e298;\n    let _e299 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_45), (&param_46), (&param_47));\n    let _e300 = sum;\n    sum = (_e300 + _e299);\n    param_48 = vec2<f32>(0.699605f, -0.445031f);\n    let _e302 = radius_1;\n    param_49 = _e302;\n    let _e303 = depth_1;\n    param_50 = _e303;\n    let _e304 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_48), (&param_49), (&param_50));\n    let _e305 = sum;\n    sum = (_e305 + _e304);\n    param_51 = vec2<f32>(-0.234004f, 0.870484f);\n    let _e307 = radius_1;\n    param_52 = _e307;\n    let _e308 = depth_1;\n    param_53 = _e308;\n    let _e309 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_51), (&param_52), (&param_53));\n    let _e310 = sum;\n    sum = (_e310 + _e309);\n    param_54 = vec2<f32>(-0.446271f, -0.859268f);\n    let _e312 = radius_1;\n    param_55 = _e312;\n    let _e313 = depth_1;\n    param_56 = _e313;\n    let _e314 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_54), (&param_55), (&param_56));\n    let _e315 = sum;\n    sum = (_e315 + _e314);\n    let _e317 = sum;\n    let _e320 = sum[3u];\n    return (_e317.xyz / vec3(_e320));\n}\n\nfn cameraBlur_u0028_vf3_u003b(scene: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var moved: vec4<f32>;\n    var velocity: vec2<f32>;\n    var depth_2: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var distance_: f32;\n    var sum_1: vec3<f32>;\n    var i: i32;\n    var t_2: f32;\n    var phi_1351_: bool;\n\n    let _e241 = vUv_1;\n    let _e242 = textureSampleLevel(uMotion_t, uMotion_s, _e241, 0f);\n    moved = _e242;\n    let _e244 = unnamed.uObjectMotion;\n    let _e245 = (_e244 > 0.5f);\n    phi_1351_ = _e245;\n    if _e245 {\n        let _e247 = moved[3u];\n        phi_1351_ = (_e247 > 0.5f);\n    }\n    let _e250 = phi_1351_;\n    if _e250 {\n        let _e251 = moved;\n        let _e255 = unnamed.uMotionStrength;\n        velocity = (-(_e251.xy) * _e255);\n    } else {\n        let _e257 = vUv_1;\n        let _e258 = textureSampleLevel(uDepth_t, uDepth_s, _e257, 0f);\n        depth_2 = _e258.x;\n        let _e260 = vUv_1;\n        let _e263 = ((_e260 * 2f) - vec2(1f));\n        let _e264 = depth_2;\n        clip = vec4<f32>(_e263.x, _e263.y, (1f - (_e264 * 2f)), 1f);\n        let _e271 = unnamed.uReprojection;\n        let _e272 = clip;\n        previous = (_e271 * _e272);\n        let _e275 = previous[3u];\n        if (_e275 <= 0f) {\n            let _e277 = (*scene);\n            return _e277;\n        }\n        let _e278 = previous;\n        let _e281 = previous[3u];\n        wasUv = (((_e278.xy / vec2(_e281)) * 0.5f) + vec2(0.5f));\n        let _e287 = vUv_1;\n        let _e288 = wasUv;\n        let _e291 = unnamed.uMotionStrength;\n        velocity = ((_e287 - _e288) * _e291);\n    }\n    let _e293 = velocity;\n    distance_ = length(_e293);\n    let _e295 = distance_;\n    if (_e295 < 0.0001f) {\n        let _e297 = (*scene);\n        return _e297;\n    }\n    let _e298 = distance_;\n    let _e300 = unnamed.uMotionMax;\n    if (_e298 > _e300) {\n        let _e303 = unnamed.uMotionMax;\n        let _e304 = distance_;\n        let _e306 = velocity;\n        velocity = (_e306 * (_e303 / _e304));\n    }\n    let _e308 = (*scene);\n    sum_1 = _e308;\n    i = 1i;\n    loop {\n        let _e309 = i;\n        if (_e309 <= 4i) {\n            let _e311 = i;\n            t_2 = ((f32(_e311) / 4f) * 0.5f);\n            let _e315 = vUv_1;\n            let _e316 = velocity;\n            let _e317 = t_2;\n            let _e320 = textureSampleLevel(uScene_t, uScene_s, (_e315 + (_e316 * _e317)), 0f);\n            let _e322 = sum_1;\n            sum_1 = (_e322 + _e320.xyz);\n            let _e324 = vUv_1;\n            let _e325 = velocity;\n            let _e326 = t_2;\n            let _e329 = textureSampleLevel(uScene_t, uScene_s, (_e324 - (_e325 * _e326)), 0f);\n            let _e331 = sum_1;\n            sum_1 = (_e331 + _e329.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e333 = i;\n            i = (_e333 + 1i);\n        }\n    }\n    let _e335 = sum_1;\n    return (_e335 / vec3(9f));\n}\n\nfn withFringe_u0028_vf3_u003b(scene_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var lens: vec2<f32>;\n    var past: vec2<f32>;\n    var red: vec2<f32>;\n    var green: vec2<f32>;\n\n    let _e237 = unnamed.uFringe[0u];\n    if (_e237 <= 0f) {\n        let _e239 = (*scene_1);\n        return _e239;\n    }\n    let _e240 = vUv_1;\n    lens = ((_e240 * 2f) - vec2(1f));\n    let _e244 = lens;\n    let _e246 = lens;\n    let _e250 = unnamed.uFringe[2u];\n    past = (sign(_e244) * clamp((abs(_e246) - vec2(_e250)), vec2(0f), vec2(1f)));\n    let _e257 = lens;\n    let _e258 = past;\n    let _e261 = unnamed.uFringe[0u];\n    red = (((_e257 - (_e258 * _e261)) * 0.5f) + vec2(0.5f));\n    let _e267 = lens;\n    let _e268 = past;\n    let _e271 = unnamed.uFringe[1u];\n    green = (((_e267 - (_e268 * _e271)) * 0.5f) + vec2(0.5f));\n    let _e277 = red;\n    let _e278 = textureSampleLevel(uScene_t, uScene_s, _e277, 0f);\n    let _e280 = green;\n    let _e281 = textureSampleLevel(uScene_t, uScene_s, _e280, 0f);\n    let _e284 = (*scene_1)[2u];\n    return vec3<f32>(_e278.x, _e281.y, _e284);\n}\n\nfn main_1() {\n    var sampled: vec4<f32>;\n    var scene_2: vec3<f32>;\n    var param_57: vec3<f32>;\n    var param_58: vec3<f32>;\n    var param_59: vec3<f32>;\n    var share: f32;\n    var ao: f32;\n    var fromCentre: vec2<f32>;\n    var radius_2: f32;\n    var inner: f32;\n    var edge: f32;\n    var amount: f32;\n    var param_60: vec3<f32>;\n    var param_61: vec3<f32>;\n    var step_: vec2<f32>;\n    var sum_2: vec3<f32>;\n    var i_1: i32;\n    var blurred: vec3<f32>;\n    var param_62: vec3<f32>;\n    var param_63: vec3<f32>;\n\n    let _e250 = vUv_1;\n    let _e251 = textureSampleLevel(uScene_t, uScene_s, _e250, 0f);\n    sampled = _e251;\n    let _e252 = sampled;\n    param_57 = _e252.xyz;\n    let _e254 = withFringe_u0028_vf3_u003b((&param_57));\n    scene_2 = _e254;\n    let _e256 = unnamed.uMotionStrength;\n    if (_e256 > 0f) {\n        let _e258 = scene_2;\n        param_58 = _e258;\n        let _e259 = cameraBlur_u0028_vf3_u003b((&param_58));\n        scene_2 = _e259;\n    }\n    let _e261 = unnamed.uDofStrength;\n    if (_e261 > 0f) {\n        let _e263 = scene_2;\n        param_59 = _e263;\n        let _e264 = depthOfField_u0028_vf3_u003b((&param_59));\n        scene_2 = _e264;\n    }\n    let _e266 = sampled[3u];\n    share = clamp(_e266, 0f, 1f);\n    let _e268 = vUv_1;\n    let _e270 = unnamed.uAoOffset;\n    let _e272 = textureSampleLevel(uAo_t, uAo_s, (_e268 + _e270), 0f);\n    let _e275 = unnamed.uAoStrength;\n    let _e276 = share;\n    ao = mix(1f, _e272.x, (_e275 * _e276));\n    let _e279 = vUv_1;\n    fromCentre = (_e279 - vec2(0.5f));\n    let _e282 = fromCentre;\n    radius_2 = (length((_e282 * vec2<f32>(1f, 0.62f))) * 2f);\n    let _e287 = unnamed.uStrength;\n    inner = mix(0.62f, 0.3f, _e287);\n    let _e289 = inner;\n    let _e290 = radius_2;\n    edge = smoothstep(_e289, 1f, _e290);\n    let _e292 = edge;\n    let _e294 = unnamed.uStrength;\n    amount = (_e292 * _e294);\n    let _e296 = amount;\n    if (_e296 <= 0f) {\n        let _e298 = scene_2;\n        let _e299 = ao;\n        param_60 = (_e298 * _e299);\n        let _e301 = withBloom_u0028_vf3_u003b((&param_60));\n        param_61 = _e301;\n        let _e302 = finish_u0028_vf3_u003b((&param_61));\n        fragColor = vec4<f32>(_e302.x, _e302.y, _e302.z, 1f);\n        return;\n    }\n    let _e307 = fromCentre;\n    let _e311 = unnamed.uReach;\n    let _e313 = amount;\n    step_ = ((normalize((_e307 + vec2<f32>(0.000001f, 0.000001f))) * _e311) * _e313);\n    let _e315 = scene_2;\n    sum_2 = _e315;\n    i_1 = 1i;\n    loop {\n        let _e316 = i_1;\n        if (_e316 <= 6i) {\n            let _e318 = vUv_1;\n            let _e319 = step_;\n            let _e320 = i_1;\n            let _e325 = textureSampleLevel(uScene_t, uScene_s, (_e318 + (_e319 * (f32(_e320) / 6f))), 0f);\n            let _e327 = sum_2;\n            sum_2 = (_e327 + _e325.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e329 = i_1;\n            i_1 = (_e329 + 1i);\n        }\n    }\n    let _e331 = sum_2;\n    blurred = (_e331 / vec3(7f));\n    let _e334 = scene_2;\n    let _e335 = blurred;\n    let _e336 = amount;\n    let _e339 = ao;\n    param_62 = (mix(_e334, _e335, vec3(_e336)) * _e339);\n    let _e341 = withBloom_u0028_vf3_u003b((&param_62));\n    param_63 = _e341;\n    let _e342 = finish_u0028_vf3_u003b((&param_63));\n    fragColor = vec4<f32>(_e342.x, _e342.y, _e342.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const RUSH_BINDINGS = {
  "RUSH_FRAG": {
    "uniforms": 1,
    "uniformSize": 272,
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
      "uFilmA": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      },
      "uFilmB": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uDisplayHeadroom": {
        "offset": 48,
        "size": 4,
        "type": "float"
      },
      "uReprojection": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uMotionStrength": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uMotionMax": {
        "offset": 132,
        "size": 4,
        "type": "float"
      },
      "uObjectMotion": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uAoStrength": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uAoOffset": {
        "offset": 144,
        "size": 8,
        "type": "vec2"
      },
      "uBloomStrength": {
        "offset": 152,
        "size": 4,
        "type": "float"
      },
      "uVeilColor": {
        "offset": 160,
        "size": 12,
        "type": "vec3"
      },
      "uVeilAlpha": {
        "offset": 172,
        "size": 4,
        "type": "float"
      },
      "uVignette": {
        "offset": 176,
        "size": 4,
        "type": "float"
      },
      "uGrain": {
        "offset": 184,
        "size": 8,
        "type": "vec2"
      },
      "uAutoExposure": {
        "offset": 192,
        "size": 4,
        "type": "float"
      },
      "uLocalExposure": {
        "offset": 196,
        "size": 4,
        "type": "float"
      },
      "uGradeStrength": {
        "offset": 200,
        "size": 4,
        "type": "float"
      },
      "uGradeSize": {
        "offset": 204,
        "size": 4,
        "type": "float"
      },
      "uFocusDistance": {
        "offset": 208,
        "size": 4,
        "type": "float"
      },
      "uFocusRange": {
        "offset": 212,
        "size": 4,
        "type": "float"
      },
      "uDofStrength": {
        "offset": 216,
        "size": 4,
        "type": "float"
      },
      "uDofAspect": {
        "offset": 224,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToView": {
        "offset": 240,
        "size": 16,
        "type": "vec4"
      },
      "uFringe": {
        "offset": 256,
        "size": 12,
        "type": "vec3"
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
      "uMotion": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      },
      "uAo": {
        "texture": 38,
        "sampler": 39,
        "type": "sampler2D"
      },
      "uBloom": {
        "texture": 40,
        "sampler": 41,
        "type": "sampler2D"
      },
      "uExposureHeld": {
        "texture": 42,
        "sampler": 43,
        "type": "sampler2D"
      },
      "uExposureLocal": {
        "texture": 44,
        "sampler": 45,
        "type": "sampler2D"
      },
      "uGradeLut": {
        "texture": 46,
        "sampler": 47,
        "type": "sampler3D"
      }
    }
  }
} as const;
