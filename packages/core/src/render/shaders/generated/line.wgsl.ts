/*
 * Generated from ../line.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const LINE_FRAG_WGSL = "struct Uniforms {\n    uColor: vec3<f32>,\n    uOpacity: f32,\n    uCameraPos: vec3<f32>,\n    uSoftness: f32,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vSide_1: f32;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e71 = (*c);\n    low = (_e71 * 12.92f);\n    let _e73 = (*c);\n    high = ((pow(max(_e73, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e79 = high;\n    let _e80 = low;\n    let _e81 = (*c);\n    return mix(_e79, _e80, step(_e81, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e72 = (*c_1)[0u];\n    let _e74 = (*c_1)[1u];\n    let _e76 = (*c_1)[2u];\n    m = max(_e72, max(_e74, _e76));\n    let _e79 = m;\n    if (_e79 <= 0.8f) {\n        let _e81 = (*c_1);\n        return _e81;\n    }\n    let _e82 = m;\n    e = (_e82 - 0.8f);\n    let _e84 = (*c_1);\n    let _e85 = e;\n    let _e87 = e;\n    let _e91 = m;\n    return (_e84 * ((0.8f + ((0.2f * _e85) / (_e87 + 0.2f))) / _e91));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e71 = (*v);\n    let _e72 = (*v);\n    a = ((_e71 * (_e72 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e78 = (*v);\n    let _e79 = (*v);\n    b = ((_e78 * ((_e79 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e86 = a;\n    let _e87 = b;\n    return (_e86 / _e87);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e71 = unnamed.uOutputExposure;\n    let _e72 = (*x);\n    (*x) = (_e72 * _e71);\n    let _e74 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e74);\n    let _e76 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e76), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e73 = unnamed.uOutputTransform;\n    if (_e73 == 0i) {\n        let _e75 = (*c_2);\n        return _e75;\n    }\n    let _e77 = unnamed.uOutputTransform;\n    if (_e77 == 2i) {\n        let _e79 = (*c_2);\n        param_1 = _e79;\n        let _e80 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e80;\n    }\n    let _e82 = unnamed.uOutputTransform;\n    if (_e82 == 3i) {\n        let _e84 = (*c_2);\n        let _e86 = unnamed.uOutputExposure;\n        param_2 = (_e84 * _e86);\n        let _e88 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e88;\n    }\n    let _e89 = (*c_2);\n    param_3 = _e89;\n    let _e90 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e90;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e69 = unnamed.uFogColor;\n    let _e71 = unnamed.uUnderwaterColor;\n    let _e73 = unnamed.uUnderwaterFactor;\n    return mix(_e69, _e71, vec3(_e73));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e82 = unnamed.uFogMode;\n    if (_e82 == 1i) {\n        let _e85 = unnamed.uFogFar;\n        let _e87 = unnamed.uFogNear;\n        span = max((_e85 - _e87), 0.0001f);\n        let _e90 = (*dist);\n        let _e92 = unnamed.uFogNear;\n        let _e94 = span;\n        ramp = clamp(((_e90 - _e92) / _e94), 0f, 1f);\n        let _e98 = unnamed.uUnderwaterFactor;\n        if (_e98 <= 0f) {\n            let _e100 = ramp;\n            return _e100;\n        }\n        let _e102 = unnamed.uUnderwaterFogDensity;\n        let _e103 = (*dist);\n        wetLinear = (_e102 * _e103);\n        let _e105 = ramp;\n        let _e106 = wetLinear;\n        let _e108 = wetLinear;\n        let _e114 = unnamed.uUnderwaterFactor;\n        return mix(_e105, (1f - exp2(((-(_e106) * _e108) * 1.442695f))), _e114);\n    }\n    let _e117 = unnamed.uFogNear;\n    let _e118 = (*dist);\n    start = min(_e117, _e118);\n    let _e120 = (*dist);\n    if (_e120 > 0f) {\n        let _e122 = start;\n        let _e123 = (*dist);\n        local = (_e122 / _e123);\n    } else {\n        local = 0f;\n    }\n    let _e125 = local;\n    before = _e125;\n    let _e126 = (*pointY);\n    let _e128 = unnamed.uFogEyeY;\n    let _e131 = unnamed.uFogHeightFalloff;\n    t = ((_e126 - _e128) * _e131);\n    let _e133 = t;\n    let _e134 = before;\n    rest = (_e133 * (1f - _e134));\n    let _e137 = rest;\n    let _e140 = rest;\n    denom = select(_e140, 0.0001f, (abs(_e137) < 0.0001f));\n    let _e143 = unnamed.uFogDensity;\n    let _e145 = t;\n    let _e147 = before;\n    let _e151 = (*dist);\n    let _e152 = start;\n    let _e155 = denom;\n    let _e160 = denom;\n    air = (1f - exp(((((-(_e143) * exp((-(_e145) * _e147))) * (_e151 - _e152)) * (1f - exp(-(_e155)))) / _e160)));\n    let _e165 = unnamed.uUnderwaterFactor;\n    if (_e165 <= 0f) {\n        let _e167 = air;\n        return _e167;\n    }\n    let _e169 = unnamed.uUnderwaterFogDensity;\n    let _e170 = (*dist);\n    wet = (_e169 * _e170);\n    let _e172 = air;\n    let _e173 = wet;\n    let _e175 = wet;\n    let _e181 = unnamed.uUnderwaterFactor;\n    return mix(_e172, (1f - exp2(((-(_e173) * _e175) * 1.442695f))), _e181);\n}\n\nfn main_1() {\n    var edge: f32;\n    var band: f32;\n    var coverage: f32;\n    var fog: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var color: vec3<f32>;\n    var param_6: vec3<f32>;\n\n    let _e76 = vSide_1;\n    edge = (1f - abs(_e76));\n    let _e79 = vSide_1;\n    let _e80 = fwidth(_e79);\n    let _e82 = unnamed.uSoftness;\n    band = max(_e80, _e82);\n    let _e84 = band;\n    let _e85 = edge;\n    coverage = smoothstep(0f, _e84, _e85);\n    let _e87 = vWorldPos_1;\n    let _e89 = unnamed.uCameraPos;\n    param_4 = distance(_e87, _e89);\n    let _e92 = vWorldPos_1[1u];\n    param_5 = _e92;\n    let _e93 = mediumFog_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    fog = _e93;\n    let _e95 = unnamed.uColor;\n    let _e96 = mediumColor_u0028_();\n    let _e97 = fog;\n    color = mix(_e95, _e96, vec3(_e97));\n    let _e100 = color;\n    param_6 = _e100;\n    let _e101 = applyOutputTransform_u0028_vf3_u003b((&param_6));\n    let _e102 = coverage;\n    let _e104 = unnamed.uOpacity;\n    outColor = vec4<f32>(_e101.x, _e101.y, _e101.z, (_e102 * _e104));\n    return;\n}\n\n@fragment \nfn main(@location(0) vSide: f32, @location(1) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vSide_1 = vSide;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e5 = outColor;\n    return _e5;\n}\n";

export const LINE_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uWidth: f32,\n    uMinWidthPerMetre: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: f32,\n    @location(1) member_1: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aFrom_1: vec3<f32>;\nvar<private> aTo_1: vec3<f32>;\nvar<private> aCorner_1: vec2<f32>;\nvar<private> vSide: f32;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var from_: vec3<f32>;\n    var to: vec3<f32>;\n    var mid: vec3<f32>;\n    var dir: vec3<f32>;\n    var len: f32;\n    var local: vec3<f32>;\n    var view: vec3<f32>;\n    var dist: f32;\n    var local_1: vec3<f32>;\n    var across: vec3<f32>;\n    var span: f32;\n    var local_2: vec3<f32>;\n    var halfWidth: f32;\n    var world: vec3<f32>;\n\n    let _e37 = unnamed.uModel;\n    let _e38 = aFrom_1;\n    from_ = (_e37 * vec4<f32>(_e38.x, _e38.y, _e38.z, 1f)).xyz;\n    let _e46 = unnamed.uModel;\n    let _e47 = aTo_1;\n    to = (_e46 * vec4<f32>(_e47.x, _e47.y, _e47.z, 1f)).xyz;\n    let _e54 = from_;\n    let _e55 = to;\n    let _e57 = aCorner_1[0u];\n    mid = mix(_e54, _e55, vec3(_e57));\n    let _e60 = to;\n    let _e61 = from_;\n    dir = (_e60 - _e61);\n    let _e63 = dir;\n    len = length(_e63);\n    let _e65 = len;\n    if (_e65 > 0.000001f) {\n        let _e67 = dir;\n        let _e68 = len;\n        local = (_e67 / vec3(_e68));\n    } else {\n        local = vec3<f32>(0f, 1f, 0f);\n    }\n    let _e71 = local;\n    dir = _e71;\n    let _e72 = mid;\n    let _e74 = unnamed.uCameraPos;\n    view = (_e72 - _e74);\n    let _e76 = view;\n    dist = length(_e76);\n    let _e78 = dist;\n    if (_e78 > 0.000001f) {\n        let _e80 = view;\n        let _e81 = dist;\n        local_1 = (_e80 / vec3(_e81));\n    } else {\n        local_1 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e84 = local_1;\n    view = _e84;\n    let _e85 = dir;\n    let _e86 = view;\n    across = cross(_e85, _e86);\n    let _e88 = across;\n    span = length(_e88);\n    let _e90 = span;\n    if (_e90 > 0.0001f) {\n        let _e92 = across;\n        let _e93 = span;\n        local_2 = (_e92 / vec3(_e93));\n    } else {\n        let _e96 = dir;\n        local_2 = normalize((cross(_e96, vec3<f32>(0f, 1f, 0f)) + vec3<f32>(0.001f, 0.001f, 0.001f)));\n    }\n    let _e100 = local_2;\n    across = _e100;\n    let _e102 = unnamed.uWidth;\n    let _e103 = dist;\n    let _e105 = unnamed.uMinWidthPerMetre;\n    halfWidth = max(_e102, (_e103 * _e105));\n    let _e108 = mid;\n    let _e109 = across;\n    let _e111 = aCorner_1[1u];\n    let _e113 = halfWidth;\n    world = (_e108 + ((_e109 * _e111) * _e113));\n    let _e117 = aCorner_1[1u];\n    vSide = _e117;\n    let _e118 = world;\n    vWorldPos = _e118;\n    let _e120 = unnamed.uViewProj;\n    let _e121 = world;\n    unnamed_1.gl_Position = (_e120 * vec4<f32>(_e121.x, _e121.y, _e121.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(0) aFrom: vec3<f32>, @location(1) aTo: vec3<f32>, @location(2) aCorner: vec2<f32>) -> VertexOutput {\n    aFrom_1 = aFrom;\n    aTo_1 = aTo;\n    aCorner_1 = aCorner;\n    main_1();\n    let _e11 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e11);\n    let _e13 = vSide;\n    let _e14 = vWorldPos;\n    let _e15 = unnamed_1.gl_Position;\n    return VertexOutput(_e13, _e14, _e15);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const LINE_BINDINGS = {
  "LINE_FRAG": {
    "uniforms": 1,
    "uniformSize": 112,
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
      "uFogDensity": {
        "offset": 44,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 48,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 52,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 84,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 88,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 96,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 100,
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
