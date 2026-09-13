/*
 * Generated from ../depth.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const DEPTH_FRAG_WGSL = "struct Uniforms {\n    uPeelShadowLayer: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLightPosition_1: vec4<f32>;\n@group(0) @binding(32) \nvar uPreviousShadowMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uPreviousShadowMap_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn main_1() {\n    var p: vec3<f32>;\n    var uv: vec2<f32>;\n    var previousDepth: f32;\n\n    let _e15 = unnamed.uPeelShadowLayer;\n    if (_e15 != 0i) {\n        let _e17 = vLightPosition_1;\n        let _e20 = vLightPosition_1[3u];\n        p = (_e17.xyz / vec3(_e20));\n        let _e23 = p;\n        uv = ((_e23.xy * 0.5f) + vec2(0.5f));\n        let _e28 = uv;\n        let _e29 = textureSample(uPreviousShadowMap_t, uPreviousShadowMap_s, _e28);\n        previousDepth = _e29.x;\n        let _e32 = gl_FragCoord_1[2u];\n        let _e33 = previousDepth;\n        if (_e32 <= (_e33 + 0.00001f)) {\n            discard;\n        }\n    }\n    return;\n}\n\n@fragment \nfn main(@location(0) vLightPosition: vec4<f32>, @builtin(position) gl_FragCoord: vec4<f32>) {\n    vLightPosition_1 = vLightPosition;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n}\n";

export const DEPTH_INSTANCED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e16 = aPosition_1;\n    local = vec4<f32>(_e16.x, _e16.y, _e16.z, 1f);\n    let _e21 = aInstanceModel0_1;\n    let _e22 = aInstanceModel1_1;\n    let _e23 = aInstanceModel2_1;\n    let _e24 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e21.x, _e21.y, _e21.z, _e21.w), vec4<f32>(_e22.x, _e22.y, _e22.z, _e22.w), vec4<f32>(_e23.x, _e23.y, _e23.z, _e23.w), vec4<f32>(_e24.x, _e24.y, _e24.z, _e24.w));\n    let _e46 = model;\n    let _e47 = local;\n    world = (_e46 * _e47);\n    let _e49 = world;\n    bent = _e49.xyz;\n    let _e52 = unnamed.uLightViewProj;\n    let _e53 = bent;\n    let _e55 = world[3u];\n    vLightPosition = (_e52 * vec4<f32>(_e53.x, _e53.y, _e53.z, _e55));\n    let _e61 = vLightPosition;\n    unnamed_1.gl_Position = _e61;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    main_1();\n    let _e14 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e14);\n    let _e16 = vLightPosition;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e16, _e17);\n}\n";

export const DEPTH_SKINNED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(16) \nvar uJointPalette_t: texture_2d<f32>;\nvar<private> aJoints_1: vec4<f32>;\nvar<private> aWeights_1: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(17) \nvar uJointPalette_s: sampler;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e26 = (*sway);\n    if (_e26 <= 0f) {\n        let _e28 = (*worldPos);\n        return _e28;\n    }\n    let _e29 = (*worldPos);\n    let _e32 = unnamed.uWindSpatialPhase;\n    let _e35 = unnamed.uWindTime;\n    phase = (dot(_e29.xz, _e32) + _e35);\n    let _e38 = unnamed.uWindSpeed;\n    let _e40 = unnamed.uWindGust;\n    let _e42 = phase;\n    let _e45 = (*sway);\n    bend = (((_e38 + _e40) * sin(_e42)) * _e45);\n    let _e48 = (*worldPos)[0u];\n    let _e51 = unnamed.uWindDirection[0u];\n    let _e52 = bend;\n    let _e56 = (*worldPos)[1u];\n    let _e58 = (*worldPos)[2u];\n    let _e61 = unnamed.uWindDirection[1u];\n    let _e62 = bend;\n    return vec3<f32>((_e48 + (_e51 * _e52)), _e56, (_e58 + (_e61 * _e62)));\n}\n\nfn jointMatrix_u0028_i1_u003b(index: ptr<function, i32>) -> mat4x4<f32> {\n    var x: i32;\n\n    let _e24 = (*index);\n    x = (_e24 * 4i);\n    let _e26 = x;\n    let _e28 = textureLoad(uJointPalette_t, vec2<i32>(_e26, 0i), 0i);\n    let _e29 = x;\n    let _e32 = textureLoad(uJointPalette_t, vec2<i32>((_e29 + 1i), 0i), 0i);\n    let _e33 = x;\n    let _e36 = textureLoad(uJointPalette_t, vec2<i32>((_e33 + 2i), 0i), 0i);\n    let _e37 = x;\n    let _e40 = textureLoad(uJointPalette_t, vec2<i32>((_e37 + 3i), 0i), 0i);\n    return mat4x4<f32>(vec4<f32>(_e28.x, _e28.y, _e28.z, _e28.w), vec4<f32>(_e32.x, _e32.y, _e32.z, _e32.w), vec4<f32>(_e36.x, _e36.y, _e36.z, _e36.w), vec4<f32>(_e40.x, _e40.y, _e40.z, _e40.w));\n}\n\nfn skinMatrix_u0028_() -> mat4x4<f32> {\n    var param: i32;\n    var param_1: i32;\n    var param_2: i32;\n    var param_3: i32;\n\n    let _e27 = aJoints_1[0u];\n    param = i32(_e27);\n    let _e29 = jointMatrix_u0028_i1_u003b((&param));\n    let _e31 = aWeights_1[0u];\n    let _e32 = (_e29 * _e31);\n    let _e34 = aJoints_1[1u];\n    param_1 = i32(_e34);\n    let _e36 = jointMatrix_u0028_i1_u003b((&param_1));\n    let _e38 = aWeights_1[1u];\n    let _e39 = (_e36 * _e38);\n    let _e52 = mat4x4<f32>((_e32[0] + _e39[0]), (_e32[1] + _e39[1]), (_e32[2] + _e39[2]), (_e32[3] + _e39[3]));\n    let _e54 = aJoints_1[2u];\n    param_2 = i32(_e54);\n    let _e56 = jointMatrix_u0028_i1_u003b((&param_2));\n    let _e58 = aWeights_1[2u];\n    let _e59 = (_e56 * _e58);\n    let _e72 = mat4x4<f32>((_e52[0] + _e59[0]), (_e52[1] + _e59[1]), (_e52[2] + _e59[2]), (_e52[3] + _e59[3]));\n    let _e74 = aJoints_1[3u];\n    param_3 = i32(_e74);\n    let _e76 = jointMatrix_u0028_i1_u003b((&param_3));\n    let _e78 = aWeights_1[3u];\n    let _e79 = (_e76 * _e78);\n    return mat4x4<f32>((_e72[0] + _e79[0]), (_e72[1] + _e79[1]), (_e72[2] + _e79[2]), (_e72[3] + _e79[3]));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: f32;\n\n    let _e28 = skinMatrix_u0028_();\n    let _e29 = aPosition_1;\n    local = (_e28 * vec4<f32>(_e29.x, _e29.y, _e29.z, 1f));\n    let _e36 = unnamed.uModel;\n    model = _e36;\n    let _e37 = model;\n    let _e38 = local;\n    world = (_e37 * _e38);\n    let _e40 = world;\n    param_4 = _e40.xyz;\n    let _e43 = aChannel_1[0u];\n    param_5 = _e43;\n    let _e44 = channelBend_u0028_vf3_u003b_f1_u003b((&param_4), (&param_5));\n    bent = _e44;\n    let _e46 = unnamed.uLightViewProj;\n    let _e47 = bent;\n    let _e49 = world[3u];\n    vLightPosition = (_e46 * vec4<f32>(_e47.x, _e47.y, _e47.z, _e49));\n    let _e55 = vLightPosition;\n    unnamed_1.gl_Position = _e55;\n    return;\n}\n\n@vertex \nfn main(@location(11) aJoints: vec4<f32>, @location(12) aWeights: vec4<f32>, @location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aJoints_1 = aJoints;\n    aWeights_1 = aWeights;\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e12 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e12);\n    let _e14 = vLightPosition;\n    let _e15 = unnamed_1.gl_Position;\n    return VertexOutput(_e14, _e15);\n}\n";

export const DEPTH_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e22 = (*sway);\n    if (_e22 <= 0f) {\n        let _e24 = (*worldPos);\n        return _e24;\n    }\n    let _e25 = (*worldPos);\n    let _e28 = unnamed.uWindSpatialPhase;\n    let _e31 = unnamed.uWindTime;\n    phase = (dot(_e25.xz, _e28) + _e31);\n    let _e34 = unnamed.uWindSpeed;\n    let _e36 = unnamed.uWindGust;\n    let _e38 = phase;\n    let _e41 = (*sway);\n    bend = (((_e34 + _e36) * sin(_e38)) * _e41);\n    let _e44 = (*worldPos)[0u];\n    let _e47 = unnamed.uWindDirection[0u];\n    let _e48 = bend;\n    let _e52 = (*worldPos)[1u];\n    let _e54 = (*worldPos)[2u];\n    let _e57 = unnamed.uWindDirection[1u];\n    let _e58 = bend;\n    return vec3<f32>((_e44 + (_e47 * _e48)), _e52, (_e54 + (_e57 * _e58)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e24 = aPosition_1;\n    local = vec4<f32>(_e24.x, _e24.y, _e24.z, 1f);\n    let _e30 = unnamed.uModel;\n    model = _e30;\n    let _e31 = model;\n    let _e32 = local;\n    world = (_e31 * _e32);\n    let _e34 = world;\n    param = _e34.xyz;\n    let _e37 = aChannel_1[0u];\n    param_1 = _e37;\n    let _e38 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e38;\n    let _e40 = unnamed.uLightViewProj;\n    let _e41 = bent;\n    let _e43 = world[3u];\n    vLightPosition = (_e40 * vec4<f32>(_e41.x, _e41.y, _e41.z, _e43));\n    let _e49 = vLightPosition;\n    unnamed_1.gl_Position = _e49;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e8 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e8);\n    let _e10 = vLightPosition;\n    let _e11 = unnamed_1.gl_Position;\n    return VertexOutput(_e10, _e11);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const DEPTH_BINDINGS = {
  "DEPTH_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uPeelShadowLayer": {
        "offset": 0,
        "size": 4,
        "type": "int"
      }
    },
    "textures": {
      "uPreviousShadowMap": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      }
    }
  },
  "DEPTH_INSTANCED_VERT": {
    "uniforms": 0,
    "uniformSize": 64,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      }
    },
    "textures": {}
  },
  "DEPTH_SKINNED_VERT": {
    "uniforms": 0,
    "uniformSize": 160,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uModel": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uWindDirection": {
        "offset": 128,
        "size": 8,
        "type": "vec2"
      },
      "uWindSpeed": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uWindGust": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uWindTime": {
        "offset": 144,
        "size": 4,
        "type": "float"
      },
      "uWindSpatialPhase": {
        "offset": 152,
        "size": 8,
        "type": "vec2"
      }
    },
    "textures": {
      "uJointPalette": {
        "texture": 16,
        "sampler": 17,
        "type": "sampler2D"
      }
    }
  },
  "DEPTH_VERT": {
    "uniforms": 0,
    "uniformSize": 160,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uModel": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uWindDirection": {
        "offset": 128,
        "size": 8,
        "type": "vec2"
      },
      "uWindSpeed": {
        "offset": 136,
        "size": 4,
        "type": "float"
      },
      "uWindGust": {
        "offset": 140,
        "size": 4,
        "type": "float"
      },
      "uWindTime": {
        "offset": 144,
        "size": 4,
        "type": "float"
      },
      "uWindSpatialPhase": {
        "offset": 152,
        "size": 8,
        "type": "vec2"
      }
    },
    "textures": {}
  }
} as const;
