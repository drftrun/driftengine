/*
 * Generated from ../fire.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const FIRE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e113 = (*c);\n    low = (_e113 * 12.92f);\n    let _e115 = (*c);\n    high = ((pow(max(_e115, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e121 = high;\n    let _e122 = low;\n    let _e123 = (*c);\n    return mix(_e121, _e122, step(_e123, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e114 = (*c_1)[0u];\n    let _e116 = (*c_1)[1u];\n    let _e118 = (*c_1)[2u];\n    m = max(_e114, max(_e116, _e118));\n    let _e121 = m;\n    if (_e121 <= 0.8f) {\n        let _e123 = (*c_1);\n        return _e123;\n    }\n    let _e124 = m;\n    e = (_e124 - 0.8f);\n    let _e126 = (*c_1);\n    let _e127 = e;\n    let _e129 = e;\n    let _e133 = m;\n    return (_e126 * ((0.8f + ((0.2f * _e127) / (_e129 + 0.2f))) / _e133));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e113 = (*v);\n    let _e114 = (*v);\n    a = ((_e113 * (_e114 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e120 = (*v);\n    let _e121 = (*v);\n    b = ((_e120 * ((_e121 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e128 = a;\n    let _e129 = b;\n    return (_e128 / _e129);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e113 = unnamed.uOutputExposure;\n    let _e114 = (*x);\n    (*x) = (_e114 * _e113);\n    let _e116 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e116);\n    let _e118 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e118), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e115 = unnamed.uOutputTransform;\n    if (_e115 == 0i) {\n        let _e117 = (*c_2);\n        return _e117;\n    }\n    let _e119 = unnamed.uOutputTransform;\n    if (_e119 == 2i) {\n        let _e121 = (*c_2);\n        param_1 = _e121;\n        let _e122 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e122;\n    }\n    let _e124 = unnamed.uOutputTransform;\n    if (_e124 == 3i) {\n        let _e126 = (*c_2);\n        let _e128 = unnamed.uOutputExposure;\n        param_2 = (_e126 * _e128);\n        let _e130 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e130;\n    }\n    let _e131 = (*c_2);\n    param_3 = _e131;\n    let _e132 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e132;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e111 = unnamed.uFogColor;\n    let _e113 = unnamed.uUnderwaterColor;\n    let _e115 = unnamed.uUnderwaterFactor;\n    return mix(_e111, _e113, vec3(_e115));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e124 = unnamed.uFogMode;\n    if (_e124 == 1i) {\n        let _e127 = unnamed.uFogFar;\n        let _e129 = unnamed.uFogNear;\n        span = max((_e127 - _e129), 0.0001f);\n        let _e132 = (*dist);\n        let _e134 = unnamed.uFogNear;\n        let _e136 = span;\n        ramp = clamp(((_e132 - _e134) / _e136), 0f, 1f);\n        let _e140 = unnamed.uUnderwaterFactor;\n        if (_e140 <= 0f) {\n            let _e142 = ramp;\n            return _e142;\n        }\n        let _e144 = unnamed.uUnderwaterFogDensity;\n        let _e145 = (*dist);\n        wetLinear = (_e144 * _e145);\n        let _e147 = ramp;\n        let _e148 = wetLinear;\n        let _e150 = wetLinear;\n        let _e156 = unnamed.uUnderwaterFactor;\n        return mix(_e147, (1f - exp2(((-(_e148) * _e150) * 1.442695f))), _e156);\n    }\n    let _e159 = unnamed.uFogNear;\n    let _e160 = (*dist);\n    start = min(_e159, _e160);\n    let _e162 = (*dist);\n    if (_e162 > 0f) {\n        let _e164 = start;\n        let _e165 = (*dist);\n        local = (_e164 / _e165);\n    } else {\n        local = 0f;\n    }\n    let _e167 = local;\n    before = _e167;\n    let _e168 = (*pointY);\n    let _e170 = unnamed.uFogEyeY;\n    let _e173 = unnamed.uFogHeightFalloff;\n    t = ((_e168 - _e170) * _e173);\n    let _e175 = t;\n    let _e176 = before;\n    rest = (_e175 * (1f - _e176));\n    let _e179 = rest;\n    let _e182 = rest;\n    denom = select(_e182, 0.0001f, (abs(_e179) < 0.0001f));\n    let _e185 = unnamed.uFogDensity;\n    let _e187 = t;\n    let _e189 = before;\n    let _e193 = (*dist);\n    let _e194 = start;\n    let _e197 = denom;\n    let _e202 = denom;\n    air = (1f - exp(((((-(_e185) * exp((-(_e187) * _e189))) * (_e193 - _e194)) * (1f - exp(-(_e197)))) / _e202)));\n    let _e207 = unnamed.uUnderwaterFactor;\n    if (_e207 <= 0f) {\n        let _e209 = air;\n        return _e209;\n    }\n    let _e211 = unnamed.uUnderwaterFogDensity;\n    let _e212 = (*dist);\n    wet = (_e211 * _e212);\n    let _e214 = air;\n    let _e215 = wet;\n    let _e217 = wet;\n    let _e223 = unnamed.uUnderwaterFactor;\n    return mix(_e214, (1f - exp2(((-(_e215) * _e217) * 1.442695f))), _e223);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e111 = (*p);\n    return fract((sin(dot(_e111, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n\n    let _e118 = (*p_1);\n    i = floor(_e118);\n    let _e120 = (*p_1);\n    f = fract(_e120);\n    let _e122 = f;\n    let _e123 = f;\n    let _e125 = f;\n    u = ((_e122 * _e123) * (vec2(3f) - (_e125 * 2f)));\n    let _e130 = i;\n    param_4 = _e130;\n    let _e131 = hash21_u0028_vf2_u003b((&param_4));\n    let _e132 = i;\n    param_5 = (_e132 + vec2<f32>(1f, 0f));\n    let _e134 = hash21_u0028_vf2_u003b((&param_5));\n    let _e136 = u[0u];\n    let _e138 = i;\n    param_6 = (_e138 + vec2<f32>(0f, 1f));\n    let _e140 = hash21_u0028_vf2_u003b((&param_6));\n    let _e141 = i;\n    param_7 = (_e141 + vec2<f32>(1f, 1f));\n    let _e143 = hash21_u0028_vf2_u003b((&param_7));\n    let _e145 = u[0u];\n    let _e148 = u[1u];\n    return mix(mix(_e131, _e134, _e136), mix(_e140, _e143, _e145), _e148);\n}\n\nfn turbulence_u0028_vf2_u003b_f1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>) -> f32 {\n    var v_1: f32;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n    var param_10: vec2<f32>;\n\n    let _e116 = (*p_2);\n    let _e118 = (*t_1);\n    param_8 = ((_e116 * 3f) + vec2<f32>(0f, (-(_e118) * 1.9f)));\n    let _e123 = valueNoise_u0028_vf2_u003b((&param_8));\n    v_1 = (_e123 * 0.55f);\n    let _e126 = unnamed.uNoiseOctaves;\n    if (_e126 == 1i) {\n        let _e128 = v_1;\n        return (_e128 / 0.55f);\n    }\n    let _e130 = (*p_2);\n    let _e132 = (*t_1);\n    let _e134 = (*t_1);\n    param_9 = ((_e130 * 6.5f) + vec2<f32>((_e132 * 0.3f), (-(_e134) * 3.1f)));\n    let _e139 = valueNoise_u0028_vf2_u003b((&param_9));\n    let _e141 = v_1;\n    v_1 = (_e141 + (_e139 * 0.28f));\n    let _e144 = unnamed.uNoiseOctaves;\n    if (_e144 == 2i) {\n        let _e146 = v_1;\n        return (_e146 / 0.83f);\n    }\n    let _e148 = v_1;\n    let _e149 = (*p_2);\n    let _e151 = (*t_1);\n    let _e154 = (*t_1);\n    param_10 = ((_e149 * 13f) + vec2<f32>((-(_e151) * 0.2f), (-(_e154) * 4.6f)));\n    let _e159 = valueNoise_u0028_vf2_u003b((&param_10));\n    return (_e148 + (_e159 * 0.17f));\n}\n\nfn main_1() {\n    var uv: vec2<f32>;\n    var t_2: f32;\n    var sides: f32;\n    var taper: f32;\n    var sway: f32;\n    var param_11: vec2<f32>;\n    var p_3: vec2<f32>;\n    var n: f32;\n    var param_12: vec2<f32>;\n    var param_13: f32;\n    var body: f32;\n    var heat: f32;\n    var col: vec3<f32>;\n    var alpha: f32;\n    var fog: f32;\n    var param_14: f32;\n    var param_15: f32;\n    var param_16: vec3<f32>;\n    var phi_516_: bool;\n\n    let _e129 = unnamed.uClipEnabled;\n    let _e130 = (_e129 != 0i);\n    phi_516_ = _e130;\n    if _e130 {\n        let _e131 = vWorldPos_1;\n        let _e137 = unnamed.uClipPlane;\n        phi_516_ = (dot(vec4<f32>(_e131.x, _e131.y, _e131.z, 1f), _e137) < 0f);\n    }\n    let _e141 = phi_516_;\n    if _e141 {\n        discard;\n    }\n    let _e142 = vUv_1;\n    uv = _e142;\n    let _e144 = unnamed.uTime;\n    let _e145 = vSeed_1;\n    t_2 = (_e144 + (_e145 * 37f));\n    let _e149 = uv[0u];\n    sides = (1f - (abs((_e149 - 0.5f)) * 2f));\n    let _e154 = sides;\n    let _e156 = uv[1u];\n    taper = (_e154 * (1f - (_e156 * 0.72f)));\n    let _e160 = taper;\n    if (_e160 <= 0f) {\n        discard;\n    }\n    let _e162 = t_2;\n    let _e164 = vSeed_1;\n    param_11 = vec2<f32>((_e162 * 0.55f), (_e164 * 11f));\n    let _e167 = valueNoise_u0028_vf2_u003b((&param_11));\n    let _e171 = uv[1u];\n    sway = (((_e167 - 0.5f) * 0.34f) * _e171);\n    let _e174 = uv[0u];\n    let _e175 = sway;\n    let _e178 = uv[1u];\n    p_3 = vec2<f32>((_e174 + _e175), _e178);\n    let _e180 = p_3;\n    param_12 = _e180;\n    let _e181 = t_2;\n    param_13 = _e181;\n    let _e182 = turbulence_u0028_vf2_u003b_f1_u003b((&param_12), (&param_13));\n    n = _e182;\n    let _e183 = n;\n    let _e184 = taper;\n    let _e188 = uv[1u];\n    body = (((_e183 * _e184) * 1.9f) - (_e188 * 0.55f));\n    let _e191 = body;\n    if (_e191 <= 0.02f) {\n        discard;\n    }\n    let _e193 = body;\n    heat = clamp((_e193 * 1.5f), 0f, 1f);\n    let _e196 = heat;\n    col = mix(vec3<f32>(0.62f, 0.06f, 0.02f), vec3<f32>(1f, 0.45f, 0.06f), vec3(smoothstep(0f, 0.45f, _e196)));\n    let _e200 = col;\n    let _e201 = heat;\n    col = mix(_e200, vec3<f32>(1f, 0.85f, 0.35f), vec3(smoothstep(0.45f, 0.75f, _e201)));\n    let _e205 = col;\n    let _e206 = heat;\n    col = mix(_e205, vec3<f32>(1f, 0.98f, 0.88f), vec3(smoothstep(0.78f, 1f, _e206)));\n    let _e210 = body;\n    let _e214 = uv[1u];\n    alpha = (clamp((_e210 * 2.2f), 0f, 1f) * (1f - smoothstep(0.72f, 1f, _e214)));\n    let _e218 = vDistance_1;\n    param_14 = _e218;\n    let _e220 = vWorldPos_1[1u];\n    param_15 = _e220;\n    let _e221 = mediumFog_u0028_f1_u003b_f1_u003b((&param_14), (&param_15));\n    fog = _e221;\n    let _e222 = col;\n    let _e223 = mediumColor_u0028_();\n    let _e224 = fog;\n    col = mix(_e222, _e223, vec3(_e224));\n    let _e227 = fog;\n    let _e229 = alpha;\n    alpha = (_e229 * (1f - _e227));\n    let _e231 = col;\n    param_16 = _e231;\n    let _e232 = applyOutputTransform_u0028_vf3_u003b((&param_16));\n    let _e233 = alpha;\n    outColor = vec4<f32>(_e232.x, _e232.y, _e232.z, _e233);\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(0) vUv: vec2<f32>, @location(1) vSeed: f32, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

export const PLUME_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uTime: f32,\n    uSizePulse: f32,\n    uWind: vec2<f32>,\n    uOrigin: vec3<f32>,\n    uWindResponse: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: f32,\n    @location(2) member_2: f32,\n    @location(3) member_3: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCenter_1: vec3<f32>;\nvar<private> aSeed_1: f32;\nvar<private> aBlade_1: f32;\nvar<private> aSize_1: vec2<f32>;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vUv: vec2<f32>;\nvar<private> vSeed: f32;\nvar<private> vDistance: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn sizePulse_u0028_f1_u003b(seed: ptr<function, f32>) -> f32 {\n    let _e35 = unnamed.uSizePulse;\n    let _e37 = unnamed.uTime;\n    let _e39 = (*seed);\n    let _e45 = unnamed.uTime;\n    let _e47 = (*seed);\n    return (1f + (_e35 * ((sin(((_e37 * 1.7f) + (_e39 * 9.1f))) * 0.62f) + (sin(((_e45 * 3.3f) + (_e47 * 4.7f))) * 0.38f))));\n}\n\nfn main_1() {\n    var anchor: vec3<f32>;\n    var up: vec3<f32>;\n    var yaw: f32;\n    var right: vec3<f32>;\n    var pulse: f32;\n    var param: f32;\n    var size: vec2<f32>;\n    var rise: f32;\n    var world: vec3<f32>;\n\n    let _e42 = aCenter_1;\n    let _e44 = unnamed.uOrigin;\n    anchor = (_e42 + _e44);\n    up = vec3<f32>(0f, 1f, 0f);\n    let _e46 = aSeed_1;\n    let _e48 = aBlade_1;\n    yaw = ((_e46 * 6.2831855f) + (_e48 * 1.5707964f));\n    let _e51 = yaw;\n    let _e53 = yaw;\n    right = vec3<f32>(cos(_e51), 0f, sin(_e53));\n    let _e56 = aSeed_1;\n    param = _e56;\n    let _e57 = sizePulse_u0028_f1_u003b((&param));\n    pulse = _e57;\n    let _e59 = aSize_1[0u];\n    let _e60 = pulse;\n    let _e64 = aSize_1[1u];\n    let _e65 = pulse;\n    size = vec2<f32>((_e59 * mix(1f, _e60, 0.55f)), (_e64 * _e65));\n    let _e69 = aCorner_1[1u];\n    rise = ((_e69 * 0.5f) + 0.5f);\n    let _e72 = anchor;\n    let _e73 = right;\n    let _e75 = aCorner_1[0u];\n    let _e77 = size[0u];\n    let _e81 = up;\n    let _e82 = rise;\n    let _e84 = size[1u];\n    world = ((_e72 + (_e73 * (_e75 * _e77))) + (_e81 * (_e82 * _e84)));\n    let _e89 = unnamed.uWind;\n    let _e91 = unnamed.uWindResponse;\n    let _e92 = rise;\n    let _e94 = rise;\n    let _e97 = size[1u];\n    let _e100 = world;\n    let _e102 = (_e100.xz + (_e89 * (((_e91 * _e92) * _e94) * _e97)));\n    let _e103 = world;\n    world = vec3<f32>(_e102.x, _e103.y, _e102.y);\n    let _e109 = aCorner_1[0u];\n    let _e113 = aCorner_1[1u];\n    vUv = vec2<f32>(((_e109 * 0.5f) + 0.5f), ((_e113 * 0.5f) + 0.5f));\n    let _e117 = aSeed_1;\n    vSeed = _e117;\n    let _e118 = world;\n    let _e120 = unnamed.uCameraPos;\n    vDistance = distance(_e118, _e120);\n    let _e122 = world;\n    vWorldPos = _e122;\n    let _e124 = unnamed.uViewProj;\n    let _e125 = world;\n    unnamed_1.gl_Position = (_e124 * vec4<f32>(_e125.x, _e125.y, _e125.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aCenter: vec3<f32>, @location(3) aSeed: f32, @location(4) aBlade: f32, @location(2) aSize: vec2<f32>, @location(1) aCorner: vec2<f32>) -> VertexOutput {\n    aCenter_1 = aCenter;\n    aSeed_1 = aSeed;\n    aBlade_1 = aBlade;\n    aSize_1 = aSize;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e17 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e17);\n    let _e19 = vUv;\n    let _e20 = vSeed;\n    let _e21 = vDistance;\n    let _e22 = vWorldPos;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e19, _e20, _e21, _e22, _e23);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const FIRE_BINDINGS = {
  "FIRE_FRAG": {
    "uniforms": 1,
    "uniformSize": 128,
    "fields": {
      "uTime": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 32,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 36,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 60,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 68,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 72,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uNoiseOctaves": {
        "offset": 80,
        "size": 4,
        "type": "int"
      },
      "uClipPlane": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uClipEnabled": {
        "offset": 112,
        "size": 4,
        "type": "int"
      },
      "uOutputTransform": {
        "offset": 116,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 120,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "PLUME_VERT": {
    "uniforms": 0,
    "uniformSize": 112,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uTime": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uSizePulse": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uWind": {
        "offset": 88,
        "size": 8,
        "type": "vec2"
      },
      "uOrigin": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uWindResponse": {
        "offset": 108,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
