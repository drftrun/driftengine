/*
 * Generated from ../text.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const TEXT_FRAG_WGSL = "struct Uniforms {\n    uColor: vec3<f32>,\n    uGlow: f32,\n    uAlpha: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vChar_1: f32;\nvar<private> fragColor: vec4<f32>;\nvar<private> vDepth_1: f32;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e65 = (*c);\n    low = (_e65 * 12.92f);\n    let _e67 = (*c);\n    high = ((pow(max(_e67, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e73 = high;\n    let _e74 = low;\n    let _e75 = (*c);\n    return mix(_e73, _e74, step(_e75, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e66 = (*c_1)[0u];\n    let _e68 = (*c_1)[1u];\n    let _e70 = (*c_1)[2u];\n    m = max(_e66, max(_e68, _e70));\n    let _e73 = m;\n    if (_e73 <= 0.8f) {\n        let _e75 = (*c_1);\n        return _e75;\n    }\n    let _e76 = m;\n    e = (_e76 - 0.8f);\n    let _e78 = (*c_1);\n    let _e79 = e;\n    let _e81 = e;\n    let _e85 = m;\n    return (_e78 * ((0.8f + ((0.2f * _e79) / (_e81 + 0.2f))) / _e85));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e65 = (*v);\n    let _e66 = (*v);\n    a = ((_e65 * (_e66 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e72 = (*v);\n    let _e73 = (*v);\n    b = ((_e72 * ((_e73 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e80 = a;\n    let _e81 = b;\n    return (_e80 / _e81);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e65 = unnamed.uOutputExposure;\n    let _e66 = (*x);\n    (*x) = (_e66 * _e65);\n    let _e68 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e68);\n    let _e70 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e70), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e67 = unnamed.uOutputTransform;\n    if (_e67 == 0i) {\n        let _e69 = (*c_2);\n        return _e69;\n    }\n    let _e71 = unnamed.uOutputTransform;\n    if (_e71 == 2i) {\n        let _e73 = (*c_2);\n        param_1 = _e73;\n        let _e74 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e74;\n    }\n    let _e76 = unnamed.uOutputTransform;\n    if (_e76 == 3i) {\n        let _e78 = (*c_2);\n        let _e80 = unnamed.uOutputExposure;\n        param_2 = (_e78 * _e80);\n        let _e82 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e82;\n    }\n    let _e83 = (*c_2);\n    param_3 = _e83;\n    let _e84 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e84;\n}\n\nfn main_1() {\n    var key: vec3<f32>;\n    var lambert: f32;\n    var lit: vec3<f32>;\n    var emissive: vec3<f32>;\n    var param_4: vec3<f32>;\n\n    key = vec3<f32>(-0.3549141f, 0.7098282f, 0.6084241f);\n    let _e67 = vNormal_1;\n    let _e69 = key;\n    lambert = (0.55f + (0.45f * max(dot(normalize(_e67), _e69), 0f)));\n    let _e75 = unnamed.uColor;\n    let _e76 = lambert;\n    lit = (_e75 * _e76);\n    let _e79 = unnamed.uColor;\n    let _e81 = unnamed.uGlow;\n    let _e83 = vChar_1;\n    emissive = ((_e79 * _e81) * (0.45f + (0.55f * _e83)));\n    let _e87 = lit;\n    let _e88 = emissive;\n    param_4 = (_e87 + _e88);\n    let _e90 = applyOutputTransform_u0028_vf3_u003b((&param_4));\n    let _e92 = unnamed.uAlpha;\n    fragColor = vec4<f32>(_e90.x, _e90.y, _e90.z, _e92);\n    return;\n}\n\n@fragment \nfn main(@location(0) vNormal: vec3<f32>, @location(2) vChar: f32, @location(1) vDepth: f32) -> @location(0) vec4<f32> {\n    vNormal_1 = vNormal;\n    vChar_1 = vChar;\n    vDepth_1 = vDepth;\n    main_1();\n    let _e7 = fragColor;\n    return _e7;\n}\n";

export const TEXT_VERT_WGSL = "struct Uniforms {\n    uViewport: vec2<f32>,\n    uOrigin: vec2<f32>,\n    uCellSize: f32,\n    uDepth: f32,\n    uReveal: f32,\n    uCharCount: f32,\n    uCharOffset: f32,\n    uSpin: f32,\n    uPunch: f32,\n    uBob: f32,\n    uTime: f32,\n    uClipCorrection: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: f32,\n    @location(2) member_2: f32,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aCharIndex_1: f32;\nvar<private> aCorner_1: vec3<f32>;\nvar<private> aCell_1: vec2<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> vDepth: f32;\nvar<private> vChar: f32;\n\nfn rot_u0028_f1_u003b(a: ptr<function, f32>) -> mat2x2<f32> {\n    var s: f32;\n    var c: f32;\n\n    let _e40 = (*a);\n    s = sin(_e40);\n    let _e42 = (*a);\n    c = cos(_e42);\n    let _e44 = c;\n    let _e45 = s;\n    let _e47 = s;\n    let _e48 = c;\n    return mat2x2<f32>(vec2<f32>(_e44, -(_e45)), vec2<f32>(_e47, _e48));\n}\n\nfn settle_u0028_f1_u003b(t: ptr<function, f32>) -> f32 {\n    var d: f32;\n\n    let _e39 = (*t);\n    if (_e39 <= 0f) {\n        return 0f;\n    }\n    let _e41 = (*t);\n    if (_e41 >= 1f) {\n        return 1f;\n    }\n    let _e43 = (*t);\n    d = (1f - _e43);\n    let _e45 = d;\n    let _e46 = d;\n    let _e48 = (*t);\n    return (1f - ((_e45 * _e46) * cos((_e48 * 12f))));\n}\n\nfn main_1() {\n    var span: f32;\n    var start: f32;\n    var local: f32;\n    var eased: f32;\n    var param: f32;\n    var spin: f32;\n    var rise: f32;\n    var punch: f32;\n    var local3_: vec3<f32>;\n    var param_1: f32;\n    var cell: vec2<f32>;\n    var bob: f32;\n    var centre: vec2<f32>;\n    var invDepth: f32;\n    var screen: vec2<f32>;\n    var ndc: vec2<f32>;\n    var depth: f32;\n    var n: vec3<f32>;\n    var param_2: f32;\n\n    let _e57 = unnamed.uCharCount;\n    span = max(_e57, 1f);\n    let _e59 = aCharIndex_1;\n    let _e61 = unnamed.uCharOffset;\n    let _e63 = span;\n    start = (((_e59 + _e61) / _e63) * 0.55f);\n    let _e67 = unnamed.uReveal;\n    let _e68 = start;\n    let _e70 = start;\n    local = clamp(((_e67 - _e68) / max(0.45f, (1f - _e70))), 0f, 1f);\n    let _e75 = local;\n    param = _e75;\n    let _e76 = settle_u0028_f1_u003b((&param));\n    eased = _e76;\n    let _e78 = unnamed.uSpin;\n    let _e79 = eased;\n    spin = (_e78 * (1f - _e79));\n    let _e82 = eased;\n    let _e85 = unnamed.uCellSize;\n    rise = (((1f - _e82) * _e85) * 6f);\n    let _e89 = unnamed.uPunch;\n    let _e90 = eased;\n    punch = (1f + (_e89 * (1f - abs(((_e90 * 2f) - 1f)))));\n    let _e97 = aCorner_1;\n    let _e99 = unnamed.uCellSize;\n    let _e102 = punch;\n    local3_ = (((_e97 * _e99) * 0.5f) * _e102);\n    let _e104 = spin;\n    param_1 = _e104;\n    let _e105 = rot_u0028_f1_u003b((&param_1));\n    let _e106 = local3_;\n    let _e108 = (_e105 * _e106.yz);\n    let _e109 = local3_;\n    local3_ = vec3<f32>(_e109.x, _e108.x, _e108.y);\n    let _e114 = aCell_1;\n    let _e116 = unnamed.uCellSize;\n    cell = (_e114 * _e116);\n    let _e119 = unnamed.uTime;\n    let _e121 = aCharIndex_1;\n    let _e126 = unnamed.uBob;\n    bob = (sin(((_e119 * 3.1f) + (_e121 * 0.7f))) * _e126);\n    let _e129 = unnamed.uOrigin;\n    let _e131 = cell[0u];\n    let _e133 = cell[1u];\n    let _e137 = rise;\n    let _e138 = bob;\n    centre = ((_e129 + vec2<f32>(_e131, -(_e133))) + vec2<f32>(0f, (_e137 - _e138)));\n    let _e143 = unnamed.uDepth;\n    let _e145 = unnamed.uDepth;\n    let _e147 = local3_[2u];\n    invDepth = (_e143 / max(0.001f, (_e145 - _e147)));\n    let _e151 = centre;\n    let _e152 = local3_;\n    let _e154 = invDepth;\n    screen = (_e151 + (_e152.xy * _e154));\n    let _e157 = screen;\n    let _e159 = unnamed.uViewport;\n    ndc = (((_e157 / _e159) * 2f) - vec2(1f));\n    let _e165 = local3_[2u];\n    let _e168 = unnamed.uCellSize;\n    depth = (clamp((-(_e165) / max(1f, (_e168 * 2f))), -1f, 1f) * 0.4f);\n    let _e175 = unnamed.uClipCorrection;\n    let _e177 = ndc[0u];\n    let _e179 = ndc[1u];\n    let _e181 = depth;\n    unnamed_1.gl_Position = (_e175 * vec4<f32>(_e177, -(_e179), _e181, 1f));\n    let _e185 = aNormal_1;\n    n = _e185;\n    let _e186 = spin;\n    param_2 = _e186;\n    let _e187 = rot_u0028_f1_u003b((&param_2));\n    let _e188 = n;\n    let _e190 = (_e187 * _e188.yz);\n    let _e191 = n;\n    n = vec3<f32>(_e191.x, _e190.x, _e190.y);\n    let _e196 = n;\n    vNormal = _e196;\n    let _e198 = local3_[2u];\n    vDepth = _e198;\n    let _e199 = eased;\n    vChar = _e199;\n    return;\n}\n\n@vertex \nfn main(@location(3) aCharIndex: f32, @location(0) aCorner: vec3<f32>, @location(2) aCell: vec2<f32>, @location(1) aNormal: vec3<f32>) -> VertexOutput {\n    aCharIndex_1 = aCharIndex;\n    aCorner_1 = aCorner;\n    aCell_1 = aCell;\n    aNormal_1 = aNormal;\n    main_1();\n    let _e14 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e14);\n    let _e16 = unnamed_1.gl_Position;\n    let _e17 = vNormal;\n    let _e18 = vDepth;\n    let _e19 = vChar;\n    return VertexOutput(_e16, _e17, _e18, _e19);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const TEXT_BINDINGS = {
  "TEXT_FRAG": {
    "uniforms": 1,
    "uniformSize": 32,
    "fields": {
      "uColor": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uGlow": {
        "offset": 12,
        "size": 4,
        "type": "float"
      },
      "uAlpha": {
        "offset": 16,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 20,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 24,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "TEXT_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
    "fields": {
      "uViewport": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uOrigin": {
        "offset": 8,
        "size": 8,
        "type": "vec2"
      },
      "uCellSize": {
        "offset": 16,
        "size": 4,
        "type": "float"
      },
      "uDepth": {
        "offset": 20,
        "size": 4,
        "type": "float"
      },
      "uReveal": {
        "offset": 24,
        "size": 4,
        "type": "float"
      },
      "uCharCount": {
        "offset": 28,
        "size": 4,
        "type": "float"
      },
      "uCharOffset": {
        "offset": 32,
        "size": 4,
        "type": "float"
      },
      "uSpin": {
        "offset": 36,
        "size": 4,
        "type": "float"
      },
      "uPunch": {
        "offset": 40,
        "size": 4,
        "type": "float"
      },
      "uBob": {
        "offset": 44,
        "size": 4,
        "type": "float"
      },
      "uTime": {
        "offset": 48,
        "size": 4,
        "type": "float"
      },
      "uClipCorrection": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  }
} as const;
