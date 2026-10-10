/*
 * Generated from ../sky.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SKY_FRAG_WGSL = "struct Uniforms {\n    uInvViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTopColor: vec3<f32>,\n    uHorizonColor: vec3<f32>,\n    uDeepColor: vec3<f32>,\n    uSunDir: vec3<f32>,\n    uSunColor: vec3<f32>,\n    uSunDiscExponent: f32,\n    uMoonDir: vec3<f32>,\n    uMoonColor: vec3<f32>,\n    uMoonAngularRadius: f32,\n    uMoonPhase: f32,\n    uNightFactor: f32,\n    uCloudOffset: vec2<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNdc_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e149 = (*c);\n    low = (_e149 * 12.92f);\n    let _e151 = (*c);\n    high = ((pow(max(_e151, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e157 = high;\n    let _e158 = low;\n    let _e159 = (*c);\n    return mix(_e157, _e158, step(_e159, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e150 = (*c_1)[0u];\n    let _e152 = (*c_1)[1u];\n    let _e154 = (*c_1)[2u];\n    m = max(_e150, max(_e152, _e154));\n    let _e157 = m;\n    if (_e157 <= 0.8f) {\n        let _e159 = (*c_1);\n        return _e159;\n    }\n    let _e160 = m;\n    e = (_e160 - 0.8f);\n    let _e162 = (*c_1);\n    let _e163 = e;\n    let _e165 = e;\n    let _e169 = m;\n    return (_e162 * ((0.8f + ((0.2f * _e163) / (_e165 + 0.2f))) / _e169));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e149 = (*v);\n    let _e150 = (*v);\n    a = ((_e149 * (_e150 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e156 = (*v);\n    let _e157 = (*v);\n    b = ((_e156 * ((_e157 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e164 = a;\n    let _e165 = b;\n    return (_e164 / _e165);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e149 = unnamed.uOutputExposure;\n    let _e150 = (*x);\n    (*x) = (_e150 * _e149);\n    let _e152 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e152);\n    let _e154 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e154), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e151 = unnamed.uOutputTransform;\n    if (_e151 == 0i) {\n        let _e153 = (*c_2);\n        return _e153;\n    }\n    let _e155 = unnamed.uOutputTransform;\n    if (_e155 == 2i) {\n        let _e157 = (*c_2);\n        param_1 = _e157;\n        let _e158 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e158;\n    }\n    let _e160 = unnamed.uOutputTransform;\n    if (_e160 == 3i) {\n        let _e162 = (*c_2);\n        let _e164 = unnamed.uOutputExposure;\n        param_2 = (_e162 * _e164);\n        let _e166 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e166;\n    }\n    let _e167 = (*c_2);\n    param_3 = _e167;\n    let _e168 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e168;\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e147 = (*p);\n    return fract((sin(dot(_e147, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var a_1: f32;\n    var param_4: vec2<f32>;\n    var b_1: f32;\n    var param_5: vec2<f32>;\n    var c_3: f32;\n    var param_6: vec2<f32>;\n    var d: f32;\n    var param_7: vec2<f32>;\n\n    let _e158 = (*p_1);\n    i = floor(_e158);\n    let _e160 = (*p_1);\n    f = fract(_e160);\n    let _e162 = f;\n    let _e163 = f;\n    let _e165 = f;\n    u = ((_e162 * _e163) * (vec2(3f) - (_e165 * 2f)));\n    let _e170 = i;\n    param_4 = _e170;\n    let _e171 = hash21_u0028_vf2_u003b((&param_4));\n    a_1 = _e171;\n    let _e172 = i;\n    param_5 = (_e172 + vec2<f32>(1f, 0f));\n    let _e174 = hash21_u0028_vf2_u003b((&param_5));\n    b_1 = _e174;\n    let _e175 = i;\n    param_6 = (_e175 + vec2<f32>(0f, 1f));\n    let _e177 = hash21_u0028_vf2_u003b((&param_6));\n    c_3 = _e177;\n    let _e178 = i;\n    param_7 = (_e178 + vec2<f32>(1f, 1f));\n    let _e180 = hash21_u0028_vf2_u003b((&param_7));\n    d = _e180;\n    let _e181 = a_1;\n    let _e182 = b_1;\n    let _e184 = u[0u];\n    let _e186 = c_3;\n    let _e187 = d;\n    let _e189 = u[0u];\n    let _e192 = u[1u];\n    return mix(mix(_e181, _e182, _e184), mix(_e186, _e187, _e189), _e192);\n}\n\nfn fbm_u0028_vf2_u003b(p_2: ptr<function, vec2<f32>>) -> f32 {\n    var v_1: f32;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n    var param_10: vec2<f32>;\n\n    let _e151 = (*p_2);\n    param_8 = _e151;\n    let _e152 = valueNoise_u0028_vf2_u003b((&param_8));\n    v_1 = (_e152 * 0.5f);\n    let _e154 = (*p_2);\n    param_9 = (_e154 * 2.03f);\n    let _e156 = valueNoise_u0028_vf2_u003b((&param_9));\n    let _e158 = v_1;\n    v_1 = (_e158 + (_e156 * 0.3f));\n    let _e160 = (*p_2);\n    param_10 = (_e160 * 4.01f);\n    let _e162 = valueNoise_u0028_vf2_u003b((&param_10));\n    let _e164 = v_1;\n    v_1 = (_e164 + (_e162 * 0.2f));\n    let _e166 = v_1;\n    return _e166;\n}\n\nfn main_1() {\n    var world: vec4<f32>;\n    var dir: vec3<f32>;\n    var t: f32;\n    var col: vec3<f32>;\n    var local: vec3<f32>;\n    var aboveHorizon: f32;\n    var sunset: f32;\n    var ember: vec3<f32>;\n    var s: f32;\n    var discColor: vec3<f32>;\n    var sunBearing: vec2<f32>;\n    var viewBearing: vec2<f32>;\n    var toward: f32;\n    var fromHorizon: f32;\n    var local_1: f32;\n    var band: f32;\n    var away: f32;\n    var moonReference: vec3<f32>;\n    var moonRight: vec3<f32>;\n    var moonUp: vec3<f32>;\n    var moonRadius: f32;\n    var moonUv: vec2<f32>;\n    var moonRadiusSq: f32;\n    var moonFacing: f32;\n    var moonDisc: f32;\n    var sphereZ: f32;\n    var surfaceNormal: vec3<f32>;\n    var phaseAngle: f32;\n    var phaseLight: vec3<f32>;\n    var phaseShade: f32;\n    var maria: f32;\n    var param_11: vec2<f32>;\n    var param_12: vec2<f32>;\n    var albedo: f32;\n    var limb: f32;\n    var earthshine: f32;\n    var lunarLight: f32;\n    var phaseIllumination: f32;\n    var moonHalo: f32;\n    var p_3: vec2<f32>;\n    var cell: vec2<f32>;\n    var h: f32;\n    var param_13: vec2<f32>;\n    var jitter: vec2<f32>;\n    var param_14: vec2<f32>;\n    var param_15: vec2<f32>;\n    var d_1: f32;\n    var star: f32;\n    var uv: vec2<f32>;\n    var band_1: f32;\n    var param_16: vec2<f32>;\n    var fade: f32;\n    var cloudCol: vec3<f32>;\n    var waterLight: f32;\n    var param_17: vec3<f32>;\n\n    let _e202 = unnamed.uInvViewProj;\n    let _e203 = vNdc_1;\n    world = (_e202 * vec4<f32>(_e203.x, _e203.y, 1f, 1f));\n    let _e208 = world;\n    let _e211 = world[3u];\n    let _e215 = unnamed.uCameraPos;\n    dir = normalize(((_e208.xyz / vec3(_e211)) - _e215));\n    let _e219 = dir[1u];\n    t = _e219;\n    let _e220 = t;\n    if (_e220 >= 0f) {\n        let _e223 = unnamed.uHorizonColor;\n        let _e225 = unnamed.uTopColor;\n        let _e226 = t;\n        local = mix(_e223, _e225, vec3(pow(min(_e226, 1f), 0.55f)));\n    } else {\n        let _e232 = unnamed.uHorizonColor;\n        let _e234 = unnamed.uDeepColor;\n        let _e235 = t;\n        local = mix(_e232, _e234, vec3(min((-(_e235) * 1.8f), 1f)));\n    }\n    let _e241 = local;\n    col = _e241;\n    let _e243 = dir[1u];\n    aboveHorizon = smoothstep(-0.04f, 0.06f, _e243);\n    let _e247 = unnamed.uSunDir[1u];\n    let _e252 = unnamed.uSunDir[1u];\n    sunset = ((1f - smoothstep(-0.03f, 0.3f, _e247)) * smoothstep(-0.35f, -0.05f, _e252));\n    ember = vec3<f32>(1f, 0.36f, 0.13f);\n    let _e255 = dir;\n    let _e257 = unnamed.uSunDir;\n    s = max(dot(_e255, _e257), 0f);\n    let _e261 = unnamed.uSunColor;\n    let _e263 = unnamed.uSunColor;\n    let _e264 = ember;\n    let _e266 = sunset;\n    discColor = mix(_e261, (_e263 * _e264), vec3((_e266 * 0.85f)));\n    let _e270 = discColor;\n    let _e271 = s;\n    let _e273 = unnamed.uSunDiscExponent;\n    let _e276 = s;\n    let _e278 = unnamed.uSunDiscExponent;\n    let _e285 = aboveHorizon;\n    let _e287 = col;\n    col = (_e287 + ((_e270 * ((pow(_e271, _e273) * 1.2f) + (pow(_e276, max((_e278 / 75f), 1f)) * 0.12f))) * _e285));\n    let _e290 = unnamed.uSunDir;\n    sunBearing = normalize((_e290.xz + vec2<f32>(0.00001f, 0.00001f)));\n    let _e294 = dir;\n    viewBearing = normalize((_e294.xz + vec2<f32>(0.00001f, 0.00001f)));\n    let _e298 = viewBearing;\n    let _e299 = sunBearing;\n    toward = max(dot(_e298, _e299), 0f);\n    let _e303 = dir[1u];\n    if (_e303 >= 0f) {\n        let _e306 = dir[1u];\n        local_1 = _e306;\n    } else {\n        let _e308 = dir[1u];\n        local_1 = (-(_e308) * 3f);\n    }\n    let _e311 = local_1;\n    fromHorizon = _e311;\n    let _e312 = fromHorizon;\n    band = pow((1f - min((_e312 * 2.2f), 1f)), 2.6f);\n    let _e317 = ember;\n    let _e318 = sunset;\n    let _e320 = band;\n    let _e322 = toward;\n    let _e327 = col;\n    col = (_e327 + (((_e317 * _e318) * _e320) * (0.18f + (0.75f * pow(_e322, 2.2f)))));\n    let _e329 = viewBearing;\n    let _e330 = sunBearing;\n    away = max(-(dot(_e329, _e330)), 0f);\n    let _e334 = sunset;\n    let _e336 = band;\n    let _e338 = away;\n    let _e341 = col;\n    col = (_e341 + ((((vec3<f32>(0.42f, 0.28f, 0.45f) * _e334) * _e336) * _e338) * 0.22f));\n    let _e345 = unnamed.uMoonDir[1u];\n    moonReference = select(vec3<f32>(1f, 0f, 0f), vec3<f32>(0f, 1f, 0f), vec3((abs(_e345) < 0.98f)));\n    let _e350 = moonReference;\n    let _e352 = unnamed.uMoonDir;\n    moonRight = normalize(cross(_e350, _e352));\n    let _e356 = unnamed.uMoonDir;\n    let _e357 = moonRight;\n    moonUp = cross(_e356, _e357);\n    let _e360 = unnamed.uMoonAngularRadius;\n    moonRadius = clamp(_e360, 0.001f, 0.5f);\n    let _e362 = dir;\n    let _e363 = moonRight;\n    let _e365 = dir;\n    let _e366 = moonUp;\n    let _e369 = moonRadius;\n    moonUv = (vec2<f32>(dot(_e362, _e363), dot(_e365, _e366)) / vec2(_e369));\n    let _e372 = moonUv;\n    let _e373 = moonUv;\n    moonRadiusSq = dot(_e372, _e373);\n    let _e375 = dir;\n    let _e377 = unnamed.uMoonDir;\n    moonFacing = step(0f, dot(_e375, _e377));\n    let _e380 = moonRadiusSq;\n    let _e383 = moonFacing;\n    moonDisc = ((1f - smoothstep(0.9f, 1f, _e380)) * _e383);\n    let _e385 = moonDisc;\n    if (_e385 > 0f) {\n        let _e387 = moonRadiusSq;\n        sphereZ = sqrt(max((1f - _e387), 0f));\n        let _e391 = moonUv;\n        let _e392 = sphereZ;\n        surfaceNormal = normalize(vec3<f32>(_e391.x, _e391.y, _e392));\n        let _e398 = unnamed.uMoonPhase;\n        phaseAngle = (_e398 * 6.2831855f);\n        let _e400 = phaseAngle;\n        let _e402 = phaseAngle;\n        phaseLight = vec3<f32>(sin(_e400), 0f, -(cos(_e402)));\n        let _e406 = surfaceNormal;\n        let _e407 = phaseLight;\n        phaseShade = max(dot(_e406, _e407), 0f);\n        let _e410 = moonUv;\n        param_11 = ((_e410 * 3.2f) + vec2<f32>(4.7f, 9.1f));\n        let _e413 = valueNoise_u0028_vf2_u003b((&param_11));\n        let _e415 = moonUv;\n        param_12 = ((_e415 * 9.3f) - vec2<f32>(7.4f, 2.6f));\n        let _e418 = valueNoise_u0028_vf2_u003b((&param_12));\n        maria = ((_e413 * 0.68f) + (_e418 * 0.32f));\n        let _e421 = maria;\n        albedo = mix(0.56f, 1.02f, _e421);\n        let _e423 = sphereZ;\n        limb = mix(0.72f, 1f, _e423);\n        earthshine = 0.035f;\n        let _e425 = earthshine;\n        let _e426 = earthshine;\n        let _e428 = phaseShade;\n        lunarLight = (_e425 + ((1f - _e426) * _e428));\n        let _e432 = unnamed.uMoonColor;\n        let _e433 = albedo;\n        let _e435 = limb;\n        let _e437 = lunarLight;\n        let _e439 = moonDisc;\n        let _e443 = unnamed.uNightFactor;\n        let _e445 = aboveHorizon;\n        let _e447 = col;\n        col = (_e447 + (((((((_e432 * _e433) * _e435) * _e437) * _e439) * 1.35f) * _e443) * _e445));\n    }\n    let _e450 = unnamed.uMoonPhase;\n    phaseIllumination = (0.5f - (cos((_e450 * 6.2831855f)) * 0.5f));\n    let _e455 = moonUv;\n    let _e459 = moonFacing;\n    moonHalo = ((1f - smoothstep(1f, 3f, length(_e455))) * _e459);\n    let _e462 = unnamed.uMoonColor;\n    let _e463 = moonHalo;\n    let _e466 = phaseIllumination;\n    let _e469 = unnamed.uNightFactor;\n    let _e471 = aboveHorizon;\n    let _e473 = col;\n    col = (_e473 + (((((_e462 * _e463) * 0.08f) * _e466) * _e469) * _e471));\n    let _e476 = dir[1u];\n    if (_e476 > 0f) {\n        let _e479 = unnamed.uNightFactor;\n        if (_e479 > 0f) {\n            let _e481 = dir;\n            let _e484 = dir[1u];\n            p_3 = ((_e481.xz / vec2((1f + _e484))) * 26f);\n            let _e489 = p_3;\n            cell = floor(_e489);\n            let _e491 = cell;\n            param_13 = _e491;\n            let _e492 = hash21_u0028_vf2_u003b((&param_13));\n            h = _e492;\n            let _e493 = h;\n            if (_e493 > 0.93f) {\n                let _e495 = cell;\n                param_14 = (_e495 + vec2(17.3f));\n                let _e498 = hash21_u0028_vf2_u003b((&param_14));\n                let _e499 = cell;\n                param_15 = (_e499 + vec2(41.7f));\n                let _e502 = hash21_u0028_vf2_u003b((&param_15));\n                jitter = vec2<f32>(_e498, _e502);\n                let _e504 = p_3;\n                let _e506 = jitter;\n                d_1 = length((fract(_e504) - _e506));\n                let _e509 = d_1;\n                let _e511 = h;\n                star = (smoothstep(0.1f, 0f, _e509) * (0.4f + (_e511 * 0.6f)));\n                let _e515 = star;\n                let _e518 = unnamed.uNightFactor;\n                let _e521 = dir[1u];\n                let _e524 = col;\n                col = (_e524 + (((vec3<f32>(0.86f, 0.91f, 1f) * _e515) * _e518) * smoothstep(0.03f, 0.3f, _e521)));\n            }\n        }\n        let _e527 = dir[1u];\n        if (_e527 > 0.02f) {\n            let _e529 = dir;\n            let _e532 = dir[1u];\n            let _e538 = unnamed.uCloudOffset;\n            uv = (((_e529.xz / vec2(max(_e532, 0.16f))) * 0.09f) + (_e538 * 0.012f));\n            let _e541 = uv;\n            param_16 = _e541;\n            let _e542 = fbm_u0028_vf2_u003b((&param_16));\n            band_1 = smoothstep(0.46f, 0.6f, _e542);\n            let _e545 = dir[1u];\n            fade = smoothstep(0.02f, 0.3f, _e545);\n            let _e548 = unnamed.uHorizonColor;\n            let _e552 = unnamed.uNightFactor;\n            cloudCol = (mix(_e548, vec3<f32>(1f, 1f, 1f), vec3(0.45f)) * mix(1f, 0.32f, _e552));\n            let _e555 = col;\n            let _e556 = cloudCol;\n            let _e557 = band_1;\n            let _e558 = fade;\n            col = mix(_e555, _e556, vec3(((_e557 * _e558) * 0.8f)));\n        }\n    }\n    let _e564 = dir[1u];\n    waterLight = mix(0.62f, 1.08f, clamp(((_e564 * 0.5f) + 0.5f), 0f, 1f));\n    let _e569 = col;\n    let _e571 = unnamed.uUnderwaterColor;\n    let _e572 = waterLight;\n    let _e575 = unnamed.uUnderwaterFactor;\n    col = mix(_e569, (_e571 * _e572), vec3(_e575));\n    let _e578 = col;\n    param_17 = _e578;\n    let _e579 = applyOutputTransform_u0028_vf3_u003b((&param_17));\n    outColor = vec4<f32>(_e579.x, _e579.y, _e579.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vNdc: vec2<f32>) -> @location(0) vec4<f32> {\n    vNdc_1 = vNdc;\n    main_1();\n    let _e3 = outColor;\n    return _e3;\n}\n";

export const SKY_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vNdc: vec2<f32>;\nvar<private> gl_VertexIndex_1: i32;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var indexable: array<vec2<f32>, 3>;\n\n    let _e14 = gl_VertexIndex_1;\n    indexable = array<vec2<f32>, 3>(vec2<f32>(-1f, -1f), vec2<f32>(3f, -1f), vec2<f32>(-1f, 3f));\n    let _e16 = indexable[_e14];\n    vNdc = _e16;\n    let _e17 = vNdc;\n    unnamed.gl_Position = vec4<f32>(_e17.x, _e17.y, 0f, 1f);\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32) -> VertexOutput {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    main_1();\n    let _e7 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e7);\n    let _e9 = vNdc;\n    let _e10 = unnamed.gl_Position;\n    return VertexOutput(_e9, _e10);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SKY_BINDINGS = {
  "SKY_FRAG": {
    "uniforms": 1,
    "uniformSize": 240,
    "fields": {
      "uInvViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uTopColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uHorizonColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uDeepColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uSunDir": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      },
      "uSunColor": {
        "offset": 144,
        "size": 12,
        "type": "vec3"
      },
      "uSunDiscExponent": {
        "offset": 156,
        "size": 4,
        "type": "float"
      },
      "uMoonDir": {
        "offset": 160,
        "size": 12,
        "type": "vec3"
      },
      "uMoonColor": {
        "offset": 176,
        "size": 12,
        "type": "vec3"
      },
      "uMoonAngularRadius": {
        "offset": 188,
        "size": 4,
        "type": "float"
      },
      "uMoonPhase": {
        "offset": 192,
        "size": 4,
        "type": "float"
      },
      "uNightFactor": {
        "offset": 196,
        "size": 4,
        "type": "float"
      },
      "uCloudOffset": {
        "offset": 200,
        "size": 8,
        "type": "vec2"
      },
      "uUnderwaterColor": {
        "offset": 208,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 220,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 224,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 228,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "SKY_VERT": {
    "uniforms": null,
    "textures": {}
  }
} as const;
