/*
 * Generated from ../octahedralResolve.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const OCTAHEDRAL_RESOLVE_FRAG_WGSL = "struct Uniforms {\n    uFaceRotation: mat3x3<f32>,\n    uFaceIndex: i32,\n    uFar: f32,\n    uNear: f32,\n    uEdge: f32,\n}\n\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uFace_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uFace_s: sampler;\nvar<private> gl_FragDepth: f32 = 0f;\n\nfn octDecode_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var f: vec2<f32>;\n    var n: vec3<f32>;\n    var t: f32;\n    var local: f32;\n    var local_1: f32;\n\n    let _e25 = (*uv);\n    f = ((_e25 * 2f) - vec2(1f));\n    let _e30 = f[0u];\n    let _e32 = f[1u];\n    let _e34 = f[0u];\n    let _e38 = f[1u];\n    n = vec3<f32>(_e30, _e32, ((1f - abs(_e34)) - abs(_e38)));\n    let _e43 = n[2u];\n    t = max(-(_e43), 0f);\n    let _e47 = n[0u];\n    if (_e47 >= 0f) {\n        let _e49 = t;\n        local = -(_e49);\n    } else {\n        let _e51 = t;\n        local = _e51;\n    }\n    let _e52 = local;\n    let _e54 = n[0u];\n    n[0u] = (_e54 + _e52);\n    let _e58 = n[1u];\n    if (_e58 >= 0f) {\n        let _e60 = t;\n        local_1 = -(_e60);\n    } else {\n        let _e62 = t;\n        local_1 = _e62;\n    }\n    let _e63 = local_1;\n    let _e65 = n[1u];\n    n[1u] = (_e65 + _e63);\n    let _e68 = n;\n    return normalize(_e68);\n}\n\nfn main_1() {\n    var d: vec3<f32>;\n    var param: vec2<f32>;\n    var a: vec3<f32>;\n    var face: i32;\n    var v: vec3<f32>;\n    var forward: f32;\n    var faceUv: vec2<f32>;\n    var stored: f32;\n    var ndc: f32;\n    var faceLocalZ: f32;\n    var phi_116_: bool;\n\n    let _e29 = gl_FragCoord_1;\n    let _e32 = unnamed.uEdge;\n    param = (_e29.xy / vec2(_e32));\n    let _e35 = octDecode_u0028_vf2_u003b((&param));\n    d = _e35;\n    let _e36 = d;\n    a = abs(_e36);\n    let _e39 = a[0u];\n    let _e41 = a[1u];\n    let _e42 = (_e39 >= _e41);\n    phi_116_ = _e42;\n    if _e42 {\n        let _e44 = a[0u];\n        let _e46 = a[2u];\n        phi_116_ = (_e44 >= _e46);\n    }\n    let _e49 = phi_116_;\n    if _e49 {\n        let _e51 = d[0u];\n        face = select(1i, 0i, (_e51 >= 0f));\n    } else {\n        let _e55 = a[1u];\n        let _e57 = a[2u];\n        if (_e55 >= _e57) {\n            let _e60 = d[1u];\n            face = select(3i, 2i, (_e60 >= 0f));\n        } else {\n            let _e64 = d[2u];\n            face = select(5i, 4i, (_e64 >= 0f));\n        }\n    }\n    let _e67 = face;\n    let _e69 = unnamed.uFaceIndex;\n    if (_e67 != _e69) {\n        discard;\n    }\n    let _e72 = unnamed.uFaceRotation;\n    let _e73 = d;\n    v = (_e72 * _e73);\n    let _e76 = v[2u];\n    forward = -(_e76);\n    let _e78 = v;\n    let _e80 = forward;\n    faceUv = (((_e78.xy / vec2(_e80)) * 0.5f) + vec2(0.5f));\n    let _e86 = faceUv;\n    let _e87 = textureSampleLevel(uFace_t, uFace_s, _e86, 0f);\n    stored = _e87.x;\n    let _e89 = stored;\n    if (_e89 >= 0.9999f) {\n        gl_FragDepth = 1f;\n        return;\n    }\n    let _e91 = stored;\n    ndc = ((_e91 * 2f) - 1f);\n    let _e95 = unnamed.uFar;\n    let _e98 = unnamed.uNear;\n    let _e101 = unnamed.uFar;\n    let _e103 = unnamed.uNear;\n    let _e105 = ndc;\n    let _e107 = unnamed.uFar;\n    let _e109 = unnamed.uNear;\n    faceLocalZ = (((2f * _e95) * _e98) / ((_e101 + _e103) - (_e105 * (_e107 - _e109))));\n    let _e114 = faceLocalZ;\n    let _e115 = forward;\n    let _e118 = unnamed.uFar;\n    gl_FragDepth = clamp(((_e114 / _e115) / _e118), 0f, 1f);\n    return;\n}\n\n@fragment \nfn main(@builtin(position) gl_FragCoord: vec4<f32>) -> @builtin(frag_depth) f32 {\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e3 = gl_FragDepth;\n    return _e3;\n}\n";

export const OCTAHEDRAL_RESOLVE_VERT_WGSL = "struct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nvar<private> gl_VertexIndex_1: i32;\nvar<private> unnamed: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var p: vec2<f32>;\n\n    let _e9 = gl_VertexIndex_1;\n    let _e14 = gl_VertexIndex_1;\n    p = vec2<f32>(f32(((_e9 << bitcast<u32>(1i)) & 2i)), f32((_e14 & 2i)));\n    let _e18 = p;\n    let _e21 = ((_e18 * 2f) - vec2(1f));\n    unnamed.gl_Position = vec4<f32>(_e21.x, _e21.y, 0f, 1f);\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32) -> @builtin(position) vec4<f32> {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    main_1();\n    let _e6 = unnamed.gl_Position.y;\n    unnamed.gl_Position.y = -(_e6);\n    let _e8 = unnamed.gl_Position;\n    return _e8;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const OCTAHEDRALRESOLVE_BINDINGS = {
  "OCTAHEDRAL_RESOLVE_FRAG": {
    "uniforms": 1,
    "uniformSize": 64,
    "fields": {
      "uFaceRotation": {
        "offset": 0,
        "size": 48,
        "type": "mat3"
      },
      "uFaceIndex": {
        "offset": 48,
        "size": 4,
        "type": "int"
      },
      "uFar": {
        "offset": 52,
        "size": 4,
        "type": "float"
      },
      "uNear": {
        "offset": 56,
        "size": 4,
        "type": "float"
      },
      "uEdge": {
        "offset": 60,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uFace": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "OCTAHEDRAL_RESOLVE_VERT": {
    "uniforms": null,
    "textures": {}
  }
} as const;
