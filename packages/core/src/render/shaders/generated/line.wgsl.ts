/*
 * Generated from ../line.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const LINE_FRAG_WGSL = "struct Uniforms {\n    uColor: vec3<f32>,\n    uOpacity: f32,\n    uCameraPos: vec3<f32>,\n    uSoftness: f32,\n    uFogColor: vec3<f32>,\n    uFogMedium: vec4<f32>,\n    uFogRange: vec4<f32>,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFactor: f32,\n    uFogLayer2_: vec4<f32>,\n    uFogGlow: vec4<f32>,\n    uFogGlowDir: vec4<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vSide_1: f32;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e70 = (*c);\n    low = (_e70 * 12.92f);\n    let _e72 = (*c);\n    high = ((pow(max(_e72, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e78 = high;\n    let _e79 = low;\n    let _e80 = (*c);\n    return mix(_e78, _e79, step(_e80, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e71 = (*c_1)[0u];\n    let _e73 = (*c_1)[1u];\n    let _e75 = (*c_1)[2u];\n    m = max(_e71, max(_e73, _e75));\n    let _e78 = m;\n    if (_e78 <= 0.8f) {\n        let _e80 = (*c_1);\n        return _e80;\n    }\n    let _e81 = m;\n    e = (_e81 - 0.8f);\n    let _e83 = (*c_1);\n    let _e84 = e;\n    let _e86 = e;\n    let _e90 = m;\n    return (_e83 * ((0.8f + ((0.2f * _e84) / (_e86 + 0.2f))) / _e90));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e70 = (*v);\n    let _e71 = (*v);\n    a = ((_e70 * (_e71 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e77 = (*v);\n    let _e78 = (*v);\n    b = ((_e77 * ((_e78 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e85 = a;\n    let _e86 = b;\n    return (_e85 / _e86);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e70 = unnamed.uOutputExposure;\n    let _e71 = (*x);\n    (*x) = (_e71 * _e70);\n    let _e73 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e73);\n    let _e75 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e75), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e72 = unnamed.uOutputTransform;\n    if (_e72 == 0i) {\n        let _e74 = (*c_2);\n        return _e74;\n    }\n    let _e76 = unnamed.uOutputTransform;\n    if (_e76 == 2i) {\n        let _e78 = (*c_2);\n        param_1 = _e78;\n        let _e79 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e79;\n    }\n    let _e81 = unnamed.uOutputTransform;\n    if (_e81 == 3i) {\n        let _e83 = (*c_2);\n        let _e85 = unnamed.uOutputExposure;\n        param_2 = (_e83 * _e85);\n        let _e87 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e87;\n    }\n    let _e88 = (*c_2);\n    param_3 = _e88;\n    let _e89 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e89;\n}\n\nfn hazeDepth_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var depth: f32;\n    var t2_: f32;\n    var rest2_: f32;\n    var denom2_: f32;\n\n    let _e81 = unnamed.uFogRange[0u];\n    let _e82 = (*dist);\n    start = min(_e81, _e82);\n    let _e84 = (*dist);\n    if (_e84 > 0f) {\n        let _e86 = start;\n        let _e87 = (*dist);\n        local = (_e86 / _e87);\n    } else {\n        local = 0f;\n    }\n    let _e89 = local;\n    before = _e89;\n    let _e90 = (*pointY);\n    let _e93 = unnamed.uFogMedium[2u];\n    let _e97 = unnamed.uFogMedium[1u];\n    t = ((_e90 - _e93) * _e97);\n    let _e99 = t;\n    let _e100 = before;\n    rest = (_e99 * (1f - _e100));\n    let _e103 = rest;\n    let _e106 = rest;\n    denom = select(_e106, 0.0001f, (abs(_e103) < 0.0001f));\n    let _e110 = unnamed.uFogMedium[0u];\n    let _e111 = t;\n    let _e113 = before;\n    let _e117 = (*dist);\n    let _e118 = start;\n    let _e121 = denom;\n    let _e126 = denom;\n    depth = ((((_e110 * exp((-(_e111) * _e113))) * (_e117 - _e118)) * (1f - exp(-(_e121)))) / _e126);\n    let _e130 = unnamed.uFogLayer2_[0u];\n    if (_e130 > 0f) {\n        let _e132 = (*pointY);\n        let _e135 = unnamed.uFogMedium[2u];\n        let _e139 = unnamed.uFogLayer2_[1u];\n        t2_ = ((_e132 - _e135) * _e139);\n        let _e141 = t2_;\n        let _e142 = before;\n        rest2_ = (_e141 * (1f - _e142));\n        let _e145 = rest2_;\n        let _e148 = rest2_;\n        denom2_ = select(_e148, 0.0001f, (abs(_e145) < 0.0001f));\n        let _e152 = unnamed.uFogLayer2_[0u];\n        let _e153 = t2_;\n        let _e155 = before;\n        let _e159 = (*dist);\n        let _e160 = start;\n        let _e163 = denom2_;\n        let _e168 = denom2_;\n        let _e170 = depth;\n        depth = (_e170 + ((((_e152 * exp((-(_e153) * _e155))) * (_e159 - _e160)) * (1f - exp(-(_e163)))) / _e168));\n    }\n    let _e172 = depth;\n    return _e172;\n}\n\nfn mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b(dist_1: ptr<function, f32>, pointY_1: ptr<function, f32>, toPoint: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var span: f32;\n    var perMetre: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var hidden: f32;\n    var lobe: f32;\n    var phi_305_: bool;\n    var phi_319_: bool;\n\n    let _e78 = unnamed.uFogRange[2u];\n    let _e79 = (_e78 == 1f);\n    phi_305_ = _e79;\n    if !(_e79) {\n        let _e83 = unnamed.uFogGlow[0u];\n        let _e86 = unnamed.uFogGlow[1u];\n        let _e90 = unnamed.uFogGlow[2u];\n        phi_305_ = (max(max(_e83, _e86), _e90) <= 0f);\n    }\n    let _e94 = phi_305_;\n    if _e94 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e97 = unnamed.uFogLayer2_[3u];\n    let _e98 = (_e97 > 0f);\n    phi_319_ = _e98;\n    if _e98 {\n        let _e99 = (*dist_1);\n        let _e102 = unnamed.uFogLayer2_[3u];\n        phi_319_ = (_e99 > _e102);\n    }\n    let _e105 = phi_319_;\n    if _e105 {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e106 = (*dist_1);\n    let _e109 = unnamed.uFogRange[0u];\n    let _e110 = (*dist_1);\n    span = (_e106 - min(_e109, _e110));\n    let _e113 = span;\n    if (_e113 <= 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e115 = (*dist_1);\n    param_4 = _e115;\n    let _e116 = (*pointY_1);\n    param_5 = _e116;\n    let _e117 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    let _e118 = span;\n    perMetre = (_e117 / _e118);\n    let _e120 = perMetre;\n    let _e122 = span;\n    let _e125 = unnamed.uFogGlowDir[3u];\n    hidden = (1f - exp((-(_e120) * max((_e122 - _e125), 0f))));\n    let _e131 = (*toPoint);\n    let _e133 = unnamed.uFogGlowDir;\n    let _e139 = unnamed.uFogGlow[3u];\n    lobe = pow(clamp(dot(_e131, _e133.xyz), 0f, 1f), _e139);\n    let _e142 = unnamed.uFogGlow;\n    let _e144 = lobe;\n    let _e145 = hidden;\n    let _e148 = unnamed.uUnderwaterFactor;\n    return (_e142.xyz * ((_e144 * _e145) * (1f - _e148)));\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e68 = unnamed.uFogColor;\n    let _e70 = unnamed.uUnderwaterColor;\n    let _e72 = unnamed.uUnderwaterFactor;\n    return mix(_e68, _e70, vec3(_e72));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist_2: ptr<function, f32>, pointY_2: ptr<function, f32>) -> f32 {\n    var cut: bool;\n    var span_1: f32;\n    var ramp: f32;\n    var local_1: f32;\n    var wetLinear: f32;\n    var air: f32;\n    var local_2: f32;\n    var param_6: f32;\n    var param_7: f32;\n    var wet: f32;\n    var phi_190_: bool;\n\n    let _e81 = unnamed.uFogLayer2_[3u];\n    let _e82 = (_e81 > 0f);\n    phi_190_ = _e82;\n    if _e82 {\n        let _e83 = (*dist_2);\n        let _e86 = unnamed.uFogLayer2_[3u];\n        phi_190_ = (_e83 > _e86);\n    }\n    let _e89 = phi_190_;\n    cut = _e89;\n    let _e92 = unnamed.uFogRange[2u];\n    if (_e92 == 1f) {\n        let _e96 = unnamed.uFogRange[1u];\n        let _e99 = unnamed.uFogRange[0u];\n        span_1 = max((_e96 - _e99), 0.0001f);\n        let _e102 = cut;\n        if _e102 {\n            local_1 = 0f;\n        } else {\n            let _e103 = (*dist_2);\n            let _e106 = unnamed.uFogRange[0u];\n            let _e108 = span_1;\n            let _e113 = unnamed.uFogLayer2_[2u];\n            local_1 = min(clamp(((_e103 - _e106) / _e108), 0f, 1f), (1f - _e113));\n        }\n        let _e116 = local_1;\n        ramp = _e116;\n        let _e118 = unnamed.uUnderwaterFactor;\n        if (_e118 <= 0f) {\n            let _e120 = ramp;\n            return _e120;\n        }\n        let _e123 = unnamed.uFogMedium[3u];\n        let _e124 = (*dist_2);\n        wetLinear = (_e123 * _e124);\n        let _e126 = ramp;\n        let _e127 = wetLinear;\n        let _e129 = wetLinear;\n        let _e135 = unnamed.uUnderwaterFactor;\n        return mix(_e126, (1f - exp2(((-(_e127) * _e129) * 1.442695f))), _e135);\n    }\n    let _e137 = cut;\n    if _e137 {\n        local_2 = 0f;\n    } else {\n        let _e138 = (*dist_2);\n        param_6 = _e138;\n        let _e139 = (*pointY_2);\n        param_7 = _e139;\n        let _e140 = hazeDepth_u0028_f1_u003b_f1_u003b((&param_6), (&param_7));\n        let _e145 = unnamed.uFogLayer2_[2u];\n        local_2 = (1f - max(exp(-(_e140)), _e145));\n    }\n    let _e148 = local_2;\n    air = _e148;\n    let _e150 = unnamed.uUnderwaterFactor;\n    if (_e150 <= 0f) {\n        let _e152 = air;\n        return _e152;\n    }\n    let _e155 = unnamed.uFogMedium[3u];\n    let _e156 = (*dist_2);\n    wet = (_e155 * _e156);\n    let _e158 = air;\n    let _e159 = wet;\n    let _e161 = wet;\n    let _e167 = unnamed.uUnderwaterFactor;\n    return mix(_e158, (1f - exp2(((-(_e159) * _e161) * 1.442695f))), _e167);\n}\n\nfn main_1() {\n    var edge: f32;\n    var band: f32;\n    var coverage: f32;\n    var dist_3: f32;\n    var fog: f32;\n    var param_8: f32;\n    var param_9: f32;\n    var color: vec3<f32>;\n    var param_10: f32;\n    var param_11: f32;\n    var param_12: vec3<f32>;\n    var param_13: vec3<f32>;\n\n    let _e79 = vSide_1;\n    edge = (1f - abs(_e79));\n    let _e82 = vSide_1;\n    let _e83 = fwidth(_e82);\n    let _e85 = unnamed.uSoftness;\n    band = max(_e83, _e85);\n    let _e87 = band;\n    let _e88 = edge;\n    coverage = smoothstep(0f, _e87, _e88);\n    let _e90 = vWorldPos_1;\n    let _e92 = unnamed.uCameraPos;\n    dist_3 = distance(_e90, _e92);\n    let _e94 = dist_3;\n    param_8 = _e94;\n    let _e96 = vWorldPos_1[1u];\n    param_9 = _e96;\n    let _e97 = mediumFog_u0028_f1_u003b_f1_u003b((&param_8), (&param_9));\n    fog = _e97;\n    let _e99 = unnamed.uColor;\n    let _e100 = mediumColor_u0028_();\n    let _e101 = fog;\n    let _e104 = vWorldPos_1;\n    let _e106 = unnamed.uCameraPos;\n    let _e109 = dist_3;\n    param_10 = _e109;\n    let _e111 = vWorldPos_1[1u];\n    param_11 = _e111;\n    param_12 = normalize((_e104 - _e106));\n    let _e112 = mediumGlow_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_10), (&param_11), (&param_12));\n    color = (mix(_e99, _e100, vec3(_e101)) + _e112);\n    let _e114 = color;\n    param_13 = _e114;\n    let _e115 = applyOutputTransform_u0028_vf3_u003b((&param_13));\n    let _e116 = coverage;\n    let _e118 = unnamed.uOpacity;\n    outColor = vec4<f32>(_e115.x, _e115.y, _e115.z, (_e116 * _e118));\n    return;\n}\n\n@fragment \nfn main(@location(0) vSide: f32, @location(1) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vSide_1 = vSide;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e5 = outColor;\n    return _e5;\n}\n";

export const LINE_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uWidth: f32,\n    uMinWidthPerMetre: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: f32,\n    @location(1) member_1: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aFrom_1: vec3<f32>;\nvar<private> aTo_1: vec3<f32>;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vSide: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var from_: vec3<f32>;\n    var to: vec3<f32>;\n    var mid: vec3<f32>;\n    var dir: vec3<f32>;\n    var len: f32;\n    var local: vec3<f32>;\n    var view: vec3<f32>;\n    var dist: f32;\n    var local_1: vec3<f32>;\n    var across: vec3<f32>;\n    var span: f32;\n    var local_2: vec3<f32>;\n    var halfWidth: f32;\n    var world: vec3<f32>;\n\n    let _e37 = unnamed.uModel;\n    let _e38 = aFrom_1;\n    from_ = (_e37 * vec4<f32>(_e38.x, _e38.y, _e38.z, 1f)).xyz;\n    let _e46 = unnamed.uModel;\n    let _e47 = aTo_1;\n    to = (_e46 * vec4<f32>(_e47.x, _e47.y, _e47.z, 1f)).xyz;\n    let _e54 = from_;\n    let _e55 = to;\n    let _e57 = aCorner_1[0u];\n    mid = mix(_e54, _e55, vec3(_e57));\n    let _e60 = to;\n    let _e61 = from_;\n    dir = (_e60 - _e61);\n    let _e63 = dir;\n    len = length(_e63);\n    let _e65 = len;\n    if (_e65 > 0.000001f) {\n        let _e67 = dir;\n        let _e68 = len;\n        local = (_e67 / vec3(_e68));\n    } else {\n        local = vec3<f32>(0f, 1f, 0f);\n    }\n    let _e71 = local;\n    dir = _e71;\n    let _e72 = mid;\n    let _e74 = unnamed.uCameraPos;\n    view = (_e72 - _e74);\n    let _e76 = view;\n    dist = length(_e76);\n    let _e78 = dist;\n    if (_e78 > 0.000001f) {\n        let _e80 = view;\n        let _e81 = dist;\n        local_1 = (_e80 / vec3(_e81));\n    } else {\n        local_1 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e84 = local_1;\n    view = _e84;\n    let _e85 = dir;\n    let _e86 = view;\n    across = cross(_e85, _e86);\n    let _e88 = across;\n    span = length(_e88);\n    let _e90 = span;\n    if (_e90 > 0.0001f) {\n        let _e92 = across;\n        let _e93 = span;\n        local_2 = (_e92 / vec3(_e93));\n    } else {\n        let _e96 = dir;\n        local_2 = normalize((cross(_e96, vec3<f32>(0f, 1f, 0f)) + vec3<f32>(0.001f, 0.001f, 0.001f)));\n    }\n    let _e100 = local_2;\n    across = _e100;\n    let _e102 = unnamed.uWidth;\n    let _e103 = dist;\n    let _e105 = unnamed.uMinWidthPerMetre;\n    halfWidth = max(_e102, (_e103 * _e105));\n    let _e108 = mid;\n    let _e109 = across;\n    let _e111 = aCorner_1[1u];\n    let _e113 = halfWidth;\n    world = (_e108 + ((_e109 * _e111) * _e113));\n    let _e117 = aCorner_1[1u];\n    vSide = _e117;\n    let _e118 = world;\n    vWorldPos = _e118;\n    let _e120 = unnamed.uViewProj;\n    let _e121 = world;\n    unnamed_1.gl_Position = (_e120 * vec4<f32>(_e121.x, _e121.y, _e121.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aFrom: vec3<f32>, @location(1) aTo: vec3<f32>, @location(2) aCorner: vec2<f32>) -> VertexOutput {\n    aFrom_1 = aFrom;\n    aTo_1 = aTo;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e11 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e11);\n    let _e13 = vSide;\n    let _e14 = vWorldPos;\n    let _e15 = unnamed_1.gl_Position;\n    return VertexOutput(_e13, _e14, _e15);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const LINE_BINDINGS = {
  "LINE_FRAG": {
    "uniforms": 1,
    "uniformSize": 160,
    "fields": {
      "uColor": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uOpacity": {
        "offset": 12,
        "size": 4,
        "type": "float"
      },
      "uCameraPos": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uSoftness": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uFogColor": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uFogMedium": {
        "offset": 48,
        "size": 16,
        "type": "vec4"
      },
      "uFogRange": {
        "offset": 64,
        "size": 16,
        "type": "vec4"
      },
      "uUnderwaterColor": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFactor": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uFogLayer2": {
        "offset": 96,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlow": {
        "offset": 112,
        "size": 16,
        "type": "vec4"
      },
      "uFogGlowDir": {
        "offset": 128,
        "size": 16,
        "type": "vec4"
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
  "LINE_VERT": {
    "uniforms": 0,
    "uniformSize": 160,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uModel": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 128,
        "size": 12,
        "type": "vec3"
      },
      "uWidth": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uMinWidthPerMetre": {
        "offset": 144,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
