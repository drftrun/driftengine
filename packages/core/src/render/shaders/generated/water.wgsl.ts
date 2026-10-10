/*
 * Generated from ../water.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const WATER_FRAG_WGSL = "struct Uniforms {\n    uGridHalf: vec2<f32>,\n    uFoamGain: f32,\n    uNadirOpacity: f32,\n    uVisibility: f32,\n    uMirror: f32,\n    uDeepColor: vec3<f32>,\n    uShallowColor: vec3<f32>,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uLightFalloff: i32,\n    uLightCone: array<vec4<f32>, 16>,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uCameraPos: vec3<f32>,\n    uReflectionEnabled: i32,\n    uReflectionTexelSize: vec2<f32>,\n    uReflectionFilterTaps: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vCrest_1: f32;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vGrid_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e152 = (*c);\n    low = (_e152 * 12.92f);\n    let _e154 = (*c);\n    high = ((pow(max(_e154, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e160 = high;\n    let _e161 = low;\n    let _e162 = (*c);\n    return mix(_e160, _e161, step(_e162, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e153 = (*c_1)[0u];\n    let _e155 = (*c_1)[1u];\n    let _e157 = (*c_1)[2u];\n    m = max(_e153, max(_e155, _e157));\n    let _e160 = m;\n    if (_e160 <= 0.8f) {\n        let _e162 = (*c_1);\n        return _e162;\n    }\n    let _e163 = m;\n    e = (_e163 - 0.8f);\n    let _e165 = (*c_1);\n    let _e166 = e;\n    let _e168 = e;\n    let _e172 = m;\n    return (_e165 * ((0.8f + ((0.2f * _e166) / (_e168 + 0.2f))) / _e172));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e152 = (*v);\n    let _e153 = (*v);\n    a = ((_e152 * (_e153 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e159 = (*v);\n    let _e160 = (*v);\n    b = ((_e159 * ((_e160 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e167 = a;\n    let _e168 = b;\n    return (_e167 / _e168);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e152 = unnamed.uOutputExposure;\n    let _e153 = (*x);\n    (*x) = (_e153 * _e152);\n    let _e155 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e155);\n    let _e157 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e157), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e154 = unnamed.uOutputTransform;\n    if (_e154 == 0i) {\n        let _e156 = (*c_2);\n        return _e156;\n    }\n    let _e158 = unnamed.uOutputTransform;\n    if (_e158 == 2i) {\n        let _e160 = (*c_2);\n        param_1 = _e160;\n        let _e161 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e161;\n    }\n    let _e163 = unnamed.uOutputTransform;\n    if (_e163 == 3i) {\n        let _e165 = (*c_2);\n        let _e167 = unnamed.uOutputExposure;\n        param_2 = (_e165 * _e167);\n        let _e169 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e169;\n    }\n    let _e170 = (*c_2);\n    param_3 = _e170;\n    let _e171 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e171;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e163 = unnamed.uFogMode;\n    if (_e163 == 1i) {\n        let _e166 = unnamed.uFogFar;\n        let _e168 = unnamed.uFogNear;\n        span = max((_e166 - _e168), 0.0001f);\n        let _e171 = (*dist);\n        let _e173 = unnamed.uFogNear;\n        let _e175 = span;\n        ramp = clamp(((_e171 - _e173) / _e175), 0f, 1f);\n        let _e179 = unnamed.uUnderwaterFactor;\n        if (_e179 <= 0f) {\n            let _e181 = ramp;\n            return _e181;\n        }\n        let _e183 = unnamed.uUnderwaterFogDensity;\n        let _e184 = (*dist);\n        wetLinear = (_e183 * _e184);\n        let _e186 = ramp;\n        let _e187 = wetLinear;\n        let _e189 = wetLinear;\n        let _e195 = unnamed.uUnderwaterFactor;\n        return mix(_e186, (1f - exp2(((-(_e187) * _e189) * 1.442695f))), _e195);\n    }\n    let _e198 = unnamed.uFogNear;\n    let _e199 = (*dist);\n    start = min(_e198, _e199);\n    let _e201 = (*dist);\n    if (_e201 > 0f) {\n        let _e203 = start;\n        let _e204 = (*dist);\n        local = (_e203 / _e204);\n    } else {\n        local = 0f;\n    }\n    let _e206 = local;\n    before = _e206;\n    let _e207 = (*pointY);\n    let _e209 = unnamed.uFogEyeY;\n    let _e212 = unnamed.uFogHeightFalloff;\n    t = ((_e207 - _e209) * _e212);\n    let _e214 = t;\n    let _e215 = before;\n    rest = (_e214 * (1f - _e215));\n    let _e218 = rest;\n    let _e221 = rest;\n    denom = select(_e221, 0.0001f, (abs(_e218) < 0.0001f));\n    let _e224 = unnamed.uFogDensity;\n    let _e226 = t;\n    let _e228 = before;\n    let _e232 = (*dist);\n    let _e233 = start;\n    let _e236 = denom;\n    let _e241 = denom;\n    air = (1f - exp(((((-(_e224) * exp((-(_e226) * _e228))) * (_e232 - _e233)) * (1f - exp(-(_e236)))) / _e241)));\n    let _e246 = unnamed.uUnderwaterFactor;\n    if (_e246 <= 0f) {\n        let _e248 = air;\n        return _e248;\n    }\n    let _e250 = unnamed.uUnderwaterFogDensity;\n    let _e251 = (*dist);\n    wet = (_e250 * _e251);\n    let _e253 = air;\n    let _e254 = wet;\n    let _e256 = wet;\n    let _e262 = unnamed.uUnderwaterFactor;\n    return mix(_e253, (1f - exp2(((-(_e254) * _e256) * 1.442695f))), _e262);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e150 = unnamed.uFogColor;\n    let _e152 = unnamed.uUnderwaterColor;\n    let _e154 = unnamed.uUnderwaterFactor;\n    return mix(_e150, _e152, vec3(_e154));\n}\n\nfn main_1() {\n    var n: vec3<f32>;\n    var view: vec3<f32>;\n    var facing: f32;\n    var fresnel: f32;\n    var atmosphereColor: vec3<f32>;\n    var col: vec3<f32>;\n    var incident: vec3<f32>;\n    var halfVec: vec3<f32>;\n    var spec: f32;\n    var highlight: vec3<f32>;\n    var i: i32;\n    var toLight: vec3<f32>;\n    var lightDist: f32;\n    var exponent: f32;\n    var reach: f32;\n    var falloff: f32;\n    var window: f32;\n    var lightDir: vec3<f32>;\n    var shaped: f32;\n    var lampHalf: vec3<f32>;\n    var foam: f32;\n    var dist_1: f32;\n    var fog: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var param_6: vec3<f32>;\n    var gradedAir: vec3<f32>;\n    var param_7: vec3<f32>;\n    var airOpacity: f32;\n    var underwaterOpacity: f32;\n    var opacity: f32;\n    var reflected: vec3<f32>;\n    var reflectionValid: f32;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var blurPixels: f32;\n    var sceneReflection: vec3<f32>;\n    var filterWeight: f32;\n    var i_1: i32;\n    var sampleUv: vec2<f32>;\n    var indexable: array<vec2<f32>, 9>;\n    var weight: f32;\n    var indexable_1: array<f32, 9>;\n    var sceneWeight: f32;\n    var reflectionGain: f32;\n    var reflectivity: f32;\n    var reflectedRadiance: f32;\n    var reflectionWeight: f32;\n    var rimFraction: vec2<f32>;\n    var rimT: f32;\n    var rim: f32;\n    var edge: f32;\n    var phi_677_: bool;\n\n    let _e201 = vNormal_1;\n    n = normalize(_e201);\n    let _e204 = unnamed.uCameraPos;\n    let _e205 = vWorldPos_1;\n    view = normalize((_e204 - _e205));\n    let _e208 = n;\n    let _e209 = view;\n    facing = clamp(abs(dot(_e208, _e209)), 0f, 1f);\n    let _e213 = facing;\n    fresnel = (0.02f + (0.98f * pow((1f - _e213), 5f)));\n    let _e218 = mediumColor_u0028_();\n    atmosphereColor = _e218;\n    let _e220 = unnamed.uDeepColor;\n    let _e222 = unnamed.uShallowColor;\n    let _e223 = vCrest_1;\n    col = mix(_e220, _e222, vec3(clamp(((_e223 * 1.4f) + 0.4f), 0f, 1f)));\n    let _e230 = unnamed.uAmbient;\n    let _e232 = unnamed.uDirectionalColor;\n    let _e233 = n;\n    let _e235 = unnamed.uDirectionalDir;\n    incident = (_e230 + ((_e232 * max(dot(_e233, _e235), 0f)) * 0.6f));\n    let _e242 = unnamed.uDirectionalDir;\n    let _e243 = view;\n    halfVec = normalize((_e242 + _e243));\n    let _e246 = n;\n    let _e247 = halfVec;\n    spec = pow(max(dot(_e246, _e247), 0f), 220f);\n    let _e252 = unnamed.uDirectionalColor;\n    let _e253 = spec;\n    highlight = ((_e252 * _e253) * 1.6f);\n    i = 0i;\n    loop {\n        let _e256 = i;\n        if (_e256 < 16i) {\n            let _e258 = i;\n            let _e260 = unnamed.uLightCount;\n            if (_e258 >= _e260) {\n                break;\n            }\n            let _e262 = i;\n            let _e265 = unnamed.uLightPos[_e262];\n            let _e266 = vWorldPos_1;\n            toLight = (_e265 - _e266);\n            let _e268 = toLight;\n            lightDist = length(_e268);\n            let _e270 = i;\n            let _e274 = unnamed.uLightCone[_e270][2u];\n            exponent = _e274;\n            let _e275 = exponent;\n            if (_e275 > 0f) {\n                let _e277 = lightDist;\n                let _e278 = i;\n                let _e282 = unnamed.uLightRadius[_e278][0u];\n                reach = (_e277 / max(_e282, 0.0001f));\n                let _e285 = reach;\n                let _e286 = reach;\n                let _e290 = exponent;\n                falloff = pow(clamp((1f - (_e285 * _e286)), 0f, 1f), _e290);\n            } else {\n                let _e293 = unnamed.uLightFalloff;\n                if (_e293 == 1i) {\n                    let _e295 = lightDist;\n                    let _e296 = i;\n                    let _e300 = unnamed.uLightRadius[_e296][0u];\n                    window = clamp((1f - pow((_e295 / max(_e300, 0.0001f)), 4f)), 0f, 1f);\n                    let _e306 = window;\n                    let _e307 = window;\n                    let _e309 = lightDist;\n                    let _e310 = lightDist;\n                    falloff = ((_e306 * _e307) / max((_e309 * _e310), 0.01f));\n                } else {\n                    let _e314 = lightDist;\n                    let _e315 = i;\n                    let _e319 = unnamed.uLightRadius[_e315][0u];\n                    falloff = clamp((1f - (_e314 / max(_e319, 0.0001f))), 0f, 1f);\n                }\n            }\n            let _e324 = falloff;\n            if (_e324 <= 0f) {\n                continue;\n            }\n            let _e326 = toLight;\n            let _e327 = lightDist;\n            lightDir = (_e326 / vec3(max(_e327, 0.0001f)));\n            let _e331 = falloff;\n            let _e332 = i;\n            let _e336 = unnamed.uLightWeight[_e332][0u];\n            shaped = (_e331 * _e336);\n            let _e338 = i;\n            let _e341 = unnamed.uLightColor[_e338];\n            let _e342 = n;\n            let _e343 = lightDir;\n            let _e347 = shaped;\n            let _e350 = incident;\n            incident = (_e350 + (((_e341 * max(dot(_e342, _e343), 0f)) * _e347) * 0.6f));\n            let _e352 = lightDir;\n            let _e353 = view;\n            lampHalf = normalize((_e352 + _e353));\n            let _e356 = i;\n            let _e359 = unnamed.uLightColor[_e356];\n            let _e360 = n;\n            let _e361 = lampHalf;\n            let _e366 = shaped;\n            let _e369 = highlight;\n            highlight = (_e369 + (((_e359 * pow(max(dot(_e360, _e361), 0f), 220f)) * _e366) * 1.6f));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e371 = i;\n            i = (_e371 + 1i);\n        }\n    }\n    let _e373 = incident;\n    let _e374 = col;\n    col = (_e374 * _e373);\n    let _e376 = highlight;\n    let _e377 = col;\n    col = (_e377 + _e376);\n    let _e379 = vCrest_1;\n    let _e382 = unnamed.uFoamGain;\n    foam = (smoothstep(0.55f, 0.85f, _e379) * _e382);\n    let _e384 = col;\n    let _e385 = foam;\n    col = mix(_e384, vec3<f32>(0.92f, 0.96f, 1f), vec3((_e385 * 0.5f)));\n    let _e389 = vWorldPos_1;\n    let _e391 = unnamed.uCameraPos;\n    dist_1 = distance(_e389, _e391);\n    let _e393 = dist_1;\n    param_4 = _e393;\n    let _e395 = vWorldPos_1[1u];\n    param_5 = _e395;\n    let _e396 = mediumFog_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    fog = _e396;\n    let _e397 = col;\n    let _e398 = atmosphereColor;\n    let _e399 = fog;\n    col = mix(_e397, _e398, vec3(_e399));\n    let _e402 = col;\n    param_6 = _e402;\n    let _e403 = applyOutputTransform_u0028_vf3_u003b((&param_6));\n    col = _e403;\n    let _e404 = atmosphereColor;\n    param_7 = _e404;\n    let _e405 = applyOutputTransform_u0028_vf3_u003b((&param_7));\n    gradedAir = _e405;\n    let _e407 = unnamed.uNadirOpacity;\n    let _e408 = fresnel;\n    airOpacity = mix(_e407, 0.96f, _e408);\n    let _e411 = unnamed.uNadirOpacity;\n    let _e413 = fresnel;\n    underwaterOpacity = mix((_e411 * 0.55f), 0.88f, _e413);\n    let _e415 = airOpacity;\n    let _e416 = underwaterOpacity;\n    let _e418 = unnamed.uUnderwaterFactor;\n    opacity = mix(_e415, _e416, _e418);\n    let _e420 = opacity;\n    let _e421 = foam;\n    opacity = mix(_e420, 0.96f, (_e421 * 0.7f));\n    let _e424 = gradedAir;\n    reflected = _e424;\n    reflectionValid = 0f;\n    let _e426 = unnamed.uReflectionEnabled;\n    let _e427 = (_e426 != 0i);\n    phi_677_ = _e427;\n    if _e427 {\n        let _e429 = vReflectionClip_1[3u];\n        phi_677_ = (_e429 > 0f);\n    }\n    let _e432 = phi_677_;\n    if _e432 {\n        let _e433 = vReflectionClip_1;\n        let _e436 = vReflectionClip_1[3u];\n        reflectionUv = (((_e433.xy / vec2(_e436)) * 0.5f) + vec2(0.5f));\n        let _e442 = n;\n        let _e444 = fresnel;\n        let _e447 = reflectionUv;\n        reflectionUv = (_e447 + (_e442.xz * mix(0.008f, 0.022f, _e444)));\n        let _e449 = reflectionUv;\n        let _e450 = reflectionUv;\n        border = min(_e449, (vec2(1f) - _e450));\n        let _e455 = border[0u];\n        let _e457 = border[1u];\n        reflectionValid = smoothstep(0f, 0.025f, min(_e455, _e457));\n        let _e460 = dist_1;\n        blurPixels = (1.35f + min((_e460 * 0.022f), 3.5f));\n        sceneReflection = vec3<f32>(0f, 0f, 0f);\n        filterWeight = 0f;\n        i_1 = 0i;\n        loop {\n            let _e464 = i_1;\n            if (_e464 < 9i) {\n                let _e466 = i_1;\n                let _e468 = unnamed.uReflectionFilterTaps;\n                if (_e466 >= _e468) {\n                    break;\n                }\n                let _e470 = reflectionUv;\n                let _e471 = i_1;\n                indexable = array<vec2<f32>, 9>(vec2<f32>(0f, 0f), vec2<f32>(-0.62f, -0.31f), vec2<f32>(0.54f, 0.43f), vec2<f32>(-0.34f, 0.76f), vec2<f32>(0.78f, -0.57f), vec2<f32>(-0.88f, 0.28f), vec2<f32>(0.22f, -0.91f), vec2<f32>(0.91f, 0.08f), vec2<f32>(-0.18f, 0.94f));\n                let _e473 = indexable[_e471];\n                let _e475 = unnamed.uReflectionTexelSize;\n                let _e477 = blurPixels;\n                sampleUv = (_e470 + ((_e473 * _e475) * _e477));\n                let _e480 = i_1;\n                indexable_1 = array<f32, 9>(0.28f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f);\n                let _e482 = indexable_1[_e480];\n                weight = _e482;\n                let _e483 = sampleUv;\n                let _e487 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e483, vec2(0f), vec2(1f)), 0f);\n                let _e489 = weight;\n                let _e491 = sceneReflection;\n                sceneReflection = (_e491 + (_e487.xyz * _e489));\n                let _e493 = weight;\n                let _e494 = filterWeight;\n                filterWeight = (_e494 + _e493);\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e496 = i_1;\n                i_1 = (_e496 + 1i);\n            }\n        }\n        let _e498 = filterWeight;\n        let _e500 = sceneReflection;\n        sceneReflection = (_e500 / vec3(max(_e498, 0.001f)));\n        let _e503 = gradedAir;\n        let _e504 = sceneReflection;\n        let _e505 = reflectionValid;\n        reflected = mix(_e503, _e504, vec3(_e505));\n    }\n    let _e509 = unnamed.uReflectionEnabled;\n    let _e511 = reflectionValid;\n    sceneWeight = (f32(_e509) * _e511);\n    let _e513 = sceneWeight;\n    reflectionGain = mix(0.75f, 0.94f, _e513);\n    let _e515 = fresnel;\n    let _e517 = unnamed.uMirror;\n    reflectivity = mix(_e515, 1f, _e517);\n    let _e519 = reflectivity;\n    let _e520 = reflectionGain;\n    let _e522 = foam;\n    let _e526 = opacity;\n    reflectedRadiance = min(((_e519 * _e520) * (1f - (_e522 * 0.8f))), _e526);\n    let _e528 = reflectedRadiance;\n    let _e529 = opacity;\n    reflectionWeight = (_e528 / max(_e529, 0.001f));\n    let _e532 = col;\n    let _e533 = reflected;\n    let _e534 = reflectionWeight;\n    col = mix(_e532, _e533, vec3(_e534));\n    let _e537 = vGrid_1;\n    let _e540 = unnamed.uGridHalf;\n    rimFraction = (abs(_e537) / max(_e540, vec2<f32>(0.001f, 0.001f)));\n    let _e544 = rimFraction[0u];\n    let _e546 = rimFraction[1u];\n    rimT = max(_e544, _e546);\n    let _e548 = rimT;\n    rim = (1f - smoothstep(0.9f, 1f, _e548));\n    let _e551 = fog;\n    edge = (1f - smoothstep(0.82f, 1f, _e551));\n    let _e554 = col;\n    let _e555 = opacity;\n    let _e556 = edge;\n    let _e558 = rim;\n    let _e561 = unnamed.uVisibility;\n    outColor = vec4<f32>(_e554.x, _e554.y, _e554.z, (((_e555 * _e556) * _e558) * _e561));\n    return;\n}\n\n@fragment \nfn main(@location(1) vNormal: vec3<f32>, @location(0) vWorldPos: vec3<f32>, @location(2) vCrest: f32, @location(3) vReflectionClip: vec4<f32>, @location(4) vGrid: vec2<f32>) -> @location(0) vec4<f32> {\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vCrest_1 = vCrest;\n    vReflectionClip_1 = vReflectionClip;\n    vGrid_1 = vGrid;\n    main_1();\n    let _e11 = outColor;\n    return _e11;\n}\n";

export const WATER_VERT_WGSL = "struct GerstnerSurface {\n    offset: vec3<f32>,\n    normal: vec3<f32>,\n    crest: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uGridOrigin: vec2<f32>,\n    uGridSpan: vec2<f32>,\n    uGridHalf: vec2<f32>,\n    uNearHalf: vec2<f32>,\n    uGridForward: vec2<f32>,\n    uWindDir: vec2<f32>,\n    uWaveGain: f32,\n    uWaterLevel: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(4) member: vec2<f32>,\n    @location(0) member_1: vec3<f32>,\n    @location(1) member_2: vec3<f32>,\n    @location(2) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aGrid_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> vGrid: vec2<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> vCrest: f32;\nvar<private> vReflectionClip: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b(k: ptr<function, f32>, dir: ptr<function, vec2<f32>>, p: ptr<function, vec2<f32>>, time: ptr<function, f32>) -> f32 {\n    var c: f32;\n\n    let _e59 = (*k);\n    c = sqrt((9.81f / _e59));\n    let _e62 = (*k);\n    let _e63 = (*dir);\n    let _e64 = (*p);\n    let _e66 = c;\n    let _e67 = (*time);\n    return (_e62 * (dot(_e63, _e64) - (_e66 * _e67)));\n}\n\nfn gerstnerWavenumber_u0028_i1_u003b(i: ptr<function, i32>) -> f32 {\n    var indexable: array<vec4<f32>, 4>;\n\n    let _e56 = (*i);\n    indexable = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable[_e56][3u];\n    return (6.2831855f / _e59);\n}\n\nfn gerstnerDirection_u0028_i1_u003b_vf2_u003b(i_1: ptr<function, i32>, windDir: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var indexable_1: array<vec4<f32>, 4>;\n\n    let _e57 = (*i_1);\n    indexable_1 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable_1[_e57];\n    let _e62 = (*windDir);\n    return normalize(mix(normalize(_e59.xy), _e62, vec2(0.62f)));\n}\n\nfn gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b(p_1: ptr<function, vec2<f32>>, time_1: ptr<function, f32>, windDir_1: ptr<function, vec2<f32>>, gain: ptr<function, f32>) -> GerstnerSurface {\n    var s: GerstnerSurface;\n    var i_2: i32;\n    var dir_1: vec2<f32>;\n    var param: i32;\n    var param_1: vec2<f32>;\n    var steepness: f32;\n    var indexable_2: array<vec4<f32>, 4>;\n    var k_1: f32;\n    var param_2: i32;\n    var f: f32;\n    var param_3: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n    var a: f32;\n\n    s.offset = vec3<f32>(0f, 0f, 0f);\n    s.normal = vec3<f32>(0f, 1f, 0f);\n    s.crest = 0f;\n    i_2 = 0i;\n    loop {\n        let _e76 = i_2;\n        if (_e76 < 4i) {\n            let _e78 = i_2;\n            param = _e78;\n            let _e79 = (*windDir_1);\n            param_1 = _e79;\n            let _e80 = gerstnerDirection_u0028_i1_u003b_vf2_u003b((&param), (&param_1));\n            dir_1 = _e80;\n            let _e81 = i_2;\n            indexable_2 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n            let _e84 = indexable_2[_e81][2u];\n            let _e85 = (*gain);\n            steepness = (_e84 * _e85);\n            let _e87 = i_2;\n            param_2 = _e87;\n            let _e88 = gerstnerWavenumber_u0028_i1_u003b((&param_2));\n            k_1 = _e88;\n            let _e89 = k_1;\n            param_3 = _e89;\n            let _e90 = dir_1;\n            param_4 = _e90;\n            let _e91 = (*p_1);\n            param_5 = _e91;\n            let _e92 = (*time_1);\n            param_6 = _e92;\n            let _e93 = gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b((&param_3), (&param_4), (&param_5), (&param_6));\n            f = _e93;\n            let _e94 = steepness;\n            let _e95 = k_1;\n            a = (_e94 / _e95);\n            let _e98 = dir_1[0u];\n            let _e99 = a;\n            let _e101 = f;\n            let _e106 = s.offset[0u];\n            s.offset[0u] = (_e106 + ((_e98 * _e99) * cos(_e101)));\n            let _e110 = a;\n            let _e111 = f;\n            let _e116 = s.offset[1u];\n            s.offset[1u] = (_e116 + (_e110 * sin(_e111)));\n            let _e121 = dir_1[1u];\n            let _e122 = a;\n            let _e124 = f;\n            let _e129 = s.offset[2u];\n            s.offset[2u] = (_e129 + ((_e121 * _e122) * cos(_e124)));\n            let _e134 = dir_1[0u];\n            let _e135 = steepness;\n            let _e137 = f;\n            let _e142 = s.normal[0u];\n            s.normal[0u] = (_e142 - ((_e134 * _e135) * cos(_e137)));\n            let _e147 = dir_1[1u];\n            let _e148 = steepness;\n            let _e150 = f;\n            let _e155 = s.normal[2u];\n            s.normal[2u] = (_e155 - ((_e147 * _e148) * cos(_e150)));\n            let _e159 = steepness;\n            let _e160 = f;\n            let _e165 = s.normal[1u];\n            s.normal[1u] = (_e165 - (_e159 * sin(_e160)));\n            let _e169 = f;\n            let _e171 = steepness;\n            let _e174 = s.crest;\n            s.crest = (_e174 + (sin(_e169) * _e171));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e177 = i_2;\n            i_2 = (_e177 + 1i);\n        }\n    }\n    let _e179 = s;\n    return _e179;\n}\n\nfn main_1() {\n    var grid: vec2<f32>;\n    var rimFraction: vec2<f32>;\n    var rimDistance: f32;\n    var waveFade: f32;\n    var laid: vec2<f32>;\n    var base: vec3<f32>;\n    var sea: GerstnerSurface;\n    var param_7: vec2<f32>;\n    var param_8: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var pos: vec3<f32>;\n\n    let _e66 = aGrid_1;\n    let _e68 = unnamed.uGridSpan;\n    grid = (_e66 * _e68);\n    let _e70 = grid;\n    vGrid = _e70;\n    let _e71 = grid;\n    let _e74 = unnamed.uNearHalf;\n    rimFraction = (abs(_e71) / max(_e74, vec2<f32>(0.0001f, 0.0001f)));\n    let _e78 = rimFraction[0u];\n    let _e80 = rimFraction[1u];\n    rimDistance = max(_e78, _e80);\n    let _e82 = rimDistance;\n    waveFade = (1f - smoothstep(0.35f, 0.97f, _e82));\n    let _e87 = unnamed.uGridForward[1u];\n    let _e90 = unnamed.uGridForward[0u];\n    let _e94 = grid[0u];\n    let _e97 = unnamed.uGridForward;\n    let _e99 = grid[1u];\n    laid = ((vec2<f32>(_e87, -(_e90)) * _e94) + (_e97 * _e99));\n    let _e104 = unnamed.uGridOrigin[0u];\n    let _e106 = laid[0u];\n    let _e109 = unnamed.uWaterLevel;\n    let _e112 = unnamed.uGridOrigin[1u];\n    let _e114 = laid[1u];\n    base = vec3<f32>((_e104 + _e106), _e109, (_e112 + _e114));\n    let _e117 = waveFade;\n    let _e119 = unnamed.uWaveGain;\n    let _e121 = base;\n    param_7 = _e121.xz;\n    let _e124 = unnamed.uTime;\n    param_8 = _e124;\n    let _e126 = unnamed.uWindDir;\n    param_9 = _e126;\n    param_10 = (_e117 * _e119);\n    let _e127 = gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b((&param_7), (&param_8), (&param_9), (&param_10));\n    sea = _e127;\n    let _e128 = base;\n    let _e130 = sea.offset;\n    pos = (_e128 + _e130);\n    let _e132 = pos;\n    vWorldPos = _e132;\n    let _e134 = sea.normal;\n    vNormal = normalize(_e134);\n    let _e137 = sea.crest;\n    vCrest = _e137;\n    let _e139 = unnamed.uReflectionViewProj;\n    let _e140 = pos;\n    vReflectionClip = (_e139 * vec4<f32>(_e140.x, _e140.y, _e140.z, 1f));\n    let _e147 = unnamed.uViewProj;\n    let _e148 = pos;\n    unnamed_1.gl_Position = (_e147 * vec4<f32>(_e148.x, _e148.y, _e148.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aGrid: vec2<f32>) -> VertexOutput {\n    aGrid_1 = aGrid;\n    main_1();\n    let _e10 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e10);\n    let _e12 = vGrid;\n    let _e13 = vWorldPos;\n    let _e14 = vNormal;\n    let _e15 = vCrest;\n    let _e16 = vReflectionClip;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e12, _e13, _e14, _e15, _e16, _e17);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const WATER_BINDINGS = {
  "WATER_FRAG": {
    "uniforms": 1,
    "uniformSize": 1520,
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
      "uFogDensity": {
        "offset": 1420,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 1424,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 1428,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 1440,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 1452,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 1456,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 1460,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 1464,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 1468,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 1472,
        "size": 12,
        "type": "vec3"
      },
      "uReflectionEnabled": {
        "offset": 1484,
        "size": 4,
        "type": "int"
      },
      "uReflectionTexelSize": {
        "offset": 1488,
        "size": 8,
        "type": "vec2"
      },
      "uReflectionFilterTaps": {
        "offset": 1496,
        "size": 4,
        "type": "int"
      },
      "uOutputTransform": {
        "offset": 1500,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 1504,
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
