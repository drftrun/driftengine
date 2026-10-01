/*
 * Generated from ../depth.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const DEPTH_CUTOUT_FRAG_WGSL = "struct Uniforms {\n    uPeelShadowLayer: i32,\n}\n\nvar<private> vUv_1: vec3<f32>;\n@group(0) @binding(34) \nvar uCutoutMap_t: texture_2d_array<f32>;\n@group(0) @binding(35) \nvar uCutoutMap_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLightPosition_1: vec4<f32>;\n@group(0) @binding(32) \nvar uPreviousShadowMap_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uPreviousShadowMap_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\nvar<private> vAlphaCutout_1: f32;\n\nfn cutoutAlpha_u0028_f1_u003b_vf2_u003b(alpha: ptr<function, f32>, texels: ptr<function, vec2<f32>>) -> f32 {\n    var dx: vec2<f32>;\n    var dy: vec2<f32>;\n    var level: f32;\n\n    let _e23 = (*texels);\n    let _e24 = dpdx(_e23);\n    dx = _e24;\n    let _e25 = (*texels);\n    let _e26 = dpdy(_e25);\n    dy = _e26;\n    let _e27 = dx;\n    let _e28 = dx;\n    let _e30 = dy;\n    let _e31 = dy;\n    level = max(0f, (0.5f * log2(max(dot(_e27, _e28), dot(_e30, _e31)))));\n    let _e37 = (*alpha);\n    let _e38 = level;\n    return (_e37 * (1f + (_e38 * 0.25f)));\n}\n\nfn main_1() {\n    var at: vec3<f32>;\n    var alpha_1: f32;\n    var param: f32;\n    var param_1: vec2<f32>;\n    var p: vec3<f32>;\n    var uv: vec2<f32>;\n    var previousDepth: f32;\n\n    let _e25 = vUv_1;\n    let _e26 = _e25.xy;\n    let _e28 = vUv_1[2u];\n    at = vec3<f32>(_e26.x, _e26.y, floor((_e28 + 0.5f)));\n    let _e34 = at;\n    let _e40 = textureSample(uCutoutMap_t, uCutoutMap_s, vec2<f32>(_e34.x, _e34.y), i32(_e34.z));\n    let _e41 = vUv_1;\n    let _e43 = textureDimensions(uCutoutMap_t, 0i);\n    param = _e40.w;\n    param_1 = (_e41.xy * vec2<f32>(vec2<i32>(_e43).xy));\n    let _e49 = cutoutAlpha_u0028_f1_u003b_vf2_u003b((&param), (&param_1));\n    alpha_1 = _e49;\n    let _e51 = unnamed.uPeelShadowLayer;\n    if (_e51 != 0i) {\n        let _e53 = vLightPosition_1;\n        let _e56 = vLightPosition_1[3u];\n        p = (_e53.xyz / vec3(_e56));\n        let _e59 = p;\n        uv = ((_e59.xy * 0.5f) + vec2(0.5f));\n        let _e64 = uv;\n        let _e67 = vec3<f32>(_e64.x, _e64.y, 0f);\n        let _e73 = textureSampleLevel(uPreviousShadowMap_t, uPreviousShadowMap_s, vec2<f32>(_e67.x, _e67.y), i32(_e67.z), 0f);\n        previousDepth = _e73.x;\n        let _e76 = gl_FragCoord_1[2u];\n        let _e77 = previousDepth;\n        if (_e76 <= (_e77 + 0.00001f)) {\n            discard;\n        }\n    }\n    let _e80 = alpha_1;\n    let _e81 = vAlphaCutout_1;\n    if (_e80 < _e81) {\n        discard;\n    }\n    return;\n}\n\n@fragment \nfn main(@location(1) vUv: vec3<f32>, @location(0) vLightPosition: vec4<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(2) @interpolate(flat) vAlphaCutout: f32) {\n    vUv_1 = vUv;\n    vLightPosition_1 = vLightPosition;\n    gl_FragCoord_1 = gl_FragCoord;\n    vAlphaCutout_1 = vAlphaCutout;\n    main_1();\n}\n";

export const DEPTH_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n    uUvScale: vec2<f32>,\n    uAlphaCutout: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: f32,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: f32;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e27 = (*sway);\n    if (_e27 <= 0f) {\n        let _e29 = (*worldPos);\n        return _e29;\n    }\n    let _e30 = (*worldPos);\n    let _e33 = unnamed.uWindSpatialPhase;\n    let _e36 = unnamed.uWindTime;\n    phase = (dot(_e30.xz, _e33) + _e36);\n    let _e39 = unnamed.uWindSpeed;\n    let _e41 = unnamed.uWindGust;\n    let _e43 = phase;\n    let _e46 = (*sway);\n    bend = (((_e39 + _e41) * sin(_e43)) * _e46);\n    let _e49 = (*worldPos)[0u];\n    let _e52 = unnamed.uWindDirection[0u];\n    let _e53 = bend;\n    let _e57 = (*worldPos)[1u];\n    let _e59 = (*worldPos)[2u];\n    let _e62 = unnamed.uWindDirection[1u];\n    let _e63 = bend;\n    return vec3<f32>((_e49 + (_e52 * _e53)), _e57, (_e59 + (_e62 * _e63)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e29 = aPosition_1;\n    local = vec4<f32>(_e29.x, _e29.y, _e29.z, 1f);\n    let _e35 = unnamed.uModel;\n    model = _e35;\n    let _e36 = model;\n    let _e37 = local;\n    world = (_e36 * _e37);\n    let _e39 = world;\n    param = _e39.xyz;\n    let _e42 = aChannel_1[0u];\n    param_1 = _e42;\n    let _e43 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e43;\n    let _e45 = unnamed.uLightViewProj;\n    let _e46 = bent;\n    let _e48 = world[3u];\n    vLightPosition = (_e45 * vec4<f32>(_e46.x, _e46.y, _e46.z, _e48));\n    let _e54 = vLightPosition;\n    unnamed_1.gl_Position = _e54;\n    let _e56 = aUv_1;\n    let _e59 = unnamed.uUvScale;\n    let _e60 = (_e56.xy * _e59);\n    let _e62 = aUv_1[2u];\n    vUv = vec3<f32>(_e60.x, _e60.y, _e62);\n    let _e67 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e67;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    aUv_1 = aUv;\n    main_1();\n    let _e12 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e12);\n    let _e14 = vLightPosition;\n    let _e15 = unnamed_1.gl_Position;\n    let _e16 = vUv;\n    let _e17 = vAlphaCutout;\n    return VertexOutput(_e14, _e15, _e16, _e17);\n}\n";

export const DEPTH_FRAG_WGSL = "struct Uniforms {\n    uPeelShadowLayer: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLightPosition_1: vec4<f32>;\n@group(0) @binding(32) \nvar uPreviousShadowMap_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uPreviousShadowMap_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn main_1() {\n    var p: vec3<f32>;\n    var uv: vec2<f32>;\n    var previousDepth: f32;\n\n    let _e16 = unnamed.uPeelShadowLayer;\n    if (_e16 != 0i) {\n        let _e18 = vLightPosition_1;\n        let _e21 = vLightPosition_1[3u];\n        p = (_e18.xyz / vec3(_e21));\n        let _e24 = p;\n        uv = ((_e24.xy * 0.5f) + vec2(0.5f));\n        let _e29 = uv;\n        let _e32 = vec3<f32>(_e29.x, _e29.y, 0f);\n        let _e38 = textureSample(uPreviousShadowMap_t, uPreviousShadowMap_s, vec2<f32>(_e32.x, _e32.y), i32(_e32.z));\n        previousDepth = _e38.x;\n        let _e41 = gl_FragCoord_1[2u];\n        let _e42 = previousDepth;\n        if (_e41 <= (_e42 + 0.00001f)) {\n            discard;\n        }\n    }\n    return;\n}\n\n@fragment \nfn main(@location(0) vLightPosition: vec4<f32>, @builtin(position) gl_FragCoord: vec4<f32>) {\n    vLightPosition_1 = vLightPosition;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n}\n";

export const DEPTH_INSTANCED_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uUvScale: vec2<f32>,\n    uAlphaCutout: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: f32,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: f32;\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e22 = aPosition_1;\n    local = vec4<f32>(_e22.x, _e22.y, _e22.z, 1f);\n    let _e27 = aInstanceModel0_1;\n    let _e28 = aInstanceModel1_1;\n    let _e29 = aInstanceModel2_1;\n    let _e30 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e27.x, _e27.y, _e27.z, _e27.w), vec4<f32>(_e28.x, _e28.y, _e28.z, _e28.w), vec4<f32>(_e29.x, _e29.y, _e29.z, _e29.w), vec4<f32>(_e30.x, _e30.y, _e30.z, _e30.w));\n    let _e52 = model;\n    let _e53 = local;\n    world = (_e52 * _e53);\n    let _e55 = world;\n    bent = _e55.xyz;\n    let _e58 = unnamed.uLightViewProj;\n    let _e59 = bent;\n    let _e61 = world[3u];\n    vLightPosition = (_e58 * vec4<f32>(_e59.x, _e59.y, _e59.z, _e61));\n    let _e67 = vLightPosition;\n    unnamed_1.gl_Position = _e67;\n    let _e69 = aUv_1;\n    let _e72 = unnamed.uUvScale;\n    let _e73 = (_e69.xy * _e72);\n    let _e75 = aUv_1[2u];\n    vUv = vec3<f32>(_e73.x, _e73.y, _e75);\n    let _e80 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e80;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    aUv_1 = aUv;\n    main_1();\n    let _e18 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e18);\n    let _e20 = vLightPosition;\n    let _e21 = unnamed_1.gl_Position;\n    let _e22 = vUv;\n    let _e23 = vAlphaCutout;\n    return VertexOutput(_e20, _e21, _e22, _e23);\n}\n";

export const DEPTH_INSTANCED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e16 = aPosition_1;\n    local = vec4<f32>(_e16.x, _e16.y, _e16.z, 1f);\n    let _e21 = aInstanceModel0_1;\n    let _e22 = aInstanceModel1_1;\n    let _e23 = aInstanceModel2_1;\n    let _e24 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e21.x, _e21.y, _e21.z, _e21.w), vec4<f32>(_e22.x, _e22.y, _e22.z, _e22.w), vec4<f32>(_e23.x, _e23.y, _e23.z, _e23.w), vec4<f32>(_e24.x, _e24.y, _e24.z, _e24.w));\n    let _e46 = model;\n    let _e47 = local;\n    world = (_e46 * _e47);\n    let _e49 = world;\n    bent = _e49.xyz;\n    let _e52 = unnamed.uLightViewProj;\n    let _e53 = bent;\n    let _e55 = world[3u];\n    vLightPosition = (_e52 * vec4<f32>(_e53.x, _e53.y, _e53.z, _e55));\n    let _e61 = vLightPosition;\n    unnamed_1.gl_Position = _e61;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    main_1();\n    let _e14 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e14);\n    let _e16 = vLightPosition;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e16, _e17);\n}\n";

export const DEPTH_SKINNED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(16) \nvar uJointPalette_t: texture_2d<f32>;\nvar<private> aJoints_1: vec4<f32>;\nvar<private> aWeights_1: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(17) \nvar uJointPalette_s: sampler;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e26 = (*sway);\n    if (_e26 <= 0f) {\n        let _e28 = (*worldPos);\n        return _e28;\n    }\n    let _e29 = (*worldPos);\n    let _e32 = unnamed.uWindSpatialPhase;\n    let _e35 = unnamed.uWindTime;\n    phase = (dot(_e29.xz, _e32) + _e35);\n    let _e38 = unnamed.uWindSpeed;\n    let _e40 = unnamed.uWindGust;\n    let _e42 = phase;\n    let _e45 = (*sway);\n    bend = (((_e38 + _e40) * sin(_e42)) * _e45);\n    let _e48 = (*worldPos)[0u];\n    let _e51 = unnamed.uWindDirection[0u];\n    let _e52 = bend;\n    let _e56 = (*worldPos)[1u];\n    let _e58 = (*worldPos)[2u];\n    let _e61 = unnamed.uWindDirection[1u];\n    let _e62 = bend;\n    return vec3<f32>((_e48 + (_e51 * _e52)), _e56, (_e58 + (_e61 * _e62)));\n}\n\nfn jointMatrix_u0028_i1_u003b(index: ptr<function, i32>) -> mat4x4<f32> {\n    var x: i32;\n\n    let _e24 = (*index);\n    x = (_e24 * 4i);\n    let _e26 = x;\n    let _e28 = textureLoad(uJointPalette_t, vec2<i32>(_e26, 0i), 0i);\n    let _e29 = x;\n    let _e32 = textureLoad(uJointPalette_t, vec2<i32>((_e29 + 1i), 0i), 0i);\n    let _e33 = x;\n    let _e36 = textureLoad(uJointPalette_t, vec2<i32>((_e33 + 2i), 0i), 0i);\n    let _e37 = x;\n    let _e40 = textureLoad(uJointPalette_t, vec2<i32>((_e37 + 3i), 0i), 0i);\n    return mat4x4<f32>(vec4<f32>(_e28.x, _e28.y, _e28.z, _e28.w), vec4<f32>(_e32.x, _e32.y, _e32.z, _e32.w), vec4<f32>(_e36.x, _e36.y, _e36.z, _e36.w), vec4<f32>(_e40.x, _e40.y, _e40.z, _e40.w));\n}\n\nfn skinMatrix_u0028_() -> mat4x4<f32> {\n    var param: i32;\n    var param_1: i32;\n    var param_2: i32;\n    var param_3: i32;\n\n    let _e27 = aJoints_1[0u];\n    param = i32(_e27);\n    let _e29 = jointMatrix_u0028_i1_u003b((&param));\n    let _e31 = aWeights_1[0u];\n    let _e32 = (_e29 * _e31);\n    let _e34 = aJoints_1[1u];\n    param_1 = i32(_e34);\n    let _e36 = jointMatrix_u0028_i1_u003b((&param_1));\n    let _e38 = aWeights_1[1u];\n    let _e39 = (_e36 * _e38);\n    let _e52 = mat4x4<f32>((_e32[0] + _e39[0]), (_e32[1] + _e39[1]), (_e32[2] + _e39[2]), (_e32[3] + _e39[3]));\n    let _e54 = aJoints_1[2u];\n    param_2 = i32(_e54);\n    let _e56 = jointMatrix_u0028_i1_u003b((&param_2));\n    let _e58 = aWeights_1[2u];\n    let _e59 = (_e56 * _e58);\n    let _e72 = mat4x4<f32>((_e52[0] + _e59[0]), (_e52[1] + _e59[1]), (_e52[2] + _e59[2]), (_e52[3] + _e59[3]));\n    let _e74 = aJoints_1[3u];\n    param_3 = i32(_e74);\n    let _e76 = jointMatrix_u0028_i1_u003b((&param_3));\n    let _e78 = aWeights_1[3u];\n    let _e79 = (_e76 * _e78);\n    return mat4x4<f32>((_e72[0] + _e79[0]), (_e72[1] + _e79[1]), (_e72[2] + _e79[2]), (_e72[3] + _e79[3]));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: f32;\n\n    let _e28 = skinMatrix_u0028_();\n    let _e29 = aPosition_1;\n    local = (_e28 * vec4<f32>(_e29.x, _e29.y, _e29.z, 1f));\n    let _e36 = unnamed.uModel;\n    model = _e36;\n    let _e37 = model;\n    let _e38 = local;\n    world = (_e37 * _e38);\n    let _e40 = world;\n    param_4 = _e40.xyz;\n    let _e43 = aChannel_1[0u];\n    param_5 = _e43;\n    let _e44 = channelBend_u0028_vf3_u003b_f1_u003b((&param_4), (&param_5));\n    bent = _e44;\n    let _e46 = unnamed.uLightViewProj;\n    let _e47 = bent;\n    let _e49 = world[3u];\n    vLightPosition = (_e46 * vec4<f32>(_e47.x, _e47.y, _e47.z, _e49));\n    let _e55 = vLightPosition;\n    unnamed_1.gl_Position = _e55;\n    return;\n}\n\n@vertex \nfn main(@location(11) aJoints: vec4<f32>, @location(12) aWeights: vec4<f32>, @location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aJoints_1 = aJoints;\n    aWeights_1 = aWeights;\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e12 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e12);\n    let _e14 = vLightPosition;\n    let _e15 = unnamed_1.gl_Position;\n    return VertexOutput(_e14, _e15);\n}\n";

export const DEPTH_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e22 = (*sway);\n    if (_e22 <= 0f) {\n        let _e24 = (*worldPos);\n        return _e24;\n    }\n    let _e25 = (*worldPos);\n    let _e28 = unnamed.uWindSpatialPhase;\n    let _e31 = unnamed.uWindTime;\n    phase = (dot(_e25.xz, _e28) + _e31);\n    let _e34 = unnamed.uWindSpeed;\n    let _e36 = unnamed.uWindGust;\n    let _e38 = phase;\n    let _e41 = (*sway);\n    bend = (((_e34 + _e36) * sin(_e38)) * _e41);\n    let _e44 = (*worldPos)[0u];\n    let _e47 = unnamed.uWindDirection[0u];\n    let _e48 = bend;\n    let _e52 = (*worldPos)[1u];\n    let _e54 = (*worldPos)[2u];\n    let _e57 = unnamed.uWindDirection[1u];\n    let _e58 = bend;\n    return vec3<f32>((_e44 + (_e47 * _e48)), _e52, (_e54 + (_e57 * _e58)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e24 = aPosition_1;\n    local = vec4<f32>(_e24.x, _e24.y, _e24.z, 1f);\n    let _e30 = unnamed.uModel;\n    model = _e30;\n    let _e31 = model;\n    let _e32 = local;\n    world = (_e31 * _e32);\n    let _e34 = world;\n    param = _e34.xyz;\n    let _e37 = aChannel_1[0u];\n    param_1 = _e37;\n    let _e38 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e38;\n    let _e40 = unnamed.uLightViewProj;\n    let _e41 = bent;\n    let _e43 = world[3u];\n    vLightPosition = (_e40 * vec4<f32>(_e41.x, _e41.y, _e41.z, _e43));\n    let _e49 = vLightPosition;\n    unnamed_1.gl_Position = _e49;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e8 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e8);\n    let _e10 = vLightPosition;\n    let _e11 = unnamed_1.gl_Position;\n    return VertexOutput(_e10, _e11);\n}\n";

export const GLASS_TINT_CUTOUT_FRAG_WGSL = "struct Uniforms {\n    uGlassPane: vec4<f32>,\n    uGlassLight: vec4<f32>,\n}\n\nvar<private> vUv_1: vec3<f32>;\n@group(0) @binding(32) \nvar uCutoutMap_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uCutoutMap_s: sampler;\nvar<private> vGlassWorld_1: vec3<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> outTint: vec4<f32>;\nvar<private> vAlphaCutout_1: f32;\nvar<private> vLightPosition_1: vec4<f32>;\n\nfn cutoutAlpha_u0028_f1_u003b_vf2_u003b(alpha: ptr<function, f32>, texels: ptr<function, vec2<f32>>) -> f32 {\n    var dx: vec2<f32>;\n    var dy: vec2<f32>;\n    var level: f32;\n\n    let _e24 = (*texels);\n    let _e25 = dpdx(_e24);\n    dx = _e25;\n    let _e26 = (*texels);\n    let _e27 = dpdy(_e26);\n    dy = _e27;\n    let _e28 = dx;\n    let _e29 = dx;\n    let _e31 = dy;\n    let _e32 = dy;\n    level = max(0f, (0.5f * log2(max(dot(_e28, _e29), dot(_e31, _e32)))));\n    let _e38 = (*alpha);\n    let _e39 = level;\n    return (_e38 * (1f + (_e39 * 0.25f)));\n}\n\nfn main_1() {\n    var at: vec3<f32>;\n    var alpha_1: f32;\n    var param: f32;\n    var param_1: vec2<f32>;\n    var n: vec3<f32>;\n    var toLight: vec3<f32>;\n    var local: vec3<f32>;\n    var cosLight: f32;\n    var reflected: f32;\n\n    let _e28 = vUv_1;\n    let _e29 = _e28.xy;\n    let _e31 = vUv_1[2u];\n    at = vec3<f32>(_e29.x, _e29.y, floor((_e31 + 0.5f)));\n    let _e37 = at;\n    let _e43 = textureSample(uCutoutMap_t, uCutoutMap_s, vec2<f32>(_e37.x, _e37.y), i32(_e37.z));\n    let _e44 = vUv_1;\n    let _e46 = textureDimensions(uCutoutMap_t, 0i);\n    param = _e43.w;\n    param_1 = (_e44.xy * vec2<f32>(vec2<i32>(_e46).xy));\n    let _e52 = cutoutAlpha_u0028_f1_u003b_vf2_u003b((&param), (&param_1));\n    alpha_1 = _e52;\n    let _e53 = vGlassWorld_1;\n    let _e54 = dpdx(_e53);\n    let _e55 = vGlassWorld_1;\n    let _e56 = dpdy(_e55);\n    n = normalize(cross(_e54, _e56));\n    let _e61 = unnamed.uGlassLight[3u];\n    if (_e61 > 0.5f) {\n        let _e64 = unnamed.uGlassLight;\n        let _e66 = vGlassWorld_1;\n        local = normalize((_e64.xyz - _e66));\n    } else {\n        let _e70 = unnamed.uGlassLight;\n        local = _e70.xyz;\n    }\n    let _e72 = local;\n    toLight = _e72;\n    let _e73 = n;\n    let _e74 = toLight;\n    cosLight = abs(dot(_e73, _e74));\n    let _e77 = cosLight;\n    reflected = (0.04f + (0.96f * pow((1f - _e77), 5f)));\n    let _e83 = unnamed.uGlassPane;\n    let _e85 = reflected;\n    let _e87 = (_e83.xyz * (1f - _e85));\n    let _e90 = unnamed.uGlassPane[3u];\n    outTint = vec4<f32>(_e87.x, _e87.y, _e87.z, _e90);\n    let _e95 = alpha_1;\n    let _e96 = vAlphaCutout_1;\n    if (_e95 < _e96) {\n        discard;\n    }\n    return;\n}\n\n@fragment \nfn main(@location(1) vUv: vec3<f32>, @location(3) vGlassWorld: vec3<f32>, @location(2) @interpolate(flat) vAlphaCutout: f32, @location(0) vLightPosition: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vGlassWorld_1 = vGlassWorld;\n    vAlphaCutout_1 = vAlphaCutout;\n    vLightPosition_1 = vLightPosition;\n    main_1();\n    let _e9 = outTint;\n    return _e9;\n}\n";

export const GLASS_TINT_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n    uUvScale: vec2<f32>,\n    uAlphaCutout: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: f32,\n    @location(3) member_3: vec3<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: f32;\nvar<private> vGlassWorld: vec3<f32>;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e28 = (*sway);\n    if (_e28 <= 0f) {\n        let _e30 = (*worldPos);\n        return _e30;\n    }\n    let _e31 = (*worldPos);\n    let _e34 = unnamed.uWindSpatialPhase;\n    let _e37 = unnamed.uWindTime;\n    phase = (dot(_e31.xz, _e34) + _e37);\n    let _e40 = unnamed.uWindSpeed;\n    let _e42 = unnamed.uWindGust;\n    let _e44 = phase;\n    let _e47 = (*sway);\n    bend = (((_e40 + _e42) * sin(_e44)) * _e47);\n    let _e50 = (*worldPos)[0u];\n    let _e53 = unnamed.uWindDirection[0u];\n    let _e54 = bend;\n    let _e58 = (*worldPos)[1u];\n    let _e60 = (*worldPos)[2u];\n    let _e63 = unnamed.uWindDirection[1u];\n    let _e64 = bend;\n    return vec3<f32>((_e50 + (_e53 * _e54)), _e58, (_e60 + (_e63 * _e64)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e30 = aPosition_1;\n    local = vec4<f32>(_e30.x, _e30.y, _e30.z, 1f);\n    let _e36 = unnamed.uModel;\n    model = _e36;\n    let _e37 = model;\n    let _e38 = local;\n    world = (_e37 * _e38);\n    let _e40 = world;\n    param = _e40.xyz;\n    let _e43 = aChannel_1[0u];\n    param_1 = _e43;\n    let _e44 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e44;\n    let _e46 = unnamed.uLightViewProj;\n    let _e47 = bent;\n    let _e49 = world[3u];\n    vLightPosition = (_e46 * vec4<f32>(_e47.x, _e47.y, _e47.z, _e49));\n    let _e55 = vLightPosition;\n    unnamed_1.gl_Position = _e55;\n    let _e57 = aUv_1;\n    let _e60 = unnamed.uUvScale;\n    let _e61 = (_e57.xy * _e60);\n    let _e63 = aUv_1[2u];\n    vUv = vec3<f32>(_e61.x, _e61.y, _e63);\n    let _e68 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e68;\n    let _e69 = bent;\n    vGlassWorld = _e69;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    aUv_1 = aUv;\n    main_1();\n    let _e13 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e13);\n    let _e15 = vLightPosition;\n    let _e16 = unnamed_1.gl_Position;\n    let _e17 = vUv;\n    let _e18 = vAlphaCutout;\n    let _e19 = vGlassWorld;\n    return VertexOutput(_e15, _e16, _e17, _e18, _e19);\n}\n";

export const GLASS_TINT_FRAG_WGSL = "struct Uniforms {\n    uGlassPane: vec4<f32>,\n    uGlassLight: vec4<f32>,\n}\n\nvar<private> vGlassWorld_1: vec3<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> outTint: vec4<f32>;\nvar<private> vLightPosition_1: vec4<f32>;\n\nfn main_1() {\n    var n: vec3<f32>;\n    var toLight: vec3<f32>;\n    var local: vec3<f32>;\n    var cosLight: f32;\n    var reflected: f32;\n\n    let _e17 = vGlassWorld_1;\n    let _e18 = dpdx(_e17);\n    let _e19 = vGlassWorld_1;\n    let _e20 = dpdy(_e19);\n    n = normalize(cross(_e18, _e20));\n    let _e25 = unnamed.uGlassLight[3u];\n    if (_e25 > 0.5f) {\n        let _e28 = unnamed.uGlassLight;\n        let _e30 = vGlassWorld_1;\n        local = normalize((_e28.xyz - _e30));\n    } else {\n        let _e34 = unnamed.uGlassLight;\n        local = _e34.xyz;\n    }\n    let _e36 = local;\n    toLight = _e36;\n    let _e37 = n;\n    let _e38 = toLight;\n    cosLight = abs(dot(_e37, _e38));\n    let _e41 = cosLight;\n    reflected = (0.04f + (0.96f * pow((1f - _e41), 5f)));\n    let _e47 = unnamed.uGlassPane;\n    let _e49 = reflected;\n    let _e51 = (_e47.xyz * (1f - _e49));\n    let _e54 = unnamed.uGlassPane[3u];\n    outTint = vec4<f32>(_e51.x, _e51.y, _e51.z, _e54);\n    return;\n}\n\n@fragment \nfn main(@location(1) vGlassWorld: vec3<f32>, @location(0) vLightPosition: vec4<f32>) -> @location(0) vec4<f32> {\n    vGlassWorld_1 = vGlassWorld;\n    vLightPosition_1 = vLightPosition;\n    main_1();\n    let _e5 = outTint;\n    return _e5;\n}\n";

export const GLASS_TINT_INSTANCED_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uUvScale: vec2<f32>,\n    uAlphaCutout: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: f32,\n    @location(3) member_3: vec3<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: f32;\nvar<private> vGlassWorld: vec3<f32>;\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e23 = aPosition_1;\n    local = vec4<f32>(_e23.x, _e23.y, _e23.z, 1f);\n    let _e28 = aInstanceModel0_1;\n    let _e29 = aInstanceModel1_1;\n    let _e30 = aInstanceModel2_1;\n    let _e31 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e28.x, _e28.y, _e28.z, _e28.w), vec4<f32>(_e29.x, _e29.y, _e29.z, _e29.w), vec4<f32>(_e30.x, _e30.y, _e30.z, _e30.w), vec4<f32>(_e31.x, _e31.y, _e31.z, _e31.w));\n    let _e53 = model;\n    let _e54 = local;\n    world = (_e53 * _e54);\n    let _e56 = world;\n    bent = _e56.xyz;\n    let _e59 = unnamed.uLightViewProj;\n    let _e60 = bent;\n    let _e62 = world[3u];\n    vLightPosition = (_e59 * vec4<f32>(_e60.x, _e60.y, _e60.z, _e62));\n    let _e68 = vLightPosition;\n    unnamed_1.gl_Position = _e68;\n    let _e70 = aUv_1;\n    let _e73 = unnamed.uUvScale;\n    let _e74 = (_e70.xy * _e73);\n    let _e76 = aUv_1[2u];\n    vUv = vec3<f32>(_e74.x, _e74.y, _e76);\n    let _e81 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e81;\n    let _e82 = bent;\n    vGlassWorld = _e82;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    aUv_1 = aUv;\n    main_1();\n    let _e19 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e19);\n    let _e21 = vLightPosition;\n    let _e22 = unnamed_1.gl_Position;\n    let _e23 = vUv;\n    let _e24 = vAlphaCutout;\n    let _e25 = vGlassWorld;\n    return VertexOutput(_e21, _e22, _e23, _e24, _e25);\n}\n";

export const GLASS_TINT_INSTANCED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vGlassWorld: vec3<f32>;\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e17 = aPosition_1;\n    local = vec4<f32>(_e17.x, _e17.y, _e17.z, 1f);\n    let _e22 = aInstanceModel0_1;\n    let _e23 = aInstanceModel1_1;\n    let _e24 = aInstanceModel2_1;\n    let _e25 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e22.x, _e22.y, _e22.z, _e22.w), vec4<f32>(_e23.x, _e23.y, _e23.z, _e23.w), vec4<f32>(_e24.x, _e24.y, _e24.z, _e24.w), vec4<f32>(_e25.x, _e25.y, _e25.z, _e25.w));\n    let _e47 = model;\n    let _e48 = local;\n    world = (_e47 * _e48);\n    let _e50 = world;\n    bent = _e50.xyz;\n    let _e53 = unnamed.uLightViewProj;\n    let _e54 = bent;\n    let _e56 = world[3u];\n    vLightPosition = (_e53 * vec4<f32>(_e54.x, _e54.y, _e54.z, _e56));\n    let _e62 = vLightPosition;\n    unnamed_1.gl_Position = _e62;\n    let _e64 = bent;\n    vGlassWorld = _e64;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    main_1();\n    let _e15 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e15);\n    let _e17 = vLightPosition;\n    let _e18 = unnamed_1.gl_Position;\n    let _e19 = vGlassWorld;\n    return VertexOutput(_e17, _e18, _e19);\n}\n";

export const GLASS_TINT_SKINNED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n}\n\n@group(0) @binding(16) \nvar uJointPalette_t: texture_2d<f32>;\nvar<private> aJoints_1: vec4<f32>;\nvar<private> aWeights_1: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vGlassWorld: vec3<f32>;\n@group(0) @binding(17) \nvar uJointPalette_s: sampler;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e27 = (*sway);\n    if (_e27 <= 0f) {\n        let _e29 = (*worldPos);\n        return _e29;\n    }\n    let _e30 = (*worldPos);\n    let _e33 = unnamed.uWindSpatialPhase;\n    let _e36 = unnamed.uWindTime;\n    phase = (dot(_e30.xz, _e33) + _e36);\n    let _e39 = unnamed.uWindSpeed;\n    let _e41 = unnamed.uWindGust;\n    let _e43 = phase;\n    let _e46 = (*sway);\n    bend = (((_e39 + _e41) * sin(_e43)) * _e46);\n    let _e49 = (*worldPos)[0u];\n    let _e52 = unnamed.uWindDirection[0u];\n    let _e53 = bend;\n    let _e57 = (*worldPos)[1u];\n    let _e59 = (*worldPos)[2u];\n    let _e62 = unnamed.uWindDirection[1u];\n    let _e63 = bend;\n    return vec3<f32>((_e49 + (_e52 * _e53)), _e57, (_e59 + (_e62 * _e63)));\n}\n\nfn jointMatrix_u0028_i1_u003b(index: ptr<function, i32>) -> mat4x4<f32> {\n    var x: i32;\n\n    let _e25 = (*index);\n    x = (_e25 * 4i);\n    let _e27 = x;\n    let _e29 = textureLoad(uJointPalette_t, vec2<i32>(_e27, 0i), 0i);\n    let _e30 = x;\n    let _e33 = textureLoad(uJointPalette_t, vec2<i32>((_e30 + 1i), 0i), 0i);\n    let _e34 = x;\n    let _e37 = textureLoad(uJointPalette_t, vec2<i32>((_e34 + 2i), 0i), 0i);\n    let _e38 = x;\n    let _e41 = textureLoad(uJointPalette_t, vec2<i32>((_e38 + 3i), 0i), 0i);\n    return mat4x4<f32>(vec4<f32>(_e29.x, _e29.y, _e29.z, _e29.w), vec4<f32>(_e33.x, _e33.y, _e33.z, _e33.w), vec4<f32>(_e37.x, _e37.y, _e37.z, _e37.w), vec4<f32>(_e41.x, _e41.y, _e41.z, _e41.w));\n}\n\nfn skinMatrix_u0028_() -> mat4x4<f32> {\n    var param: i32;\n    var param_1: i32;\n    var param_2: i32;\n    var param_3: i32;\n\n    let _e28 = aJoints_1[0u];\n    param = i32(_e28);\n    let _e30 = jointMatrix_u0028_i1_u003b((&param));\n    let _e32 = aWeights_1[0u];\n    let _e33 = (_e30 * _e32);\n    let _e35 = aJoints_1[1u];\n    param_1 = i32(_e35);\n    let _e37 = jointMatrix_u0028_i1_u003b((&param_1));\n    let _e39 = aWeights_1[1u];\n    let _e40 = (_e37 * _e39);\n    let _e53 = mat4x4<f32>((_e33[0] + _e40[0]), (_e33[1] + _e40[1]), (_e33[2] + _e40[2]), (_e33[3] + _e40[3]));\n    let _e55 = aJoints_1[2u];\n    param_2 = i32(_e55);\n    let _e57 = jointMatrix_u0028_i1_u003b((&param_2));\n    let _e59 = aWeights_1[2u];\n    let _e60 = (_e57 * _e59);\n    let _e73 = mat4x4<f32>((_e53[0] + _e60[0]), (_e53[1] + _e60[1]), (_e53[2] + _e60[2]), (_e53[3] + _e60[3]));\n    let _e75 = aJoints_1[3u];\n    param_3 = i32(_e75);\n    let _e77 = jointMatrix_u0028_i1_u003b((&param_3));\n    let _e79 = aWeights_1[3u];\n    let _e80 = (_e77 * _e79);\n    return mat4x4<f32>((_e73[0] + _e80[0]), (_e73[1] + _e80[1]), (_e73[2] + _e80[2]), (_e73[3] + _e80[3]));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param_4: vec3<f32>;\n    var param_5: f32;\n\n    let _e29 = skinMatrix_u0028_();\n    let _e30 = aPosition_1;\n    local = (_e29 * vec4<f32>(_e30.x, _e30.y, _e30.z, 1f));\n    let _e37 = unnamed.uModel;\n    model = _e37;\n    let _e38 = model;\n    let _e39 = local;\n    world = (_e38 * _e39);\n    let _e41 = world;\n    param_4 = _e41.xyz;\n    let _e44 = aChannel_1[0u];\n    param_5 = _e44;\n    let _e45 = channelBend_u0028_vf3_u003b_f1_u003b((&param_4), (&param_5));\n    bent = _e45;\n    let _e47 = unnamed.uLightViewProj;\n    let _e48 = bent;\n    let _e50 = world[3u];\n    vLightPosition = (_e47 * vec4<f32>(_e48.x, _e48.y, _e48.z, _e50));\n    let _e56 = vLightPosition;\n    unnamed_1.gl_Position = _e56;\n    let _e58 = bent;\n    vGlassWorld = _e58;\n    return;\n}\n\n@vertex \nfn main(@location(11) aJoints: vec4<f32>, @location(12) aWeights: vec4<f32>, @location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aJoints_1 = aJoints;\n    aWeights_1 = aWeights;\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e13 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e13);\n    let _e15 = vLightPosition;\n    let _e16 = unnamed_1.gl_Position;\n    let _e17 = vGlassWorld;\n    return VertexOutput(_e15, _e16, _e17);\n}\n";

export const GLASS_TINT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vGlassWorld: vec3<f32>;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e23 = (*sway);\n    if (_e23 <= 0f) {\n        let _e25 = (*worldPos);\n        return _e25;\n    }\n    let _e26 = (*worldPos);\n    let _e29 = unnamed.uWindSpatialPhase;\n    let _e32 = unnamed.uWindTime;\n    phase = (dot(_e26.xz, _e29) + _e32);\n    let _e35 = unnamed.uWindSpeed;\n    let _e37 = unnamed.uWindGust;\n    let _e39 = phase;\n    let _e42 = (*sway);\n    bend = (((_e35 + _e37) * sin(_e39)) * _e42);\n    let _e45 = (*worldPos)[0u];\n    let _e48 = unnamed.uWindDirection[0u];\n    let _e49 = bend;\n    let _e53 = (*worldPos)[1u];\n    let _e55 = (*worldPos)[2u];\n    let _e58 = unnamed.uWindDirection[1u];\n    let _e59 = bend;\n    return vec3<f32>((_e45 + (_e48 * _e49)), _e53, (_e55 + (_e58 * _e59)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e25 = aPosition_1;\n    local = vec4<f32>(_e25.x, _e25.y, _e25.z, 1f);\n    let _e31 = unnamed.uModel;\n    model = _e31;\n    let _e32 = model;\n    let _e33 = local;\n    world = (_e32 * _e33);\n    let _e35 = world;\n    param = _e35.xyz;\n    let _e38 = aChannel_1[0u];\n    param_1 = _e38;\n    let _e39 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e39;\n    let _e41 = unnamed.uLightViewProj;\n    let _e42 = bent;\n    let _e44 = world[3u];\n    vLightPosition = (_e41 * vec4<f32>(_e42.x, _e42.y, _e42.z, _e44));\n    let _e50 = vLightPosition;\n    unnamed_1.gl_Position = _e50;\n    let _e52 = bent;\n    vGlassWorld = _e52;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e9 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e9);\n    let _e11 = vLightPosition;\n    let _e12 = unnamed_1.gl_Position;\n    let _e13 = vGlassWorld;\n    return VertexOutput(_e11, _e12, _e13);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const DEPTH_BINDINGS = {
  "DEPTH_CUTOUT_FRAG": {
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
        "type": "sampler2DArray"
      },
      "uCutoutMap": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2DArray"
      }
    }
  },
  "DEPTH_CUTOUT_VERT": {
    "uniforms": 0,
    "uniformSize": 176,
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
      },
      "uUvScale": {
        "offset": 160,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 168,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
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
        "type": "sampler2DArray"
      }
    }
  },
  "DEPTH_INSTANCED_CUTOUT_VERT": {
    "uniforms": 0,
    "uniformSize": 80,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uUvScale": {
        "offset": 64,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 72,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
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
  },
  "GLASS_TINT_CUTOUT_FRAG": {
    "uniforms": 1,
    "uniformSize": 32,
    "fields": {
      "uGlassPane": {
        "offset": 0,
        "size": 16,
        "type": "vec4"
      },
      "uGlassLight": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      }
    },
    "textures": {
      "uCutoutMap": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2DArray"
      }
    }
  },
  "GLASS_TINT_CUTOUT_VERT": {
    "uniforms": 0,
    "uniformSize": 176,
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
      },
      "uUvScale": {
        "offset": 160,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 168,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "GLASS_TINT_FRAG": {
    "uniforms": 1,
    "uniformSize": 32,
    "fields": {
      "uGlassPane": {
        "offset": 0,
        "size": 16,
        "type": "vec4"
      },
      "uGlassLight": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      }
    },
    "textures": {}
  },
  "GLASS_TINT_INSTANCED_CUTOUT_VERT": {
    "uniforms": 0,
    "uniformSize": 80,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uUvScale": {
        "offset": 64,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 72,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "GLASS_TINT_INSTANCED_VERT": {
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
  "GLASS_TINT_SKINNED_VERT": {
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
  "GLASS_TINT_VERT": {
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
