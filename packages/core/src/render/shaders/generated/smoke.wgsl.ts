/*
 * Generated from ../smoke.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SMOKE_FRAG_WGSL = "struct Uniforms {\n    uTime: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uNoiseOctaves: i32,\n    uClipPlane: vec4<f32>,\n    uClipEnabled: i32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> vSeed_1: f32;\nvar<private> vUv_1: vec2<f32>;\nvar<private> vDistance_1: f32;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e113 = (*c);\n    low = (_e113 * 12.92f);\n    let _e115 = (*c);\n    high = ((pow(max(_e115, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e121 = high;\n    let _e122 = low;\n    let _e123 = (*c);\n    return mix(_e121, _e122, step(_e123, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e114 = (*c_1)[0u];\n    let _e116 = (*c_1)[1u];\n    let _e118 = (*c_1)[2u];\n    m = max(_e114, max(_e116, _e118));\n    let _e121 = m;\n    if (_e121 <= 0.8f) {\n        let _e123 = (*c_1);\n        return _e123;\n    }\n    let _e124 = m;\n    e = (_e124 - 0.8f);\n    let _e126 = (*c_1);\n    let _e127 = e;\n    let _e129 = e;\n    let _e133 = m;\n    return (_e126 * ((0.8f + ((0.2f * _e127) / (_e129 + 0.2f))) / _e133));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e113 = (*v);\n    let _e114 = (*v);\n    a = ((_e113 * (_e114 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e120 = (*v);\n    let _e121 = (*v);\n    b = ((_e120 * ((_e121 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e128 = a;\n    let _e129 = b;\n    return (_e128 / _e129);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e113 = unnamed.uOutputExposure;\n    let _e114 = (*x);\n    (*x) = (_e114 * _e113);\n    let _e116 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e116);\n    let _e118 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e118), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e115 = unnamed.uOutputTransform;\n    if (_e115 == 0i) {\n        let _e117 = (*c_2);\n        return _e117;\n    }\n    let _e119 = unnamed.uOutputTransform;\n    if (_e119 == 2i) {\n        let _e121 = (*c_2);\n        param_1 = _e121;\n        let _e122 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e122;\n    }\n    let _e124 = unnamed.uOutputTransform;\n    if (_e124 == 3i) {\n        let _e126 = (*c_2);\n        let _e128 = unnamed.uOutputExposure;\n        param_2 = (_e126 * _e128);\n        let _e130 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e130;\n    }\n    let _e131 = (*c_2);\n    param_3 = _e131;\n    let _e132 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e132;\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e124 = unnamed.uFogMode;\n    if (_e124 == 1i) {\n        let _e127 = unnamed.uFogFar;\n        let _e129 = unnamed.uFogNear;\n        span = max((_e127 - _e129), 0.0001f);\n        let _e132 = (*dist);\n        let _e134 = unnamed.uFogNear;\n        let _e136 = span;\n        ramp = clamp(((_e132 - _e134) / _e136), 0f, 1f);\n        let _e140 = unnamed.uUnderwaterFactor;\n        if (_e140 <= 0f) {\n            let _e142 = ramp;\n            return _e142;\n        }\n        let _e144 = unnamed.uUnderwaterFogDensity;\n        let _e145 = (*dist);\n        wetLinear = (_e144 * _e145);\n        let _e147 = ramp;\n        let _e148 = wetLinear;\n        let _e150 = wetLinear;\n        let _e156 = unnamed.uUnderwaterFactor;\n        return mix(_e147, (1f - exp2(((-(_e148) * _e150) * 1.442695f))), _e156);\n    }\n    let _e159 = unnamed.uFogNear;\n    let _e160 = (*dist);\n    start = min(_e159, _e160);\n    let _e162 = (*dist);\n    if (_e162 > 0f) {\n        let _e164 = start;\n        let _e165 = (*dist);\n        local = (_e164 / _e165);\n    } else {\n        local = 0f;\n    }\n    let _e167 = local;\n    before = _e167;\n    let _e168 = (*pointY);\n    let _e170 = unnamed.uFogEyeY;\n    let _e173 = unnamed.uFogHeightFalloff;\n    t = ((_e168 - _e170) * _e173);\n    let _e175 = t;\n    let _e176 = before;\n    rest = (_e175 * (1f - _e176));\n    let _e179 = rest;\n    let _e182 = rest;\n    denom = select(_e182, 0.0001f, (abs(_e179) < 0.0001f));\n    let _e185 = unnamed.uFogDensity;\n    let _e187 = t;\n    let _e189 = before;\n    let _e193 = (*dist);\n    let _e194 = start;\n    let _e197 = denom;\n    let _e202 = denom;\n    air = (1f - exp(((((-(_e185) * exp((-(_e187) * _e189))) * (_e193 - _e194)) * (1f - exp(-(_e197)))) / _e202)));\n    let _e207 = unnamed.uUnderwaterFactor;\n    if (_e207 <= 0f) {\n        let _e209 = air;\n        return _e209;\n    }\n    let _e211 = unnamed.uUnderwaterFogDensity;\n    let _e212 = (*dist);\n    wet = (_e211 * _e212);\n    let _e214 = air;\n    let _e215 = wet;\n    let _e217 = wet;\n    let _e223 = unnamed.uUnderwaterFactor;\n    return mix(_e214, (1f - exp2(((-(_e215) * _e217) * 1.442695f))), _e223);\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e111 = unnamed.uFogColor;\n    let _e113 = unnamed.uUnderwaterColor;\n    let _e115 = unnamed.uUnderwaterFactor;\n    return mix(_e111, _e113, vec3(_e115));\n}\n\nfn hash21_u0028_vf2_u003b(p: ptr<function, vec2<f32>>) -> f32 {\n    let _e111 = (*p);\n    return fract((sin(dot(_e111, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn valueNoise_u0028_vf2_u003b(p_1: ptr<function, vec2<f32>>) -> f32 {\n    var i: vec2<f32>;\n    var f: vec2<f32>;\n    var u: vec2<f32>;\n    var param_4: vec2<f32>;\n    var param_5: vec2<f32>;\n    var param_6: vec2<f32>;\n    var param_7: vec2<f32>;\n\n    let _e118 = (*p_1);\n    i = floor(_e118);\n    let _e120 = (*p_1);\n    f = fract(_e120);\n    let _e122 = f;\n    let _e123 = f;\n    let _e125 = f;\n    u = ((_e122 * _e123) * (vec2(3f) - (_e125 * 2f)));\n    let _e130 = i;\n    param_4 = _e130;\n    let _e131 = hash21_u0028_vf2_u003b((&param_4));\n    let _e132 = i;\n    param_5 = (_e132 + vec2<f32>(1f, 0f));\n    let _e134 = hash21_u0028_vf2_u003b((&param_5));\n    let _e136 = u[0u];\n    let _e138 = i;\n    param_6 = (_e138 + vec2<f32>(0f, 1f));\n    let _e140 = hash21_u0028_vf2_u003b((&param_6));\n    let _e141 = i;\n    param_7 = (_e141 + vec2<f32>(1f, 1f));\n    let _e143 = hash21_u0028_vf2_u003b((&param_7));\n    let _e145 = u[0u];\n    let _e148 = u[1u];\n    return mix(mix(_e131, _e134, _e136), mix(_e140, _e143, _e145), _e148);\n}\n\nfn billow_u0028_vf2_u003b_f1_u003b(p_2: ptr<function, vec2<f32>>, t_1: ptr<function, f32>) -> f32 {\n    var v_1: f32;\n    var param_8: vec2<f32>;\n    var param_9: vec2<f32>;\n    var param_10: vec2<f32>;\n\n    let _e116 = (*p_2);\n    let _e118 = (*t_1);\n    param_8 = ((_e116 * 2.2f) + vec2<f32>(0f, (-(_e118) * 0.55f)));\n    let _e123 = valueNoise_u0028_vf2_u003b((&param_8));\n    v_1 = (_e123 * 0.55f);\n    let _e126 = unnamed.uNoiseOctaves;\n    if (_e126 == 1i) {\n        let _e128 = v_1;\n        return (_e128 / 0.55f);\n    }\n    let _e130 = (*p_2);\n    let _e132 = (*t_1);\n    let _e134 = (*t_1);\n    param_9 = ((_e130 * 4.7f) + vec2<f32>((_e132 * 0.12f), (-(_e134) * 0.9f)));\n    let _e139 = valueNoise_u0028_vf2_u003b((&param_9));\n    let _e141 = v_1;\n    v_1 = (_e141 + (_e139 * 0.29f));\n    let _e144 = unnamed.uNoiseOctaves;\n    if (_e144 == 2i) {\n        let _e146 = v_1;\n        return (_e146 / 0.84f);\n    }\n    let _e148 = v_1;\n    let _e149 = (*p_2);\n    let _e151 = (*t_1);\n    let _e154 = (*t_1);\n    param_10 = ((_e149 * 9.3f) + vec2<f32>((-(_e151) * 0.09f), (-(_e154) * 1.4f)));\n    let _e159 = valueNoise_u0028_vf2_u003b((&param_10));\n    return (_e148 + (_e159 * 0.16f));\n}\n\nfn main_1() {\n    var t_2: f32;\n    var height: f32;\n    var spread: f32;\n    var centred: f32;\n    var sides: f32;\n    var drift: f32;\n    var param_11: vec2<f32>;\n    var n: f32;\n    var param_12: vec2<f32>;\n    var param_13: f32;\n    var density: f32;\n    var col: vec3<f32>;\n    var atmosphereColor: vec3<f32>;\n    var emerge: f32;\n    var dissipate: f32;\n    var fog: f32;\n    var param_14: f32;\n    var param_15: f32;\n    var alpha: f32;\n    var param_16: vec3<f32>;\n    var phi_517_: bool;\n\n    let _e131 = unnamed.uClipEnabled;\n    let _e132 = (_e131 != 0i);\n    phi_517_ = _e132;\n    if _e132 {\n        let _e133 = vWorldPos_1;\n        let _e139 = unnamed.uClipPlane;\n        phi_517_ = (dot(vec4<f32>(_e133.x, _e133.y, _e133.z, 1f), _e139) < 0f);\n    }\n    let _e143 = phi_517_;\n    if _e143 {\n        discard;\n    }\n    let _e145 = unnamed.uTime;\n    let _e146 = vSeed_1;\n    t_2 = (_e145 + (_e146 * 53f));\n    let _e150 = vUv_1[1u];\n    height = _e150;\n    let _e151 = height;\n    spread = mix(0.5f, 1f, _e151);\n    let _e154 = vUv_1[0u];\n    let _e156 = spread;\n    centred = (((_e154 - 0.5f) / _e156) + 0.5f);\n    let _e159 = centred;\n    sides = smoothstep(0f, 0.55f, (1f - clamp((abs((_e159 - 0.5f)) * 2f), 0f, 1f)));\n    let _e166 = sides;\n    if (_e166 <= 0.001f) {\n        discard;\n    }\n    let _e168 = t_2;\n    let _e170 = vSeed_1;\n    param_11 = vec2<f32>((_e168 * 0.21f), (_e170 * 7f));\n    let _e173 = valueNoise_u0028_vf2_u003b((&param_11));\n    let _e176 = height;\n    let _e178 = height;\n    drift = ((((_e173 - 0.5f) * 0.6f) * _e176) * _e178);\n    let _e180 = centred;\n    let _e181 = drift;\n    let _e183 = height;\n    param_12 = vec2<f32>((_e180 + _e181), _e183);\n    let _e185 = t_2;\n    param_13 = _e185;\n    let _e186 = billow_u0028_vf2_u003b_f1_u003b((&param_12), (&param_13));\n    n = _e186;\n    let _e187 = n;\n    let _e188 = sides;\n    let _e191 = height;\n    density = (((_e187 * _e188) * 1.35f) - (_e191 * 0.88f));\n    let _e194 = density;\n    if (_e194 <= 0.02f) {\n        discard;\n    }\n    let _e196 = height;\n    col = mix(vec3<f32>(0.9f, 0.42f, 0.16f), vec3<f32>(0.11f, 0.1f, 0.1f), vec3(smoothstep(0f, 0.34f, _e196)));\n    let _e200 = mediumColor_u0028_();\n    atmosphereColor = _e200;\n    let _e201 = col;\n    let _e202 = atmosphereColor;\n    let _e203 = height;\n    col = mix(_e201, _e202, vec3(smoothstep(0.3f, 0.95f, _e203)));\n    let _e207 = height;\n    emerge = smoothstep(0f, 0.3f, _e207);\n    let _e209 = height;\n    dissipate = (1f - smoothstep(0.22f, 0.75f, _e209));\n    let _e212 = vDistance_1;\n    param_14 = _e212;\n    let _e214 = vWorldPos_1[1u];\n    param_15 = _e214;\n    let _e215 = mediumFog_u0028_f1_u003b_f1_u003b((&param_14), (&param_15));\n    fog = _e215;\n    let _e216 = col;\n    let _e217 = atmosphereColor;\n    let _e218 = fog;\n    col = mix(_e216, _e217, vec3(_e218));\n    let _e221 = density;\n    let _e224 = emerge;\n    let _e226 = dissipate;\n    alpha = (((clamp((_e221 * 0.95f), 0f, 1f) * _e224) * _e226) * 0.13f);\n    let _e229 = col;\n    param_16 = _e229;\n    let _e230 = applyOutputTransform_u0028_vf3_u003b((&param_16));\n    let _e231 = alpha;\n    let _e232 = fog;\n    outColor = vec4<f32>(_e230.x, _e230.y, _e230.z, (_e231 * (1f - _e232)));\n    return;\n}\n\n@fragment \nfn main(@location(3) vWorldPos: vec3<f32>, @location(1) vSeed: f32, @location(0) vUv: vec2<f32>, @location(2) vDistance: f32) -> @location(0) vec4<f32> {\n    vWorldPos_1 = vWorldPos;\n    vSeed_1 = vSeed;\n    vUv_1 = vUv;\n    vDistance_1 = vDistance;\n    main_1();\n    let _e9 = outColor;\n    return _e9;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SMOKE_BINDINGS = {
  "SMOKE_FRAG": {
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
  }
} as const;
