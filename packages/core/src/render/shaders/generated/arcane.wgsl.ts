/*
 * Generated from ../arcane.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const ARCANE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uTint: vec3<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e105 = (*c);\n    low = (_e105 * 12.92f);\n    let _e107 = (*c);\n    high = ((pow(max(_e107, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e113 = high;\n    let _e114 = low;\n    let _e115 = (*c);\n    return mix(_e113, _e114, step(_e115, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e106 = (*c_1)[0u];\n    let _e108 = (*c_1)[1u];\n    let _e110 = (*c_1)[2u];\n    m = max(_e106, max(_e108, _e110));\n    let _e113 = m;\n    if (_e113 <= 0.8f) {\n        let _e115 = (*c_1);\n        return _e115;\n    }\n    let _e116 = m;\n    e = (_e116 - 0.8f);\n    let _e118 = (*c_1);\n    let _e119 = e;\n    let _e121 = e;\n    let _e125 = m;\n    return (_e118 * ((0.8f + ((0.2f * _e119) / (_e121 + 0.2f))) / _e125));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e105 = (*v);\n    let _e106 = (*v);\n    a = ((_e105 * (_e106 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e112 = (*v);\n    let _e113 = (*v);\n    b = ((_e112 * ((_e113 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e120 = a;\n    let _e121 = b;\n    return (_e120 / _e121);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e105 = unnamed.uOutputExposure;\n    let _e106 = (*x);\n    (*x) = (_e106 * _e105);\n    let _e108 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e108);\n    let _e110 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e110), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e107 = unnamed.uOutputTransform;\n    if (_e107 == 0i) {\n        let _e109 = (*c_2);\n        return _e109;\n    }\n    let _e111 = unnamed.uOutputTransform;\n    if (_e111 == 2i) {\n        let _e113 = (*c_2);\n        param_1 = _e113;\n        let _e114 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e114;\n    }\n    let _e116 = unnamed.uOutputTransform;\n    if (_e116 == 3i) {\n        let _e118 = (*c_2);\n        let _e120 = unnamed.uOutputExposure;\n        param_2 = (_e118 * _e120);\n        let _e122 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e122;\n    }\n    let _e123 = (*c_2);\n    param_3 = _e123;\n    let _e124 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e124;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e103 = unnamed.uFogColor;\n    let _e105 = unnamed.uUnderwaterColor;\n    let _e107 = unnamed.uUnderwaterFactor;\n    return mix(_e103, _e105, vec3(_e107));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e116 = unnamed.uFogMode;\n    if (_e116 == 1i) {\n        let _e119 = unnamed.uFogFar;\n        let _e121 = unnamed.uFogNear;\n        span = max((_e119 - _e121), 0.0001f);\n        let _e124 = (*dist);\n        let _e126 = unnamed.uFogNear;\n        let _e128 = span;\n        ramp = clamp(((_e124 - _e126) / _e128), 0f, 1f);\n        let _e132 = unnamed.uUnderwaterFactor;\n        if (_e132 <= 0f) {\n            let _e134 = ramp;\n            return _e134;\n        }\n        let _e136 = unnamed.uUnderwaterFogDensity;\n        let _e137 = (*dist);\n        wetLinear = (_e136 * _e137);\n        let _e139 = ramp;\n        let _e140 = wetLinear;\n        let _e142 = wetLinear;\n        let _e148 = unnamed.uUnderwaterFactor;\n        return mix(_e139, (1f - exp2(((-(_e140) * _e142) * 1.442695f))), _e148);\n    }\n    let _e151 = unnamed.uFogNear;\n    let _e152 = (*dist);\n    start = min(_e151, _e152);\n    let _e154 = (*dist);\n    if (_e154 > 0f) {\n        let _e156 = start;\n        let _e157 = (*dist);\n        local = (_e156 / _e157);\n    } else {\n        local = 0f;\n    }\n    let _e159 = local;\n    before = _e159;\n    let _e160 = (*pointY);\n    let _e162 = unnamed.uFogEyeY;\n    let _e165 = unnamed.uFogHeightFalloff;\n    t = ((_e160 - _e162) * _e165);\n    let _e167 = t;\n    let _e168 = before;\n    rest = (_e167 * (1f - _e168));\n    let _e171 = rest;\n    let _e174 = rest;\n    denom = select(_e174, 0.0001f, (abs(_e171) < 0.0001f));\n    let _e177 = unnamed.uFogDensity;\n    let _e179 = t;\n    let _e181 = before;\n    let _e185 = (*dist);\n    let _e186 = start;\n    let _e189 = denom;\n    let _e194 = denom;\n    air = (1f - exp(((((-(_e177) * exp((-(_e179) * _e181))) * (_e185 - _e186)) * (1f - exp(-(_e189)))) / _e194)));\n    let _e199 = unnamed.uUnderwaterFactor;\n    if (_e199 <= 0f) {\n        let _e201 = air;\n        return _e201;\n    }\n    let _e203 = unnamed.uUnderwaterFogDensity;\n    let _e204 = (*dist);\n    wet = (_e203 * _e204);\n    let _e206 = air;\n    let _e207 = wet;\n    let _e209 = wet;\n    let _e215 = unnamed.uUnderwaterFactor;\n    return mix(_e206, (1f - exp2(((-(_e207) * _e209) * 1.442695f))), _e215);\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e103 = (*p);\n    return fract((sin(dot(_e103, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n\n    let _e110 = (*p_1);\n    i = floor(_e110);\n    let _e112 = (*p_1);\n    f = fract(_e112);\n    let _e114 = f;\n    let _e115 = f;\n    let _e117 = f;\n    u = ((_e114 * _e115) * (vec2(3f) - (_e117 * 2f)));\n    let _e122 = i;\n    param_4 = _e122;\n    let _e123 = hash21_u0028_vf2_u003b((&param_4));\n    let _e124 = i;\n    param_5 = (_e124 + vec2<f32>(1f, 0f));\n    let _e126 = hash21_u0028_vf2_u003b((&param_5));\n    let _e128 = u[0u];\n    let _e130 = i;\n    param_6 = (_e130 + vec2<f32>(0f, 1f));\n    let _e132 = hash21_u0028_vf2_u003b((&param_6));\n    let _e133 = i;\n    param_7 = (_e133 + vec2<f32>(1f, 1f));\n    let _e135 = hash21_u0028_vf2_u003b((&param_7));\n    let _e137 = u[0u];\n    let _e140 = u[1u];\n    return mix(mix(_e123, _e126, _e128), mix(_e132, _e135, _e137), _e140);\n}\n\nfn main_1() {\n    var radius: f32;\n    var d: vec2<f32>;\n    var angle: f32;\n    var t_1: f32;\n    var inner: f32;\n    var param_8: vec2<f32>;\n    var outer: f32;\n    var param_9: vec2<f32>;\n    var swirl: f32;\n    var param_10: vec2<f32>;\n    var core: f32;\n    var corona: f32;\n    var body: f32;\n    var col: vec3<f32>;\n    var alpha: f32;\n    var fog: f32;\n    var param_11: f32;\n    var param_12: f32;\n    var param_13: vec3<f32>;\n    var phi_442_: bool;\n\n    let _e122 = unnamed.uClipEnabled;\n    let _e123 = (_e122 != 0i);\n    phi_442_ = _e123;\n    if _e123 {\n        let _e124 = vWorldPos_1;\n        let _e130 = unnamed.uClipPlane;\n        phi_442_ = (dot(vec4<f32>(_e124.x, _e124.y, _e124.z, 1f), _e130) < 0f);\n    }\n    let _e134 = phi_442_;\n    if _e134 {\n        discard;\n    }\n    let _e135 = vUv_1;\n    radius = (length((_e135 - vec2(0.5f))) * 2f);\n    let _e140 = radius;\n    if (_e140 >= 1f) {\n        discard;\n    }\n    let _e142 = vUv_1;\n    d = (_e142 - vec2(0.5f));\n    let _e146 = d[1u];\n    let _e148 = d[0u];\n    angle = atan2(_e146, _e148);\n    let _e151 = unnamed.uTime;\n    let _e152 = vSeed_1;\n    t_1 = (_e151 + (_e152 * 37f));\n    let _e155 = angle;\n    let _e157 = t_1;\n    let _e160 = radius;\n    param_8 = vec2<f32>(((_e155 * 1.9f) + (_e157 * 0.55f)), (_e160 * 4.2f));\n    let _e163 = valueNoise_u0028_vf2_u003b((&param_8));\n    inner = _e163;\n    let _e164 = angle;\n    let _e166 = t_1;\n    let _e169 = radius;\n    param_9 = vec2<f32>(((_e164 * 3.1f) - (_e166 * 0.34f)), (_e169 * 2.6f));\n    let _e172 = valueNoise_u0028_vf2_u003b((&param_9));\n    outer = _e172;\n    let _e173 = inner;\n    let _e175 = outer;\n    swirl = ((_e173 * 0.62f) + (_e175 * 0.38f));\n    let _e179 = unnamed.uNoiseOctaves;\n    if (_e179 > 1i) {\n        let _e181 = swirl;\n        let _e182 = swirl;\n        let _e183 = angle;\n        let _e185 = t_1;\n        let _e188 = radius;\n        param_10 = vec2<f32>(((_e183 * 6.3f) + (_e185 * 0.9f)), (_e188 * 8f));\n        let _e191 = valueNoise_u0028_vf2_u003b((&param_10));\n        swirl = mix(_e181, ((_e182 * _e191) * 2f), 0.35f);\n    }\n    let _e195 = radius;\n    core = (1f - smoothstep(0f, 0.28f, _e195));\n    let _e198 = radius;\n    let _e201 = swirl;\n    corona = ((1f - smoothstep(0.18f, 1f, _e198)) * (0.35f + (_e201 * 0.65f)));\n    let _e205 = core;\n    let _e207 = corona;\n    body = ((_e205 * 0.9f) + _e207);\n    let _e209 = body;\n    if (_e209 <= 0.02f) {\n        discard;\n    }\n    let _e212 = unnamed.uTint;\n    let _e215 = unnamed.uTint;\n    let _e216 = body;\n    col = mix((_e212 * 0.35f), _e215, vec3(smoothstep(0f, 0.55f, _e216)));\n    let _e220 = col;\n    let _e221 = body;\n    col = mix(_e220, vec3<f32>(1f, 1f, 1f), vec3(smoothstep(0.82f, 1.4f, _e221)));\n    let _e226 = unnamed.uTint;\n    let _e227 = col;\n    col = (_e227 * _e226);\n    let _e229 = body;\n    alpha = clamp((_e229 * 1.6f), 0f, 1f);\n    let _e232 = vDistance_1;\n    param_11 = _e232;\n    let _e234 = vWorldPos_1[1u];\n    param_12 = _e234;\n    let _e235 = mediumFog_u0028_f1_u003b_f1_u003b((&param_11), (&param_12));\n    fog = _e235;\n    let _e236 = col;\n    let _e237 = mediumColor_u0028_();\n    let _e238 = fog;\n    col = mix(_e236, _e237, vec3(_e238));\n    let _e241 = fog;\n    let _e243 = alpha;\n    alpha = (_e243 * (1f - _e241));\n    let _e245 = col;\n    param_13 = _e245;\n    let _e246 = applyOutputTransform_u0028_vf3_u003b((&param_13));\n    let _e247 = alpha;\n    outColor = vec4<f32>(_e246.x, _e246.y, _e246.z, _e247);\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(0) vUv: vec2<f32>, @location(1) vSeed: f32, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vUv_1 = vUv;\n    vSeed_1 = vSeed;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const ARCANE_BINDINGS = {
  "ARCANE_FRAG": {
    "uniforms": 1,
    "uniformSize": 144,
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
      },
      "uTint": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      }
    },
    "textures": {}
  }
} as const;
