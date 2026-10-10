/*
 * Generated from ../caustics.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const CAUSTICS_FRAG_WGSL = "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uWindDir: vec2<f32>,\n    uWaveGain: f32,\n    uTime: f32,\n    uLightDir: vec3<f32>,\n    uTint: vec3<f32>,\n    uStrength: f32,\n    uMaxDrop: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vParams_1: vec2<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vLocal_1: vec2<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e107 = (*c);\n    low = (_e107 * 12.92f);\n    let _e109 = (*c);\n    high = ((pow(max(_e109, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e115 = high;\n    let _e116 = low;\n    let _e117 = (*c);\n    return mix(_e115, _e116, step(_e117, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e108 = (*c_1)[0u];\n    let _e110 = (*c_1)[1u];\n    let _e112 = (*c_1)[2u];\n    m = max(_e108, max(_e110, _e112));\n    let _e115 = m;\n    if (_e115 <= 0.8f) {\n        let _e117 = (*c_1);\n        return _e117;\n    }\n    let _e118 = m;\n    e = (_e118 - 0.8f);\n    let _e120 = (*c_1);\n    let _e121 = e;\n    let _e123 = e;\n    let _e127 = m;\n    return (_e120 * ((0.8f + ((0.2f * _e121) / (_e123 + 0.2f))) / _e127));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e107 = (*v);\n    let _e108 = (*v);\n    a = ((_e107 * (_e108 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e114 = (*v);\n    let _e115 = (*v);\n    b = ((_e114 * ((_e115 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e122 = a;\n    let _e123 = b;\n    return (_e122 / _e123);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e107 = unnamed.uOutputExposure;\n    let _e108 = (*x);\n    (*x) = (_e108 * _e107);\n    let _e110 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e110);\n    let _e112 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e112), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e109 = unnamed.uOutputTransform;\n    if (_e109 == 0i) {\n        let _e111 = (*c_2);\n        return _e111;\n    }\n    let _e113 = unnamed.uOutputTransform;\n    if (_e113 == 2i) {\n        let _e115 = (*c_2);\n        param_1 = _e115;\n        let _e116 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e116;\n    }\n    let _e118 = unnamed.uOutputTransform;\n    if (_e118 == 3i) {\n        let _e120 = (*c_2);\n        let _e122 = unnamed.uOutputExposure;\n        param_2 = (_e120 * _e122);\n        let _e124 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e124;\n    }\n    let _e125 = (*c_2);\n    param_3 = _e125;\n    let _e126 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e126;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e118 = unnamed.uFogMode;\n    if (_e118 == 1i) {\n        let _e121 = unnamed.uFogFar;\n        let _e123 = unnamed.uFogNear;\n        span = max((_e121 - _e123), 0.0001f);\n        let _e126 = (*dist);\n        let _e128 = unnamed.uFogNear;\n        let _e130 = span;\n        ramp = clamp(((_e126 - _e128) / _e130), 0f, 1f);\n        let _e134 = unnamed.uUnderwaterFactor;\n        if (_e134 <= 0f) {\n            let _e136 = ramp;\n            return _e136;\n        }\n        let _e138 = unnamed.uUnderwaterFogDensity;\n        let _e139 = (*dist);\n        wetLinear = (_e138 * _e139);\n        let _e141 = ramp;\n        let _e142 = wetLinear;\n        let _e144 = wetLinear;\n        let _e150 = unnamed.uUnderwaterFactor;\n        return mix(_e141, (1f - exp2(((-(_e142) * _e144) * 1.442695f))), _e150);\n    }\n    let _e153 = unnamed.uFogNear;\n    let _e154 = (*dist);\n    start = min(_e153, _e154);\n    let _e156 = (*dist);\n    if (_e156 > 0f) {\n        let _e158 = start;\n        let _e159 = (*dist);\n        local = (_e158 / _e159);\n    } else {\n        local = 0f;\n    }\n    let _e161 = local;\n    before = _e161;\n    let _e162 = (*pointY);\n    let _e164 = unnamed.uFogEyeY;\n    let _e167 = unnamed.uFogHeightFalloff;\n    t = ((_e162 - _e164) * _e167);\n    let _e169 = t;\n    let _e170 = before;\n    rest = (_e169 * (1f - _e170));\n    let _e173 = rest;\n    let _e176 = rest;\n    denom = select(_e176, 0.0001f, (abs(_e173) < 0.0001f));\n    let _e179 = unnamed.uFogDensity;\n    let _e181 = t;\n    let _e183 = before;\n    let _e187 = (*dist);\n    let _e188 = start;\n    let _e191 = denom;\n    let _e196 = denom;\n    air = (1f - exp(((((-(_e179) * exp((-(_e181) * _e183))) * (_e187 - _e188)) * (1f - exp(-(_e191)))) / _e196)));\n    let _e201 = unnamed.uUnderwaterFactor;\n    if (_e201 <= 0f) {\n        let _e203 = air;\n        return _e203;\n    }\n    let _e205 = unnamed.uUnderwaterFogDensity;\n    let _e206 = (*dist);\n    wet = (_e205 * _e206);\n    let _e208 = air;\n    let _e209 = wet;\n    let _e211 = wet;\n    let _e217 = unnamed.uUnderwaterFactor;\n    return mix(_e208, (1f - exp2(((-(_e209) * _e211) * 1.442695f))), _e217);\n}\n\nfn gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b(k: ptr<function, f32>, dir: ptr<function, vec2<f32>>, p: ptr<function, vec2<f32>>, time: ptr<function, f32>) -> f32 {\n    var c_3: f32;\n\n    let _e109 = (*k);\n    c_3 = sqrt((9.81f / _e109));\n    let _e112 = (*k);\n    let _e113 = (*dir);\n    let _e114 = (*p);\n    let _e116 = c_3;\n    let _e117 = (*time);\n    return (_e112 * (dot(_e113, _e114) - (_e116 * _e117)));\n}\n\nfn gerstnerWavenumber_u0028_i1_u003b(i: ptr<function, i32>) -> f32 {\n    var indexable: array<vec4<f32>, 4>;\n\n    let _e106 = (*i);\n    indexable = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e109 = indexable[_e106][3u];\n    return (6.2831855f / _e109);\n}\n\nfn gerstnerDirection_u0028_i1_u003b_vf2_u003b(i_1: ptr<function, i32>, windDir: ptr<function, vec2<f32>>) -> vec2<f32> {\n    var indexable_1: array<vec4<f32>, 4>;\n\n    let _e107 = (*i_1);\n    indexable_1 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n    let _e109 = indexable_1[_e107];\n    let _e112 = (*windDir);\n    return normalize(mix(normalize(_e109.xy), _e112, vec2(0.62f)));\n}\n\nfn gerstnerCurvature_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b(p_1: ptr<function, vec2<f32>>, time_1: ptr<function, f32>, windDir_1: ptr<function, vec2<f32>>, gain: ptr<function, f32>) -> vec3<f32> {\n    var h: vec3<f32>;\n    var i_2: i32;\n    var dir_1: vec2<f32>;\n    var param_4: i32;\n    var param_5: vec2<f32>;\n    var steepness: f32;\n    var indexable_2: array<vec4<f32>, 4>;\n    var k_1: f32;\n    var param_6: i32;\n    var f: f32;\n    var param_7: f32;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var second: f32;\n\n    h = vec3<f32>(0f, 0f, 0f);\n    i_2 = 0i;\n    loop {\n        let _e123 = i_2;\n        if (_e123 < 4i) {\n            let _e125 = i_2;\n            param_4 = _e125;\n            let _e126 = (*windDir_1);\n            param_5 = _e126;\n            let _e127 = gerstnerDirection_u0028_i1_u003b_vf2_u003b((&param_4), (&param_5));\n            dir_1 = _e127;\n            let _e128 = i_2;\n            indexable_2 = array<vec4<f32>, 4>(vec4<f32>(1f, 0f, 0.115f, 34f), vec4<f32>(0.6f, 0.8f, 0.1f, 18f), vec4<f32>(-0.7f, 0.7f, 0.08f, 9f), vec4<f32>(0.2f, -0.98f, 0.06f, 5f));\n            let _e131 = indexable_2[_e128][2u];\n            let _e132 = (*gain);\n            steepness = (_e131 * _e132);\n            let _e134 = i_2;\n            param_6 = _e134;\n            let _e135 = gerstnerWavenumber_u0028_i1_u003b((&param_6));\n            k_1 = _e135;\n            let _e136 = k_1;\n            param_7 = _e136;\n            let _e137 = dir_1;\n            param_8 = _e137;\n            let _e138 = (*p_1);\n            param_9 = _e138;\n            let _e139 = (*time_1);\n            param_10 = _e139;\n            let _e140 = gerstnerPhase_u0028_f1_u003b_vf2_u003b_vf2_u003b_f1_u003b((&param_7), (&param_8), (&param_9), (&param_10));\n            f = _e140;\n            let _e141 = steepness;\n            let _e143 = k_1;\n            let _e145 = f;\n            second = ((-(_e141) * _e143) * sin(_e145));\n            let _e148 = second;\n            let _e150 = dir_1[0u];\n            let _e153 = dir_1[0u];\n            let _e156 = h[0u];\n            h[0u] = (_e156 + ((_e148 * _e150) * _e153));\n            let _e159 = second;\n            let _e161 = dir_1[1u];\n            let _e164 = dir_1[1u];\n            let _e167 = h[1u];\n            h[1u] = (_e167 + ((_e159 * _e161) * _e164));\n            let _e170 = second;\n            let _e172 = dir_1[0u];\n            let _e175 = dir_1[1u];\n            let _e178 = h[2u];\n            h[2u] = (_e178 + ((_e170 * _e172) * _e175));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e181 = i_2;\n            i_2 = (_e181 + 1i);\n        }\n    }\n    let _e183 = h;\n    return _e183;\n}\n\nfn main_1() {\n    var waterY: f32;\n    var drop: f32;\n    var distanceFromWater: f32;\n    var clear: f32;\n    var height: f32;\n    var rim: f32;\n    var edge: f32;\n    var reach: f32;\n    var elevation: f32;\n    var slant: f32;\n    var d: f32;\n    var water: vec2<f32>;\n    var h_1: vec3<f32>;\n    var param_11: vec2<f32>;\n    var param_12: f32;\n    var param_13: vec2<f32>;\n    var param_14: f32;\n    var a_1: f32;\n    var b_1: f32;\n    var c_4: f32;\n    var det: f32;\n    var soft: f32;\n    var lines: f32;\n    var sheen: f32;\n    var caustic: f32;\n    var fog: f32;\n    var param_15: f32;\n    var param_16: f32;\n    var param_17: vec3<f32>;\n\n    let _e134 = vParams_1[0u];\n    waterY = _e134;\n    let _e136 = vWorldPos_1[1u];\n    let _e137 = waterY;\n    drop = (_e136 - _e137);\n    let _e139 = drop;\n    distanceFromWater = abs(_e139);\n    let _e141 = distanceFromWater;\n    clear = step(0.02f, _e141);\n    let _e144 = unnamed.uMaxDrop;\n    let _e147 = unnamed.uMaxDrop;\n    let _e148 = distanceFromWater;\n    height = (1f - smoothstep((_e144 * 0.45f), _e147, _e148));\n    let _e152 = vLocal_1[0u];\n    let _e154 = vLocal_1[0u];\n    let _e158 = vLocal_1[1u];\n    let _e160 = vLocal_1[1u];\n    rim = min(min(_e152, (1f - _e154)), min(_e158, (1f - _e160)));\n    let _e164 = rim;\n    edge = smoothstep(0f, 0.12f, _e164);\n    let _e166 = clear;\n    let _e167 = height;\n    let _e169 = edge;\n    reach = ((_e166 * _e167) * _e169);\n    let _e173 = unnamed.uLightDir[1u];\n    elevation = max(_e173, 0.16f);\n    let _e175 = elevation;\n    slant = (1f / _e175);\n    let _e177 = drop;\n    let _e178 = slant;\n    d = (_e177 * _e178);\n    let _e180 = vWorldPos_1;\n    let _e183 = unnamed.uLightDir;\n    let _e185 = d;\n    water = (_e180.xz + (_e183.xz * _e185));\n    let _e188 = water;\n    param_11 = _e188;\n    let _e190 = unnamed.uTime;\n    param_12 = _e190;\n    let _e192 = unnamed.uWindDir;\n    param_13 = _e192;\n    let _e194 = unnamed.uWaveGain;\n    param_14 = _e194;\n    let _e195 = gerstnerCurvature_u0028_vf2_u003b_f1_u003b_vf2_u003b_f1_u003b((&param_11), (&param_12), (&param_13), (&param_14));\n    h_1 = _e195;\n    let _e196 = d;\n    let _e199 = h_1[0u];\n    a_1 = (1f - ((2f * _e196) * _e199));\n    let _e202 = d;\n    let _e205 = h_1[1u];\n    b_1 = (1f - ((2f * _e202) * _e205));\n    let _e208 = d;\n    let _e211 = h_1[2u];\n    c_4 = ((2f * _e208) * _e211);\n    let _e213 = a_1;\n    let _e214 = b_1;\n    let _e216 = c_4;\n    let _e217 = c_4;\n    det = ((_e213 * _e214) - (_e216 * _e217));\n    let _e220 = det;\n    let _e221 = fwidth(_e220);\n    soft = max(0.05f, (_e221 * 1.6f));\n    let _e224 = soft;\n    let _e225 = det;\n    let _e227 = soft;\n    lines = (_e224 / max(abs(_e225), _e227));\n    let _e230 = det;\n    sheen = clamp(((1f / max(abs(_e230), 0.18f)) - 0.85f), 0f, 1f);\n    let _e236 = lines;\n    let _e238 = sheen;\n    caustic = clamp(((_e236 * 0.9f) + (_e238 * 0.09f)), 0f, 1.6f);\n    let _e242 = vWorldPos_1;\n    let _e244 = unnamed.uCameraPos;\n    param_15 = distance(_e242, _e244);\n    let _e247 = vWorldPos_1[1u];\n    param_16 = _e247;\n    let _e248 = mediumFog_u0028_f1_u003b_f1_u003b((&param_15), (&param_16));\n    fog = _e248;\n    let _e250 = unnamed.uTint;\n    let _e251 = caustic;\n    let _e253 = unnamed.uStrength;\n    let _e255 = reach;\n    let _e257 = fog;\n    param_17 = (_e250 * (((_e251 * _e253) * _e255) * (1f - _e257)));\n    let _e261 = applyOutputTransform_u0028_vf3_u003b((&param_17));\n    outColor = vec4<f32>(_e261.x, _e261.y, _e261.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(2) vParams: vec2<f32>, @location(0) vWorldPos: vec3<f32>, @location(1) vLocal: vec2<f32>) -> @location(0) vec4<f32> {\n    vParams_1 = vParams;\n    vWorldPos_1 = vWorldPos;\n    vLocal_1 = vLocal;\n    main_1();\n    let _e7 = outColor;\n    return _e7;\n}\n";

export const CAUSTICS_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct Uniforms {\n    uViewProj: mat4x4<f32>,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: vec2<f32>,\n    @location(2) member_2: vec2<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> vWorldPos: vec3<f32>;\nvar<private> aRest_1: vec3<f32>;\nvar<private> vLocal: vec2<f32>;\nvar<private> aLocal_1: vec2<f32>;\nvar<private> vParams: vec2<f32>;\nvar<private> aParams_1: vec2<f32>;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(0) \nvar<uniform> unnamed_1: Uniforms;\n\nfn main_1() {\n    let _e10 = aRest_1;\n    vWorldPos = _e10;\n    let _e11 = aLocal_1;\n    vLocal = _e11;\n    let _e12 = aParams_1;\n    vParams = _e12;\n    let _e14 = unnamed_1.uViewProj;\n    let _e15 = aRest_1;\n    unnamed.gl_Position = (_e14 * vec4<f32>(_e15.x, _e15.y, _e15.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aRest: vec3<f32>, @location(1) aLocal: vec2<f32>, @location(2) aParams: vec2<f32>) -> VertexOutput {\n    aRest_1 = aRest;\n    aLocal_1 = aLocal;\n    aParams_1 = aParams;\n    main_1();\n    let _e12 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e12);\n    let _e14 = vWorldPos;\n    let _e15 = vLocal;\n    let _e16 = vParams;\n    let _e17 = unnamed.gl_Position;\n    return VertexOutput(_e14, _e15, _e16, _e17);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const CAUSTICS_BINDINGS = {
  "CAUSTICS_FRAG": {
    "uniforms": 1,
    "uniformSize": 160,
    "fields": {
      "uCameraPos": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uWindDir": {
        "offset": 16,
        "size": 8,
        "type": "vec2"
      },
      "uWaveGain": {
        "offset": 24,
        "size": 4,
        "type": "float"
      },
      "uTime": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uLightDir": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uTint": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uStrength": {
        "offset": 60,
        "size": 4,
        "type": "float"
      },
      "uMaxDrop": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 96,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 100,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 132,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 144,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 148,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "CAUSTICS_VERT": {
    "uniforms": 0,
    "uniformSize": 64,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
