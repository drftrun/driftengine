/*
 * Generated from ../rush.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const RUSH_FRAG_WGSL = "struct Uniforms {\n    uStrength: f32,\n    uReach: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uSceneGraded: i32,\n    uFilmA: vec4<f32>,\n    uFilmB: vec4<f32>,\n    uDisplayHeadroom: f32,\n    uReprojection: mat4x4<f32>,\n    uMotionStrength: f32,\n    uMotionMax: f32,\n    uObjectMotion: f32,\n    uAoStrength: f32,\n    uAoOffset: vec2<f32>,\n    uBloomStrength: f32,\n    uVeilColor: vec3<f32>,\n    uVeilAlpha: f32,\n    uVignette: f32,\n    uGrain: vec2<f32>,\n    uAutoExposure: f32,\n    uLocalExposure: f32,\n    uGradeStrength: f32,\n    uGradeSize: f32,\n    uFocusDistance: f32,\n    uFocusRange: f32,\n    uDofStrength: f32,\n    uDofAspect: vec2<f32>,\n    uDepthToView: vec4<f32>,\n    uFringe: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(42) \nvar uExposureHeld_t: texture_2d<f32>;\n@group(0) @binding(44) \nvar uExposureLocal_t: texture_2d<f32>;\n@group(0) @binding(45) \nvar uExposureLocal_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\n@group(0) @binding(40) \nvar uBloom_t: texture_2d<f32>;\n@group(0) @binding(41) \nvar uBloom_s: sampler;\n@group(0) @binding(46) \nvar uGradeLut_t: texture_3d<f32>;\n@group(0) @binding(47) \nvar uGradeLut_s: sampler;\n@group(0) @binding(36) \nvar uMotion_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uMotion_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(38) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uAo_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(43) \nvar uExposureHeld_s: sampler;\n\nfn grainNoise_u0028_vu2_u003b_u1_u003b(p: ptr<function, vec2<u32>>, seed: ptr<function, u32>) -> f32 {\n    var h: u32;\n\n    let _e235 = (*p)[0u];\n    let _e238 = (*p)[1u];\n    let _e241 = (*seed);\n    h = (((_e235 * 1664525u) + (_e238 * 1013904223u)) + (_e241 * 2654435769u));\n    let _e244 = h;\n    let _e247 = h;\n    h = (_e247 ^ (_e244 >> bitcast<u32>(16u)));\n    let _e249 = h;\n    h = (_e249 * 2246822519u);\n    let _e251 = h;\n    let _e254 = h;\n    h = (_e254 ^ (_e251 >> bitcast<u32>(13u)));\n    let _e256 = h;\n    h = (_e256 * 3266489917u);\n    let _e258 = h;\n    let _e261 = h;\n    h = (_e261 ^ (_e258 >> bitcast<u32>(16u)));\n    let _e263 = h;\n    return (f32(_e263) * 0.00000000023283064f);\n}\n\nfn withGrain_u0028_vf3_u003b_vf2_u003b(c: ptr<function, vec3<f32>>, fragCoord: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var luma: f32;\n    var weight: f32;\n    var n: f32;\n    var param: vec2<u32>;\n    var param_1: u32;\n\n    let _e240 = unnamed.uGrain[0u];\n    if (_e240 <= 0f) {\n        let _e242 = (*c);\n        return _e242;\n    }\n    let _e243 = (*c);\n    luma = dot(clamp(_e243, vec3(0f), vec3(1f)), vec3<f32>(0.2126f, 0.7152f, 0.0722f));\n    let _e248 = luma;\n    let _e250 = luma;\n    weight = (0.25f + ((3f * _e248) * (1f - _e250)));\n    let _e254 = (*fragCoord);\n    let _e258 = unnamed.uGrain[1u];\n    param = vec2<u32>(_e254);\n    param_1 = u32(_e258);\n    let _e260 = grainNoise_u0028_vu2_u003b_u1_u003b((&param), (&param_1));\n    n = (_e260 - 0.5f);\n    let _e262 = (*c);\n    let _e263 = n;\n    let _e267 = unnamed.uGrain[0u];\n    let _e269 = weight;\n    return (_e262 + vec3((((2f * _e263) * _e267) * _e269)));\n}\n\nfn withVeil_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e233 = unnamed.uVeilAlpha;\n    if (_e233 <= 0f) {\n        let _e235 = (*c_1);\n        return _e235;\n    }\n    let _e236 = (*c_1);\n    let _e238 = unnamed.uVeilColor;\n    let _e240 = unnamed.uVeilAlpha;\n    return mix(_e236, _e238, vec3(_e240));\n}\n\nfn applyColourGrade_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var over: f32;\n    var local: f32;\n    var clamped: vec3<f32>;\n    var uvw: vec3<f32>;\n\n    let _e237 = unnamed.uGradeStrength;\n    if (_e237 <= 0f) {\n        let _e239 = (*c_2);\n        return _e239;\n    }\n    let _e241 = unnamed.uDisplayHeadroom;\n    if (_e241 > 1f) {\n        let _e244 = (*c_2)[0u];\n        let _e246 = (*c_2)[1u];\n        let _e248 = (*c_2)[2u];\n        local = max(max(_e244, max(_e246, _e248)), 1f);\n    } else {\n        local = 1f;\n    }\n    let _e252 = local;\n    over = _e252;\n    let _e253 = (*c_2);\n    let _e254 = over;\n    clamped = clamp((_e253 / vec3(_e254)), vec3(0f), vec3(1f));\n    let _e260 = clamped;\n    let _e262 = unnamed.uGradeSize;\n    let _e268 = unnamed.uGradeSize;\n    uvw = (((_e260 * (_e262 - 1f)) + vec3(0.5f)) / vec3(_e268));\n    let _e271 = (*c_2);\n    let _e272 = uvw;\n    let _e273 = textureSampleLevel(uGradeLut_t, uGradeLut_s, _e272, 0f);\n    let _e275 = over;\n    let _e278 = unnamed.uGradeStrength;\n    return mix(_e271, (_e273.xyz * _e275), vec3(_e278));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c_3: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e234 = (*c_3);\n    low = (_e234 * 12.92f);\n    let _e236 = (*c_3);\n    high = ((pow(max(_e236, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e242 = low;\n    let _e243 = high;\n    let _e244 = (*c_3);\n    return mix(_e242, _e243, step(vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f), _e244));\n}\n\nfn filmCentredHue_u0028_vf3_u003b(c_4: ptr<function, vec3<f32>>) -> f32 {\n    var y: f32;\n    var x: f32;\n    var phi_889_: bool;\n\n    let _e235 = (*c_4)[1u];\n    let _e237 = (*c_4)[2u];\n    y = (1.7320508f * (_e235 - _e237));\n    let _e241 = (*c_4)[0u];\n    let _e244 = (*c_4)[1u];\n    let _e247 = (*c_4)[2u];\n    x = (((2f * _e241) - _e244) - _e247);\n    let _e249 = x;\n    let _e251 = (abs(_e249) < 0.0000000001f);\n    phi_889_ = _e251;\n    if _e251 {\n        let _e252 = y;\n        phi_889_ = (abs(_e252) < 0.0000000001f);\n    }\n    let _e256 = phi_889_;\n    if _e256 {\n        return 0f;\n    }\n    let _e257 = y;\n    let _e258 = x;\n    return degrees(atan2(_e257, _e258));\n}\n\nfn filmGlow_u0028_f1_u003b_f1_u003b_f1_u003b(yc: ptr<function, f32>, gain: ptr<function, f32>, mid: ptr<function, f32>) -> f32 {\n    let _e234 = (*yc);\n    let _e235 = (*mid);\n    if (_e234 <= (0.6666667f * _e235)) {\n        let _e238 = (*gain);\n        return _e238;\n    }\n    let _e239 = (*yc);\n    let _e240 = (*mid);\n    if (_e239 >= (2f * _e240)) {\n        return 0f;\n    }\n    let _e243 = (*gain);\n    let _e244 = (*mid);\n    let _e245 = (*yc);\n    return (_e243 * ((_e244 / _e245) - 0.5f));\n}\n\nfn filmSigmoid_u0028_f1_u003b(x_1: ptr<function, f32>) -> f32 {\n    var t: f32;\n\n    let _e233 = (*x_1);\n    t = max((1f - abs((_e233 / 2f))), 0f);\n    let _e238 = (*x_1);\n    let _e240 = t;\n    let _e241 = t;\n    return ((1f + (sign(_e238) * (1f - (_e240 * _e241)))) / 2f);\n}\n\nfn filmYc_u0028_vf3_u003b(c_5: ptr<function, vec3<f32>>) -> f32 {\n    var chroma: f32;\n\n    let _e234 = (*c_5)[2u];\n    let _e236 = (*c_5)[2u];\n    let _e238 = (*c_5)[1u];\n    let _e242 = (*c_5)[1u];\n    let _e244 = (*c_5)[1u];\n    let _e246 = (*c_5)[0u];\n    let _e251 = (*c_5)[0u];\n    let _e253 = (*c_5)[0u];\n    let _e255 = (*c_5)[2u];\n    chroma = sqrt(max((((_e234 * (_e236 - _e238)) + (_e242 * (_e244 - _e246))) + (_e251 * (_e253 - _e255))), 0f));\n    let _e262 = (*c_5)[2u];\n    let _e264 = (*c_5)[1u];\n    let _e267 = (*c_5)[0u];\n    let _e269 = chroma;\n    return ((((_e262 + _e264) + _e267) + (1.75f * _e269)) / 3f);\n}\n\nfn filmSaturation_u0028_vf3_u003b(c_6: ptr<function, vec3<f32>>) -> f32 {\n    var hi: f32;\n    var lo: f32;\n\n    let _e235 = (*c_6)[0u];\n    let _e237 = (*c_6)[1u];\n    let _e239 = (*c_6)[2u];\n    hi = max(_e235, max(_e237, _e239));\n    let _e243 = (*c_6)[0u];\n    let _e245 = (*c_6)[1u];\n    let _e247 = (*c_6)[2u];\n    lo = min(_e243, min(_e245, _e247));\n    let _e250 = hi;\n    let _e252 = lo;\n    let _e255 = hi;\n    return ((max(_e250, 0.0000000001f) - max(_e252, 0.0000000001f)) / max(_e255, 0.01f));\n}\n\nfn filmicCurve_u0028_vf3_u003b(linear: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var ap0_: vec3<f32>;\n    var saturation: f32;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: f32;\n    var param_5: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var weight_1: f32;\n    var param_8: vec3<f32>;\n    var work: vec3<f32>;\n    var slope: f32;\n    var black: f32;\n    var white: f32;\n    var toeScale: f32;\n    var shoulderScale: f32;\n    var toeMatch: f32;\n    var straightMatch: f32;\n    var shoulderMatch: f32;\n    var logc: vec3<f32>;\n    var straight: vec3<f32>;\n    var toeC: vec3<f32>;\n    var shoulderC: vec3<f32>;\n    var t_1: vec3<f32>;\n    var tone: vec3<f32>;\n    var ceiling: f32;\n    var local_1: f32;\n\n    let _e259 = (*linear);\n    ap0_ = (mat3x3<f32>(vec3<f32>(0.6954522f, 0.044794563f, -0.005525883f), vec3<f32>(0.1406787f, 0.8596711f, 0.00402521f), vec3<f32>(0.16386907f, 0.09553432f, 1.0015007f)) * (mat3x3<f32>(vec3<f32>(0.61319f, 0.07021f, 0.02062f), vec3<f32>(0.33951f, 0.91634f, 0.10957f), vec3<f32>(0.04737f, 0.01345f, 0.86961f)) * _e259));\n    let _e262 = ap0_;\n    param_2 = _e262;\n    let _e263 = filmSaturation_u0028_vf3_u003b((&param_2));\n    saturation = _e263;\n    let _e264 = ap0_;\n    param_3 = _e264;\n    let _e265 = filmYc_u0028_vf3_u003b((&param_3));\n    let _e266 = saturation;\n    param_4 = ((_e266 - 0.4f) / 0.2f);\n    let _e269 = filmSigmoid_u0028_f1_u003b((&param_4));\n    param_5 = _e265;\n    param_6 = (0.05f * _e269);\n    param_7 = 0.08f;\n    let _e271 = filmGlow_u0028_f1_u003b_f1_u003b_f1_u003b((&param_5), (&param_6), (&param_7));\n    let _e273 = ap0_;\n    ap0_ = (_e273 * (1f + _e271));\n    let _e275 = ap0_;\n    param_8 = _e275;\n    let _e276 = filmCentredHue_u0028_vf3_u003b((&param_8));\n    weight_1 = smoothstep(0f, 1f, (1f - abs(((2f * _e276) / 135f))));\n    let _e282 = weight_1;\n    let _e283 = weight_1;\n    let _e285 = saturation;\n    let _e288 = ap0_[0u];\n    let _e293 = ap0_[0u];\n    ap0_[0u] = (_e293 + ((((_e282 * _e283) * _e285) * (0.03f - _e288)) * 0.18f));\n    let _e296 = ap0_;\n    work = max((mat3x3<f32>(vec3<f32>(1.4514393f, -0.07655378f, 0.008316148f), vec3<f32>(-0.23651075f, 1.1762297f, -0.0060324497f), vec3<f32>(-0.21492857f, -0.09967592f, 0.9977163f)) * _e296), vec3<f32>(0f, 0f, 0f));\n    let _e299 = work;\n    let _e302 = work;\n    work = mix(vec3(dot(_e299, vec3<f32>(0.27222872f, 0.67408174f, 0.053689517f))), _e302, vec3(0.96f));\n    let _e307 = unnamed.uFilmA[0u];\n    slope = _e307;\n    let _e310 = unnamed.uFilmA[1u];\n    black = _e310;\n    let _e313 = unnamed.uFilmA[2u];\n    white = _e313;\n    let _e316 = unnamed.uFilmA[3u];\n    toeScale = _e316;\n    let _e319 = unnamed.uFilmB[0u];\n    shoulderScale = _e319;\n    let _e322 = unnamed.uFilmB[1u];\n    toeMatch = _e322;\n    let _e325 = unnamed.uFilmB[2u];\n    straightMatch = _e325;\n    let _e328 = unnamed.uFilmB[3u];\n    shoulderMatch = _e328;\n    let _e329 = work;\n    logc = (log2(max(_e329, vec3<f32>(0.0000000001f, 0.0000000001f, 0.0000000001f))) * 0.30103f);\n    let _e333 = slope;\n    let _e334 = logc;\n    let _e335 = straightMatch;\n    straight = ((_e334 + vec3(_e335)) * _e333);\n    let _e339 = black;\n    let _e341 = toeScale;\n    let _e343 = slope;\n    let _e345 = toeScale;\n    let _e347 = logc;\n    let _e348 = toeMatch;\n    toeC = (vec3(-(_e339)) + (vec3((2f * _e341)) / (vec3(1f) + exp(((_e347 - vec3(_e348)) * ((-2f * _e343) / _e345))))));\n    let _e359 = white;\n    let _e361 = shoulderScale;\n    let _e363 = slope;\n    let _e365 = shoulderScale;\n    let _e367 = logc;\n    let _e368 = shoulderMatch;\n    shoulderC = (vec3((1f + _e359)) - (vec3((2f * _e361)) / (vec3(1f) + exp(((_e367 - vec3(_e368)) * ((2f * _e363) / _e365))))));\n    let _e379 = straight;\n    let _e380 = toeC;\n    let _e381 = logc;\n    let _e382 = toeMatch;\n    toeC = mix(_e379, _e380, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e381 < vec3(_e382))));\n    let _e387 = straight;\n    let _e388 = shoulderC;\n    let _e389 = logc;\n    let _e390 = shoulderMatch;\n    shoulderC = mix(_e387, _e388, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e389 > vec3(_e390))));\n    let _e395 = logc;\n    let _e396 = toeMatch;\n    let _e399 = shoulderMatch;\n    let _e400 = toeMatch;\n    t_1 = clamp(((_e395 - vec3(_e396)) / vec3((_e399 - _e400))), vec3(0f), vec3(1f));\n    let _e407 = shoulderMatch;\n    let _e408 = toeMatch;\n    if (_e407 < _e408) {\n        let _e410 = t_1;\n        t_1 = (vec3(1f) - _e410);\n    }\n    let _e413 = t_1;\n    let _e417 = t_1;\n    let _e419 = t_1;\n    t_1 = (((vec3(3f) - (_e413 * 2f)) * _e417) * _e419);\n    let _e421 = toeC;\n    let _e422 = shoulderC;\n    let _e423 = t_1;\n    tone = mix(_e421, _e422, _e423);\n    let _e425 = tone;\n    let _e428 = tone;\n    tone = mix(vec3(dot(_e425, vec3<f32>(0.27222872f, 0.67408174f, 0.053689517f))), _e428, vec3(0.93f));\n    let _e432 = unnamed.uDisplayHeadroom;\n    if (_e432 > 1f) {\n        let _e434 = white;\n        local_1 = (1f + _e434);\n    } else {\n        local_1 = 1f;\n    }\n    let _e436 = local_1;\n    ceiling = _e436;\n    let _e437 = tone;\n    let _e440 = ceiling;\n    return clamp((mat3x3<f32>(vec3<f32>(1.7048f, -0.13027f, -0.02401f), vec3<f32>(-0.62168f, 1.14082f, -0.129f), vec3<f32>(-0.08325f, -0.01055f, 1.15324f)) * max(_e437, vec3<f32>(0f, 0f, 0f))), vec3(0f), vec3(_e440));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_7: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e235 = (*c_7)[0u];\n    let _e237 = (*c_7)[1u];\n    let _e239 = (*c_7)[2u];\n    m = max(_e235, max(_e237, _e239));\n    let _e242 = m;\n    if (_e242 <= 0.8f) {\n        let _e244 = (*c_7);\n        return _e244;\n    }\n    let _e245 = m;\n    e = (_e245 - 0.8f);\n    let _e247 = (*c_7);\n    let _e248 = e;\n    let _e250 = e;\n    let _e254 = m;\n    return (_e247 * ((0.8f + ((0.2f * _e248) / (_e250 + 0.2f))) / _e254));\n}\n\nfn acesFilmic_u0028_vf3_u003b(x_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var v: vec3<f32>;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e236 = unnamed.uOutputExposure;\n    let _e237 = (*x_2);\n    (*x_2) = (_e237 * _e236);\n    let _e239 = (*x_2);\n    v = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e239);\n    let _e241 = v;\n    let _e242 = v;\n    a = ((_e241 * (_e242 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e248 = v;\n    let _e249 = v;\n    b = ((_e248 * ((_e249 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e256 = a;\n    let _e257 = b;\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * (_e256 / _e257)), vec3(0f), vec3(1f));\n}\n\nfn grade_u0028_vf3_u003b(c_8: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_9: vec3<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var param_12: vec3<f32>;\n\n    let _e237 = unnamed.uOutputTransform;\n    if (_e237 == 0i) {\n        let _e239 = (*c_8);\n        return _e239;\n    }\n    let _e241 = unnamed.uOutputTransform;\n    if (_e241 == 2i) {\n        let _e243 = (*c_8);\n        param_9 = _e243;\n        let _e244 = acesFilmic_u0028_vf3_u003b((&param_9));\n        (*c_8) = _e244;\n    }\n    let _e246 = unnamed.uOutputTransform;\n    if (_e246 == 3i) {\n        let _e248 = (*c_8);\n        let _e250 = unnamed.uOutputExposure;\n        param_10 = (_e248 * _e250);\n        let _e252 = highlightShoulder_u0028_vf3_u003b((&param_10));\n        (*c_8) = _e252;\n    }\n    let _e254 = unnamed.uOutputTransform;\n    if (_e254 == 4i) {\n        let _e256 = (*c_8);\n        let _e258 = unnamed.uOutputExposure;\n        param_11 = (_e256 * _e258);\n        let _e260 = filmicCurve_u0028_vf3_u003b((&param_11));\n        (*c_8) = _e260;\n    }\n    let _e261 = (*c_8);\n    param_12 = _e261;\n    let _e262 = linearToSrgb_u0028_vf3_u003b((&param_12));\n    return _e262;\n}\n\nfn withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b(c_9: ptr<function, vec3<f32>>, uv: ptr<function, vec2<f32>>, size: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var d: vec2<f32>;\n    var corner: vec2<f32>;\n    var r2_: f32;\n    var falloff: f32;\n\n    let _e239 = unnamed.uVignette;\n    if (_e239 <= 0f) {\n        let _e241 = (*c_9);\n        return _e241;\n    }\n    let _e242 = (*uv);\n    let _e245 = (*size);\n    d = ((_e242 - vec2(0.5f)) * _e245);\n    let _e247 = (*size);\n    corner = (_e247 * 0.5f);\n    let _e249 = d;\n    let _e250 = d;\n    let _e252 = corner;\n    let _e253 = corner;\n    r2_ = (dot(_e249, _e250) / dot(_e252, _e253));\n    let _e257 = unnamed.uVignette;\n    let _e258 = r2_;\n    falloff = (1f + (_e257 * _e258));\n    let _e261 = (*c_9);\n    let _e262 = falloff;\n    let _e263 = falloff;\n    return (_e261 / vec3((_e262 * _e263)));\n}\n\nfn autoExposureGain_u0028_() -> f32 {\n    var held: f32;\n    var stops: f32;\n\n    let _e234 = unnamed.uAutoExposure;\n    if (_e234 <= 0f) {\n        return 1f;\n    }\n    let _e236 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held = _e236.x;\n    let _e239 = unnamed.uAutoExposure;\n    let _e240 = held;\n    stops = (_e239 * (-2.473931f - _e240));\n    let _e243 = stops;\n    return exp2(clamp(_e243, -6f, 6f));\n}\n\nfn localBlock_u0028_vf2_u003b_f1_u003b(uv_1: ptr<function, vec2<f32>>, block: ptr<function, f32>) -> vec2<f32> {\n    var inside: vec2<f32>;\n\n    let _e234 = (*uv_1);\n    inside = clamp(_e234, vec2<f32>(0.015625f, 0.015625f), vec2<f32>(0.984375f, 0.984375f));\n    let _e236 = (*block);\n    let _e238 = inside[0u];\n    let _e242 = inside[1u];\n    let _e244 = textureSampleLevel(uExposureLocal_t, uExposureLocal_s, vec2<f32>(((_e236 + _e238) / 11f), _e242), 0f);\n    return _e244.xy;\n}\n\nfn localExposureGain_u0028_vf2_u003b_vf3_u003b(uv_2: ptr<function, vec2<f32>>, light: ptr<function, vec3<f32>>) -> f32 {\n    var held_1: f32;\n    var pixel: f32;\n    var b_1: f32;\n    var lower: f32;\n    var upper: f32;\n    var banded: vec2<f32>;\n    var param_13: vec2<f32>;\n    var param_14: f32;\n    var param_15: vec2<f32>;\n    var param_16: f32;\n    var tileMean: f32;\n    var param_17: vec2<f32>;\n    var param_18: f32;\n    var bilateral: f32;\n    var local_2: f32;\n    var local_3: f32;\n    var stops_1: f32;\n\n    let _e251 = unnamed.uLocalExposure;\n    if (_e251 <= 0f) {\n        return 1f;\n    }\n    let _e253 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held_1 = _e253.x;\n    let _e255 = (*light);\n    pixel = clamp(log2(max(dot(_e255, vec3<f32>(0.2126f, 0.7152f, 0.0722f)), 0.00000001f)), -12f, 8f);\n    let _e260 = pixel;\n    b_1 = (((_e260 - -12f) / 2f) - 0.5f);\n    let _e264 = b_1;\n    lower = clamp(floor(_e264), 0f, 9f);\n    let _e267 = lower;\n    upper = min((_e267 + 1f), 9f);\n    let _e270 = (*uv_2);\n    param_13 = _e270;\n    let _e271 = lower;\n    param_14 = _e271;\n    let _e272 = localBlock_u0028_vf2_u003b_f1_u003b((&param_13), (&param_14));\n    let _e273 = (*uv_2);\n    param_15 = _e273;\n    let _e274 = upper;\n    param_16 = _e274;\n    let _e275 = localBlock_u0028_vf2_u003b_f1_u003b((&param_15), (&param_16));\n    let _e276 = b_1;\n    let _e277 = lower;\n    banded = mix(_e272, _e275, vec2(clamp((_e276 - _e277), 0f, 1f)));\n    let _e282 = (*uv_2);\n    param_17 = _e282;\n    param_18 = 10f;\n    let _e283 = localBlock_u0028_vf2_u003b_f1_u003b((&param_17), (&param_18));\n    tileMean = _e283.x;\n    let _e286 = banded[1u];\n    if (_e286 > 0.001f) {\n        let _e289 = banded[0u];\n        let _e291 = banded[1u];\n        local_2 = (_e289 / _e291);\n    } else {\n        let _e293 = tileMean;\n        local_2 = _e293;\n    }\n    let _e294 = local_2;\n    bilateral = _e294;\n    let _e295 = bilateral;\n    let _e296 = tileMean;\n    local_3 = mix(_e295, _e296, 0.4f);\n    let _e299 = unnamed.uLocalExposure;\n    let _e300 = held_1;\n    let _e301 = local_3;\n    stops_1 = (_e299 * (_e300 - _e301));\n    let _e304 = stops_1;\n    return exp2(clamp(_e304, -3f, 3f));\n}\n\nfn finish_u0028_vf3_u003b(light_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var local_4: f32;\n    var param_19: vec2<f32>;\n    var param_20: vec3<f32>;\n    var lensed: vec3<f32>;\n    var param_21: vec3<f32>;\n    var param_22: vec2<f32>;\n    var param_23: vec2<f32>;\n    var param_24: vec3<f32>;\n    var param_25: vec3<f32>;\n    var param_26: vec3<f32>;\n    var param_27: vec3<f32>;\n    var param_28: vec2<f32>;\n\n    let _e244 = vUv_1;\n    param_19 = _e244;\n    let _e245 = (*light_1);\n    param_20 = _e245;\n    let _e246 = localExposureGain_u0028_vf2_u003b_vf3_u003b((&param_19), (&param_20));\n    local_4 = _e246;\n    let _e247 = autoExposureGain_u0028_();\n    let _e248 = local_4;\n    let _e250 = (*light_1);\n    (*light_1) = (_e250 * (_e247 * _e248));\n    let _e252 = textureDimensions(uScene_t, 0i);\n    let _e255 = (*light_1);\n    param_21 = _e255;\n    let _e256 = vUv_1;\n    param_22 = _e256;\n    param_23 = vec2<f32>(vec2<i32>(_e252));\n    let _e257 = withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b((&param_21), (&param_22), (&param_23));\n    lensed = _e257;\n    let _e258 = lensed;\n    param_24 = _e258;\n    let _e259 = grade_u0028_vf3_u003b((&param_24));\n    param_25 = _e259;\n    let _e260 = applyColourGrade_u0028_vf3_u003b((&param_25));\n    param_26 = _e260;\n    let _e261 = withVeil_u0028_vf3_u003b((&param_26));\n    param_27 = _e261;\n    let _e262 = gl_FragCoord_1;\n    param_28 = _e262.xy;\n    let _e264 = withGrain_u0028_vf3_u003b_vf2_u003b((&param_27), (&param_28));\n    return _e264;\n}\n\nfn withBloom_u0028_vf3_u003b(c_10: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e233 = unnamed.uBloomStrength;\n    if (_e233 <= 0f) {\n        let _e235 = (*c_10);\n        return _e235;\n    }\n    let _e236 = (*c_10);\n    let _e237 = vUv_1;\n    let _e238 = textureSampleLevel(uBloom_t, uBloom_s, _e237, 0f);\n    let _e241 = unnamed.uBloomStrength;\n    return (_e236 + (_e238.xyz * _e241));\n}\n\nfn circleOfConfusion_u0028_f1_u003b(viewDepth: ptr<function, f32>) -> f32 {\n    var offPlane: f32;\n\n    let _e233 = (*viewDepth);\n    let _e235 = unnamed.uFocusDistance;\n    let _e239 = unnamed.uFocusRange;\n    offPlane = (abs((_e233 - _e235)) - _e239);\n    let _e241 = offPlane;\n    let _e243 = unnamed.uFocusRange;\n    return clamp((_e241 / _e243), 0f, 1f);\n}\n\nfn viewDepthOf_u0028_vf2_u003b(uv_3: ptr<function, vec2<f32>>) -> f32 {\n    var z: f32;\n\n    let _e233 = (*uv_3);\n    let _e234 = textureSampleLevel(uDepth_t, uDepth_s, _e233, 0f);\n    z = (1f - (_e234.x * 2f));\n    let _e240 = unnamed.uDepthToView[0u];\n    let _e241 = z;\n    let _e245 = unnamed.uDepthToView[1u];\n    let _e250 = unnamed.uDepthToView[2u];\n    let _e251 = z;\n    let _e255 = unnamed.uDepthToView[3u];\n    return (-(((_e240 * _e241) + _e245)) / ((_e250 * _e251) + _e255));\n}\n\nfn dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b(direction: ptr<function, vec2<f32>>, radius: ptr<function, f32>, centreDepth: ptr<function, f32>) -> vec4<f32> {\n    var uv_4: vec2<f32>;\n    var depth: f32;\n    var param_29: vec2<f32>;\n    var weight_2: f32;\n    var local_5: f32;\n    var param_30: f32;\n\n    let _e240 = vUv_1;\n    let _e241 = (*direction);\n    let _e242 = (*radius);\n    let _e245 = unnamed.uDofAspect;\n    uv_4 = (_e240 + ((_e241 * _e242) * _e245));\n    let _e248 = uv_4;\n    param_29 = _e248;\n    let _e249 = viewDepthOf_u0028_vf2_u003b((&param_29));\n    depth = _e249;\n    let _e250 = depth;\n    let _e251 = (*centreDepth);\n    if (_e250 >= _e251) {\n        local_5 = 1f;\n    } else {\n        let _e253 = depth;\n        param_30 = _e253;\n        let _e254 = circleOfConfusion_u0028_f1_u003b((&param_30));\n        local_5 = _e254;\n    }\n    let _e255 = local_5;\n    weight_2 = _e255;\n    let _e256 = uv_4;\n    let _e257 = textureSampleLevel(uScene_t, uScene_s, _e256, 0f);\n    let _e259 = weight_2;\n    let _e260 = (_e257.xyz * _e259);\n    let _e261 = weight_2;\n    return vec4<f32>(_e260.x, _e260.y, _e260.z, _e261);\n}\n\nfn depthOfField_u0028_vf3_u003b(centre: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_1: f32;\n    var param_31: vec2<f32>;\n    var coc: f32;\n    var param_32: f32;\n    var radius_1: f32;\n    var sum: vec4<f32>;\n    var param_33: vec2<f32>;\n    var param_34: f32;\n    var param_35: f32;\n    var param_36: vec2<f32>;\n    var param_37: f32;\n    var param_38: f32;\n    var param_39: vec2<f32>;\n    var param_40: f32;\n    var param_41: f32;\n    var param_42: vec2<f32>;\n    var param_43: f32;\n    var param_44: f32;\n    var param_45: vec2<f32>;\n    var param_46: f32;\n    var param_47: f32;\n    var param_48: vec2<f32>;\n    var param_49: f32;\n    var param_50: f32;\n    var param_51: vec2<f32>;\n    var param_52: f32;\n    var param_53: f32;\n    var param_54: vec2<f32>;\n    var param_55: f32;\n    var param_56: f32;\n\n    let _e262 = vUv_1;\n    param_31 = _e262;\n    let _e263 = viewDepthOf_u0028_vf2_u003b((&param_31));\n    depth_1 = _e263;\n    let _e264 = depth_1;\n    param_32 = _e264;\n    let _e265 = circleOfConfusion_u0028_f1_u003b((&param_32));\n    coc = _e265;\n    let _e266 = coc;\n    if (_e266 <= 0f) {\n        let _e268 = (*centre);\n        return _e268;\n    }\n    let _e269 = coc;\n    let _e271 = unnamed.uDofStrength;\n    radius_1 = (_e269 * _e271);\n    let _e273 = (*centre);\n    sum = vec4<f32>(_e273.x, _e273.y, _e273.z, 1f);\n    param_33 = vec2<f32>(0.25f, 0f);\n    let _e278 = radius_1;\n    param_34 = _e278;\n    let _e279 = depth_1;\n    param_35 = _e279;\n    let _e280 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_33), (&param_34), (&param_35));\n    let _e281 = sum;\n    sum = (_e281 + _e280);\n    param_36 = vec2<f32>(-0.31929f, 0.292496f);\n    let _e283 = radius_1;\n    param_37 = _e283;\n    let _e284 = depth_1;\n    param_38 = _e284;\n    let _e285 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_36), (&param_37), (&param_38));\n    let _e286 = sum;\n    sum = (_e286 + _e285);\n    param_39 = vec2<f32>(0.048872f, -0.556877f);\n    let _e288 = radius_1;\n    param_40 = _e288;\n    let _e289 = depth_1;\n    param_41 = _e289;\n    let _e290 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_39), (&param_40), (&param_41));\n    let _e291 = sum;\n    sum = (_e291 + _e290);\n    param_42 = vec2<f32>(0.402444f, 0.524918f);\n    let _e293 = radius_1;\n    param_43 = _e293;\n    let _e294 = depth_1;\n    param_44 = _e294;\n    let _e295 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_42), (&param_43), (&param_44));\n    let _e296 = sum;\n    sum = (_e296 + _e295);\n    param_45 = vec2<f32>(-0.738535f, -0.130636f);\n    let _e298 = radius_1;\n    param_46 = _e298;\n    let _e299 = depth_1;\n    param_47 = _e299;\n    let _e300 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_45), (&param_46), (&param_47));\n    let _e301 = sum;\n    sum = (_e301 + _e300);\n    param_48 = vec2<f32>(0.699605f, -0.445031f);\n    let _e303 = radius_1;\n    param_49 = _e303;\n    let _e304 = depth_1;\n    param_50 = _e304;\n    let _e305 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_48), (&param_49), (&param_50));\n    let _e306 = sum;\n    sum = (_e306 + _e305);\n    param_51 = vec2<f32>(-0.234004f, 0.870484f);\n    let _e308 = radius_1;\n    param_52 = _e308;\n    let _e309 = depth_1;\n    param_53 = _e309;\n    let _e310 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_51), (&param_52), (&param_53));\n    let _e311 = sum;\n    sum = (_e311 + _e310);\n    param_54 = vec2<f32>(-0.446271f, -0.859268f);\n    let _e313 = radius_1;\n    param_55 = _e313;\n    let _e314 = depth_1;\n    param_56 = _e314;\n    let _e315 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_54), (&param_55), (&param_56));\n    let _e316 = sum;\n    sum = (_e316 + _e315);\n    let _e318 = sum;\n    let _e321 = sum[3u];\n    return (_e318.xyz / vec3(_e321));\n}\n\nfn cameraBlur_u0028_vf3_u003b(scene: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var moved: vec4<f32>;\n    var velocity: vec2<f32>;\n    var depth_2: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var distance_: f32;\n    var sum_1: vec3<f32>;\n    var i: i32;\n    var t_2: f32;\n    var phi_1352_: bool;\n\n    let _e242 = vUv_1;\n    let _e243 = textureSampleLevel(uMotion_t, uMotion_s, _e242, 0f);\n    moved = _e243;\n    let _e245 = unnamed.uObjectMotion;\n    let _e246 = (_e245 > 0.5f);\n    phi_1352_ = _e246;\n    if _e246 {\n        let _e248 = moved[3u];\n        phi_1352_ = (_e248 > 0.5f);\n    }\n    let _e251 = phi_1352_;\n    if _e251 {\n        let _e252 = moved;\n        let _e256 = unnamed.uMotionStrength;\n        velocity = (-(_e252.xy) * _e256);\n    } else {\n        let _e258 = vUv_1;\n        let _e259 = textureSampleLevel(uDepth_t, uDepth_s, _e258, 0f);\n        depth_2 = _e259.x;\n        let _e261 = vUv_1;\n        let _e264 = ((_e261 * 2f) - vec2(1f));\n        let _e265 = depth_2;\n        clip = vec4<f32>(_e264.x, _e264.y, (1f - (_e265 * 2f)), 1f);\n        let _e272 = unnamed.uReprojection;\n        let _e273 = clip;\n        previous = (_e272 * _e273);\n        let _e276 = previous[3u];\n        if (_e276 <= 0f) {\n            let _e278 = (*scene);\n            return _e278;\n        }\n        let _e279 = previous;\n        let _e282 = previous[3u];\n        wasUv = (((_e279.xy / vec2(_e282)) * 0.5f) + vec2(0.5f));\n        let _e288 = vUv_1;\n        let _e289 = wasUv;\n        let _e292 = unnamed.uMotionStrength;\n        velocity = ((_e288 - _e289) * _e292);\n    }\n    let _e294 = velocity;\n    distance_ = length(_e294);\n    let _e296 = distance_;\n    if (_e296 < 0.0001f) {\n        let _e298 = (*scene);\n        return _e298;\n    }\n    let _e299 = distance_;\n    let _e301 = unnamed.uMotionMax;\n    if (_e299 > _e301) {\n        let _e304 = unnamed.uMotionMax;\n        let _e305 = distance_;\n        let _e307 = velocity;\n        velocity = (_e307 * (_e304 / _e305));\n    }\n    let _e309 = (*scene);\n    sum_1 = _e309;\n    i = 1i;\n    loop {\n        let _e310 = i;\n        if (_e310 <= 4i) {\n            let _e312 = i;\n            t_2 = ((f32(_e312) / 4f) * 0.5f);\n            let _e316 = vUv_1;\n            let _e317 = velocity;\n            let _e318 = t_2;\n            let _e321 = textureSampleLevel(uScene_t, uScene_s, (_e316 + (_e317 * _e318)), 0f);\n            let _e323 = sum_1;\n            sum_1 = (_e323 + _e321.xyz);\n            let _e325 = vUv_1;\n            let _e326 = velocity;\n            let _e327 = t_2;\n            let _e330 = textureSampleLevel(uScene_t, uScene_s, (_e325 - (_e326 * _e327)), 0f);\n            let _e332 = sum_1;\n            sum_1 = (_e332 + _e330.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e334 = i;\n            i = (_e334 + 1i);\n        }\n    }\n    let _e336 = sum_1;\n    return (_e336 / vec3(9f));\n}\n\nfn withFringe_u0028_vf3_u003b(scene_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var lens: vec2<f32>;\n    var past: vec2<f32>;\n    var red: vec2<f32>;\n    var green: vec2<f32>;\n\n    let _e238 = unnamed.uFringe[0u];\n    if (_e238 <= 0f) {\n        let _e240 = (*scene_1);\n        return _e240;\n    }\n    let _e241 = vUv_1;\n    lens = ((_e241 * 2f) - vec2(1f));\n    let _e245 = lens;\n    let _e247 = lens;\n    let _e251 = unnamed.uFringe[2u];\n    past = (sign(_e245) * clamp((abs(_e247) - vec2(_e251)), vec2(0f), vec2(1f)));\n    let _e258 = lens;\n    let _e259 = past;\n    let _e262 = unnamed.uFringe[0u];\n    red = (((_e258 - (_e259 * _e262)) * 0.5f) + vec2(0.5f));\n    let _e268 = lens;\n    let _e269 = past;\n    let _e272 = unnamed.uFringe[1u];\n    green = (((_e268 - (_e269 * _e272)) * 0.5f) + vec2(0.5f));\n    let _e278 = red;\n    let _e279 = textureSampleLevel(uScene_t, uScene_s, _e278, 0f);\n    let _e281 = green;\n    let _e282 = textureSampleLevel(uScene_t, uScene_s, _e281, 0f);\n    let _e285 = (*scene_1)[2u];\n    return vec3<f32>(_e279.x, _e282.y, _e285);\n}\n\nfn main_1() {\n    var sampled: vec4<f32>;\n    var scene_2: vec3<f32>;\n    var param_57: vec3<f32>;\n    var param_58: vec3<f32>;\n    var param_59: vec3<f32>;\n    var share: f32;\n    var ao: f32;\n    var param_60: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var radius_2: f32;\n    var inner: f32;\n    var edge: f32;\n    var amount: f32;\n    var param_61: vec3<f32>;\n    var param_62: vec3<f32>;\n    var step_: vec2<f32>;\n    var sum_2: vec3<f32>;\n    var i_1: i32;\n    var blurred: vec3<f32>;\n    var param_63: vec3<f32>;\n    var param_64: vec3<f32>;\n\n    let _e252 = vUv_1;\n    let _e253 = textureSampleLevel(uScene_t, uScene_s, _e252, 0f);\n    sampled = _e253;\n    let _e254 = sampled;\n    param_57 = _e254.xyz;\n    let _e256 = withFringe_u0028_vf3_u003b((&param_57));\n    scene_2 = _e256;\n    let _e258 = unnamed.uMotionStrength;\n    if (_e258 > 0f) {\n        let _e260 = scene_2;\n        param_58 = _e260;\n        let _e261 = cameraBlur_u0028_vf3_u003b((&param_58));\n        scene_2 = _e261;\n    }\n    let _e263 = unnamed.uDofStrength;\n    if (_e263 > 0f) {\n        let _e265 = scene_2;\n        param_59 = _e265;\n        let _e266 = depthOfField_u0028_vf3_u003b((&param_59));\n        scene_2 = _e266;\n    }\n    let _e268 = sampled[3u];\n    share = clamp(_e268, 0f, 1f);\n    let _e270 = vUv_1;\n    let _e272 = unnamed.uAoOffset;\n    let _e274 = textureSampleLevel(uAo_t, uAo_s, (_e270 + _e272), 0f);\n    let _e277 = unnamed.uAoStrength;\n    let _e278 = share;\n    ao = mix(1f, _e274.x, (_e277 * _e278));\n    let _e282 = unnamed.uSceneGraded;\n    if (_e282 != 0i) {\n        let _e284 = ao;\n        param_60 = vec3(_e284);\n        let _e286 = linearToSrgb_u0028_vf3_u003b((&param_60));\n        ao = _e286.x;\n    }\n    let _e288 = vUv_1;\n    fromCentre = (_e288 - vec2(0.5f));\n    let _e291 = fromCentre;\n    radius_2 = (length((_e291 * vec2<f32>(1f, 0.62f))) * 2f);\n    let _e296 = unnamed.uStrength;\n    inner = mix(0.62f, 0.3f, _e296);\n    let _e298 = inner;\n    let _e299 = radius_2;\n    edge = smoothstep(_e298, 1f, _e299);\n    let _e301 = edge;\n    let _e303 = unnamed.uStrength;\n    amount = (_e301 * _e303);\n    let _e305 = amount;\n    if (_e305 <= 0f) {\n        let _e307 = scene_2;\n        let _e308 = ao;\n        param_61 = (_e307 * _e308);\n        let _e310 = withBloom_u0028_vf3_u003b((&param_61));\n        param_62 = _e310;\n        let _e311 = finish_u0028_vf3_u003b((&param_62));\n        fragColor = vec4<f32>(_e311.x, _e311.y, _e311.z, 1f);\n        return;\n    }\n    let _e316 = fromCentre;\n    let _e320 = unnamed.uReach;\n    let _e322 = amount;\n    step_ = ((normalize((_e316 + vec2<f32>(0.000001f, 0.000001f))) * _e320) * _e322);\n    let _e324 = scene_2;\n    sum_2 = _e324;\n    i_1 = 1i;\n    loop {\n        let _e325 = i_1;\n        if (_e325 <= 6i) {\n            let _e327 = vUv_1;\n            let _e328 = step_;\n            let _e329 = i_1;\n            let _e334 = textureSampleLevel(uScene_t, uScene_s, (_e327 + (_e328 * (f32(_e329) / 6f))), 0f);\n            let _e336 = sum_2;\n            sum_2 = (_e336 + _e334.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e338 = i_1;\n            i_1 = (_e338 + 1i);\n        }\n    }\n    let _e340 = sum_2;\n    blurred = (_e340 / vec3(7f));\n    let _e343 = scene_2;\n    let _e344 = blurred;\n    let _e345 = amount;\n    let _e348 = ao;\n    param_63 = (mix(_e343, _e344, vec3(_e345)) * _e348);\n    let _e350 = withBloom_u0028_vf3_u003b((&param_63));\n    param_64 = _e350;\n    let _e351 = finish_u0028_vf3_u003b((&param_64));\n    fragColor = vec4<f32>(_e351.x, _e351.y, _e351.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const RUSH_BINDINGS = {
  "RUSH_FRAG": {
    "uniforms": 1,
    "uniformSize": 288,
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
      "uSceneGraded": {
        "offset": 16,
        "size": 4,
        "type": "int"
      },
      "uFilmA": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uFilmB": {
        "offset": 48,
        "size": 16,
        "type": "vec4"
      },
      "uDisplayHeadroom": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uReprojection": {
        "offset": 80,
        "size": 64,
        "type": "mat4"
      },
      "uMotionStrength": {
        "offset": 144,
        "size": 4,
        "type": "float"
      },
      "uMotionMax": {
        "offset": 148,
        "size": 4,
        "type": "float"
      },
      "uObjectMotion": {
        "offset": 152,
        "size": 4,
        "type": "float"
      },
      "uAoStrength": {
        "offset": 156,
        "size": 4,
        "type": "float"
      },
      "uAoOffset": {
        "offset": 160,
        "size": 8,
        "type": "vec2"
      },
      "uBloomStrength": {
        "offset": 168,
        "size": 4,
        "type": "float"
      },
      "uVeilColor": {
        "offset": 176,
        "size": 12,
        "type": "vec3"
      },
      "uVeilAlpha": {
        "offset": 188,
        "size": 4,
        "type": "float"
      },
      "uVignette": {
        "offset": 192,
        "size": 4,
        "type": "float"
      },
      "uGrain": {
        "offset": 200,
        "size": 8,
        "type": "vec2"
      },
      "uAutoExposure": {
        "offset": 208,
        "size": 4,
        "type": "float"
      },
      "uLocalExposure": {
        "offset": 212,
        "size": 4,
        "type": "float"
      },
      "uGradeStrength": {
        "offset": 216,
        "size": 4,
        "type": "float"
      },
      "uGradeSize": {
        "offset": 220,
        "size": 4,
        "type": "float"
      },
      "uFocusDistance": {
        "offset": 224,
        "size": 4,
        "type": "float"
      },
      "uFocusRange": {
        "offset": 228,
        "size": 4,
        "type": "float"
      },
      "uDofStrength": {
        "offset": 232,
        "size": 4,
        "type": "float"
      },
      "uDofAspect": {
        "offset": 240,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToView": {
        "offset": 256,
        "size": 16,
        "type": "vec4"
      },
      "uFringe": {
        "offset": 272,
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
