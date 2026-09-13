/*
 * Generated from ../water.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const WATER_FRAG_WGSL = "struct Uniforms {\n    uGridHalf: vec2<f32>,\n    uFoamGain: f32,\n    uNadirOpacity: f32,\n    uVisibility: f32,\n    uMirror: f32,\n    uDeepColor: vec3<f32>,\n    uShallowColor: vec3<f32>,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uLightFalloff: i32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uCameraPos: vec3<f32>,\n    uReflectionEnabled: i32,\n    uReflectionTexelSize: vec2<f32>,\n    uReflectionFilterTaps: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vCrest_1: f32;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vGrid_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var t: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e116 = unnamed.uFogMode;\n    if (_e116 == 1i) {\n        let _e119 = unnamed.uFogFar;\n        let _e121 = unnamed.uFogNear;\n        span = max((_e119 - _e121), 0.0001f);\n        let _e124 = (*dist);\n        let _e126 = unnamed.uFogNear;\n        let _e128 = span;\n        ramp = clamp(((_e124 - _e126) / _e128), 0f, 1f);\n        let _e132 = unnamed.uUnderwaterFactor;\n        if (_e132 <= 0f) {\n            let _e134 = ramp;\n            return _e134;\n        }\n        let _e136 = unnamed.uUnderwaterFogDensity;\n        let _e137 = (*dist);\n        wetLinear = (_e136 * _e137);\n        let _e139 = ramp;\n        let _e140 = wetLinear;\n        let _e142 = wetLinear;\n        let _e148 = unnamed.uUnderwaterFactor;\n        return mix(_e139, (1f - exp2(((-(_e140) * _e142) * 1.442695f))), _e148);\n    }\n    let _e150 = (*pointY);\n    let _e152 = unnamed.uFogEyeY;\n    let _e155 = unnamed.uFogHeightFalloff;\n    t = ((_e150 - _e152) * _e155);\n    let _e157 = t;\n    let _e160 = t;\n    denom = select(_e160, 0.0001f, (abs(_e157) < 0.0001f));\n    let _e163 = unnamed.uFogDensity;\n    let _e165 = (*dist);\n    let _e167 = denom;\n    let _e172 = denom;\n    air = (1f - exp((((-(_e163) * _e165) * (1f - exp(-(_e167)))) / _e172)));\n    let _e177 = unnamed.uUnderwaterFactor;\n    if (_e177 <= 0f) {\n        let _e179 = air;\n        return _e179;\n    }\n    let _e181 = unnamed.uUnderwaterFogDensity;\n    let _e182 = (*dist);\n    wet = (_e181 * _e182);\n    let _e184 = air;\n    let _e185 = wet;\n    let _e187 = wet;\n    let _e193 = unnamed.uUnderwaterFactor;\n    return mix(_e184, (1f - exp2(((-(_e185) * _e187) * 1.442695f))), _e193);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e107 = unnamed.uFogColor;\n    let _e109 = unnamed.uUnderwaterColor;\n    let _e111 = unnamed.uUnderwaterFactor;\n    return mix(_e107, _e109, vec3(_e111));\n}\n\nfn main_1() {\n    var n: vec3<f32>;\n    var view: vec3<f32>;\n    var facing: f32;\n    var fresnel: f32;\n    var atmosphereColor: vec3<f32>;\n    var col: vec3<f32>;\n    var incident: vec3<f32>;\n    var halfVec: vec3<f32>;\n    var spec: f32;\n    var highlight: vec3<f32>;\n    var i: i32;\n    var toLight: vec3<f32>;\n    var lightDist: f32;\n    var window: f32;\n    var falloff: f32;\n    var lightDir: vec3<f32>;\n    var shaped: f32;\n    var lampHalf: vec3<f32>;\n    var foam: f32;\n    var dist_1: f32;\n    var fog: f32;\n    var param: f32;\n    var param_1: f32;\n    var airOpacity: f32;\n    var underwaterOpacity: f32;\n    var opacity: f32;\n    var reflected: vec3<f32>;\n    var reflectionValid: f32;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var blurPixels: f32;\n    var sceneReflection: vec3<f32>;\n    var filterWeight: f32;\n    var i_1: i32;\n    var sampleUv: vec2<f32>;\n    var indexable: array<vec2<f32>, 9>;\n    var weight: f32;\n    var indexable_1: array<f32, 9>;\n    var sceneWeight: f32;\n    var reflectionGain: f32;\n    var reflectivity: f32;\n    var reflectedRadiance: f32;\n    var reflectionWeight: f32;\n    var rimFraction: vec2<f32>;\n    var rimT: f32;\n    var rim: f32;\n    var edge: f32;\n    var phi_440_: bool;\n\n    let _e153 = vNormal_1;\n    n = normalize(_e153);\n    let _e156 = unnamed.uCameraPos;\n    let _e157 = vWorldPos_1;\n    view = normalize((_e156 - _e157));\n    let _e160 = n;\n    let _e161 = view;\n    facing = clamp(abs(dot(_e160, _e161)), 0f, 1f);\n    let _e165 = facing;\n    fresnel = (0.02f + (0.98f * pow((1f - _e165), 5f)));\n    let _e170 = mediumColor_u0028_();\n    atmosphereColor = _e170;\n    let _e172 = unnamed.uDeepColor;\n    let _e174 = unnamed.uShallowColor;\n    let _e175 = vCrest_1;\n    col = mix(_e172, _e174, vec3(clamp(((_e175 * 1.4f) + 0.4f), 0f, 1f)));\n    let _e182 = unnamed.uAmbient;\n    let _e184 = unnamed.uDirectionalColor;\n    let _e185 = n;\n    let _e187 = unnamed.uDirectionalDir;\n    incident = (_e182 + ((_e184 * max(dot(_e185, _e187), 0f)) * 0.6f));\n    let _e194 = unnamed.uDirectionalDir;\n    let _e195 = view;\n    halfVec = normalize((_e194 + _e195));\n    let _e198 = n;\n    let _e199 = halfVec;\n    spec = pow(max(dot(_e198, _e199), 0f), 220f);\n    let _e204 = unnamed.uDirectionalColor;\n    let _e205 = spec;\n    highlight = ((_e204 * _e205) * 1.6f);\n    i = 0i;\n    loop {\n        let _e208 = i;\n        if (_e208 < 16i) {\n            let _e210 = i;\n            let _e212 = unnamed.uLightCount;\n            if (_e210 >= _e212) {\n                break;\n            }\n            let _e214 = i;\n            let _e217 = unnamed.uLightPos[_e214];\n            let _e218 = vWorldPos_1;\n            toLight = (_e217 - _e218);\n            let _e220 = toLight;\n            lightDist = length(_e220);\n            let _e223 = unnamed.uLightFalloff;\n            if (_e223 == 1i) {\n                let _e225 = lightDist;\n                let _e226 = i;\n                let _e230 = unnamed.uLightRadius[_e226][0u];\n                window = clamp((1f - pow((_e225 / max(_e230, 0.0001f)), 4f)), 0f, 1f);\n                let _e236 = window;\n                let _e237 = window;\n                let _e239 = lightDist;\n                let _e240 = lightDist;\n                falloff = ((_e236 * _e237) / max((_e239 * _e240), 0.01f));\n            } else {\n                let _e244 = lightDist;\n                let _e245 = i;\n                let _e249 = unnamed.uLightRadius[_e245][0u];\n                falloff = clamp((1f - (_e244 / max(_e249, 0.0001f))), 0f, 1f);\n            }\n            let _e254 = falloff;\n            if (_e254 <= 0f) {\n                continue;\n            }\n            let _e256 = toLight;\n            let _e257 = lightDist;\n            lightDir = (_e256 / vec3(max(_e257, 0.0001f)));\n            let _e261 = falloff;\n            let _e262 = i;\n            let _e266 = unnamed.uLightWeight[_e262][0u];\n            shaped = (_e261 * _e266);\n            let _e268 = i;\n            let _e271 = unnamed.uLightColor[_e268];\n            let _e272 = n;\n            let _e273 = lightDir;\n            let _e277 = shaped;\n            let _e280 = incident;\n            incident = (_e280 + (((_e271 * max(dot(_e272, _e273), 0f)) * _e277) * 0.6f));\n            let _e282 = lightDir;\n            let _e283 = view;\n            lampHalf = normalize((_e282 + _e283));\n            let _e286 = i;\n            let _e289 = unnamed.uLightColor[_e286];\n            let _e290 = n;\n            let _e291 = lampHalf;\n            let _e296 = shaped;\n            let _e299 = highlight;\n            highlight = (_e299 + (((_e289 * pow(max(dot(_e290, _e291), 0f), 220f)) * _e296) * 1.6f));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e301 = i;\n            i = (_e301 + 1i);\n        }\n    }\n    let _e303 = incident;\n    let _e304 = col;\n    col = (_e304 * _e303);\n    let _e306 = highlight;\n    let _e307 = col;\n    col = (_e307 + _e306);\n    let _e309 = vCrest_1;\n    let _e312 = unnamed.uFoamGain;\n    foam = (smoothstep(0.55f, 0.85f, _e309) * _e312);\n    let _e314 = col;\n    let _e315 = foam;\n    col = mix(_e314, vec3<f32>(0.92f, 0.96f, 1f), vec3((_e315 * 0.5f)));\n    let _e319 = vWorldPos_1;\n    let _e321 = unnamed.uCameraPos;\n    dist_1 = distance(_e319, _e321);\n    let _e323 = dist_1;\n    param = _e323;\n    let _e325 = vWorldPos_1[1u];\n    param_1 = _e325;\n    let _e326 = mediumFog_u0028_f1_u003b_f1_u003b((&param), (&param_1));\n    fog = _e326;\n    let _e327 = col;\n    let _e328 = atmosphereColor;\n    let _e329 = fog;\n    col = mix(_e327, _e328, vec3(_e329));\n    let _e333 = unnamed.uNadirOpacity;\n    let _e334 = fresnel;\n    airOpacity = mix(_e333, 0.96f, _e334);\n    let _e337 = unnamed.uNadirOpacity;\n    let _e339 = fresnel;\n    underwaterOpacity = mix((_e337 * 0.55f), 0.88f, _e339);\n    let _e341 = airOpacity;\n    let _e342 = underwaterOpacity;\n    let _e344 = unnamed.uUnderwaterFactor;\n    opacity = mix(_e341, _e342, _e344);\n    let _e346 = opacity;\n    let _e347 = foam;\n    opacity = mix(_e346, 0.96f, (_e347 * 0.7f));\n    let _e350 = atmosphereColor;\n    reflected = _e350;\n    reflectionValid = 0f;\n    let _e352 = unnamed.uReflectionEnabled;\n    let _e353 = (_e352 != 0i);\n    phi_440_ = _e353;\n    if _e353 {\n        let _e355 = vReflectionClip_1[3u];\n        phi_440_ = (_e355 > 0f);\n    }\n    let _e358 = phi_440_;\n    if _e358 {\n        let _e359 = vReflectionClip_1;\n        let _e362 = vReflectionClip_1[3u];\n        reflectionUv = (((_e359.xy / vec2(_e362)) * 0.5f) + vec2(0.5f));\n        let _e368 = n;\n        let _e370 = fresnel;\n        let _e373 = reflectionUv;\n        reflectionUv = (_e373 + (_e368.xz * mix(0.008f, 0.022f, _e370)));\n        let _e375 = reflectionUv;\n        let _e376 = reflectionUv;\n        border = min(_e375, (vec2(1f) - _e376));\n        let _e381 = border[0u];\n        let _e383 = border[1u];\n        reflectionValid = smoothstep(0f, 0.025f, min(_e381, _e383));\n        let _e386 = dist_1;\n        blurPixels = (1.35f + min((_e386 * 0.022f), 3.5f));\n        sceneReflection = vec3<f32>(0f, 0f, 0f);\n        filterWeight = 0f;\n        i_1 = 0i;\n        loop {\n            let _e390 = i_1;\n            if (_e390 < 9i) {\n                let _e392 = i_1;\n                let _e394 = unnamed.uReflectionFilterTaps;\n                if (_e392 >= _e394) {\n                    break;\n                }\n                let _e396 = reflectionUv;\n                let _e397 = i_1;\n                indexable = array<vec2<f32>, 9>(vec2<f32>(0f, 0f), vec2<f32>(-0.62f, -0.31f), vec2<f32>(0.54f, 0.43f), vec2<f32>(-0.34f, 0.76f), vec2<f32>(0.78f, -0.57f), vec2<f32>(-0.88f, 0.28f), vec2<f32>(0.22f, -0.91f), vec2<f32>(0.91f, 0.08f), vec2<f32>(-0.18f, 0.94f));\n                let _e399 = indexable[_e397];\n                let _e401 = unnamed.uReflectionTexelSize;\n                let _e403 = blurPixels;\n                sampleUv = (_e396 + ((_e399 * _e401) * _e403));\n                let _e406 = i_1;\n                indexable_1 = array<f32, 9>(0.28f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f);\n                let _e408 = indexable_1[_e406];\n                weight = _e408;\n                let _e409 = sampleUv;\n                let _e413 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e409, vec2(0f), vec2(1f)), 0f);\n                let _e415 = weight;\n                let _e417 = sceneReflection;\n                sceneReflection = (_e417 + (_e413.xyz * _e415));\n                let _e419 = weight;\n                let _e420 = filterWeight;\n                filterWeight = (_e420 + _e419);\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e422 = i_1;\n                i_1 = (_e422 + 1i);\n            }\n        }\n        let _e424 = filterWeight;\n        let _e426 = sceneReflection;\n        sceneReflection = (_e426 / vec3(max(_e424, 0.001f)));\n        let _e429 = atmosphereColor;\n        let _e430 = sceneReflection;\n        let _e431 = reflectionValid;\n        reflected = mix(_e429, _e430, vec3(_e431));\n    }\n    let _e435 = unnamed.uReflectionEnabled;\n    let _e437 = reflectionValid;\n    sceneWeight = (f32(_e435) * _e437);\n    let _e439 = sceneWeight;\n    reflectionGain = mix(0.75f, 0.94f, _e439);\n    let _e441 = fresnel;\n    let _e443 = unnamed.uMirror;\n    reflectivity = mix(_e441, 1f, _e443);\n    let _e445 = reflectivity;\n    let _e446 = reflectionGain;\n    let _e448 = foam;\n    let _e452 = opacity;\n    reflectedRadiance = min(((_e445 * _e446) * (1f - (_e448 * 0.8f))), _e452);\n    let _e454 = reflectedRadiance;\n    let _e455 = opacity;\n    reflectionWeight = (_e454 / max(_e455, 0.001f));\n    let _e458 = col;\n    let _e459 = reflected;\n    let _e460 = reflectionWeight;\n    col = mix(_e458, _e459, vec3(_e460));\n    let _e463 = vGrid_1;\n    let _e466 = unnamed.uGridHalf;\n    rimFraction = (abs(_e463) / max(_e466, vec2<f32>(0.001f, 0.001f)));\n    let _e470 = rimFraction[0u];\n    let _e472 = rimFraction[1u];\n    rimT = max(_e470, _e472);\n    let _e474 = rimT;\n    rim = (1f - smoothstep(0.9f, 1f, _e474));\n    let _e477 = fog;\n    edge = (1f - smoothstep(0.82f, 1f, _e477));\n    let _e480 = col;\n    let _e481 = opacity;\n    let _e482 = edge;\n    let _e484 = rim;\n    let _e487 = unnamed.uVisibility;\n    outColor = vec4<f32>(_e480.x, _e480.y, _e480.z, (((_e481 * _e482) * _e484) * _e487));\n    return;\n}\n\n@fragment \nfn main(@location(1) vNormal: vec3<f32>, @location(0) vWorldPos: vec3<f32>, @location(2) vCrest: f32, @location(3) vReflectionClip: vec4<f32>, @location(4) vGrid: vec2<f32>) -> @location(0) vec4<f32> {\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vCrest_1 = vCrest;\n    vReflectionClip_1 = vReflectionClip;\n    vGrid_1 = vGrid;\n    main_1();\n    let _e11 = outColor;\n    return _e11;\n}\n";

export const WATER_VERT_WGSL = "struct GerstnerSurface {\n    offset: vec3<f32>,\n    normal: vec3<f32>,\n    crest: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uGridOrigin: vec2<f32>,\n    uGridSpan: vec2<f32>,\n    uGridHalf: vec2<f32>,\n    uNearHalf: vec2<f32>,\n    uGridForward: vec2<f32>,\n    uWindDir: vec2<f32>,\n    uWaveGain: f32,\n    uWaterLevel: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(4) member: vec2<f32>,\n    @location(0) member_1: vec3<f32>,\n    @location(1) member_2: vec3<f32>,\n    @location(2) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aGrid_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> vGrid: vec2<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> vCrest: f32;\nvar<private> vReflectionClip: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b(k: ptr<function, f32>, dir: ptr<function, vec2<f32>>, p: ptr<function, vec2<f32>>, time: ptr<function, f32>) -> f32 {\n    var c: f32;\n\n    let _e59 = (*k);\n    c = sqrt((9.81f / _e59));\n    let _e62 = (*k);\n    let _e63 = (*dir);\n    let _e64 = (*p);\n    let _e66 = c;\n    let _e67 = (*time);\n    return (_e62 * (dot(_e63, _e64) - (_e66 * _e67)));\n}\n\nfn gerstnerWavenumber_u0028_i1_u003b(i: ptr<function, i32>) -> f32 {\n    var indexable: array<vec4<f32>, 4>;\n\n    let _e56 = (*i);\n    indexable = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable[_e56][3u];\n    return (6.2831855f / _e59);\n}\n\nfn gerstnerDirection_u0028_i1_u003b_vf2_u003b(i_1: ptr<function, i32>, windDir: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var indexable_1: array<vec4<f32>, 4>;\n\n    let _e57 = (*i_1);\n    indexable_1 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable_1[_e57];\n    let _e62 = (*windDir);\n    return normalize(mix(normalize(_e59.xy), _e62, vec2(0.62f)));\n}\n\nfn gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b(p_1: ptr<function, vec2<f32>>, time_1: ptr<function, f32>, windDir_1: ptr<function, vec2<f32>>, gain: ptr<function, f32>) -> GerstnerSurface {\n    var s: GerstnerSurface;\n    var i_2: i32;\n    var dir_1: vec2<f32>;\n    var param: i32;\n    var param_1: vec2<f32>;\n    var steepness: f32;\n    var indexable_2: array<vec4<f32>, 4>;\n    var k_1: f32;\n    var param_2: i32;\n    var f: f32;\n    var param_3: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n    var a: f32;\n\n    s.offset = vec3<f32>(0f, 0f, 0f);\n    s.normal = vec3<f32>(0f, 1f, 0f);\n    s.crest = 0f;\n    i_2 = 0i;\n    loop {\n        let _e76 = i_2;\n        if (_e76 < 4i) {\n            let _e78 = i_2;\n            param = _e78;\n            let _e79 = (*windDir_1);\n            param_1 = _e79;\n            let _e80 = gerstnerDirection_u0028_i1_u003b_vf2_u003b((&param), (&param_1));\n            dir_1 = _e80;\n            let _e81 = i_2;\n            indexable_2 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n            let _e84 = indexable_2[_e81][2u];\n            let _e85 = (*gain);\n            steepness = (_e84 * _e85);\n            let _e87 = i_2;\n            param_2 = _e87;\n            let _e88 = gerstnerWavenumber_u0028_i1_u003b((&param_2));\n            k_1 = _e88;\n            let _e89 = k_1;\n            param_3 = _e89;\n            let _e90 = dir_1;\n            param_4 = _e90;\n            let _e91 = (*p_1);\n            param_5 = _e91;\n            let _e92 = (*time_1);\n            param_6 = _e92;\n            let _e93 = gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b((&param_3), (&param_4), (&param_5), (&param_6));\n            f = _e93;\n            let _e94 = steepness;\n            let _e95 = k_1;\n            a = (_e94 / _e95);\n            let _e98 = dir_1[0u];\n            let _e99 = a;\n            let _e101 = f;\n            let _e106 = s.offset[0u];\n            s.offset[0u] = (_e106 + ((_e98 * _e99) * cos(_e101)));\n            let _e110 = a;\n            let _e111 = f;\n            let _e116 = s.offset[1u];\n            s.offset[1u] = (_e116 + (_e110 * sin(_e111)));\n            let _e121 = dir_1[1u];\n            let _e122 = a;\n            let _e124 = f;\n            let _e129 = s.offset[2u];\n            s.offset[2u] = (_e129 + ((_e121 * _e122) * cos(_e124)));\n            let _e134 = dir_1[0u];\n            let _e135 = steepness;\n            let _e137 = f;\n            let _e142 = s.normal[0u];\n            s.normal[0u] = (_e142 - ((_e134 * _e135) * cos(_e137)));\n            let _e147 = dir_1[1u];\n            let _e148 = steepness;\n            let _e150 = f;\n            let _e155 = s.normal[2u];\n            s.normal[2u] = (_e155 - ((_e147 * _e148) * cos(_e150)));\n            let _e159 = steepness;\n            let _e160 = f;\n            let _e165 = s.normal[1u];\n            s.normal[1u] = (_e165 - (_e159 * sin(_e160)));\n            let _e169 = f;\n            let _e171 = steepness;\n            let _e174 = s.crest;\n            s.crest = (_e174 + (sin(_e169) * _e171));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e177 = i_2;\n            i_2 = (_e177 + 1i);\n        }\n    }\n    let _e179 = s;\n    return _e179;\n}\n\nfn main_1() {\n    var grid: vec2<f32>;\n    var rimFraction: vec2<f32>;\n    var rimDistance: f32;\n    var waveFade: f32;\n    var laid: vec2<f32>;\n    var base: vec3<f32>;\n    var sea: GerstnerSurface;\n    var param_7: vec2<f32>;\n    var param_8: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var pos: vec3<f32>;\n\n    let _e66 = aGrid_1;\n    let _e68 = unnamed.uGridSpan;\n    grid = (_e66 * _e68);\n    let _e70 = grid;\n    vGrid = _e70;\n    let _e71 = grid;\n    let _e74 = unnamed.uNearHalf;\n    rimFraction = (abs(_e71) / max(_e74, vec2<f32>(0.0001f, 0.0001f)));\n    let _e78 = rimFraction[0u];\n    let _e80 = rimFraction[1u];\n    rimDistance = max(_e78, _e80);\n    let _e82 = rimDistance;\n    waveFade = (1f - smoothstep(0.35f, 0.97f, _e82));\n    let _e87 = unnamed.uGridForward[1u];\n    let _e90 = unnamed.uGridForward[0u];\n    let _e94 = grid[0u];\n    let _e97 = unnamed.uGridForward;\n    let _e99 = grid[1u];\n    laid = ((vec2<f32>(_e87, -(_e90)) * _e94) + (_e97 * _e99));\n    let _e104 = unnamed.uGridOrigin[0u];\n    let _e106 = laid[0u];\n    let _e109 = unnamed.uWaterLevel;\n    let _e112 = unnamed.uGridOrigin[1u];\n    let _e114 = laid[1u];\n    base = vec3<f32>((_e104 + _e106), _e109, (_e112 + _e114));\n    let _e117 = waveFade;\n    let _e119 = unnamed.uWaveGain;\n    let _e121 = base;\n    param_7 = _e121.xz;\n    let _e124 = unnamed.uTime;\n    param_8 = _e124;\n    let _e126 = unnamed.uWindDir;\n    param_9 = _e126;\n    param_10 = (_e117 * _e119);\n    let _e127 = gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b((&param_7), (&param_8), (&param_9), (&param_10));\n    sea = _e127;\n    let _e128 = base;\n    let _e130 = sea.offset;\n    pos = (_e128 + _e130);\n    let _e132 = pos;\n    vWorldPos = _e132;\n    let _e134 = sea.normal;\n    vNormal = normalize(_e134);\n    let _e137 = sea.crest;\n    vCrest = _e137;\n    let _e139 = unnamed.uReflectionViewProj;\n    let _e140 = pos;\n    vReflectionClip = (_e139 * vec4<f32>(_e140.x, _e140.y, _e140.z, 1f));\n    let _e147 = unnamed.uViewProj;\n    let _e148 = pos;\n    unnamed_1.gl_Position = (_e147 * vec4<f32>(_e148.x, _e148.y, _e148.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aGrid: vec2<f32>) -> VertexOutput {\n    aGrid_1 = aGrid;\n    main_1();\n    let _e10 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e10);\n    let _e12 = vGrid;\n    let _e13 = vWorldPos;\n    let _e14 = vNormal;\n    let _e15 = vCrest;\n    let _e16 = vReflectionClip;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e12, _e13, _e14, _e15, _e16, _e17);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const WATER_BINDINGS = {
  "WATER_FRAG": {
    "uniforms": 1,
    "uniformSize": 1248,
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
      "uFogColor": {
        "offset": 1152,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 1164,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 1168,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 1172,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 1184,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 1196,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 1200,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 1204,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 1208,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 1212,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 1216,
        "size": 12,
        "type": "vec3"
      },
      "uReflectionEnabled": {
        "offset": 1228,
        "size": 4,
        "type": "int"
      },
      "uReflectionTexelSize": {
        "offset": 1232,
        "size": 8,
        "type": "vec2"
      },
      "uReflectionFilterTaps": {
        "offset": 1240,
        "size": 4,
        "type": "int"
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
