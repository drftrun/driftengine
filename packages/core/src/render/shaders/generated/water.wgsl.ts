/*
 * Generated from ../water.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const WATER_FRAG_WGSL = "struct Uniforms {\n    uGridHalf: vec2<f32>,\n    uFoamGain: f32,\n    uNadirOpacity: f32,\n    uVisibility: f32,\n    uMirror: f32,\n    uDeepColor: vec3<f32>,\n    uShallowColor: vec3<f32>,\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uLightCount: i32,\n    uLightPos: array<vec3<f32>, 16>,\n    uLightColor: array<vec3<f32>, 16>,\n    uLightRadius: array<vec4<f32>, 16>,\n    uLightWeight: array<vec4<f32>, 16>,\n    uLightFalloff: i32,\n    uLightCone: array<vec4<f32>, 16>,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uCameraPos: vec3<f32>,\n    uReflectionEnabled: i32,\n    uReflectionTexelSize: vec2<f32>,\n    uReflectionFilterTaps: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vCrest_1: f32;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vGrid_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e122 = unnamed.uFogMode;\n    if (_e122 == 1i) {\n        let _e125 = unnamed.uFogFar;\n        let _e127 = unnamed.uFogNear;\n        span = max((_e125 - _e127), 0.0001f);\n        let _e130 = (*dist);\n        let _e132 = unnamed.uFogNear;\n        let _e134 = span;\n        ramp = clamp(((_e130 - _e132) / _e134), 0f, 1f);\n        let _e138 = unnamed.uUnderwaterFactor;\n        if (_e138 <= 0f) {\n            let _e140 = ramp;\n            return _e140;\n        }\n        let _e142 = unnamed.uUnderwaterFogDensity;\n        let _e143 = (*dist);\n        wetLinear = (_e142 * _e143);\n        let _e145 = ramp;\n        let _e146 = wetLinear;\n        let _e148 = wetLinear;\n        let _e154 = unnamed.uUnderwaterFactor;\n        return mix(_e145, (1f - exp2(((-(_e146) * _e148) * 1.442695f))), _e154);\n    }\n    let _e157 = unnamed.uFogNear;\n    let _e158 = (*dist);\n    start = min(_e157, _e158);\n    let _e160 = (*dist);\n    if (_e160 > 0f) {\n        let _e162 = start;\n        let _e163 = (*dist);\n        local = (_e162 / _e163);\n    } else {\n        local = 0f;\n    }\n    let _e165 = local;\n    before = _e165;\n    let _e166 = (*pointY);\n    let _e168 = unnamed.uFogEyeY;\n    let _e171 = unnamed.uFogHeightFalloff;\n    t = ((_e166 - _e168) * _e171);\n    let _e173 = t;\n    let _e174 = before;\n    rest = (_e173 * (1f - _e174));\n    let _e177 = rest;\n    let _e180 = rest;\n    denom = select(_e180, 0.0001f, (abs(_e177) < 0.0001f));\n    let _e183 = unnamed.uFogDensity;\n    let _e185 = t;\n    let _e187 = before;\n    let _e191 = (*dist);\n    let _e192 = start;\n    let _e195 = denom;\n    let _e200 = denom;\n    air = (1f - exp(((((-(_e183) * exp((-(_e185) * _e187))) * (_e191 - _e192)) * (1f - exp(-(_e195)))) / _e200)));\n    let _e205 = unnamed.uUnderwaterFactor;\n    if (_e205 <= 0f) {\n        let _e207 = air;\n        return _e207;\n    }\n    let _e209 = unnamed.uUnderwaterFogDensity;\n    let _e210 = (*dist);\n    wet = (_e209 * _e210);\n    let _e212 = air;\n    let _e213 = wet;\n    let _e215 = wet;\n    let _e221 = unnamed.uUnderwaterFactor;\n    return mix(_e212, (1f - exp2(((-(_e213) * _e215) * 1.442695f))), _e221);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e109 = unnamed.uFogColor;\n    let _e111 = unnamed.uUnderwaterColor;\n    let _e113 = unnamed.uUnderwaterFactor;\n    return mix(_e109, _e111, vec3(_e113));\n}\n\nfn main_1() {\n    var n: vec3<f32>;\n    var view: vec3<f32>;\n    var facing: f32;\n    var fresnel: f32;\n    var atmosphereColor: vec3<f32>;\n    var col: vec3<f32>;\n    var incident: vec3<f32>;\n    var halfVec: vec3<f32>;\n    var spec: f32;\n    var highlight: vec3<f32>;\n    var i: i32;\n    var toLight: vec3<f32>;\n    var lightDist: f32;\n    var exponent: f32;\n    var reach: f32;\n    var falloff: f32;\n    var window: f32;\n    var lightDir: vec3<f32>;\n    var shaped: f32;\n    var lampHalf: vec3<f32>;\n    var foam: f32;\n    var dist_1: f32;\n    var fog: f32;\n    var param: f32;\n    var param_1: f32;\n    var airOpacity: f32;\n    var underwaterOpacity: f32;\n    var opacity: f32;\n    var reflected: vec3<f32>;\n    var reflectionValid: f32;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var blurPixels: f32;\n    var sceneReflection: vec3<f32>;\n    var filterWeight: f32;\n    var i_1: i32;\n    var sampleUv: vec2<f32>;\n    var indexable: array<vec2<f32>, 9>;\n    var weight: f32;\n    var indexable_1: array<f32, 9>;\n    var sceneWeight: f32;\n    var reflectionGain: f32;\n    var reflectivity: f32;\n    var reflectedRadiance: f32;\n    var reflectionWeight: f32;\n    var rimFraction: vec2<f32>;\n    var rimT: f32;\n    var rim: f32;\n    var edge: f32;\n    var phi_495_: bool;\n\n    let _e157 = vNormal_1;\n    n = normalize(_e157);\n    let _e160 = unnamed.uCameraPos;\n    let _e161 = vWorldPos_1;\n    view = normalize((_e160 - _e161));\n    let _e164 = n;\n    let _e165 = view;\n    facing = clamp(abs(dot(_e164, _e165)), 0f, 1f);\n    let _e169 = facing;\n    fresnel = (0.02f + (0.98f * pow((1f - _e169), 5f)));\n    let _e174 = mediumColor_u0028_();\n    atmosphereColor = _e174;\n    let _e176 = unnamed.uDeepColor;\n    let _e178 = unnamed.uShallowColor;\n    let _e179 = vCrest_1;\n    col = mix(_e176, _e178, vec3(clamp(((_e179 * 1.4f) + 0.4f), 0f, 1f)));\n    let _e186 = unnamed.uAmbient;\n    let _e188 = unnamed.uDirectionalColor;\n    let _e189 = n;\n    let _e191 = unnamed.uDirectionalDir;\n    incident = (_e186 + ((_e188 * max(dot(_e189, _e191), 0f)) * 0.6f));\n    let _e198 = unnamed.uDirectionalDir;\n    let _e199 = view;\n    halfVec = normalize((_e198 + _e199));\n    let _e202 = n;\n    let _e203 = halfVec;\n    spec = pow(max(dot(_e202, _e203), 0f), 220f);\n    let _e208 = unnamed.uDirectionalColor;\n    let _e209 = spec;\n    highlight = ((_e208 * _e209) * 1.6f);\n    i = 0i;\n    loop {\n        let _e212 = i;\n        if (_e212 < 16i) {\n            let _e214 = i;\n            let _e216 = unnamed.uLightCount;\n            if (_e214 >= _e216) {\n                break;\n            }\n            let _e218 = i;\n            let _e221 = unnamed.uLightPos[_e218];\n            let _e222 = vWorldPos_1;\n            toLight = (_e221 - _e222);\n            let _e224 = toLight;\n            lightDist = length(_e224);\n            let _e226 = i;\n            let _e230 = unnamed.uLightCone[_e226][2u];\n            exponent = _e230;\n            let _e231 = exponent;\n            if (_e231 > 0f) {\n                let _e233 = lightDist;\n                let _e234 = i;\n                let _e238 = unnamed.uLightRadius[_e234][0u];\n                reach = (_e233 / max(_e238, 0.0001f));\n                let _e241 = reach;\n                let _e242 = reach;\n                let _e246 = exponent;\n                falloff = pow(clamp((1f - (_e241 * _e242)), 0f, 1f), _e246);\n            } else {\n                let _e249 = unnamed.uLightFalloff;\n                if (_e249 == 1i) {\n                    let _e251 = lightDist;\n                    let _e252 = i;\n                    let _e256 = unnamed.uLightRadius[_e252][0u];\n                    window = clamp((1f - pow((_e251 / max(_e256, 0.0001f)), 4f)), 0f, 1f);\n                    let _e262 = window;\n                    let _e263 = window;\n                    let _e265 = lightDist;\n                    let _e266 = lightDist;\n                    falloff = ((_e262 * _e263) / max((_e265 * _e266), 0.01f));\n                } else {\n                    let _e270 = lightDist;\n                    let _e271 = i;\n                    let _e275 = unnamed.uLightRadius[_e271][0u];\n                    falloff = clamp((1f - (_e270 / max(_e275, 0.0001f))), 0f, 1f);\n                }\n            }\n            let _e280 = falloff;\n            if (_e280 <= 0f) {\n                continue;\n            }\n            let _e282 = toLight;\n            let _e283 = lightDist;\n            lightDir = (_e282 / vec3(max(_e283, 0.0001f)));\n            let _e287 = falloff;\n            let _e288 = i;\n            let _e292 = unnamed.uLightWeight[_e288][0u];\n            shaped = (_e287 * _e292);\n            let _e294 = i;\n            let _e297 = unnamed.uLightColor[_e294];\n            let _e298 = n;\n            let _e299 = lightDir;\n            let _e303 = shaped;\n            let _e306 = incident;\n            incident = (_e306 + (((_e297 * max(dot(_e298, _e299), 0f)) * _e303) * 0.6f));\n            let _e308 = lightDir;\n            let _e309 = view;\n            lampHalf = normalize((_e308 + _e309));\n            let _e312 = i;\n            let _e315 = unnamed.uLightColor[_e312];\n            let _e316 = n;\n            let _e317 = lampHalf;\n            let _e322 = shaped;\n            let _e325 = highlight;\n            highlight = (_e325 + (((_e315 * pow(max(dot(_e316, _e317), 0f), 220f)) * _e322) * 1.6f));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e327 = i;\n            i = (_e327 + 1i);\n        }\n    }\n    let _e329 = incident;\n    let _e330 = col;\n    col = (_e330 * _e329);\n    let _e332 = highlight;\n    let _e333 = col;\n    col = (_e333 + _e332);\n    let _e335 = vCrest_1;\n    let _e338 = unnamed.uFoamGain;\n    foam = (smoothstep(0.55f, 0.85f, _e335) * _e338);\n    let _e340 = col;\n    let _e341 = foam;\n    col = mix(_e340, vec3<f32>(0.92f, 0.96f, 1f), vec3((_e341 * 0.5f)));\n    let _e345 = vWorldPos_1;\n    let _e347 = unnamed.uCameraPos;\n    dist_1 = distance(_e345, _e347);\n    let _e349 = dist_1;\n    param = _e349;\n    let _e351 = vWorldPos_1[1u];\n    param_1 = _e351;\n    let _e352 = mediumFog_u0028_f1_u003b_f1_u003b((&param), (&param_1));\n    fog = _e352;\n    let _e353 = col;\n    let _e354 = atmosphereColor;\n    let _e355 = fog;\n    col = mix(_e353, _e354, vec3(_e355));\n    let _e359 = unnamed.uNadirOpacity;\n    let _e360 = fresnel;\n    airOpacity = mix(_e359, 0.96f, _e360);\n    let _e363 = unnamed.uNadirOpacity;\n    let _e365 = fresnel;\n    underwaterOpacity = mix((_e363 * 0.55f), 0.88f, _e365);\n    let _e367 = airOpacity;\n    let _e368 = underwaterOpacity;\n    let _e370 = unnamed.uUnderwaterFactor;\n    opacity = mix(_e367, _e368, _e370);\n    let _e372 = opacity;\n    let _e373 = foam;\n    opacity = mix(_e372, 0.96f, (_e373 * 0.7f));\n    let _e376 = atmosphereColor;\n    reflected = _e376;\n    reflectionValid = 0f;\n    let _e378 = unnamed.uReflectionEnabled;\n    let _e379 = (_e378 != 0i);\n    phi_495_ = _e379;\n    if _e379 {\n        let _e381 = vReflectionClip_1[3u];\n        phi_495_ = (_e381 > 0f);\n    }\n    let _e384 = phi_495_;\n    if _e384 {\n        let _e385 = vReflectionClip_1;\n        let _e388 = vReflectionClip_1[3u];\n        reflectionUv = (((_e385.xy / vec2(_e388)) * 0.5f) + vec2(0.5f));\n        let _e394 = n;\n        let _e396 = fresnel;\n        let _e399 = reflectionUv;\n        reflectionUv = (_e399 + (_e394.xz * mix(0.008f, 0.022f, _e396)));\n        let _e401 = reflectionUv;\n        let _e402 = reflectionUv;\n        border = min(_e401, (vec2(1f) - _e402));\n        let _e407 = border[0u];\n        let _e409 = border[1u];\n        reflectionValid = smoothstep(0f, 0.025f, min(_e407, _e409));\n        let _e412 = dist_1;\n        blurPixels = (1.35f + min((_e412 * 0.022f), 3.5f));\n        sceneReflection = vec3<f32>(0f, 0f, 0f);\n        filterWeight = 0f;\n        i_1 = 0i;\n        loop {\n            let _e416 = i_1;\n            if (_e416 < 9i) {\n                let _e418 = i_1;\n                let _e420 = unnamed.uReflectionFilterTaps;\n                if (_e418 >= _e420) {\n                    break;\n                }\n                let _e422 = reflectionUv;\n                let _e423 = i_1;\n                indexable = array<vec2<f32>, 9>(vec2<f32>(0f, 0f), vec2<f32>(-0.62f, -0.31f), vec2<f32>(0.54f, 0.43f), vec2<f32>(-0.34f, 0.76f), vec2<f32>(0.78f, -0.57f), vec2<f32>(-0.88f, 0.28f), vec2<f32>(0.22f, -0.91f), vec2<f32>(0.91f, 0.08f), vec2<f32>(-0.18f, 0.94f));\n                let _e425 = indexable[_e423];\n                let _e427 = unnamed.uReflectionTexelSize;\n                let _e429 = blurPixels;\n                sampleUv = (_e422 + ((_e425 * _e427) * _e429));\n                let _e432 = i_1;\n                indexable_1 = array<f32, 9>(0.28f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f, 0.09f);\n                let _e434 = indexable_1[_e432];\n                weight = _e434;\n                let _e435 = sampleUv;\n                let _e439 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e435, vec2(0f), vec2(1f)), 0f);\n                let _e441 = weight;\n                let _e443 = sceneReflection;\n                sceneReflection = (_e443 + (_e439.xyz * _e441));\n                let _e445 = weight;\n                let _e446 = filterWeight;\n                filterWeight = (_e446 + _e445);\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e448 = i_1;\n                i_1 = (_e448 + 1i);\n            }\n        }\n        let _e450 = filterWeight;\n        let _e452 = sceneReflection;\n        sceneReflection = (_e452 / vec3(max(_e450, 0.001f)));\n        let _e455 = atmosphereColor;\n        let _e456 = sceneReflection;\n        let _e457 = reflectionValid;\n        reflected = mix(_e455, _e456, vec3(_e457));\n    }\n    let _e461 = unnamed.uReflectionEnabled;\n    let _e463 = reflectionValid;\n    sceneWeight = (f32(_e461) * _e463);\n    let _e465 = sceneWeight;\n    reflectionGain = mix(0.75f, 0.94f, _e465);\n    let _e467 = fresnel;\n    let _e469 = unnamed.uMirror;\n    reflectivity = mix(_e467, 1f, _e469);\n    let _e471 = reflectivity;\n    let _e472 = reflectionGain;\n    let _e474 = foam;\n    let _e478 = opacity;\n    reflectedRadiance = min(((_e471 * _e472) * (1f - (_e474 * 0.8f))), _e478);\n    let _e480 = reflectedRadiance;\n    let _e481 = opacity;\n    reflectionWeight = (_e480 / max(_e481, 0.001f));\n    let _e484 = col;\n    let _e485 = reflected;\n    let _e486 = reflectionWeight;\n    col = mix(_e484, _e485, vec3(_e486));\n    let _e489 = vGrid_1;\n    let _e492 = unnamed.uGridHalf;\n    rimFraction = (abs(_e489) / max(_e492, vec2<f32>(0.001f, 0.001f)));\n    let _e496 = rimFraction[0u];\n    let _e498 = rimFraction[1u];\n    rimT = max(_e496, _e498);\n    let _e500 = rimT;\n    rim = (1f - smoothstep(0.9f, 1f, _e500));\n    let _e503 = fog;\n    edge = (1f - smoothstep(0.82f, 1f, _e503));\n    let _e506 = col;\n    let _e507 = opacity;\n    let _e508 = edge;\n    let _e510 = rim;\n    let _e513 = unnamed.uVisibility;\n    outColor = vec4<f32>(_e506.x, _e506.y, _e506.z, (((_e507 * _e508) * _e510) * _e513));\n    return;\n}\n\n@fragment \nfn main(@location(1) vNormal: vec3<f32>, @location(0) vWorldPos: vec3<f32>, @location(2) vCrest: f32, @location(3) vReflectionClip: vec4<f32>, @location(4) vGrid: vec2<f32>) -> @location(0) vec4<f32> {\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    vCrest_1 = vCrest;\n    vReflectionClip_1 = vReflectionClip;\n    vGrid_1 = vGrid;\n    main_1();\n    let _e11 = outColor;\n    return _e11;\n}\n";

export const WATER_VERT_WGSL = "struct GerstnerSurface {\n    offset: vec3<f32>,\n    normal: vec3<f32>,\n    crest: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uGridOrigin: vec2<f32>,\n    uGridSpan: vec2<f32>,\n    uGridHalf: vec2<f32>,\n    uNearHalf: vec2<f32>,\n    uGridForward: vec2<f32>,\n    uWindDir: vec2<f32>,\n    uWaveGain: f32,\n    uWaterLevel: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(4) member: vec2<f32>,\n    @location(0) member_1: vec3<f32>,\n    @location(1) member_2: vec3<f32>,\n    @location(2) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aGrid_1: vec2<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> vGrid: vec2<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> vCrest: f32;\nvar<private> vReflectionClip: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b(k: ptr<function, f32>, dir: ptr<function, vec2<f32>>, p: ptr<function, vec2<f32>>, time: ptr<function, f32>) -> f32 {\n    var c: f32;\n\n    let _e59 = (*k);\n    c = sqrt((9.81f / _e59));\n    let _e62 = (*k);\n    let _e63 = (*dir);\n    let _e64 = (*p);\n    let _e66 = c;\n    let _e67 = (*time);\n    return (_e62 * (dot(_e63, _e64) - (_e66 * _e67)));\n}\n\nfn gerstnerWavenumber_u0028_i1_u003b(i: ptr<function, i32>) -> f32 {\n    var indexable: array<vec4<f32>, 4>;\n\n    let _e56 = (*i);\n    indexable = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable[_e56][3u];\n    return (6.2831855f / _e59);\n}\n\nfn gerstnerDirection_u0028_i1_u003b_vf2_u003b(i_1: ptr<function, i32>, windDir: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var indexable_1: array<vec4<f32>, 4>;\n\n    let _e57 = (*i_1);\n    indexable_1 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e59 = indexable_1[_e57];\n    let _e62 = (*windDir);\n    return normalize(mix(normalize(_e59.xy), _e62, vec2(0.62f)));\n}\n\nfn gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b(p_1: ptr<function, vec2<f32>>, time_1: ptr<function, f32>, windDir_1: ptr<function, vec2<f32>>, gain: ptr<function, f32>) -> GerstnerSurface {\n    var s: GerstnerSurface;\n    var i_2: i32;\n    var dir_1: vec2<f32>;\n    var param: i32;\n    var param_1: vec2<f32>;\n    var steepness: f32;\n    var indexable_2: array<vec4<f32>, 4>;\n    var k_1: f32;\n    var param_2: i32;\n    var f: f32;\n    var param_3: f32;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n    var a: f32;\n\n    s.offset = vec3<f32>(0f, 0f, 0f);\n    s.normal = vec3<f32>(0f, 1f, 0f);\n    s.crest = 0f;\n    i_2 = 0i;\n    loop {\n        let _e76 = i_2;\n        if (_e76 < 4i) {\n            let _e78 = i_2;\n            param = _e78;\n            let _e79 = (*windDir_1);\n            param_1 = _e79;\n            let _e80 = gerstnerDirection_u0028_i1_u003b_vf2_u003b((&param), (&param_1));\n            dir_1 = _e80;\n            let _e81 = i_2;\n            indexable_2 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n            let _e84 = indexable_2[_e81][2u];\n            let _e85 = (*gain);\n            steepness = (_e84 * _e85);\n            let _e87 = i_2;\n            param_2 = _e87;\n            let _e88 = gerstnerWavenumber_u0028_i1_u003b((&param_2));\n            k_1 = _e88;\n            let _e89 = k_1;\n            param_3 = _e89;\n            let _e90 = dir_1;\n            param_4 = _e90;\n            let _e91 = (*p_1);\n            param_5 = _e91;\n            let _e92 = (*time_1);\n            param_6 = _e92;\n            let _e93 = gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b((&param_3), (&param_4), (&param_5), (&param_6));\n            f = _e93;\n            let _e94 = steepness;\n            let _e95 = k_1;\n            a = (_e94 / _e95);\n            let _e98 = dir_1[0u];\n            let _e99 = a;\n            let _e101 = f;\n            let _e106 = s.offset[0u];\n            s.offset[0u] = (_e106 + ((_e98 * _e99) * cos(_e101)));\n            let _e110 = a;\n            let _e111 = f;\n            let _e116 = s.offset[1u];\n            s.offset[1u] = (_e116 + (_e110 * sin(_e111)));\n            let _e121 = dir_1[1u];\n            let _e122 = a;\n            let _e124 = f;\n            let _e129 = s.offset[2u];\n            s.offset[2u] = (_e129 + ((_e121 * _e122) * cos(_e124)));\n            let _e134 = dir_1[0u];\n            let _e135 = steepness;\n            let _e137 = f;\n            let _e142 = s.normal[0u];\n            s.normal[0u] = (_e142 - ((_e134 * _e135) * cos(_e137)));\n            let _e147 = dir_1[1u];\n            let _e148 = steepness;\n            let _e150 = f;\n            let _e155 = s.normal[2u];\n            s.normal[2u] = (_e155 - ((_e147 * _e148) * cos(_e150)));\n            let _e159 = steepness;\n            let _e160 = f;\n            let _e165 = s.normal[1u];\n            s.normal[1u] = (_e165 - (_e159 * sin(_e160)));\n            let _e169 = f;\n            let _e171 = steepness;\n            let _e174 = s.crest;\n            s.crest = (_e174 + (sin(_e169) * _e171));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e177 = i_2;\n            i_2 = (_e177 + 1i);\n        }\n    }\n    let _e179 = s;\n    return _e179;\n}\n\nfn main_1() {\n    var grid: vec2<f32>;\n    var rimFraction: vec2<f32>;\n    var rimDistance: f32;\n    var waveFade: f32;\n    var laid: vec2<f32>;\n    var base: vec3<f32>;\n    var sea: GerstnerSurface;\n    var param_7: vec2<f32>;\n    var param_8: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var pos: vec3<f32>;\n\n    let _e66 = aGrid_1;\n    let _e68 = unnamed.uGridSpan;\n    grid = (_e66 * _e68);\n    let _e70 = grid;\n    vGrid = _e70;\n    let _e71 = grid;\n    let _e74 = unnamed.uNearHalf;\n    rimFraction = (abs(_e71) / max(_e74, vec2<f32>(0.0001f, 0.0001f)));\n    let _e78 = rimFraction[0u];\n    let _e80 = rimFraction[1u];\n    rimDistance = max(_e78, _e80);\n    let _e82 = rimDistance;\n    waveFade = (1f - smoothstep(0.35f, 0.97f, _e82));\n    let _e87 = unnamed.uGridForward[1u];\n    let _e90 = unnamed.uGridForward[0u];\n    let _e94 = grid[0u];\n    let _e97 = unnamed.uGridForward;\n    let _e99 = grid[1u];\n    laid = ((vec2<f32>(_e87, -(_e90)) * _e94) + (_e97 * _e99));\n    let _e104 = unnamed.uGridOrigin[0u];\n    let _e106 = laid[0u];\n    let _e109 = unnamed.uWaterLevel;\n    let _e112 = unnamed.uGridOrigin[1u];\n    let _e114 = laid[1u];\n    base = vec3<f32>((_e104 + _e106), _e109, (_e112 + _e114));\n    let _e117 = waveFade;\n    let _e119 = unnamed.uWaveGain;\n    let _e121 = base;\n    param_7 = _e121.xz;\n    let _e124 = unnamed.uTime;\n    param_8 = _e124;\n    let _e126 = unnamed.uWindDir;\n    param_9 = _e126;\n    param_10 = (_e117 * _e119);\n    let _e127 = gerstnerSurface_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b((&param_7), (&param_8), (&param_9), (&param_10));\n    sea = _e127;\n    let _e128 = base;\n    let _e130 = sea.offset;\n    pos = (_e128 + _e130);\n    let _e132 = pos;\n    vWorldPos = _e132;\n    let _e134 = sea.normal;\n    vNormal = normalize(_e134);\n    let _e137 = sea.crest;\n    vCrest = _e137;\n    let _e139 = unnamed.uReflectionViewProj;\n    let _e140 = pos;\n    vReflectionClip = (_e139 * vec4<f32>(_e140.x, _e140.y, _e140.z, 1f));\n    let _e147 = unnamed.uViewProj;\n    let _e148 = pos;\n    unnamed_1.gl_Position = (_e147 * vec4<f32>(_e148.x, _e148.y, _e148.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aGrid: vec2<f32>) -> VertexOutput {\n    aGrid_1 = aGrid;\n    main_1();\n    let _e10 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e10);\n    let _e12 = vGrid;\n    let _e13 = vWorldPos;\n    let _e14 = vNormal;\n    let _e15 = vCrest;\n    let _e16 = vReflectionClip;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e12, _e13, _e14, _e15, _e16, _e17);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const WATER_BINDINGS = {
  "WATER_FRAG": {
    "uniforms": 1,
    "uniformSize": 1504,
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
