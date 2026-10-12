/*
 * Generated from ../rush.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const RUSH_FRAG_WGSL = "struct Uniforms {\n    uStrength: f32,\n    uReach: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uSceneGraded: i32,\n    uFilmA: vec4<f32>,\n    uFilmB: vec4<f32>,\n    uDisplayHeadroom: f32,\n    uReprojection: mat4x4<f32>,\n    uMotionStrength: f32,\n    uMotionMax: f32,\n    uObjectMotion: f32,\n    uAoStrength: f32,\n    uAoOffset: vec2<f32>,\n    uBloomStrength: f32,\n    uVeilColor: vec3<f32>,\n    uVeilAlpha: f32,\n    uVignette: f32,\n    uGrain: vec2<f32>,\n    uAutoExposure: f32,\n    uLocalExposure: f32,\n    uLocalShape: vec4<f32>,\n    uLocalPivot: vec4<f32>,\n    uGradeStrength: f32,\n    uGradeSize: f32,\n    uFocusDistance: f32,\n    uFocusRange: f32,\n    uDofStrength: f32,\n    uDofAspect: vec2<f32>,\n    uDepthToView: vec4<f32>,\n    uFringe: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(42) \nvar uExposureHeld_t: texture_2d<f32>;\n@group(0) @binding(44) \nvar uExposureLocal_t: texture_2d<f32>;\n@group(0) @binding(45) \nvar uExposureLocal_s: sampler;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\n@group(0) @binding(40) \nvar uBloom_t: texture_2d<f32>;\n@group(0) @binding(41) \nvar uBloom_s: sampler;\n@group(0) @binding(46) \nvar uGradeLut_t: texture_3d<f32>;\n@group(0) @binding(47) \nvar uGradeLut_s: sampler;\n@group(0) @binding(36) \nvar uMotion_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uMotion_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(38) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uAo_s: sampler;\nvar<private> fragColor: vec4<f32>;\n@group(0) @binding(43) \nvar uExposureHeld_s: sampler;\n\nfn grainNoise_u0028_vu2_u003b_u1_u003b(p: ptr<function, vec2<u32>>, seed: ptr<function, u32>) -> f32 {\n    var h: u32;\n\n    let _e236 = (*p)[0u];\n    let _e239 = (*p)[1u];\n    let _e242 = (*seed);\n    h = (((_e236 * 1664525u) + (_e239 * 1013904223u)) + (_e242 * 2654435769u));\n    let _e245 = h;\n    let _e248 = h;\n    h = (_e248 ^ (_e245 >> bitcast<u32>(16u)));\n    let _e250 = h;\n    h = (_e250 * 2246822519u);\n    let _e252 = h;\n    let _e255 = h;\n    h = (_e255 ^ (_e252 >> bitcast<u32>(13u)));\n    let _e257 = h;\n    h = (_e257 * 3266489917u);\n    let _e259 = h;\n    let _e262 = h;\n    h = (_e262 ^ (_e259 >> bitcast<u32>(16u)));\n    let _e264 = h;\n    return (f32(_e264) * 0.00000000023283064f);\n}\n\nfn withGrain_u0028_vf3_u003b_vf2_u003b(c: ptr<function, vec3<f32>>, fragCoord: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var luma: f32;\n    var weight: f32;\n    var n: f32;\n    var param: vec2<u32>;\n    var param_1: u32;\n\n    let _e241 = unnamed.uGrain[0u];\n    if (_e241 <= 0f) {\n        let _e243 = (*c);\n        return _e243;\n    }\n    let _e244 = (*c);\n    luma = dot(clamp(_e244, vec3(0f), vec3(1f)), vec3<f32>(0.2126f, 0.7152f, 0.0722f));\n    let _e249 = luma;\n    let _e251 = luma;\n    weight = (0.25f + ((3f * _e249) * (1f - _e251)));\n    let _e255 = (*fragCoord);\n    let _e259 = unnamed.uGrain[1u];\n    param = vec2<u32>(_e255);\n    param_1 = u32(_e259);\n    let _e261 = grainNoise_u0028_vu2_u003b_u1_u003b((&param), (&param_1));\n    n = (_e261 - 0.5f);\n    let _e263 = (*c);\n    let _e264 = n;\n    let _e268 = unnamed.uGrain[0u];\n    let _e270 = weight;\n    return (_e263 + vec3((((2f * _e264) * _e268) * _e270)));\n}\n\nfn withVeil_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e234 = unnamed.uVeilAlpha;\n    if (_e234 <= 0f) {\n        let _e236 = (*c_1);\n        return _e236;\n    }\n    let _e237 = (*c_1);\n    let _e239 = unnamed.uVeilColor;\n    let _e241 = unnamed.uVeilAlpha;\n    return mix(_e237, _e239, vec3(_e241));\n}\n\nfn applyColourGrade_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var over: f32;\n    var local: f32;\n    var clamped: vec3<f32>;\n    var uvw: vec3<f32>;\n\n    let _e238 = unnamed.uGradeStrength;\n    if (_e238 <= 0f) {\n        let _e240 = (*c_2);\n        return _e240;\n    }\n    let _e242 = unnamed.uDisplayHeadroom;\n    if (_e242 > 1f) {\n        let _e245 = (*c_2)[0u];\n        let _e247 = (*c_2)[1u];\n        let _e249 = (*c_2)[2u];\n        local = max(max(_e245, max(_e247, _e249)), 1f);\n    } else {\n        local = 1f;\n    }\n    let _e253 = local;\n    over = _e253;\n    let _e254 = (*c_2);\n    let _e255 = over;\n    clamped = clamp((_e254 / vec3(_e255)), vec3(0f), vec3(1f));\n    let _e261 = clamped;\n    let _e263 = unnamed.uGradeSize;\n    let _e269 = unnamed.uGradeSize;\n    uvw = (((_e261 * (_e263 - 1f)) + vec3(0.5f)) / vec3(_e269));\n    let _e272 = (*c_2);\n    let _e273 = uvw;\n    let _e274 = textureSampleLevel(uGradeLut_t, uGradeLut_s, _e273, 0f);\n    let _e276 = over;\n    let _e279 = unnamed.uGradeStrength;\n    return mix(_e272, (_e274.xyz * _e276), vec3(_e279));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c_3: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e235 = (*c_3);\n    low = (_e235 * 12.92f);\n    let _e237 = (*c_3);\n    high = ((pow(max(_e237, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e243 = low;\n    let _e244 = high;\n    let _e245 = (*c_3);\n    return mix(_e243, _e244, step(vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f), _e245));\n}\n\nfn filmCentredHue_u0028_vf3_u003b(c_4: ptr<function, vec3<f32>>) -> f32 {\n    var y: f32;\n    var x: f32;\n    var phi_936_: bool;\n\n    let _e236 = (*c_4)[1u];\n    let _e238 = (*c_4)[2u];\n    y = (1.7320508f * (_e236 - _e238));\n    let _e242 = (*c_4)[0u];\n    let _e245 = (*c_4)[1u];\n    let _e248 = (*c_4)[2u];\n    x = (((2f * _e242) - _e245) - _e248);\n    let _e250 = x;\n    let _e252 = (abs(_e250) < 0.0000000001f);\n    phi_936_ = _e252;\n    if _e252 {\n        let _e253 = y;\n        phi_936_ = (abs(_e253) < 0.0000000001f);\n    }\n    let _e257 = phi_936_;\n    if _e257 {\n        return 0f;\n    }\n    let _e258 = y;\n    let _e259 = x;\n    return degrees(atan2(_e258, _e259));\n}\n\nfn filmGlow_u0028_f1_u003b_f1_u003b_f1_u003b(yc: ptr<function, f32>, gain: ptr<function, f32>, mid: ptr<function, f32>) -> f32 {\n    let _e235 = (*yc);\n    let _e236 = (*mid);\n    if (_e235 <= (0.6666667f * _e236)) {\n        let _e239 = (*gain);\n        return _e239;\n    }\n    let _e240 = (*yc);\n    let _e241 = (*mid);\n    if (_e240 >= (2f * _e241)) {\n        return 0f;\n    }\n    let _e244 = (*gain);\n    let _e245 = (*mid);\n    let _e246 = (*yc);\n    return (_e244 * ((_e245 / _e246) - 0.5f));\n}\n\nfn filmSigmoid_u0028_f1_u003b(x_1: ptr<function, f32>) -> f32 {\n    var t: f32;\n\n    let _e234 = (*x_1);\n    t = max((1f - abs((_e234 / 2f))), 0f);\n    let _e239 = (*x_1);\n    let _e241 = t;\n    let _e242 = t;\n    return ((1f + (sign(_e239) * (1f - (_e241 * _e242)))) / 2f);\n}\n\nfn filmYc_u0028_vf3_u003b(c_5: ptr<function, vec3<f32>>) -> f32 {\n    var chroma: f32;\n\n    let _e235 = (*c_5)[2u];\n    let _e237 = (*c_5)[2u];\n    let _e239 = (*c_5)[1u];\n    let _e243 = (*c_5)[1u];\n    let _e245 = (*c_5)[1u];\n    let _e247 = (*c_5)[0u];\n    let _e252 = (*c_5)[0u];\n    let _e254 = (*c_5)[0u];\n    let _e256 = (*c_5)[2u];\n    chroma = sqrt(max((((_e235 * (_e237 - _e239)) + (_e243 * (_e245 - _e247))) + (_e252 * (_e254 - _e256))), 0f));\n    let _e263 = (*c_5)[2u];\n    let _e265 = (*c_5)[1u];\n    let _e268 = (*c_5)[0u];\n    let _e270 = chroma;\n    return ((((_e263 + _e265) + _e268) + (1.75f * _e270)) / 3f);\n}\n\nfn filmSaturation_u0028_vf3_u003b(c_6: ptr<function, vec3<f32>>) -> f32 {\n    var hi: f32;\n    var lo: f32;\n\n    let _e236 = (*c_6)[0u];\n    let _e238 = (*c_6)[1u];\n    let _e240 = (*c_6)[2u];\n    hi = max(_e236, max(_e238, _e240));\n    let _e244 = (*c_6)[0u];\n    let _e246 = (*c_6)[1u];\n    let _e248 = (*c_6)[2u];\n    lo = min(_e244, min(_e246, _e248));\n    let _e251 = hi;\n    let _e253 = lo;\n    let _e256 = hi;\n    return ((max(_e251, 0.0000000001f) - max(_e253, 0.0000000001f)) / max(_e256, 0.01f));\n}\n\nfn filmicCurve_u0028_vf3_u003b(linear: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var ap0_: vec3<f32>;\n    var saturation: f32;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: f32;\n    var param_5: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var weight_1: f32;\n    var param_8: vec3<f32>;\n    var work: vec3<f32>;\n    var slope: f32;\n    var black: f32;\n    var white: f32;\n    var toeScale: f32;\n    var shoulderScale: f32;\n    var toeMatch: f32;\n    var straightMatch: f32;\n    var shoulderMatch: f32;\n    var logc: vec3<f32>;\n    var straight: vec3<f32>;\n    var toeC: vec3<f32>;\n    var shoulderC: vec3<f32>;\n    var t_1: vec3<f32>;\n    var tone: vec3<f32>;\n    var ceiling: f32;\n    var local_1: f32;\n\n    let _e260 = (*linear);\n    ap0_ = (mat3x3<f32>(vec3<f32>(0.6954522f, 0.044794563f, -0.005525883f), vec3<f32>(0.1406787f, 0.8596711f, 0.00402521f), vec3<f32>(0.16386907f, 0.09553432f, 1.0015007f)) * (mat3x3<f32>(vec3<f32>(0.61319f, 0.07021f, 0.02062f), vec3<f32>(0.33951f, 0.91634f, 0.10957f), vec3<f32>(0.04737f, 0.01345f, 0.86961f)) * _e260));\n    let _e263 = ap0_;\n    param_2 = _e263;\n    let _e264 = filmSaturation_u0028_vf3_u003b((&param_2));\n    saturation = _e264;\n    let _e265 = ap0_;\n    param_3 = _e265;\n    let _e266 = filmYc_u0028_vf3_u003b((&param_3));\n    let _e267 = saturation;\n    param_4 = ((_e267 - 0.4f) / 0.2f);\n    let _e270 = filmSigmoid_u0028_f1_u003b((&param_4));\n    param_5 = _e266;\n    param_6 = (0.05f * _e270);\n    param_7 = 0.08f;\n    let _e272 = filmGlow_u0028_f1_u003b_f1_u003b_f1_u003b((&param_5), (&param_6), (&param_7));\n    let _e274 = ap0_;\n    ap0_ = (_e274 * (1f + _e272));\n    let _e276 = ap0_;\n    param_8 = _e276;\n    let _e277 = filmCentredHue_u0028_vf3_u003b((&param_8));\n    weight_1 = smoothstep(0f, 1f, (1f - abs(((2f * _e277) / 135f))));\n    let _e283 = weight_1;\n    let _e284 = weight_1;\n    let _e286 = saturation;\n    let _e289 = ap0_[0u];\n    let _e294 = ap0_[0u];\n    ap0_[0u] = (_e294 + ((((_e283 * _e284) * _e286) * (0.03f - _e289)) * 0.18f));\n    let _e297 = ap0_;\n    work = max((mat3x3<f32>(vec3<f32>(1.4514393f, -0.07655378f, 0.008316148f), vec3<f32>(-0.23651075f, 1.1762297f, -0.0060324497f), vec3<f32>(-0.21492857f, -0.09967592f, 0.9977163f)) * _e297), vec3<f32>(0f, 0f, 0f));\n    let _e300 = work;\n    let _e303 = work;\n    work = mix(vec3(dot(_e300, vec3<f32>(0.27222872f, 0.67408174f, 0.053689517f))), _e303, vec3(0.96f));\n    let _e308 = unnamed.uFilmA[0u];\n    slope = _e308;\n    let _e311 = unnamed.uFilmA[1u];\n    black = _e311;\n    let _e314 = unnamed.uFilmA[2u];\n    white = _e314;\n    let _e317 = unnamed.uFilmA[3u];\n    toeScale = _e317;\n    let _e320 = unnamed.uFilmB[0u];\n    shoulderScale = _e320;\n    let _e323 = unnamed.uFilmB[1u];\n    toeMatch = _e323;\n    let _e326 = unnamed.uFilmB[2u];\n    straightMatch = _e326;\n    let _e329 = unnamed.uFilmB[3u];\n    shoulderMatch = _e329;\n    let _e330 = work;\n    logc = (log2(max(_e330, vec3<f32>(0.0000000001f, 0.0000000001f, 0.0000000001f))) * 0.30103f);\n    let _e334 = slope;\n    let _e335 = logc;\n    let _e336 = straightMatch;\n    straight = ((_e335 + vec3(_e336)) * _e334);\n    let _e340 = black;\n    let _e342 = toeScale;\n    let _e344 = slope;\n    let _e346 = toeScale;\n    let _e348 = logc;\n    let _e349 = toeMatch;\n    toeC = (vec3(-(_e340)) + (vec3((2f * _e342)) / (vec3(1f) + exp(((_e348 - vec3(_e349)) * ((-2f * _e344) / _e346))))));\n    let _e360 = white;\n    let _e362 = shoulderScale;\n    let _e364 = slope;\n    let _e366 = shoulderScale;\n    let _e368 = logc;\n    let _e369 = shoulderMatch;\n    shoulderC = (vec3((1f + _e360)) - (vec3((2f * _e362)) / (vec3(1f) + exp(((_e368 - vec3(_e369)) * ((2f * _e364) / _e366))))));\n    let _e380 = straight;\n    let _e381 = toeC;\n    let _e382 = logc;\n    let _e383 = toeMatch;\n    toeC = mix(_e380, _e381, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e382 < vec3(_e383))));\n    let _e388 = straight;\n    let _e389 = shoulderC;\n    let _e390 = logc;\n    let _e391 = shoulderMatch;\n    shoulderC = mix(_e388, _e389, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e390 > vec3(_e391))));\n    let _e396 = logc;\n    let _e397 = toeMatch;\n    let _e400 = shoulderMatch;\n    let _e401 = toeMatch;\n    t_1 = clamp(((_e396 - vec3(_e397)) / vec3((_e400 - _e401))), vec3(0f), vec3(1f));\n    let _e408 = shoulderMatch;\n    let _e409 = toeMatch;\n    if (_e408 < _e409) {\n        let _e411 = t_1;\n        t_1 = (vec3(1f) - _e411);\n    }\n    let _e414 = t_1;\n    let _e418 = t_1;\n    let _e420 = t_1;\n    t_1 = (((vec3(3f) - (_e414 * 2f)) * _e418) * _e420);\n    let _e422 = toeC;\n    let _e423 = shoulderC;\n    let _e424 = t_1;\n    tone = mix(_e422, _e423, _e424);\n    let _e426 = tone;\n    let _e429 = tone;\n    tone = mix(vec3(dot(_e426, vec3<f32>(0.27222872f, 0.67408174f, 0.053689517f))), _e429, vec3(0.93f));\n    let _e433 = unnamed.uDisplayHeadroom;\n    if (_e433 > 1f) {\n        let _e435 = white;\n        local_1 = (1f + _e435);\n    } else {\n        local_1 = 1f;\n    }\n    let _e437 = local_1;\n    ceiling = _e437;\n    let _e438 = tone;\n    let _e441 = ceiling;\n    return clamp((mat3x3<f32>(vec3<f32>(1.7048f, -0.13027f, -0.02401f), vec3<f32>(-0.62168f, 1.14082f, -0.129f), vec3<f32>(-0.08325f, -0.01055f, 1.15324f)) * max(_e438, vec3<f32>(0f, 0f, 0f))), vec3(0f), vec3(_e441));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_7: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e236 = (*c_7)[0u];\n    let _e238 = (*c_7)[1u];\n    let _e240 = (*c_7)[2u];\n    m = max(_e236, max(_e238, _e240));\n    let _e243 = m;\n    if (_e243 <= 0.8f) {\n        let _e245 = (*c_7);\n        return _e245;\n    }\n    let _e246 = m;\n    e = (_e246 - 0.8f);\n    let _e248 = (*c_7);\n    let _e249 = e;\n    let _e251 = e;\n    let _e255 = m;\n    return (_e248 * ((0.8f + ((0.2f * _e249) / (_e251 + 0.2f))) / _e255));\n}\n\nfn acesFilmic_u0028_vf3_u003b(x_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var v: vec3<f32>;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e237 = unnamed.uOutputExposure;\n    let _e238 = (*x_2);\n    (*x_2) = (_e238 * _e237);\n    let _e240 = (*x_2);\n    v = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e240);\n    let _e242 = v;\n    let _e243 = v;\n    a = ((_e242 * (_e243 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e249 = v;\n    let _e250 = v;\n    b = ((_e249 * ((_e250 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e257 = a;\n    let _e258 = b;\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * (_e257 / _e258)), vec3(0f), vec3(1f));\n}\n\nfn grade_u0028_vf3_u003b(c_8: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_9: vec3<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var param_12: vec3<f32>;\n\n    let _e238 = unnamed.uOutputTransform;\n    if (_e238 == 0i) {\n        let _e240 = (*c_8);\n        return _e240;\n    }\n    let _e242 = unnamed.uOutputTransform;\n    if (_e242 == 2i) {\n        let _e244 = (*c_8);\n        param_9 = _e244;\n        let _e245 = acesFilmic_u0028_vf3_u003b((&param_9));\n        (*c_8) = _e245;\n    }\n    let _e247 = unnamed.uOutputTransform;\n    if (_e247 == 3i) {\n        let _e249 = (*c_8);\n        let _e251 = unnamed.uOutputExposure;\n        param_10 = (_e249 * _e251);\n        let _e253 = highlightShoulder_u0028_vf3_u003b((&param_10));\n        (*c_8) = _e253;\n    }\n    let _e255 = unnamed.uOutputTransform;\n    if (_e255 == 4i) {\n        let _e257 = (*c_8);\n        let _e259 = unnamed.uOutputExposure;\n        param_11 = (_e257 * _e259);\n        let _e261 = filmicCurve_u0028_vf3_u003b((&param_11));\n        (*c_8) = _e261;\n    }\n    let _e262 = (*c_8);\n    param_12 = _e262;\n    let _e263 = linearToSrgb_u0028_vf3_u003b((&param_12));\n    return _e263;\n}\n\nfn withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b(c_9: ptr<function, vec3<f32>>, uv: ptr<function, vec2<f32>>, size: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var d: vec2<f32>;\n    var corner: vec2<f32>;\n    var r2_: f32;\n    var falloff: f32;\n\n    let _e240 = unnamed.uVignette;\n    if (_e240 <= 0f) {\n        let _e242 = (*c_9);\n        return _e242;\n    }\n    let _e243 = (*uv);\n    let _e246 = (*size);\n    d = ((_e243 - vec2(0.5f)) * _e246);\n    let _e248 = (*size);\n    corner = (_e248 * 0.5f);\n    let _e250 = d;\n    let _e251 = d;\n    let _e253 = corner;\n    let _e254 = corner;\n    r2_ = (dot(_e250, _e251) / dot(_e253, _e254));\n    let _e258 = unnamed.uVignette;\n    let _e259 = r2_;\n    falloff = (1f + (_e258 * _e259));\n    let _e262 = (*c_9);\n    let _e263 = falloff;\n    let _e264 = falloff;\n    return (_e262 / vec3((_e263 * _e264)));\n}\n\nfn autoExposureGain_u0028_() -> f32 {\n    var held: f32;\n    var stops: f32;\n\n    let _e235 = unnamed.uAutoExposure;\n    if (_e235 <= 0f) {\n        return 1f;\n    }\n    let _e237 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held = _e237.x;\n    let _e240 = unnamed.uAutoExposure;\n    let _e241 = held;\n    stops = (_e240 * (-2.473931f - _e241));\n    let _e244 = stops;\n    return exp2(clamp(_e244, -6f, 6f));\n}\n\nfn localBlock_u0028_vf2_u003b_f1_u003b(uv_1: ptr<function, vec2<f32>>, block: ptr<function, f32>) -> vec2<f32> {\n    var inside: vec2<f32>;\n\n    let _e235 = (*uv_1);\n    inside = clamp(_e235, vec2<f32>(0.015625f, 0.015625f), vec2<f32>(0.984375f, 0.984375f));\n    let _e237 = (*block);\n    let _e239 = inside[0u];\n    let _e243 = inside[1u];\n    let _e245 = textureSampleLevel(uExposureLocal_t, uExposureLocal_s, vec2<f32>(((_e237 + _e239) / 11f), _e243), 0f);\n    return _e245.xy;\n}\n\nfn localExposureGain_u0028_vf2_u003b_vf3_u003b(uv_2: ptr<function, vec2<f32>>, light: ptr<function, vec3<f32>>) -> f32 {\n    var held_1: f32;\n    var pixel: f32;\n    var b_1: f32;\n    var lower: f32;\n    var upper: f32;\n    var banded: vec2<f32>;\n    var param_13: vec2<f32>;\n    var param_14: f32;\n    var param_15: vec2<f32>;\n    var param_16: f32;\n    var tileMean: f32;\n    var param_17: vec2<f32>;\n    var param_18: f32;\n    var bilateral: f32;\n    var local_2: f32;\n    var local_3: f32;\n    var pivot: f32;\n    var local_4: f32;\n    var keep: f32;\n    var local_5: f32;\n    var stops_1: f32;\n\n    let _e256 = unnamed.uLocalExposure;\n    if (_e256 <= 0f) {\n        return 1f;\n    }\n    let _e258 = textureLoad(uExposureHeld_t, vec2<i32>(0i, 0i), 0i);\n    held_1 = _e258.x;\n    let _e260 = (*light);\n    pixel = clamp(log2(max(dot(_e260, vec3<f32>(0.2126f, 0.7152f, 0.0722f)), 0.00000001f)), -12f, 8f);\n    let _e265 = pixel;\n    b_1 = (((_e265 - -12f) / 2f) - 0.5f);\n    let _e269 = b_1;\n    lower = clamp(floor(_e269), 0f, 9f);\n    let _e272 = lower;\n    upper = min((_e272 + 1f), 9f);\n    let _e275 = (*uv_2);\n    param_13 = _e275;\n    let _e276 = lower;\n    param_14 = _e276;\n    let _e277 = localBlock_u0028_vf2_u003b_f1_u003b((&param_13), (&param_14));\n    let _e278 = (*uv_2);\n    param_15 = _e278;\n    let _e279 = upper;\n    param_16 = _e279;\n    let _e280 = localBlock_u0028_vf2_u003b_f1_u003b((&param_15), (&param_16));\n    let _e281 = b_1;\n    let _e282 = lower;\n    banded = mix(_e277, _e280, vec2(clamp((_e281 - _e282), 0f, 1f)));\n    let _e287 = (*uv_2);\n    param_17 = _e287;\n    param_18 = 10f;\n    let _e288 = localBlock_u0028_vf2_u003b_f1_u003b((&param_17), (&param_18));\n    tileMean = _e288.x;\n    let _e291 = banded[1u];\n    if (_e291 > 0.001f) {\n        let _e294 = banded[0u];\n        let _e296 = banded[1u];\n        local_2 = (_e294 / _e296);\n    } else {\n        let _e298 = tileMean;\n        local_2 = _e298;\n    }\n    let _e299 = local_2;\n    bilateral = _e299;\n    let _e300 = bilateral;\n    let _e301 = tileMean;\n    let _e304 = unnamed.uLocalShape[3u];\n    local_3 = mix(_e300, _e301, _e304);\n    let _e308 = unnamed.uLocalPivot[0u];\n    if (_e308 > 0.5f) {\n        let _e310 = held_1;\n        local_4 = _e310;\n    } else {\n        let _e311 = autoExposureGain_u0028_();\n        let _e313 = unnamed.uOutputExposure;\n        local_4 = (-2.473931f - log2(max((_e311 * _e313), 0.00000001f)));\n    }\n    let _e318 = local_4;\n    pivot = _e318;\n    let _e321 = unnamed.uLocalPivot[1u];\n    let _e322 = pivot;\n    pivot = (_e322 + _e321);\n    let _e324 = local_3;\n    let _e325 = pivot;\n    if (_e324 > _e325) {\n        let _e329 = unnamed.uLocalShape[0u];\n        local_5 = _e329;\n    } else {\n        let _e332 = unnamed.uLocalShape[1u];\n        local_5 = _e332;\n    }\n    let _e333 = local_5;\n    keep = _e333;\n    let _e334 = local_3;\n    let _e335 = pivot;\n    let _e337 = keep;\n    let _e339 = pixel;\n    let _e340 = local_3;\n    let _e344 = unnamed.uLocalShape[2u];\n    stops_1 = (((_e334 - _e335) * _e337) + ((_e339 - _e340) * _e344));\n    let _e347 = stops_1;\n    let _e350 = unnamed.uLocalPivot[2u];\n    let _e354 = unnamed.uLocalPivot[2u];\n    return exp2(clamp(_e347, -(_e350), _e354));\n}\n\nfn finish_u0028_vf3_u003b(light_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var local_6: f32;\n    var param_19: vec2<f32>;\n    var param_20: vec3<f32>;\n    var lensed: vec3<f32>;\n    var param_21: vec3<f32>;\n    var param_22: vec2<f32>;\n    var param_23: vec2<f32>;\n    var param_24: vec3<f32>;\n    var param_25: vec3<f32>;\n    var param_26: vec3<f32>;\n    var param_27: vec3<f32>;\n    var param_28: vec2<f32>;\n\n    let _e245 = vUv_1;\n    param_19 = _e245;\n    let _e246 = (*light_1);\n    param_20 = _e246;\n    let _e247 = localExposureGain_u0028_vf2_u003b_vf3_u003b((&param_19), (&param_20));\n    local_6 = _e247;\n    let _e248 = autoExposureGain_u0028_();\n    let _e249 = local_6;\n    let _e251 = (*light_1);\n    (*light_1) = (_e251 * (_e248 * _e249));\n    let _e253 = textureDimensions(uScene_t, 0i);\n    let _e256 = (*light_1);\n    param_21 = _e256;\n    let _e257 = vUv_1;\n    param_22 = _e257;\n    param_23 = vec2<f32>(vec2<i32>(_e253));\n    let _e258 = withVignette_u0028_vf3_u003b_vf2_u003b_vf2_u003b((&param_21), (&param_22), (&param_23));\n    lensed = _e258;\n    let _e259 = lensed;\n    param_24 = _e259;\n    let _e260 = grade_u0028_vf3_u003b((&param_24));\n    param_25 = _e260;\n    let _e261 = applyColourGrade_u0028_vf3_u003b((&param_25));\n    param_26 = _e261;\n    let _e262 = withVeil_u0028_vf3_u003b((&param_26));\n    param_27 = _e262;\n    let _e263 = gl_FragCoord_1;\n    param_28 = _e263.xy;\n    let _e265 = withGrain_u0028_vf3_u003b_vf2_u003b((&param_27), (&param_28));\n    return _e265;\n}\n\nfn withBloom_u0028_vf3_u003b(c_10: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e234 = unnamed.uBloomStrength;\n    if (_e234 <= 0f) {\n        let _e236 = (*c_10);\n        return _e236;\n    }\n    let _e237 = (*c_10);\n    let _e238 = vUv_1;\n    let _e239 = textureSampleLevel(uBloom_t, uBloom_s, _e238, 0f);\n    let _e242 = unnamed.uBloomStrength;\n    return (_e237 + (_e239.xyz * _e242));\n}\n\nfn circleOfConfusion_u0028_f1_u003b(viewDepth: ptr<function, f32>) -> f32 {\n    var offPlane: f32;\n\n    let _e234 = (*viewDepth);\n    let _e236 = unnamed.uFocusDistance;\n    let _e240 = unnamed.uFocusRange;\n    offPlane = (abs((_e234 - _e236)) - _e240);\n    let _e242 = offPlane;\n    let _e244 = unnamed.uFocusRange;\n    return clamp((_e242 / _e244), 0f, 1f);\n}\n\nfn viewDepthOf_u0028_vf2_u003b(uv_3: ptr<function, vec2<f32>>) -> f32 {\n    var z: f32;\n\n    let _e234 = (*uv_3);\n    let _e235 = textureSampleLevel(uDepth_t, uDepth_s, _e234, 0f);\n    z = (1f - (_e235.x * 2f));\n    let _e241 = unnamed.uDepthToView[0u];\n    let _e242 = z;\n    let _e246 = unnamed.uDepthToView[1u];\n    let _e251 = unnamed.uDepthToView[2u];\n    let _e252 = z;\n    let _e256 = unnamed.uDepthToView[3u];\n    return (-(((_e241 * _e242) + _e246)) / ((_e251 * _e252) + _e256));\n}\n\nfn dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b(direction: ptr<function, vec2<f32>>, radius: ptr<function, f32>, centreDepth: ptr<function, f32>) -> vec4<f32> {\n    var uv_4: vec2<f32>;\n    var depth: f32;\n    var param_29: vec2<f32>;\n    var weight_2: f32;\n    var local_7: f32;\n    var param_30: f32;\n\n    let _e241 = vUv_1;\n    let _e242 = (*direction);\n    let _e243 = (*radius);\n    let _e246 = unnamed.uDofAspect;\n    uv_4 = (_e241 + ((_e242 * _e243) * _e246));\n    let _e249 = uv_4;\n    param_29 = _e249;\n    let _e250 = viewDepthOf_u0028_vf2_u003b((&param_29));\n    depth = _e250;\n    let _e251 = depth;\n    let _e252 = (*centreDepth);\n    if (_e251 >= _e252) {\n        local_7 = 1f;\n    } else {\n        let _e254 = depth;\n        param_30 = _e254;\n        let _e255 = circleOfConfusion_u0028_f1_u003b((&param_30));\n        local_7 = _e255;\n    }\n    let _e256 = local_7;\n    weight_2 = _e256;\n    let _e257 = uv_4;\n    let _e258 = textureSampleLevel(uScene_t, uScene_s, _e257, 0f);\n    let _e260 = weight_2;\n    let _e261 = (_e258.xyz * _e260);\n    let _e262 = weight_2;\n    return vec4<f32>(_e261.x, _e261.y, _e261.z, _e262);\n}\n\nfn depthOfField_u0028_vf3_u003b(centre: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_1: f32;\n    var param_31: vec2<f32>;\n    var coc: f32;\n    var param_32: f32;\n    var radius_1: f32;\n    var sum: vec4<f32>;\n    var param_33: vec2<f32>;\n    var param_34: f32;\n    var param_35: f32;\n    var param_36: vec2<f32>;\n    var param_37: f32;\n    var param_38: f32;\n    var param_39: vec2<f32>;\n    var param_40: f32;\n    var param_41: f32;\n    var param_42: vec2<f32>;\n    var param_43: f32;\n    var param_44: f32;\n    var param_45: vec2<f32>;\n    var param_46: f32;\n    var param_47: f32;\n    var param_48: vec2<f32>;\n    var param_49: f32;\n    var param_50: f32;\n    var param_51: vec2<f32>;\n    var param_52: f32;\n    var param_53: f32;\n    var param_54: vec2<f32>;\n    var param_55: f32;\n    var param_56: f32;\n\n    let _e263 = vUv_1;\n    param_31 = _e263;\n    let _e264 = viewDepthOf_u0028_vf2_u003b((&param_31));\n    depth_1 = _e264;\n    let _e265 = depth_1;\n    param_32 = _e265;\n    let _e266 = circleOfConfusion_u0028_f1_u003b((&param_32));\n    coc = _e266;\n    let _e267 = coc;\n    if (_e267 <= 0f) {\n        let _e269 = (*centre);\n        return _e269;\n    }\n    let _e270 = coc;\n    let _e272 = unnamed.uDofStrength;\n    radius_1 = (_e270 * _e272);\n    let _e274 = (*centre);\n    sum = vec4<f32>(_e274.x, _e274.y, _e274.z, 1f);\n    param_33 = vec2<f32>(0.25f, 0f);\n    let _e279 = radius_1;\n    param_34 = _e279;\n    let _e280 = depth_1;\n    param_35 = _e280;\n    let _e281 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_33), (&param_34), (&param_35));\n    let _e282 = sum;\n    sum = (_e282 + _e281);\n    param_36 = vec2<f32>(-0.31929f, 0.292496f);\n    let _e284 = radius_1;\n    param_37 = _e284;\n    let _e285 = depth_1;\n    param_38 = _e285;\n    let _e286 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_36), (&param_37), (&param_38));\n    let _e287 = sum;\n    sum = (_e287 + _e286);\n    param_39 = vec2<f32>(0.048872f, -0.556877f);\n    let _e289 = radius_1;\n    param_40 = _e289;\n    let _e290 = depth_1;\n    param_41 = _e290;\n    let _e291 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_39), (&param_40), (&param_41));\n    let _e292 = sum;\n    sum = (_e292 + _e291);\n    param_42 = vec2<f32>(0.402444f, 0.524918f);\n    let _e294 = radius_1;\n    param_43 = _e294;\n    let _e295 = depth_1;\n    param_44 = _e295;\n    let _e296 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_42), (&param_43), (&param_44));\n    let _e297 = sum;\n    sum = (_e297 + _e296);\n    param_45 = vec2<f32>(-0.738535f, -0.130636f);\n    let _e299 = radius_1;\n    param_46 = _e299;\n    let _e300 = depth_1;\n    param_47 = _e300;\n    let _e301 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_45), (&param_46), (&param_47));\n    let _e302 = sum;\n    sum = (_e302 + _e301);\n    param_48 = vec2<f32>(0.699605f, -0.445031f);\n    let _e304 = radius_1;\n    param_49 = _e304;\n    let _e305 = depth_1;\n    param_50 = _e305;\n    let _e306 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_48), (&param_49), (&param_50));\n    let _e307 = sum;\n    sum = (_e307 + _e306);\n    param_51 = vec2<f32>(-0.234004f, 0.870484f);\n    let _e309 = radius_1;\n    param_52 = _e309;\n    let _e310 = depth_1;\n    param_53 = _e310;\n    let _e311 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_51), (&param_52), (&param_53));\n    let _e312 = sum;\n    sum = (_e312 + _e311);\n    param_54 = vec2<f32>(-0.446271f, -0.859268f);\n    let _e314 = radius_1;\n    param_55 = _e314;\n    let _e315 = depth_1;\n    param_56 = _e315;\n    let _e316 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_54), (&param_55), (&param_56));\n    let _e317 = sum;\n    sum = (_e317 + _e316);\n    let _e319 = sum;\n    let _e322 = sum[3u];\n    return (_e319.xyz / vec3(_e322));\n}\n\nfn cameraBlur_u0028_vf3_u003b(scene: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var moved: vec4<f32>;\n    var velocity: vec2<f32>;\n    var depth_2: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var distance_: f32;\n    var sum_1: vec3<f32>;\n    var i: i32;\n    var t_2: f32;\n    var phi_1400_: bool;\n\n    let _e243 = vUv_1;\n    let _e244 = textureSampleLevel(uMotion_t, uMotion_s, _e243, 0f);\n    moved = _e244;\n    let _e246 = unnamed.uObjectMotion;\n    let _e247 = (_e246 > 0.5f);\n    phi_1400_ = _e247;\n    if _e247 {\n        let _e249 = moved[3u];\n        phi_1400_ = (_e249 > 0.5f);\n    }\n    let _e252 = phi_1400_;\n    if _e252 {\n        let _e253 = moved;\n        let _e257 = unnamed.uMotionStrength;\n        velocity = (-(_e253.xy) * _e257);\n    } else {\n        let _e259 = vUv_1;\n        let _e260 = textureSampleLevel(uDepth_t, uDepth_s, _e259, 0f);\n        depth_2 = _e260.x;\n        let _e262 = vUv_1;\n        let _e265 = ((_e262 * 2f) - vec2(1f));\n        let _e266 = depth_2;\n        clip = vec4<f32>(_e265.x, _e265.y, (1f - (_e266 * 2f)), 1f);\n        let _e273 = unnamed.uReprojection;\n        let _e274 = clip;\n        previous = (_e273 * _e274);\n        let _e277 = previous[3u];\n        if (_e277 <= 0f) {\n            let _e279 = (*scene);\n            return _e279;\n        }\n        let _e280 = previous;\n        let _e283 = previous[3u];\n        wasUv = (((_e280.xy / vec2(_e283)) * 0.5f) + vec2(0.5f));\n        let _e289 = vUv_1;\n        let _e290 = wasUv;\n        let _e293 = unnamed.uMotionStrength;\n        velocity = ((_e289 - _e290) * _e293);\n    }\n    let _e295 = velocity;\n    distance_ = length(_e295);\n    let _e297 = distance_;\n    if (_e297 < 0.0001f) {\n        let _e299 = (*scene);\n        return _e299;\n    }\n    let _e300 = distance_;\n    let _e302 = unnamed.uMotionMax;\n    if (_e300 > _e302) {\n        let _e305 = unnamed.uMotionMax;\n        let _e306 = distance_;\n        let _e308 = velocity;\n        velocity = (_e308 * (_e305 / _e306));\n    }\n    let _e310 = (*scene);\n    sum_1 = _e310;\n    i = 1i;\n    loop {\n        let _e311 = i;\n        if (_e311 <= 4i) {\n            let _e313 = i;\n            t_2 = ((f32(_e313) / 4f) * 0.5f);\n            let _e317 = vUv_1;\n            let _e318 = velocity;\n            let _e319 = t_2;\n            let _e322 = textureSampleLevel(uScene_t, uScene_s, (_e317 + (_e318 * _e319)), 0f);\n            let _e324 = sum_1;\n            sum_1 = (_e324 + _e322.xyz);\n            let _e326 = vUv_1;\n            let _e327 = velocity;\n            let _e328 = t_2;\n            let _e331 = textureSampleLevel(uScene_t, uScene_s, (_e326 - (_e327 * _e328)), 0f);\n            let _e333 = sum_1;\n            sum_1 = (_e333 + _e331.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e335 = i;\n            i = (_e335 + 1i);\n        }\n    }\n    let _e337 = sum_1;\n    return (_e337 / vec3(9f));\n}\n\nfn withFringe_u0028_vf3_u003b(scene_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var lens: vec2<f32>;\n    var past: vec2<f32>;\n    var red: vec2<f32>;\n    var green: vec2<f32>;\n\n    let _e239 = unnamed.uFringe[0u];\n    if (_e239 <= 0f) {\n        let _e241 = (*scene_1);\n        return _e241;\n    }\n    let _e242 = vUv_1;\n    lens = ((_e242 * 2f) - vec2(1f));\n    let _e246 = lens;\n    let _e248 = lens;\n    let _e252 = unnamed.uFringe[2u];\n    past = (sign(_e246) * clamp((abs(_e248) - vec2(_e252)), vec2(0f), vec2(1f)));\n    let _e259 = lens;\n    let _e260 = past;\n    let _e263 = unnamed.uFringe[0u];\n    red = (((_e259 - (_e260 * _e263)) * 0.5f) + vec2(0.5f));\n    let _e269 = lens;\n    let _e270 = past;\n    let _e273 = unnamed.uFringe[1u];\n    green = (((_e269 - (_e270 * _e273)) * 0.5f) + vec2(0.5f));\n    let _e279 = red;\n    let _e280 = textureSampleLevel(uScene_t, uScene_s, _e279, 0f);\n    let _e282 = green;\n    let _e283 = textureSampleLevel(uScene_t, uScene_s, _e282, 0f);\n    let _e286 = (*scene_1)[2u];\n    return vec3<f32>(_e280.x, _e283.y, _e286);\n}\n\nfn main_1() {\n    var sampled: vec4<f32>;\n    var scene_2: vec3<f32>;\n    var param_57: vec3<f32>;\n    var param_58: vec3<f32>;\n    var param_59: vec3<f32>;\n    var share: f32;\n    var ao: f32;\n    var param_60: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var radius_2: f32;\n    var inner: f32;\n    var edge: f32;\n    var amount: f32;\n    var param_61: vec3<f32>;\n    var param_62: vec3<f32>;\n    var step_: vec2<f32>;\n    var sum_2: vec3<f32>;\n    var i_1: i32;\n    var blurred: vec3<f32>;\n    var param_63: vec3<f32>;\n    var param_64: vec3<f32>;\n\n    let _e253 = vUv_1;\n    let _e254 = textureSampleLevel(uScene_t, uScene_s, _e253, 0f);\n    sampled = _e254;\n    let _e255 = sampled;\n    param_57 = _e255.xyz;\n    let _e257 = withFringe_u0028_vf3_u003b((&param_57));\n    scene_2 = _e257;\n    let _e259 = unnamed.uMotionStrength;\n    if (_e259 > 0f) {\n        let _e261 = scene_2;\n        param_58 = _e261;\n        let _e262 = cameraBlur_u0028_vf3_u003b((&param_58));\n        scene_2 = _e262;\n    }\n    let _e264 = unnamed.uDofStrength;\n    if (_e264 > 0f) {\n        let _e266 = scene_2;\n        param_59 = _e266;\n        let _e267 = depthOfField_u0028_vf3_u003b((&param_59));\n        scene_2 = _e267;\n    }\n    let _e269 = sampled[3u];\n    share = clamp(_e269, 0f, 1f);\n    let _e271 = vUv_1;\n    let _e273 = unnamed.uAoOffset;\n    let _e275 = textureSampleLevel(uAo_t, uAo_s, (_e271 + _e273), 0f);\n    let _e278 = unnamed.uAoStrength;\n    let _e279 = share;\n    ao = mix(1f, _e275.x, (_e278 * _e279));\n    let _e283 = unnamed.uSceneGraded;\n    if (_e283 != 0i) {\n        let _e285 = ao;\n        param_60 = vec3(_e285);\n        let _e287 = linearToSrgb_u0028_vf3_u003b((&param_60));\n        ao = _e287.x;\n    }\n    let _e289 = vUv_1;\n    fromCentre = (_e289 - vec2(0.5f));\n    let _e292 = fromCentre;\n    radius_2 = (length((_e292 * vec2<f32>(1f, 0.62f))) * 2f);\n    let _e297 = unnamed.uStrength;\n    inner = mix(0.62f, 0.3f, _e297);\n    let _e299 = inner;\n    let _e300 = radius_2;\n    edge = smoothstep(_e299, 1f, _e300);\n    let _e302 = edge;\n    let _e304 = unnamed.uStrength;\n    amount = (_e302 * _e304);\n    let _e306 = amount;\n    if (_e306 <= 0f) {\n        let _e308 = scene_2;\n        let _e309 = ao;\n        param_61 = (_e308 * _e309);\n        let _e311 = withBloom_u0028_vf3_u003b((&param_61));\n        param_62 = _e311;\n        let _e312 = finish_u0028_vf3_u003b((&param_62));\n        fragColor = vec4<f32>(_e312.x, _e312.y, _e312.z, 1f);\n        return;\n    }\n    let _e317 = fromCentre;\n    let _e321 = unnamed.uReach;\n    let _e323 = amount;\n    step_ = ((normalize((_e317 + vec2<f32>(0.000001f, 0.000001f))) * _e321) * _e323);\n    let _e325 = scene_2;\n    sum_2 = _e325;\n    i_1 = 1i;\n    loop {\n        let _e326 = i_1;\n        if (_e326 <= 6i) {\n            let _e328 = vUv_1;\n            let _e329 = step_;\n            let _e330 = i_1;\n            let _e335 = textureSampleLevel(uScene_t, uScene_s, (_e328 + (_e329 * (f32(_e330) / 6f))), 0f);\n            let _e337 = sum_2;\n            sum_2 = (_e337 + _e335.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e339 = i_1;\n            i_1 = (_e339 + 1i);\n        }\n    }\n    let _e341 = sum_2;\n    blurred = (_e341 / vec3(7f));\n    let _e344 = scene_2;\n    let _e345 = blurred;\n    let _e346 = amount;\n    let _e349 = ao;\n    param_63 = (mix(_e344, _e345, vec3(_e346)) * _e349);\n    let _e351 = withBloom_u0028_vf3_u003b((&param_63));\n    param_64 = _e351;\n    let _e352 = finish_u0028_vf3_u003b((&param_64));\n    fragColor = vec4<f32>(_e352.x, _e352.y, _e352.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const RUSH_BINDINGS = {
  "RUSH_FRAG": {
    "uniforms": 1,
    "uniformSize": 320,
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
      "uLocalShape": {
        "offset": 224,
        "size": 16,
        "type": "vec4"
      },
      "uLocalPivot": {
        "offset": 240,
        "size": 16,
        "type": "vec4"
      },
      "uGradeStrength": {
        "offset": 256,
        "size": 4,
        "type": "float"
      },
      "uGradeSize": {
        "offset": 260,
        "size": 4,
        "type": "float"
      },
      "uFocusDistance": {
        "offset": 264,
        "size": 4,
        "type": "float"
      },
      "uFocusRange": {
        "offset": 268,
        "size": 4,
        "type": "float"
      },
      "uDofStrength": {
        "offset": 272,
        "size": 4,
        "type": "float"
      },
      "uDofAspect": {
        "offset": 280,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToView": {
        "offset": 288,
        "size": 16,
        "type": "vec4"
      },
      "uFringe": {
        "offset": 304,
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
