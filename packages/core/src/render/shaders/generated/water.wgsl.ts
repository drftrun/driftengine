/*
 * Generated from ../water.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const WATER_FRAG_WGSL = "struct Uniforms {\n    uGridHalf: vec2<f32>,\n    uFoamGain: f32,\n    uNadirOpacity: f32,\n    uVisibility: f32,\n    uMirror: f32,\n    uDeepColor: vec3<f32>,\n    uShallowColor: vec3<f32>,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uLightFalloff: i32,\n    uLightCone: array<vec4<f32>, 16>,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uCameraPos: vec3<f32>,\n    uReflectionEnabled: i32,\n    uReflectionTexelSize: vec2<f32>,\n    uReflectionFilterTaps: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vCrest_1: f32;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vGrid_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e150 = (*c);\n    low = (_e150 * 12.92f);\n    let _e152 = (*c);\n    high = ((pow(max(_e152, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e158 = high;\n    let _e159 = low;\n    let _e160 = (*c);\n    return mix(_e158, _e159, step(_e160, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e151 = (*c_1)[0u];\n    let _e153 = (*c_1)[1u];\n    let _e155 = (*c_1)[2u];\n    m = max(_e151, max(_e153, _e155));\n    let _e158 = m;\n    if (_e158 <= 0.8f) {\n        let _e160 = (*c_1);\n        return _e160;\n    }\n    let _e161 = m;\n    e = (_e161 - 0.8f);\n    let _e163 = (*c_1);\n    let _e164 = e;\n    let _e166 = e;\n    let _e170 = m;\n    return (_e163 * ((0.8f + ((0.2f * _e164) / (_e166 + 0.2f))) / _e170));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e150 = (*v);\n    let _e151 = (*v);\n    a = ((_e150 * (_e151 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e157 = (*v);\n    let _e158 = (*v);\n    b = ((_e157 * ((_e158 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e165 = a;\n    let _e166 = b;\n    return (_e165 / _e166);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e150 = unnamed.uOutputExposure;\n    let _e151 = (*x);\n    (*x) = (_e151 * _e150);\n    let _e153 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e153);\n    let _e155 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e155), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e152 = unnamed.uOutputTransform;\n    if (_e152 == 0i) {\n        let _e154 = (*c_2);\n        return _e154;\n    }\n    let _e156 = unnamed.uOutputTransform;\n    if (_e156 == 2i) {\n        let _e158 = (*c_2);\n        param_1 = _e158;\n        let _e159 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e159;\n    }\n    let _e161 = unnamed.uOutputTransform;\n    if (_e161 == 3i) {\n        let _e163 = (*c_2);\n        let _e165 = unnamed.uOutputExposure;\n        param_2 = (_e163 * _e165);\n        let _e167 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e167;\n    }\n    let _e168 = (*c_2);\n    param_3 = _e168;\n    let _e169 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e169;\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e161 = unnamed.uFogRange[0u];\n    let _e162 = (*dist);\n    start = min(_e161, _e162);\n    let _e164 = (*dist);\n    if (_e164 > 0f) {\n        let _e166 = start;\n        let _e167 = (*dist);\n        local = (_e166 / _e167);\n    } else {\n        local = 0f;\n    }\n    let _e169 = local;\n    before = _e169;\n    let _e170 = (*pointY);\n    let _e173 = unnamed.uFogMedium[2u];\n    let _e177 = unnamed.uFogMedium[1u];\n    t = ((_e170 - _e173) * _e177);\n    let _e179 = t;\n    let _e180 = before;\n    rest = (_e179 * (1f - _e180));\n    let _e183 = rest;\n    let _e186 = rest;\n    denom = select(_e186, 0.0001f, (abs(_e183) < 0.0001f));\n    let _e190 = unnamed.uFogMedium[0u];\n    let _e191 = t;\n    let _e193 = before;\n    let _e197 = (*dist);\n    let _e198 = start;\n    let _e201 = denom;\n    let _e206 = denom;\n    depth = ((((_e190 * exp((-(_e191) * _e193))) * (_e197 - _e198)) * (1f - exp(-(_e201)))) / _e206);\n    let _e210 = unnamed.uFogLayer2_[0u];\n    if (_e210 > 0f) {\n        let _e212 = (*pointY);\n        let _e215 = unnamed.uFogMedium[2u];\n        let _e219 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e212 - _e215) * _e219);\n        let _e221 = t2_;\n        let _e222 = before;\n        rest2_ = (_e221 * (1f - _e222));\n        let _e225 = rest2_;\n        let _e228 = rest2_;\n        denom2_ = select(_e228, 0.0001f, (abs(_e225) < 0.0001f));\n        let _e232 = unnamed.uFogLayer2_[0u];\n        let _e233 = t2_;\n        let _e235 = before;\n        let _e239 = (*dist);\n        let _e240 = start;\n        let _e243 = denom2_;\n        let _e248 = denom2_;\n        let _e250 = depth;\n        depth = (_e250 + ((((_e232 * exp((-(_e233) * _e235))) * (_e239 - _e240)) * (1f - exp(-(_e243)))) / _e248));\n    }\n    let _e252 = depth;\n    return _e252;\n}\n\nfn mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>, toPoint: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var span: f32;\n    var perMetre: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var hidden: f32;\n    var lobe: f32;\n    var phi_312_: bool;\n    var phi_326_: bool;\n\n    let _e158 = unnamed.uFogRange[2u];\n    let _e159 = (_e158 == 1f);\n    phi_312_ = _e159;\n    if !(_e159) {\n        let _e163 = unnamed.uFogGlow[0u];\n        let _e166 = unnamed.uFogGlow[1u];\n        let _e170 = unnamed.uFogGlow[2u];\n        phi_312_ = (max(max(_e163, _e166), _e170) <= 0f);\n    }\n    let _e174 = phi_312_;\n    if _e174 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e177 = unnamed.uFogLayer2_[3u];\n    let _e178 = (_e177 > 0f);\n    phi_326_ = _e178;\n    if _e178 {\n        let _e179 = (*dist_1);\n        let _e182 = unnamed.uFogLayer2_[3u];\n        phi_326_ = (_e179 > _e182);\n    }\n    let _e185 = phi_326_;\n    if _e185 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e186 = (*dist_1);\n    let _e189 = unnamed.uFogRange[0u];\n    let _e190 = (*dist_1);\n    span = (_e186 - min(_e189, _e190));\n    let _e193 = span;\n    if (_e193 <= 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e195 = (*dist_1);\n    param_4 = _e195;\n    let _e196 = (*pointY_1);\n    param_5 = _e196;\n    let _e197 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    let _e198 = span;\n    perMetre = (_e197 / _e198);\n    let _e200 = perMetre;\n    let _e202 = span;\n    let _e205 = unnamed.uFogGlowDir[3u];\n    hidden = (1f - exp((-(_e200) * max((_e202 - _e205), 0f))));\n    let _e211 = (*toPoint);\n    let _e213 = unnamed.uFogGlowDir;\n    let _e219 = unnamed.uFogGlow[3u];\n    lobe = pow(clamp(dot(_e211, _e213.xyz), 0f, 1f), _e219);\n    let _e222 = unnamed.uFogGlow;\n    let _e224 = lobe;\n    let _e225 = hidden;\n    let _e228 = unnamed.uUnderwaterFactor;\n    return (_e222.xyz * ((_e224 * _e225) * (1f - _e228)));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_2: ptr<function, f32>, pointY_2: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span_1: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var wet: f32;\n    var phi_197_: bool;\n\n    let _e161 = unnamed.uFogLayer2_[3u];\n    let _e162 = (_e161 > 0f);\n    phi_197_ = _e162;\n    if _e162 {\n        let _e163 = (*dist_2);\n        let _e166 = unnamed.uFogLayer2_[3u];\n        phi_197_ = (_e163 > _e166);\n    }\n    let _e169 = phi_197_;\n    cut = _e169;\n    let _e172 = unnamed.uFogRange[2u];\n    if (_e172 == 1f) {\n        let _e176 = unnamed.uFogRange[1u];\n        let _e179 = unnamed.uFogRange[0u];\n        span_1 = max((_e176 - _e179), 0.0001f);\n        let _e182 = cut;\n        if _e182 {\n            local_1 = 0f;\n        } else {\n            let _e183 = (*dist_2);\n            let _e186 = unnamed.uFogRange[0u];\n            let _e188 = span_1;\n            let _e193 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e183 - _e186) / _e188), 0f, 1f), (1f - _e193));\n        }\n        let _e196 = local_1;\n        ramp = _e196;\n        let _e198 = unnamed.uUnderwaterFactor;\n        if (_e198 <= 0f) {\n            let _e200 = ramp;\n            return _e200;\n        }\n        let _e203 = unnamed.uFogMedium[3u];\n        let _e204 = (*dist_2);\n        wetLinear = (_e203 * _e204);\n        let _e206 = ramp;\n        let _e207 = wetLinear;\n        let _e209 = wetLinear;\n        let _e215 = unnamed.uUnderwaterFactor;\n        return mix(_e206, (1f - exp2(((-(_e207) * _e209) * 1.442695f))), _e215);\n    }\n    let _e217 = cut;\n    if _e217 {\n        local_2 = 0f;\n    } else {\n        let _e218 = (*dist_2);\n        param_6 = _e218;\n        let _e219 = (*pointY_2);\n        param_7 = _e219;\n        let _e220 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_6), (&param_7));\n        let _e225 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e220)), _e225));\n    }\n    let _e228 = local_2;\n    air = _e228;\n    let _e230 = unnamed.uUnderwaterFactor;\n    if (_e230 <= 0f) {\n        let _e232 = air;\n        return _e232;\n    }\n    let _e235 = unnamed.uFogMedium[3u];\n    let _e236 = (*dist_2);\n    wet = (_e235 * _e236);\n    let _e238 = air;\n    let _e239 = wet;\n    let _e241 = wet;\n    let _e247 = unnamed.uUnderwaterFactor;\n    return mix(_e238, (1f - exp2(((-(_e239) * _e241) * 1.442695f))), _e247);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e148 = unnamed.uFogColor;\n    let _e150 = unnamed.uUnderwaterColor;\n    let _e152 = unnamed.uUnderwaterFactor;\n    return mix(_e148, _e150, vec3(_e152));\n}\n\nfn main_1() {\n    var n: vec3<f32>;\n    var view: vec3<f32>;\n    var facing: f32;\n    var fresnel: f32;\n    var atmosphereColor: vec3<f32>;\n    var col: vec3<f32>;\n    var incident: vec3<f32>;\n    var halfVec: vec3<f32>;\n    var spec: f32;\n    var highlight: vec3<f32>;\n    var i: i32;\n    var toLight: vec3<f32>;\n    var lightDist: f32;\n    var exponent: f32;\n    var reach: f32;\n    var falloff: f32;\n    var window: f32;\n    var lightDir: vec3<f32>;\n    var shaped: f32;\n    var lampHalf: vec3<f32>;\n    var foam: f32;\n    var dist_3: f32;\n    var fog: f32;\n    var param_8: f32;\n    var param_9: f32;\n    var glow: vec3<f32>;\n    var param_10: f32;\n    var param_11: f32;\n    var param_12: vec3<f32>;\n    var param_13: vec3<f32>;\n    var gradedAir: vec3<f32>;\n    var param_14: vec3<f32>;\n    var airOpacity: f32;\n    var underwaterOpacity: f32;\n    var opacity: f32;\n    var reflected: vec3<f32>;\n    var reflectionValid: f32;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var blurPixels: f32;\n    var sceneReflection: vec3<f32>;\n    var filterWeight: f32;\n    var i_1: i32;\n    var sampleUv: vec2<f32>;\n    var indexable: array<vec2<f32>, 9>;\n    var weight: f32;\n    var indexable_1: array<f32, 9>;\n    var sceneWeight: f32;\n    var reflectionGain: f32;\n    var reflectivity: f32;\n    var reflectedRadiance: f32;\n    var reflectionWeight: f32;\n    var rimFraction: vec2<f32>;\n    var rimT: f32;\n    var rim: f32;\n    var edge: f32;\n    var phi_872_: bool;\n\n    let _e203 = vNormal_1;\n    n = normalize(_e203);\n    let _e206 = unnamed.uCameraPos;\n    let _e207 = vWorldPos_1;\n    view = normalize((_e206 - _e207));\n    let _e210 = n;\n    let _e211 = view;\n    facing = clamp(abs(dot(_e210, _e211)), 0f, 1f);\n    let _e215 = facing;\n    fresnel = (0.02f + (0.98f * pow((1f - _e215), 5f)));\n    let _e220 = mediumColor_u0028_();\n    atmosphereColor = _e220;\n    let _e222 = unnamed.uDeepColor;\n    let _e224 = unnamed.uShallowColor;\n    let _e225 = vCrest_1;\n    col = mix(_e222, _e224, vec3(clamp(((_e225 * 1.4f) + 0.4f), 0f, 1f)));\n    let _e232 = unnamed.uAmbient;\n    let _e234 = unnamed.uDirectionalColor;\n    let _e235 = n;\n    let _e237 = unnamed.uDirectionalDir;\n    incident = (_e232 + ((_e234 * max(dot(_e235, _e237), 0f)) * 0.6f));\n    let _e244 = unnamed.uDirectionalDir;\n    let _e245 = view;\n    halfVec = normalize((_e244 + _e245));\n    let _e248 = n;\n    let _e249 = halfVec;\n    spec = pow(max(dot(_e248, _e249), 0f), 220f);\n    let _e254 = unnamed.uDirectionalColor;\n    let _e255 = spec;\n    highlight = ((_e254 * _e255) * 1.6f);\n    i = 0i;\n    loop {\n        let _e258 = i;\n        if (_e258 < 16i) {\n            let _e260 = i;\n            let _e262 = unnamed.uLightCount;\n            if (_e260 >= _e262) {\n                break;\n            }\n            let _e264 = i;\n            let _e267 = unnamed.uLightPos[_e264];\n            let _e268 = vWorldPos_1;\n            toLight = (_e267 - _e268);\n            let _e270 = toLight;\n            lightDist = length(_e270);\n            let _e272 = i;\n            let _e276 = unnamed.uLightCone[_e272][2u];\n            exponent = _e276;\n            let _e277 = exponent;\n            if (_e277 > 0f) {\n                let _e279 = lightDist;\n                let _e280 = i;\n                let _e284 = unnamed.uLightRadius[_e280][0u];\n                reach = (_e279 / max(_e284, 0.0001f));\n                let _e287 = reach;\n                let _e288 = reach;\n                let _e292 = exponent;\n                falloff = pow(clamp((1f - (_e287 * _e288)), 0f, 1f), _e292);\n            } else {\n                let _e295 = unnamed.uLightFalloff;\n                if (_e295 == 1i) {\n                    let _e297 = lightDist;\n                    let _e298 = i;\n                    let _e302 = unnamed.uLightRadius[_e298][0u];\n                    window = clamp((1f - pow((_e297 / max(_e302, 0.0001f)), 4f)), 0f, 1f);\n                    let _e308 = window;\n                    let _e309 = window;\n                    let _e311 = lightDist;\n                    let _e312 = lightDist;\n                    falloff = ((_e308 * _e309) / max((_e311 * _e312), 0.01f));\n                } else {\n                    let _e316 = lightDist;\n                    let _e317 = i;\n                    let _e321 = unnamed.uLightRadius[_e317][0u];\n                    falloff = clamp((1f - (_e316 / max(_e321, 0.0001f))), 0f, 1f);\n                }\n            }\n            let _e326 = falloff;\n            if (_e326 <= 0f) {\n                continue;\n            }\n            let _e328 = toLight;\n            let _e329 = lightDist;\n            lightDir = (_e328 / vec3(max(_e329, 0.0001f)));\n            let _e333 = falloff;\n            let _e334 = i;\n            let _e338 = unnamed.uLightWeight[_e334][0u];\n            shaped = (_e333 * _e338);\n            let _e340 = i;\n            let _e343 = unnamed.uLightColor[_e340];\n            let _e344 = n;\n            let _e345 = lightDir;\n            let _e349 = shaped;\n            let _e352 = incident;\n            incident = (_e352 + (((_e343 * max(dot(_e344, _e345), 0f)) * _e349) * 0.6f));\n            let _e354 = lightDir;\n            let _e355 = view;\n            lampHalf = normalize((_e354 + _e355));\n            let _e358 = i;\n            let _e361 = unnamed.uLightColor[_e358];\n            let _e362 = n;\n            let _e363 = lampHalf;\n            let _e368 = shaped;\n            let _e371 = highlight;\n            highlight = (_e371 + (((_e361 * pow(max(dot(_e362, _e363), 0f), 220f)) * _e368) * 1.6f));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e373 = i;\n            i = (_e373 + 1i);\n        }\n    }\n    let _e375 = incident;\n    let _e376 = col;\n    col = (_e376 * _e375);\n    let _e378 = highlight;\n    let _e379 = col;\n    col = (_e379 + _e378);\n    let _e381 = vCrest_1;\n    let _e384 = unnamed.uFoamGain;\n    foam = (smoothstep(0.55f, 0.85f, _e381) * _e384);\n    let _e386 = col;\n    let _e387 = foam;\n    col = mix(_e386, vec3<f32>(0.92f, 0.96f, 1f), vec3((_e387 * 0.5f)));\n    let _e391 = vWorldPos_1;\n    let _e393 = unnamed.uCameraPos;\n    dist_3 = distance(_e391, _e393);\n    let _e395 = dist_3;\n    param_8 = _e395;\n    let _e397 = vWorldPos_1[1u];\n    param_9 = _e397;\n    let _e398 = mediumFog_u0028_f1_u003b_f1_u003b((&param_8), (&param_9));\n    fog = _e398;\n    let _e399 = vWorldPos_1;\n    let _e401 = unnamed.uCameraPos;\n    let _e404 = dist_3;\n    param_10 = _e404;\n    let _e406 = vWorldPos_1[1u];\n    param_11 = _e406;\n    param_12 = normalize((_e399 - _e401));\n    let _e407 = mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_10), (&param_11), (&param_12));\n    glow = _e407;\n    let _e408 = col;\n    let _e409 = atmosphereColor;\n    let _e410 = fog;\n    let _e413 = glow;\n    col = (mix(_e408, _e409, vec3(_e410)) + _e413);\n    let _e415 = col;\n    param_13 = _e415;\n    let _e416 = applyOutputTransform_u0028_vf3_u003b((&param_13));\n    col = _e416;\n    let _e417 = atmosphereColor;\n    param_14 = _e417;\n    let _e418 = applyOutputTransform_u0028_vf3_u003b((&param_14));\n    gradedAir = _e418;\n    let _e420 = unnamed.uNadirOpacity;\n    let _e421 = fresnel;\n    airOpacity = mix(_e420, 0.96f, _e421);\n    let _e424 = unnamed.uNadirOpacity;\n    let _e426 = fresnel;\n    underwaterOpacity = mix((_e424 * 0.55f), 0.88f, _e426);\n    let _e428 = airOpacity;\n    let _e429 = underwaterOpacity;\n    let _e431 = unnamed.uUnderwaterFactor;\n    opacity = mix(_e428, _e429, _e431);\n    let _e433 = opacity;\n    let _e434 = foam;\n    opacity = mix(_e433, 0.96f, (_e434 * 0.7f));\n    let _e437 = gradedAir;\n    reflected = _e437;\n    reflectionValid = 0f;\n    let _e439 = unnamed.uReflectionEnabled;\n    let _e440 = (_e439 != 0i);\n    phi_872_ = _e440;\n    if _e440 {\n        let _e442 = vReflectionClip_1[3u];\n        phi_872_ = (_e442 > 0f);\n    }\n    let _e445 = phi_872_;\n    if _e445 {\n        let _e446 = vReflectionClip_1;\n        let _e449 = vReflectionClip_1[3u];\n        reflectionUv = (((_e446.xy / vec2(_e449)) * 0.5f) + vec2(0.5f));\n        let _e455 = n;\n        let _e457 = fresnel;\n        let _e460 = reflectionUv;\n        reflectionUv = (_e460 + (_e455.xz * mix(0.008f, 0.022f, _e457)));\n        let _e462 = reflectionUv;\n        let _e463 = reflectionUv;\n        border = min(_e462, (vec2(1f) - _e463));\n        let _e468 = border[0u];\n        let _e470 = border[1u];\n        reflectionValid = smoothstep(0f, 0.025f, min(_e468, _e470));\n        let _e473 = dist_3;\n        blurPixels = (1.35f + min((_e473 * 0.022f), 3.5f));\n        sceneReflection = vec3<f32>(0f, 0f, 0f);\n        filterWeight = 0f;\n        i_1 = 0i;\n        loop {\n            let _e477 = i_1;\n            if (_e477 < 9i) {\n                let _e479 = i_1;\n                let _e481 = unnamed.uReflectionFilterTaps;\n                if (_e479 >= _e481) {\n                    break;\n                }\n                let _e483 = reflectionUv;\n                let _e484 = i_1;\n                indexable = array<vec2<f32>, 9>(vec2<f32>(0f, 0f), vec2<f32>(-0.62f, -0.31f), vec2<f32>(0.54f, 0.43f), vec2<f32>(-0.34f, 0.76f), vec2<f32>(0.78f, -0.57f), vec2<f32>(-0.88f, 0.28f), vec2<f32>(0.22f, -0.91f), vec2<f32>(0.91f, 0.08f), vec2<f32>(-0.18f, 0.94f));\n                let _e486 = indexable[_e484];\n                let _e488 = unnamed.uReflectionTexelSize;\n                let _e490 = blurPixels;\n                sampleUv = (_e483 + ((_e486 * _e488) * _e490));\n                let _e493 = i_1;\n                indexable_1 = array<f32, 9>(0.28f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f);\n                let _e495 = indexable_1[_e493];\n                weight = _e495;\n                let _e496 = sampleUv;\n                let _e500 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e496, vec2(0f), vec2(1f)), 0f);\n                let _e502 = weight;\n                let _e504 = sceneReflection;\n                sceneReflection = (_e504 + (_e500.xyz * _e502));\n                let _e506 = weight;\n                let _e507 = filterWeight;\n                filterWeight = (_e507 + _e506);\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e509 = i_1;\n                i_1 = (_e509 + 1i);\n            }\n        }\n        let _e511 = filterWeight;\n        let _e513 = sceneReflection;\n        sceneReflection = (_e513 / vec3(max(_e511, 0.001f)));\n        let _e516 = gradedAir;\n        let _e517 = sceneReflection;\n        let _e518 = reflectionValid;\n        reflected = mix(_e516, _e517, vec3(_e518));\n    }\n    let _e522 = unnamed.uReflectionEnabled;\n    let _e524 = reflectionValid;\n    sceneWeight = (f32(_e522) * _e524);\n    let _e526 = sceneWeight;\n    reflectionGain = mix(0.75f, 0.94f, _e526);\n    let _e528 = fresnel;\n    let _e530 = unnamed.uMirror;\n    reflectivity = mix(_e528, 1f, _e530);\n    let _e532 = reflectivity;\n    let _e533 = reflectionGain;\n    let _e535 = foam;\n    let _e539 = opacity;\n    reflectedRadiance = min(((_e532 * _e533) * (1f - (_e535 * 0.8f))), _e539);\n    let _e541 = reflectedRadiance;\n    let _e542 = opacity;\n    reflectionWeight = (_e541 / max(_e542, 0.001f));\n    let _e545 = col;\n    let _e546 = reflected;\n    let _e547 = reflectionWeight;\n    col = mix(_e545, _e546, vec3(_e547));\n    let _e550 = vGrid_1;\n    let _e553 = unnamed.uGridHalf;\n    rimFraction = (abs(_e550) / max(_e553, vec2<f32>(0.001f, 0.001f)));\n    let _e557 = rimFraction[0u];\n    let _e559 = rimFraction[1u];\n    rimT = max(_e557, _e559);\n    let _e561 = rimT;\n    rim = (1f - smoothstep(0.9f, 1f, _e561));\n    let _e564 = fog;\n    edge = (1f - smoothstep(0.82f, 1f, _e564));\n    let _e567 = col;\n    let _e568 = opacity;\n    let _e569 = edge;\n    let _e571 = rim;\n    let _e574 = unnamed.uVisibility;\n    outColor = vec4<f32>(_e567.x, _e567.y, _e567.z, (((_e568 * _e569) * _e571) * _e574));\n    return;\n}\n\n@fragment \nfn main(@location(1) vNormal: vec3<f32>, @location(0) vWorldPos: vec3<f32>, @location(2) vCrest: f32, @location(3) vReflectionClip: vec4<f32>, @location(4) vGrid: vec2<f32>) -> @location(0) vec4<f32> {\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vCrest_1 = vCrest;\n    vReflectionClip_1 = vReflectionClip;\n    vGrid_1 = vGrid;\n    main_1();\n    let _e11 = outColor;\n    return _e11;\n}\n";

export const WATER_VERT_WGSL = "struct GerstnerSurface {\n    offset: vec3<f32>,\n    normal: vec3<f32>,\n    crest: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uGridOrigin: vec2<f32>,\n    uGridSpan: vec2<f32>,\n    uGridHalf: vec2<f32>,\n    uNearHalf: vec2<f32>,\n    uGridForward: vec2<f32>,\n    uWindDir: vec2<f32>,\n    uWaveGain: f32,\n    uWaterLevel: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(4) member: vec2<f32>,\n    @location(0) member_1: vec3<f32>,\n    @location(1) member_2: vec3<f32>,\n    @location(2) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aGrid_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> vGrid: vec2<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> vCrest: f32;\nvar<private> vReflectionClip: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b(k: ptr<function, f32>, dir: ptr<function, vec2<f32>>, p: ptr<function, vec2<f32>>, time: ptr<function, f32>) -> f32 {\n    var c: f32;\n\n    let _e59 = (*k);\n    c = sqrt((9.81f / _e59));\n    let _e62 = (*k);\n    let _e63 = (*dir);\n    let _e64 = (*p);\n    let _e66 = c;\n    let _e67 = (*time);\n    return (_e62 * (dot(_e63, _e64) - (_e66 * _e67)));\n}\n\nfn gerstnerWavenumber_u0028_i1_u003b(i: ptr<function, i32>) -> f32 {\n    var indexable: array<vec4<f32>, 4>;\n\n    let _e56 = (*i);\n    indexable = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable[_e56][3u];\n    return (6.2831855f / _e59);\n}\n\nfn gerstnerDirection_u0028_i1_u003b_vf2_u003b(i_1: ptr<function, i32>, windDir: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var indexable_1: array<vec4<f32>, 4>;\n\n    let _e57 = (*i_1);\n    indexable_1 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable_1[_e57];\n    let _e62 = (*windDir);\n    return normalize(mix(normalize(_e59.xy), _e62, vec2(0.62f)));\n}\n\nfn gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b(p_1: ptr<function, vec2<f32>>, time_1: ptr<function, f32>, windDir_1: ptr<function, vec2<f32>>, gain: ptr<function, f32>) -> GerstnerSurface {\n    var s: GerstnerSurface;\n    var i_2: i32;\n    var dir_1: vec2<f32>;\n    var param: i32;\n    var param_1: vec2<f32>;\n    var steepness: f32;\n    var indexable_2: array<vec4<f32>, 4>;\n    var k_1: f32;\n    var param_2: i32;\n    var f: f32;\n    var param_3: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n    var a: f32;\n\n    s.offset = vec3<f32>(0f, 0f, 0f);\n    s.normal = vec3<f32>(0f, 1f, 0f);\n    s.crest = 0f;\n    i_2 = 0i;\n    loop {\n        let _e76 = i_2;\n        if (_e76 < 4i) {\n            let _e78 = i_2;\n            param = _e78;\n            let _e79 = (*windDir_1);\n            param_1 = _e79;\n            let _e80 = gerstnerDirection_u0028_i1_u003b_vf2_u003b((&param), (&param_1));\n            dir_1 = _e80;\n            let _e81 = i_2;\n            indexable_2 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n            let _e84 = indexable_2[_e81][2u];\n            let _e85 = (*gain);\n            steepness = (_e84 * _e85);\n            let _e87 = i_2;\n            param_2 = _e87;\n            let _e88 = gerstnerWavenumber_u0028_i1_u003b((&param_2));\n            k_1 = _e88;\n            let _e89 = k_1;\n            param_3 = _e89;\n            let _e90 = dir_1;\n            param_4 = _e90;\n            let _e91 = (*p_1);\n            param_5 = _e91;\n            let _e92 = (*time_1);\n            param_6 = _e92;\n            let _e93 = gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b((&param_3), (&param_4), (&param_5), (&param_6));\n            f = _e93;\n            let _e94 = steepness;\n            let _e95 = k_1;\n            a = (_e94 / _e95);\n            let _e98 = dir_1[0u];\n            let _e99 = a;\n            let _e101 = f;\n            let _e106 = s.offset[0u];\n            s.offset[0u] = (_e106 + ((_e98 * _e99) * cos(_e101)));\n            let _e110 = a;\n            let _e111 = f;\n            let _e116 = s.offset[1u];\n            s.offset[1u] = (_e116 + (_e110 * sin(_e111)));\n            let _e121 = dir_1[1u];\n            let _e122 = a;\n            let _e124 = f;\n            let _e129 = s.offset[2u];\n            s.offset[2u] = (_e129 + ((_e121 * _e122) * cos(_e124)));\n            let _e134 = dir_1[0u];\n            let _e135 = steepness;\n            let _e137 = f;\n            let _e142 = s.normal[0u];\n            s.normal[0u] = (_e142 - ((_e134 * _e135) * cos(_e137)));\n            let _e147 = dir_1[1u];\n            let _e148 = steepness;\n            let _e150 = f;\n            let _e155 = s.normal[2u];\n            s.normal[2u] = (_e155 - ((_e147 * _e148) * cos(_e150)));\n            let _e159 = steepness;\n            let _e160 = f;\n            let _e165 = s.normal[1u];\n            s.normal[1u] = (_e165 - (_e159 * sin(_e160)));\n            let _e169 = f;\n            let _e171 = steepness;\n            let _e174 = s.crest;\n            s.crest = (_e174 + (sin(_e169) * _e171));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e177 = i_2;\n            i_2 = (_e177 + 1i);\n        }\n    }\n    let _e179 = s;\n    return _e179;\n}\n\nfn main_1() {\n    var grid: vec2<f32>;\n    var rimFraction: vec2<f32>;\n    var rimDistance: f32;\n    var waveFade: f32;\n    var laid: vec2<f32>;\n    var base: vec3<f32>;\n    var sea: GerstnerSurface;\n    var param_7: vec2<f32>;\n    var param_8: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var pos: vec3<f32>;\n\n    let _e66 = aGrid_1;\n    let _e68 = unnamed.uGridSpan;\n    grid = (_e66 * _e68);\n    let _e70 = grid;\n    vGrid = _e70;\n    let _e71 = grid;\n    let _e74 = unnamed.uNearHalf;\n    rimFraction = (abs(_e71) / max(_e74, vec2<f32>(0.0001f, 0.0001f)));\n    let _e78 = rimFraction[0u];\n    let _e80 = rimFraction[1u];\n    rimDistance = max(_e78, _e80);\n    let _e82 = rimDistance;\n    waveFade = (1f - smoothstep(0.35f, 0.97f, _e82));\n    let _e87 = unnamed.uGridForward[1u];\n    let _e90 = unnamed.uGridForward[0u];\n    let _e94 = grid[0u];\n    let _e97 = unnamed.uGridForward;\n    let _e99 = grid[1u];\n    laid = ((vec2<f32>(_e87, -(_e90)) * _e94) + (_e97 * _e99));\n    let _e104 = unnamed.uGridOrigin[0u];\n    let _e106 = laid[0u];\n    let _e109 = unnamed.uWaterLevel;\n    let _e112 = unnamed.uGridOrigin[1u];\n    let _e114 = laid[1u];\n    base = vec3<f32>((_e104 + _e106), _e109, (_e112 + _e114));\n    let _e117 = waveFade;\n    let _e119 = unnamed.uWaveGain;\n    let _e121 = base;\n    param_7 = _e121.xz;\n    let _e124 = unnamed.uTime;\n    param_8 = _e124;\n    let _e126 = unnamed.uWindDir;\n    param_9 = _e126;\n    param_10 = (_e117 * _e119);\n    let _e127 = gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b((&param_7), (&param_8), (&param_9), (&param_10));\n    sea = _e127;\n    let _e128 = base;\n    let _e130 = sea.offset;\n    pos = (_e128 + _e130);\n    let _e132 = pos;\n    vWorldPos = _e132;\n    let _e134 = sea.normal;\n    vNormal = normalize(_e134);\n    let _e137 = sea.crest;\n    vCrest = _e137;\n    let _e139 = unnamed.uReflectionViewProj;\n    let _e140 = pos;\n    vReflectionClip = (_e139 * vec4<f32>(_e140.x, _e140.y, _e140.z, 1f));\n    let _e147 = unnamed.uViewProj;\n    let _e148 = pos;\n    unnamed_1.gl_Position = (_e147 * vec4<f32>(_e148.x, _e148.y, _e148.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aGrid: vec2<f32>) -> VertexOutput {\n    aGrid_1 = aGrid;\n    main_1();\n    let _e10 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e10);\n    let _e12 = vGrid;\n    let _e13 = vWorldPos;\n    let _e14 = vNormal;\n    let _e15 = vCrest;\n    let _e16 = vReflectionClip;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e12, _e13, _e14, _e15, _e16, _e17);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const WATER_BINDINGS = {
  "WATER_FRAG": {
    "uniforms": 1,
    "uniformSize": 1568,
    "fields": {
      "uGridHalf": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uFoamGain": {
        "offset": 8,
        "size": 4,
        "type": "float"
      },
      "uNadirOpacity": {
        "offset": 12,
        "size": 4,
        "type": "float"
      },
      "uVisibility": {
        "offset": 16,
        "size": 4,
        "type": "float"
      },
      "uMirror": {
        "offset": 20,
        "size": 4,
        "type": "float"
      },
      "uDeepColor": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uShallowColor": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uDirectionalDir": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uDirectionalColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uAmbient": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uLightCount": {
        "offset": 108,
        "size": 4,
        "type": "int"
      },
      "uLightPos": {
        "offset": 112,
        "size": 256,
        "type": "vec3",
        "length": 16,
        "stride": 16
      },
      "uLightColor": {
        "offset": 368,
        "size": 256,
        "type": "vec3",
        "length": 16,
        "stride": 16
      },
      "uLightRadius": {
        "offset": 624,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLightWeight": {
        "offset": 880,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLightFalloff": {
        "offset": 1136,
        "size": 4,
        "type": "int"
      },
      "uLightCone": {
        "offset": 1152,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uFogColor": {
        "offset": 1408,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 1424,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 1440,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 1456,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 1468,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 1472,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 1488,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 1504,
        "size": 16,
        "type": "vec4"
      },
      "uCameraPos": {
        "offset": 1520,
        "size": 12,
        "type": "vec3"
      },
      "uReflectionEnabled": {
        "offset": 1532,
        "size": 4,
        "type": "int"
      },
      "uReflectionTexelSize": {
        "offset": 1536,
        "size": 8,
        "type": "vec2"
      },
      "uReflectionFilterTaps": {
        "offset": 1544,
        "size": 4,
        "type": "int"
      },
      "uOutputTransform": {
        "offset": 1548,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 1552,
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
  "WATER_VERT": {
    "uniforms": 0,
    "uniformSize": 208,
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
      },
      "uCameraPos": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      },
      "uTime": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uGridOrigin": {
        "offset": 144,
        "size": 8,
        "type": "vec2"
      },
      "uGridSpan": {
        "offset": 152,
        "size": 8,
        "type": "vec2"
      },
      "uGridHalf": {
        "offset": 160,
        "size": 8,
        "type": "vec2"
      },
      "uNearHalf": {
        "offset": 168,
        "size": 8,
        "type": "vec2"
      },
      "uGridForward": {
        "offset": 176,
        "size": 8,
        "type": "vec2"
      },
      "uWindDir": {
        "offset": 184,
        "size": 8,
        "type": "vec2"
      },
      "uWaveGain": {
        "offset": 192,
        "size": 4,
        "type": "float"
      },
      "uWaterLevel": {
        "offset": 196,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
