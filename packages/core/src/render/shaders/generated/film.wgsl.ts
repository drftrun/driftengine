/*
 * Generated from ../film.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FILM_FRAG_WGSL = "struct Uniforms {\n    uReflectionEnabled: i32,\n    uReflectionStrength: f32,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uSheen: f32,\n    uFilmRoughness: f32,\n    uFilmRoughnessCycles: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorld_1: vec3<f32>;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vTint_1: vec3<f32>;\nvar<private> vReflectionClip_1: vec4<f32>;\n@group(0) @binding(32) \nvar uReflectionMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uReflectionMap_s: sampler;\nvar<private> vCoverage_1: f32;\nvar<private> fragColor: vec4<f32>;\n\nfn filmHash_u0028_vf3_u003b(p: ptr<function, vec3<f32>>) -> f32 {\n    let _e115 = (*p);\n    (*p) = fract((_e115 * 0.1031f));\n    let _e118 = (*p);\n    let _e119 = (*p);\n    let _e124 = (*p);\n    (*p) = (_e124 + vec3(dot(_e118, (_e119.zyx + vec3(31.32f)))));\n    let _e128 = (*p)[0u];\n    let _e130 = (*p)[1u];\n    let _e133 = (*p)[2u];\n    return fract(((_e128 + _e130) * _e133));\n}\n\nfn filmNoise_u0028_vf3_u003b(p_1: ptr<function, vec3<f32>>) -> f32 {\n    var i: vec3<f32>;\n    var f: vec3<f32>;\n    var u: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec3<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n\n    let _e126 = (*p_1);\n    i = floor(_e126);\n    let _e128 = (*p_1);\n    f = fract(_e128);\n    let _e130 = f;\n    let _e131 = f;\n    let _e133 = f;\n    u = ((_e130 * _e131) * (vec3(3f) - (_e133 * 2f)));\n    let _e138 = i;\n    param = (_e138 + vec3<f32>(0f, 0f, 0f));\n    let _e140 = filmHash_u0028_vf3_u003b((&param));\n    let _e141 = i;\n    param_1 = (_e141 + vec3<f32>(1f, 0f, 0f));\n    let _e143 = filmHash_u0028_vf3_u003b((&param_1));\n    let _e145 = u[0u];\n    let _e147 = i;\n    param_2 = (_e147 + vec3<f32>(0f, 1f, 0f));\n    let _e149 = filmHash_u0028_vf3_u003b((&param_2));\n    let _e150 = i;\n    param_3 = (_e150 + vec3<f32>(1f, 1f, 0f));\n    let _e152 = filmHash_u0028_vf3_u003b((&param_3));\n    let _e154 = u[0u];\n    let _e157 = u[1u];\n    let _e159 = i;\n    param_4 = (_e159 + vec3<f32>(0f, 0f, 1f));\n    let _e161 = filmHash_u0028_vf3_u003b((&param_4));\n    let _e162 = i;\n    param_5 = (_e162 + vec3<f32>(1f, 0f, 1f));\n    let _e164 = filmHash_u0028_vf3_u003b((&param_5));\n    let _e166 = u[0u];\n    let _e168 = i;\n    param_6 = (_e168 + vec3<f32>(0f, 1f, 1f));\n    let _e170 = filmHash_u0028_vf3_u003b((&param_6));\n    let _e171 = i;\n    param_7 = (_e171 + vec3<f32>(1f, 1f, 1f));\n    let _e173 = filmHash_u0028_vf3_u003b((&param_7));\n    let _e175 = u[0u];\n    let _e178 = u[1u];\n    let _e181 = u[2u];\n    return mix(mix(mix(_e140, _e143, _e145), mix(_e149, _e152, _e154), _e157), mix(mix(_e161, _e164, _e166), mix(_e170, _e173, _e175), _e178), _e181);\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e117 = (*c);\n    low = (_e117 * 12.92f);\n    let _e119 = (*c);\n    high = ((pow(max(_e119, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e125 = high;\n    let _e126 = low;\n    let _e127 = (*c);\n    return mix(_e125, _e126, step(_e127, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e118 = (*c_1)[0u];\n    let _e120 = (*c_1)[1u];\n    let _e122 = (*c_1)[2u];\n    m = max(_e118, max(_e120, _e122));\n    let _e125 = m;\n    if (_e125 <= 0.8f) {\n        let _e127 = (*c_1);\n        return _e127;\n    }\n    let _e128 = m;\n    e = (_e128 - 0.8f);\n    let _e130 = (*c_1);\n    let _e131 = e;\n    let _e133 = e;\n    let _e137 = m;\n    return (_e130 * ((0.8f + ((0.2f * _e131) / (_e133 + 0.2f))) / _e137));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e117 = (*v);\n    let _e118 = (*v);\n    a = ((_e117 * (_e118 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e124 = (*v);\n    let _e125 = (*v);\n    b = ((_e124 * ((_e125 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e132 = a;\n    let _e133 = b;\n    return (_e132 / _e133);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_8: vec3<f32>;\n\n    let _e117 = unnamed.uOutputExposure;\n    let _e118 = (*x);\n    (*x) = (_e118 * _e117);\n    let _e120 = (*x);\n    param_8 = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e120);\n    let _e122 = rrtAndOdtFit_u0028_vf3_u003b((&param_8));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e122), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_9: vec3<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n\n    let _e119 = unnamed.uOutputTransform;\n    if (_e119 == 0i) {\n        let _e121 = (*c_2);\n        return _e121;\n    }\n    let _e123 = unnamed.uOutputTransform;\n    if (_e123 == 2i) {\n        let _e125 = (*c_2);\n        param_9 = _e125;\n        let _e126 = acesFilmic_u0028_vf3_u003b((&param_9));\n        (*c_2) = _e126;\n    }\n    let _e128 = unnamed.uOutputTransform;\n    if (_e128 == 3i) {\n        let _e130 = (*c_2);\n        let _e132 = unnamed.uOutputExposure;\n        param_10 = (_e130 * _e132);\n        let _e134 = highlightShoulder_u0028_vf3_u003b((&param_10));\n        (*c_2) = _e134;\n    }\n    let _e135 = (*c_2);\n    param_11 = _e135;\n    let _e136 = linearToSrgb_u0028_vf3_u003b((&param_11));\n    return _e136;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e115 = unnamed.uFogColor;\n    let _e117 = unnamed.uUnderwaterColor;\n    let _e119 = unnamed.uUnderwaterFactor;\n    return mix(_e115, _e117, vec3(_e119));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e128 = unnamed.uFogMode;\n    if (_e128 == 1i) {\n        let _e131 = unnamed.uFogFar;\n        let _e133 = unnamed.uFogNear;\n        span = max((_e131 - _e133), 0.0001f);\n        let _e136 = (*dist);\n        let _e138 = unnamed.uFogNear;\n        let _e140 = span;\n        ramp = clamp(((_e136 - _e138) / _e140), 0f, 1f);\n        let _e144 = unnamed.uUnderwaterFactor;\n        if (_e144 <= 0f) {\n            let _e146 = ramp;\n            return _e146;\n        }\n        let _e148 = unnamed.uUnderwaterFogDensity;\n        let _e149 = (*dist);\n        wetLinear = (_e148 * _e149);\n        let _e151 = ramp;\n        let _e152 = wetLinear;\n        let _e154 = wetLinear;\n        let _e160 = unnamed.uUnderwaterFactor;\n        return mix(_e151, (1f - exp2(((-(_e152) * _e154) * 1.442695f))), _e160);\n    }\n    let _e163 = unnamed.uFogNear;\n    let _e164 = (*dist);\n    start = min(_e163, _e164);\n    let _e166 = (*dist);\n    if (_e166 > 0f) {\n        let _e168 = start;\n        let _e169 = (*dist);\n        local = (_e168 / _e169);\n    } else {\n        local = 0f;\n    }\n    let _e171 = local;\n    before = _e171;\n    let _e172 = (*pointY);\n    let _e174 = unnamed.uFogEyeY;\n    let _e177 = unnamed.uFogHeightFalloff;\n    t = ((_e172 - _e174) * _e177);\n    let _e179 = t;\n    let _e180 = before;\n    rest = (_e179 * (1f - _e180));\n    let _e183 = rest;\n    let _e186 = rest;\n    denom = select(_e186, 0.0001f, (abs(_e183) < 0.0001f));\n    let _e189 = unnamed.uFogDensity;\n    let _e191 = t;\n    let _e193 = before;\n    let _e197 = (*dist);\n    let _e198 = start;\n    let _e201 = denom;\n    let _e206 = denom;\n    air = (1f - exp(((((-(_e189) * exp((-(_e191) * _e193))) * (_e197 - _e198)) * (1f - exp(-(_e201)))) / _e206)));\n    let _e211 = unnamed.uUnderwaterFactor;\n    if (_e211 <= 0f) {\n        let _e213 = air;\n        return _e213;\n    }\n    let _e215 = unnamed.uUnderwaterFogDensity;\n    let _e216 = (*dist);\n    wet = (_e215 * _e216);\n    let _e218 = air;\n    let _e219 = wet;\n    let _e221 = wet;\n    let _e227 = unnamed.uUnderwaterFactor;\n    return mix(_e218, (1f - exp2(((-(_e219) * _e221) * 1.442695f))), _e227);\n}\n\nfn hue_u0028_f1_u003b(h: ptr<function, f32>) -> vec3<f32> {\n    var c_3: vec3<f32>;\n\n    let _e116 = (*h);\n    (*h) = (fract(_e116) * 6f);\n    let _e119 = (*h);\n    let _e123 = (*h);\n    let _e127 = (*h);\n    c_3 = clamp(vec3<f32>((abs((_e119 - 3f)) - 1f), (2f - abs((_e123 - 2f))), (2f - abs((_e127 - 4f)))), vec3(0f), vec3(1f));\n    let _e135 = c_3;\n    return _e135;\n}\n\nfn main_1() {\n    var view: vec3<f32>;\n    var facing: f32;\n    var grazing: f32;\n    var ripple: f32;\n    var sheen: vec3<f32>;\n    var param_12: f32;\n    var base: vec3<f32>;\n    var color: vec3<f32>;\n    var fog: f32;\n    var param_13: f32;\n    var param_14: f32;\n    var gradedAir: vec3<f32>;\n    var param_15: vec3<f32>;\n    var graded: vec3<f32>;\n    var param_16: vec3<f32>;\n    var reflectionUv: vec2<f32>;\n    var border: vec2<f32>;\n    var valid: f32;\n    var at: vec3<f32>;\n    var here: f32;\n    var param_17: vec3<f32>;\n    var slope: vec2<f32>;\n    var param_18: vec3<f32>;\n    var param_19: vec3<f32>;\n    var along: vec2<f32>;\n    var smear: vec2<f32>;\n    var movedBorder: vec2<f32>;\n    var mirrored: vec3<f32>;\n    var coverage: f32;\n    var alpha: f32;\n    var phi_519_: bool;\n    var phi_634_: bool;\n    var phi_643_: bool;\n\n    let _e145 = unnamed.uClipEnabled;\n    let _e146 = (_e145 != 0i);\n    phi_519_ = _e146;\n    if _e146 {\n        let _e147 = vWorld_1;\n        let _e153 = unnamed.uClipPlane;\n        phi_519_ = (dot(vec4<f32>(_e147.x, _e147.y, _e147.z, 1f), _e153) < 0f);\n    }\n    let _e157 = phi_519_;\n    if _e157 {\n        discard;\n    }\n    let _e159 = unnamed.uCameraPos;\n    let _e160 = vWorld_1;\n    view = normalize((_e159 - _e160));\n    let _e163 = vNormal_1;\n    let _e165 = view;\n    facing = max(dot(normalize(_e163), _e165), 0f);\n    let _e168 = facing;\n    grazing = pow((1f - _e168), 3f);\n    let _e172 = vWorld_1[0u];\n    let _e175 = vWorld_1[2u];\n    let _e179 = unnamed.uTime;\n    let _e184 = vWorld_1[2u];\n    let _e187 = vWorld_1[0u];\n    let _e191 = unnamed.uTime;\n    ripple = (sin((((_e172 * 0.73f) + (_e175 * 0.41f)) + (_e179 * 0.55f))) * cos((((_e184 * 0.91f) - (_e187 * 0.29f)) - (_e191 * 0.37f))));\n    let _e196 = grazing;\n    let _e198 = ripple;\n    param_12 = (((_e196 * 1.35f) + (_e198 * 0.14f)) + 0.55f);\n    let _e202 = hue_u0028_f1_u003b((&param_12));\n    sheen = _e202;\n    let _e203 = vTint_1;\n    base = (_e203 * 0.9f);\n    let _e205 = base;\n    let _e206 = sheen;\n    let _e208 = unnamed.uSheen;\n    let _e210 = grazing;\n    color = (_e205 + ((_e206 * _e208) * (0.22f + (_e210 * 0.75f))));\n    let _e216 = unnamed.uCameraPos;\n    let _e217 = vWorld_1;\n    param_13 = length((_e216 - _e217));\n    let _e221 = vWorld_1[1u];\n    param_14 = _e221;\n    let _e222 = mediumFog_u0028_f1_u003b_f1_u003b((&param_13), (&param_14));\n    fog = _e222;\n    let _e223 = mediumColor_u0028_();\n    param_15 = _e223;\n    let _e224 = applyOutputTransform_u0028_vf3_u003b((&param_15));\n    gradedAir = _e224;\n    let _e225 = color;\n    let _e226 = mediumColor_u0028_();\n    let _e227 = fog;\n    param_16 = mix(_e225, _e226, vec3(_e227));\n    let _e230 = applyOutputTransform_u0028_vf3_u003b((&param_16));\n    graded = _e230;\n    let _e232 = unnamed.uReflectionEnabled;\n    let _e233 = (_e232 != 0i);\n    phi_634_ = _e233;\n    if _e233 {\n        let _e235 = unnamed.uReflectionStrength;\n        phi_634_ = (_e235 > 0f);\n    }\n    let _e238 = phi_634_;\n    phi_643_ = _e238;\n    if _e238 {\n        let _e240 = vReflectionClip_1[3u];\n        phi_643_ = (_e240 > 0f);\n    }\n    let _e243 = phi_643_;\n    if _e243 {\n        let _e244 = vReflectionClip_1;\n        let _e247 = vReflectionClip_1[3u];\n        reflectionUv = (((_e244.xy / vec2(_e247)) * 0.5f) + vec2(0.5f));\n        let _e253 = reflectionUv;\n        let _e254 = reflectionUv;\n        border = min(_e253, (vec2(1f) - _e254));\n        let _e259 = border[0u];\n        let _e261 = border[1u];\n        valid = smoothstep(0f, 0.025f, min(_e259, _e261));\n        let _e265 = unnamed.uFilmRoughness;\n        if (_e265 > 0f) {\n            let _e267 = vWorld_1;\n            let _e269 = unnamed.uFilmRoughnessCycles;\n            at = (_e267 * _e269);\n            let _e271 = at;\n            param_17 = _e271;\n            let _e272 = filmNoise_u0028_vf3_u003b((&param_17));\n            here = _e272;\n            let _e273 = at;\n            param_18 = (_e273 + vec3<f32>(0.5f, 0f, 0f));\n            let _e275 = filmNoise_u0028_vf3_u003b((&param_18));\n            let _e276 = here;\n            let _e278 = at;\n            param_19 = (_e278 + vec3<f32>(0f, 0f, 0.5f));\n            let _e280 = filmNoise_u0028_vf3_u003b((&param_19));\n            let _e281 = here;\n            slope = vec2<f32>((_e275 - _e276), (_e280 - _e281));\n            let _e285 = view[0u];\n            let _e287 = view[2u];\n            along = normalize((vec2<f32>(_e285, _e287) + vec2<f32>(0.00001f, 0f)));\n            let _e291 = along;\n            let _e292 = slope;\n            let _e293 = along;\n            let _e297 = slope;\n            smear = (((_e291 * dot(_e292, _e293)) * 3f) + (_e297 * 0.35f));\n            let _e300 = smear;\n            let _e302 = unnamed.uFilmRoughness;\n            let _e305 = grazing;\n            let _e309 = reflectionUv;\n            reflectionUv = (_e309 + (((_e300 * _e302) * 0.016f) * (0.2f + (_e305 * 0.8f))));\n            let _e311 = reflectionUv;\n            let _e312 = reflectionUv;\n            movedBorder = min(_e311, (vec2(1f) - _e312));\n            let _e316 = valid;\n            let _e318 = movedBorder[0u];\n            let _e320 = movedBorder[1u];\n            valid = min(_e316, smoothstep(0f, 0.025f, min(_e318, _e320)));\n        }\n        let _e324 = reflectionUv;\n        let _e328 = textureSampleLevel(uReflectionMap_t, uReflectionMap_s, clamp(_e324, vec2(0f), vec2(1f)), 0f);\n        mirrored = _e328.xyz;\n        let _e330 = graded;\n        let _e331 = mirrored;\n        let _e332 = gradedAir;\n        let _e333 = fog;\n        let _e336 = valid;\n        let _e338 = unnamed.uReflectionStrength;\n        let _e340 = grazing;\n        graded = mix(_e330, mix(_e331, _e332, vec3(_e333)), vec3(((_e336 * _e338) * (0.25f + (_e340 * 0.75f)))));\n    }\n    let _e346 = vCoverage_1;\n    coverage = clamp(_e346, 0f, 1f);\n    let _e348 = coverage;\n    let _e349 = coverage;\n    let _e351 = coverage;\n    alpha = (mix((_e348 * _e349), _e351, 0.65f) * 0.92f);\n    let _e354 = graded;\n    let _e355 = alpha;\n    fragColor = vec4<f32>(_e354.x, _e354.y, _e354.z, _e355);\n    return;\n}\n\n@fragment \nfn main(@location(0) vWorld: vec3<f32>, @location(1) vNormal: vec3<f32>, @location(2) vTint: vec3<f32>, @location(3) vReflectionClip: vec4<f32>, @location(4) vCoverage: f32) -> @location(0) vec4<f32> {\n    vWorld_1 = vWorld;\n    vNormal_1 = vNormal;\n    vTint_1 = vTint;\n    vReflectionClip_1 = vReflectionClip;\n    vCoverage_1 = vCoverage;\n    main_1();\n    let _e11 = fragColor;\n    return _e11;\n}\n";

export const FILM_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uReflectionViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) member_2: vec3<f32>,\n    @location(4) member_3: f32,\n    @location(3) member_4: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vWorld: vec3<f32>;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vTint: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vCoverage: f32;\nvar<private> aCoverage_1: f32;\nvar<private> vReflectionClip: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    let _e14 = aPosition_1;\n    vWorld = _e14;\n    let _e15 = aNormal_1;\n    vNormal = normalize(_e15);\n    let _e17 = aColor_1;\n    vTint = _e17;\n    let _e18 = aCoverage_1;\n    vCoverage = _e18;\n    let _e20 = unnamed.uReflectionViewProj;\n    let _e21 = aPosition_1;\n    vReflectionClip = (_e20 * vec4<f32>(_e21.x, _e21.y, _e21.z, 1f));\n    let _e28 = unnamed.uViewProj;\n    let _e29 = aPosition_1;\n    unnamed_1.gl_Position = (_e28 * vec4<f32>(_e29.x, _e29.y, _e29.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(1) aNormal: vec3<f32>, @location(2) aColor: vec3<f32>, @location(3) aCoverage: f32) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aNormal_1 = aNormal;\n    aColor_1 = aColor;\n    aCoverage_1 = aCoverage;\n    main_1();\n    let _e16 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e16);\n    let _e18 = vWorld;\n    let _e19 = vNormal;\n    let _e20 = vTint;\n    let _e21 = vCoverage;\n    let _e22 = vReflectionClip;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e18, _e19, _e20, _e21, _e22, _e23);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FILM_BINDINGS = {
  "FILM_FRAG": {
    "uniforms": 1,
    "uniformSize": 160,
    "fields": {
      "uReflectionEnabled": {
        "offset": 0,
        "size": 4,
        "type": "int"
      },
      "uReflectionStrength": {
        "offset": 4,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uTime": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uClipPlane": {
        "offset": 32,
        "size": 16,
        "type": "vec4"
      },
      "uClipEnabled": {
        "offset": 48,
        "size": 4,
        "type": "int"
      },
      "uFogColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 84,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 108,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 112,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 116,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 120,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uSheen": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uFilmRoughness": {
        "offset": 132,
        "size": 4,
        "type": "float"
      },
      "uFilmRoughnessCycles": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 140,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 144,
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
  "FILM_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
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
      }
    },
    "textures": {}
  }
} as const;
