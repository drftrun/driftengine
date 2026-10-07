/*
 * Generated from ../depth.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const DEPTH_CUTOUT_FRAG_WGSL = "struct Uniforms {\n    uPeelShadowLayer: i32,\n}\n\nvar<private> vUv_1: vec3<f32>;\n@group(0) @binding(34) \nvar uCutoutMap_t: texture_2d_array<f32>;\n@group(0) @binding(35) \nvar uCutoutMap_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLightPosition_1: vec4<f32>;\n@group(0) @binding(32) \nvar uPreviousShadowMap_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uPreviousShadowMap_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\nvar<private> vAlphaCutout_1: vec2<f32>;\n\nfn cutoutKeeps_u0028_f1_u003b_vf2_u003b_f1_u003b(share: ptr<function, f32>, pixel: ptr<function, vec2<f32>>, frame: ptr<function, f32>) -> bool {\n    var p: vec2<f32>;\n    var noise: f32;\n\n    let _e31 = (*pixel);\n    let _e32 = (*frame);\n    p = (_e31 + vec2((5.588238f * _e32)));\n    let _e36 = p;\n    noise = fract((52.982918f * fract(dot(_e36, vec2<f32>(0.06711056f, 0.00583715f)))));\n    let _e41 = (*share);\n    let _e42 = noise;\n    return (_e41 > _e42);\n}\n\nfn cutoutShare_u0028_f1_u003b_f1_u003b(alpha: ptr<function, f32>, cutoff: ptr<function, f32>) -> f32 {\n    var band: f32;\n\n    let _e29 = (*cutoff);\n    let _e30 = (*cutoff);\n    band = max((2f * min(_e29, (1f - _e30))), 0.0001f);\n    let _e35 = (*alpha);\n    let _e36 = (*cutoff);\n    let _e38 = band;\n    return clamp((((_e35 - _e36) / _e38) + 0.5f), 0f, 1f);\n}\n\nfn cutoutAlpha_u0028_f1_u003b_vf2_u003b(alpha_1: ptr<function, f32>, texels: ptr<function, vec2<f32>>) -> f32 {\n    var dx: vec2<f32>;\n    var dy: vec2<f32>;\n    var level: f32;\n\n    let _e31 = (*texels);\n    let _e32 = dpdx(_e31);\n    dx = _e32;\n    let _e33 = (*texels);\n    let _e34 = dpdy(_e33);\n    dy = _e34;\n    let _e35 = dx;\n    let _e36 = dx;\n    let _e38 = dy;\n    let _e39 = dy;\n    level = max(0f, (0.5f * log2(max(dot(_e35, _e36), dot(_e38, _e39)))));\n    let _e45 = (*alpha_1);\n    let _e46 = level;\n    return (_e45 * (1f + (_e46 * 0.25f)));\n}\n\nfn main_1() {\n    var at: vec3<f32>;\n    var alpha_2: f32;\n    var param: f32;\n    var param_1: vec2<f32>;\n    var p_1: vec3<f32>;\n    var uv: vec2<f32>;\n    var previousDepth: f32;\n    var param_2: f32;\n    var param_3: f32;\n    var param_4: f32;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n\n    let _e38 = vUv_1;\n    let _e39 = _e38.xy;\n    let _e41 = vUv_1[2u];\n    at = vec3<f32>(_e39.x, _e39.y, floor((_e41 + 0.5f)));\n    let _e47 = at;\n    let _e53 = textureSample(uCutoutMap_t, uCutoutMap_s, vec2<f32>(_e47.x, _e47.y), i32(_e47.z));\n    let _e54 = vUv_1;\n    let _e56 = textureDimensions(uCutoutMap_t, 0i);\n    param = _e53.w;\n    param_1 = (_e54.xy * vec2<f32>(vec2<i32>(_e56).xy));\n    let _e62 = cutoutAlpha_u0028_f1_u003b_vf2_u003b((&param), (&param_1));\n    alpha_2 = _e62;\n    let _e64 = unnamed.uPeelShadowLayer;\n    if (_e64 != 0i) {\n        let _e66 = vLightPosition_1;\n        let _e69 = vLightPosition_1[3u];\n        p_1 = (_e66.xyz / vec3(_e69));\n        let _e72 = p_1;\n        uv = ((_e72.xy * 0.5f) + vec2(0.5f));\n        let _e77 = uv;\n        let _e80 = vec3<f32>(_e77.x, _e77.y, 0f);\n        let _e86 = textureSampleLevel(uPreviousShadowMap_t, uPreviousShadowMap_s, vec2<f32>(_e80.x, _e80.y), i32(_e80.z), 0f);\n        previousDepth = _e86.x;\n        let _e89 = gl_FragCoord_1[2u];\n        let _e90 = previousDepth;\n        if (_e89 <= (_e90 + 0.00001f)) {\n            discard;\n        }\n    }\n    let _e94 = vAlphaCutout_1[1u];\n    if (_e94 > 0.5f) {\n        let _e96 = alpha_2;\n        param_2 = _e96;\n        let _e98 = vAlphaCutout_1[0u];\n        param_3 = _e98;\n        let _e99 = cutoutShare_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n        param_4 = _e99;\n        let _e100 = gl_FragCoord_1;\n        param_5 = _e100.xy;\n        param_6 = 0f;\n        let _e102 = cutoutKeeps_u0028_f1_u003b_vf2_u003b_f1_u003b((&param_4), (&param_5), (&param_6));\n        if !(_e102) {\n            discard;\n        }\n    } else {\n        let _e104 = alpha_2;\n        let _e106 = vAlphaCutout_1[0u];\n        if (_e104 < _e106) {\n            discard;\n        }\n    }\n    return;\n}\n\n@fragment \nfn main(@location(1) vUv: vec3<f32>, @location(0) vLightPosition: vec4<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(2) @interpolate(flat) vAlphaCutout: vec2<f32>) {\n    vUv_1 = vUv;\n    vLightPosition_1 = vLightPosition;\n    gl_FragCoord_1 = gl_FragCoord;\n    vAlphaCutout_1 = vAlphaCutout;\n    main_1();\n}\n";

export const DEPTH_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n    uUvScale: vec2<f32>,\n    uUvOffset: vec2<f32>,\n    uAlphaCutout: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: vec2<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: vec2<f32>;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e28 = (*sway);\n    if (_e28 <= 0f) {\n        let _e30 = (*worldPos);\n        return _e30;\n    }\n    let _e31 = (*worldPos);\n    let _e34 = unnamed.uWindSpatialPhase;\n    let _e37 = unnamed.uWindTime;\n    phase = (dot(_e31.xz, _e34) + _e37);\n    let _e40 = unnamed.uWindSpeed;\n    let _e42 = unnamed.uWindGust;\n    let _e44 = phase;\n    let _e47 = (*sway);\n    bend = (((_e40 + _e42) * sin(_e44)) * _e47);\n    let _e50 = (*worldPos)[0u];\n    let _e53 = unnamed.uWindDirection[0u];\n    let _e54 = bend;\n    let _e58 = (*worldPos)[1u];\n    let _e60 = (*worldPos)[2u];\n    let _e63 = unnamed.uWindDirection[1u];\n    let _e64 = bend;\n    return vec3<f32>((_e50 + (_e53 * _e54)), _e58, (_e60 + (_e63 * _e64)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e30 = aPosition_1;\n    local = vec4<f32>(_e30.x, _e30.y, _e30.z, 1f);\n    let _e36 = unnamed.uModel;\n    model = _e36;\n    let _e37 = model;\n    let _e38 = local;\n    world = (_e37 * _e38);\n    let _e40 = world;\n    param = _e40.xyz;\n    let _e43 = aChannel_1[0u];\n    param_1 = _e43;\n    let _e44 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e44;\n    let _e46 = unnamed.uLightViewProj;\n    let _e47 = bent;\n    let _e49 = world[3u];\n    vLightPosition = (_e46 * vec4<f32>(_e47.x, _e47.y, _e47.z, _e49));\n    let _e55 = vLightPosition;\n    unnamed_1.gl_Position = _e55;\n    let _e57 = aUv_1;\n    let _e60 = unnamed.uUvScale;\n    let _e63 = unnamed.uUvOffset;\n    let _e64 = ((_e57.xy * _e60) + _e63);\n    let _e66 = aUv_1[2u];\n    vUv = vec3<f32>(_e64.x, _e64.y, _e66);\n    let _e71 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e71;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    aUv_1 = aUv;\n    main_1();\n    let _e12 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e12);\n    let _e14 = vLightPosition;\n    let _e15 = unnamed_1.gl_Position;\n    let _e16 = vUv;\n    let _e17 = vAlphaCutout;\n    return VertexOutput(_e14, _e15, _e16, _e17);\n}\n";

export const DEPTH_FRAG_WGSL = "struct Uniforms {\n    uPeelShadowLayer: i32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLightPosition_1: vec4<f32>;\n@group(0) @binding(32) \nvar uPreviousShadowMap_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uPreviousShadowMap_s: sampler;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn main_1() {\n    var p: vec3<f32>;\n    var uv: vec2<f32>;\n    var previousDepth: f32;\n\n    let _e16 = unnamed.uPeelShadowLayer;\n    if (_e16 != 0i) {\n        let _e18 = vLightPosition_1;\n        let _e21 = vLightPosition_1[3u];\n        p = (_e18.xyz / vec3(_e21));\n        let _e24 = p;\n        uv = ((_e24.xy * 0.5f) + vec2(0.5f));\n        let _e29 = uv;\n        let _e32 = vec3<f32>(_e29.x, _e29.y, 0f);\n        let _e38 = textureSample(uPreviousShadowMap_t, uPreviousShadowMap_s, vec2<f32>(_e32.x, _e32.y), i32(_e32.z));\n        previousDepth = _e38.x;\n        let _e41 = gl_FragCoord_1[2u];\n        let _e42 = previousDepth;\n        if (_e41 <= (_e42 + 0.00001f)) {\n            discard;\n        }\n    }\n    return;\n}\n\n@fragment \nfn main(@location(0) vLightPosition: vec4<f32>, @builtin(position) gl_FragCoord: vec4<f32>) {\n    vLightPosition_1 = vLightPosition;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n}\n";

export const DEPTH_INSTANCED_ANIMATED_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uUvScale: vec2<f32>,\n    uUvOffset: vec2<f32>,\n    uAlphaCutout: vec2<f32>,\n    uSceneTime: f32,\n    uBoneClip: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: vec2<f32>,\n}\n\n@group(0) @binding(16) \nvar uBonePlaces_t: texture_2d<f32>;\n@group(0) @binding(20) \nvar uInstanceClocks_t: texture_2d<f32>;\nvar<private> gl_InstanceIndex_1: i32;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aGrain_1: f32;\n@group(0) @binding(18) \nvar uBoneTurns_t: texture_2d<f32>;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: vec2<f32>;\n@group(0) @binding(17) \nvar uBonePlaces_s: sampler;\n@group(0) @binding(19) \nvar uBoneTurns_s: sampler;\n@group(0) @binding(21) \nvar uInstanceClocks_s: sampler;\n\nfn boneTurn_u0028_vf4_u003b_vf3_u003b(q: ptr<function, vec4<f32>>, v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e38 = (*v);\n    let _e39 = (*q);\n    let _e41 = (*q);\n    let _e43 = (*v);\n    let _e46 = (*q)[3u];\n    let _e47 = (*v);\n    return (_e38 + (cross(_e39.xyz, (cross(_e41.xyz, _e43) + (_e47 * _e46))) * 2f));\n}\n\nfn boneAnimate_u0028_vf3_u003b_vf3_u003b_vf3_u003b(position: ptr<function, vec3<f32>>, normal: ptr<function, vec3<f32>>, tangent: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var size: vec2<i32>;\n    var clocksWidth: i32;\n    var clock: vec2<f32>;\n    var moment: f32;\n    var frames: f32;\n    var wrapped: f32;\n    var first: i32;\n    var second: i32;\n    var local: i32;\n    var blend: f32;\n    var bone: i32;\n    var q0_: vec4<f32>;\n    var q1_: vec4<f32>;\n    var q_1: vec4<f32>;\n    var place: vec3<f32>;\n    var param: vec4<f32>;\n    var param_1: vec3<f32>;\n    var param_2: vec4<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec4<f32>;\n    var param_5: vec3<f32>;\n\n    let _e60 = textureDimensions(uBonePlaces_t, 0i);\n    size = vec2<i32>(_e60);\n    let _e62 = textureDimensions(uInstanceClocks_t, 0i);\n    clocksWidth = vec2<i32>(_e62).x;\n    let _e65 = gl_InstanceIndex_1;\n    let _e66 = clocksWidth;\n    let _e74 = gl_InstanceIndex_1;\n    let _e75 = clocksWidth;\n    let _e78 = textureLoad(uInstanceClocks_t, vec2<i32>((_e65 - (i32(floor((f32(_e65) / f32(_e66)))) * _e66)), (_e74 / _e75)), 0i);\n    clock = _e78.xy;\n    let _e81 = unnamed.uSceneTime;\n    let _e83 = clock[1u];\n    let _e86 = clock[0u];\n    let _e90 = unnamed.uBoneClip[0u];\n    moment = (((_e81 * _e83) + _e86) * _e90);\n    let _e93 = size[1u];\n    frames = f32(_e93);\n    let _e95 = moment;\n    let _e96 = frames;\n    let _e97 = moment;\n    let _e98 = frames;\n    wrapped = (_e95 - (_e96 * floor((_e97 / _e98))));\n    let _e103 = wrapped;\n    let _e107 = size[1u];\n    first = min(i32(floor(_e103)), (_e107 - 1i));\n    let _e110 = first;\n    let _e113 = size[1u];\n    if ((_e110 + 1i) == _e113) {\n        local = 0i;\n    } else {\n        let _e115 = first;\n        local = (_e115 + 1i);\n    }\n    let _e117 = local;\n    second = _e117;\n    let _e118 = wrapped;\n    let _e119 = first;\n    blend = clamp((_e118 - f32(_e119)), 0f, 1f);\n    let _e123 = aGrain_1;\n    let _e127 = unnamed.uBoneClip[1u];\n    let _e133 = size[0u];\n    bone = clamp(i32(floor((((-1f - _e123) * _e127) + 0.5f))), 0i, (_e133 - 1i));\n    let _e136 = bone;\n    let _e137 = first;\n    let _e139 = textureLoad(uBoneTurns_t, vec2<i32>(_e136, _e137), 0i);\n    q0_ = _e139;\n    let _e140 = bone;\n    let _e141 = second;\n    let _e143 = textureLoad(uBoneTurns_t, vec2<i32>(_e140, _e141), 0i);\n    q1_ = _e143;\n    let _e144 = q0_;\n    let _e145 = q1_;\n    if (dot(_e144, _e145) < 0f) {\n        let _e148 = q1_;\n        q1_ = -(_e148);\n    }\n    let _e150 = q0_;\n    let _e151 = q1_;\n    let _e152 = blend;\n    q_1 = normalize(mix(_e150, _e151, vec4(_e152)));\n    let _e156 = bone;\n    let _e157 = first;\n    let _e159 = textureLoad(uBonePlaces_t, vec2<i32>(_e156, _e157), 0i);\n    let _e161 = bone;\n    let _e162 = second;\n    let _e164 = textureLoad(uBonePlaces_t, vec2<i32>(_e161, _e162), 0i);\n    let _e166 = blend;\n    place = mix(_e159.xyz, _e164.xyz, vec3(_e166));\n    let _e169 = q_1;\n    param = _e169;\n    let _e170 = (*normal);\n    param_1 = _e170;\n    let _e171 = boneTurn_u0028_vf4_u003b_vf3_u003b((&param), (&param_1));\n    (*normal) = _e171;\n    let _e172 = q_1;\n    param_2 = _e172;\n    let _e173 = (*tangent);\n    param_3 = _e173;\n    let _e174 = boneTurn_u0028_vf4_u003b_vf3_u003b((&param_2), (&param_3));\n    (*tangent) = _e174;\n    let _e175 = q_1;\n    param_4 = _e175;\n    let _e176 = (*position);\n    param_5 = _e176;\n    let _e177 = boneTurn_u0028_vf4_u003b_vf3_u003b((&param_4), (&param_5));\n    let _e178 = place;\n    return (_e177 + _e178);\n}\n\nfn main_1() {\n    var local_1: vec4<f32>;\n    var animatedNormal: vec3<f32>;\n    var animatedTangent: vec3<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n    var param_8: vec3<f32>;\n    var model: mat4x4<f32>;\n    var instanceCell: vec4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e46 = aPosition_1;\n    local_1 = vec4<f32>(_e46.x, _e46.y, _e46.z, 1f);\n    animatedNormal = vec3<f32>(0f, 1f, 0f);\n    animatedTangent = vec3<f32>(1f, 0f, 0f);\n    let _e51 = local_1;\n    param_6 = _e51.xyz;\n    let _e53 = animatedNormal;\n    param_7 = _e53;\n    let _e54 = animatedTangent;\n    param_8 = _e54;\n    let _e55 = boneAnimate_u0028_vf3_u003b_vf3_u003b_vf3_u003b((&param_6), (&param_7), (&param_8));\n    let _e56 = param_7;\n    animatedNormal = _e56;\n    let _e57 = param_8;\n    animatedTangent = _e57;\n    local_1 = vec4<f32>(_e55.x, _e55.y, _e55.z, 1f);\n    let _e62 = aInstanceModel0_1;\n    let _e63 = aInstanceModel1_1;\n    let _e64 = aInstanceModel2_1;\n    let _e65 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e62.x, _e62.y, _e62.z, _e62.w), vec4<f32>(_e63.x, _e63.y, _e63.z, _e63.w), vec4<f32>(_e64.x, _e64.y, _e64.z, _e64.w), vec4<f32>(_e65.x, _e65.y, _e65.z, _e65.w));\n    let _e89 = model[0][3u];\n    let _e92 = model[1][3u];\n    let _e95 = model[2][3u];\n    let _e98 = model[3][3u];\n    instanceCell = vec4<f32>(_e89, _e92, _e95, _e98);\n    model[0][3u] = 0f;\n    model[1][3u] = 0f;\n    model[2][3u] = 0f;\n    model[3][3u] = 1f;\n    let _e108 = model;\n    let _e109 = local_1;\n    world = (_e108 * _e109);\n    let _e111 = world;\n    bent = _e111.xyz;\n    let _e114 = unnamed.uLightViewProj;\n    let _e115 = bent;\n    let _e117 = world[3u];\n    vLightPosition = (_e114 * vec4<f32>(_e115.x, _e115.y, _e115.z, _e117));\n    let _e123 = vLightPosition;\n    unnamed_1.gl_Position = _e123;\n    let _e125 = aUv_1;\n    let _e127 = instanceCell;\n    let _e130 = instanceCell;\n    let _e134 = unnamed.uUvScale;\n    let _e137 = unnamed.uUvOffset;\n    let _e138 = ((((_e125.xy * _e127.xy) + _e130.zw) * _e134) + _e137);\n    let _e140 = aUv_1[2u];\n    vUv = vec3<f32>(_e138.x, _e138.y, _e140);\n    let _e145 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e145;\n    return;\n}\n\n@vertex \nfn main(@builtin(instance_index) gl_InstanceIndex: u32, @location(8) aGrain: f32, @location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    gl_InstanceIndex_1 = i32(gl_InstanceIndex);\n    aGrain_1 = aGrain;\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    aUv_1 = aUv;\n    main_1();\n    let _e23 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e23);\n    let _e25 = vLightPosition;\n    let _e26 = unnamed_1.gl_Position;\n    let _e27 = vUv;\n    let _e28 = vAlphaCutout;\n    return VertexOutput(_e25, _e26, _e27, _e28);\n}\n";

export const DEPTH_INSTANCED_ANIMATED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uSceneTime: f32,\n    uBoneClip: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(16) \nvar uBonePlaces_t: texture_2d<f32>;\n@group(0) @binding(20) \nvar uInstanceClocks_t: texture_2d<f32>;\nvar<private> gl_InstanceIndex_1: i32;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aGrain_1: f32;\n@group(0) @binding(18) \nvar uBoneTurns_t: texture_2d<f32>;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(17) \nvar uBonePlaces_s: sampler;\n@group(0) @binding(19) \nvar uBoneTurns_s: sampler;\n@group(0) @binding(21) \nvar uInstanceClocks_s: sampler;\n\nfn boneTurn_u0028_vf4_u003b_vf3_u003b(q: ptr<function, vec4<f32>>, v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e32 = (*v);\n    let _e33 = (*q);\n    let _e35 = (*q);\n    let _e37 = (*v);\n    let _e40 = (*q)[3u];\n    let _e41 = (*v);\n    return (_e32 + (cross(_e33.xyz, (cross(_e35.xyz, _e37) + (_e41 * _e40))) * 2f));\n}\n\nfn boneAnimate_u0028_vf3_u003b_vf3_u003b_vf3_u003b(position: ptr<function, vec3<f32>>, normal: ptr<function, vec3<f32>>, tangent: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var size: vec2<i32>;\n    var clocksWidth: i32;\n    var clock: vec2<f32>;\n    var moment: f32;\n    var frames: f32;\n    var wrapped: f32;\n    var first: i32;\n    var second: i32;\n    var local: i32;\n    var blend: f32;\n    var bone: i32;\n    var q0_: vec4<f32>;\n    var q1_: vec4<f32>;\n    var q_1: vec4<f32>;\n    var place: vec3<f32>;\n    var param: vec4<f32>;\n    var param_1: vec3<f32>;\n    var param_2: vec4<f32>;\n    var param_3: vec3<f32>;\n    var param_4: vec4<f32>;\n    var param_5: vec3<f32>;\n\n    let _e54 = textureDimensions(uBonePlaces_t, 0i);\n    size = vec2<i32>(_e54);\n    let _e56 = textureDimensions(uInstanceClocks_t, 0i);\n    clocksWidth = vec2<i32>(_e56).x;\n    let _e59 = gl_InstanceIndex_1;\n    let _e60 = clocksWidth;\n    let _e68 = gl_InstanceIndex_1;\n    let _e69 = clocksWidth;\n    let _e72 = textureLoad(uInstanceClocks_t, vec2<i32>((_e59 - (i32(floor((f32(_e59) / f32(_e60)))) * _e60)), (_e68 / _e69)), 0i);\n    clock = _e72.xy;\n    let _e75 = unnamed.uSceneTime;\n    let _e77 = clock[1u];\n    let _e80 = clock[0u];\n    let _e84 = unnamed.uBoneClip[0u];\n    moment = (((_e75 * _e77) + _e80) * _e84);\n    let _e87 = size[1u];\n    frames = f32(_e87);\n    let _e89 = moment;\n    let _e90 = frames;\n    let _e91 = moment;\n    let _e92 = frames;\n    wrapped = (_e89 - (_e90 * floor((_e91 / _e92))));\n    let _e97 = wrapped;\n    let _e101 = size[1u];\n    first = min(i32(floor(_e97)), (_e101 - 1i));\n    let _e104 = first;\n    let _e107 = size[1u];\n    if ((_e104 + 1i) == _e107) {\n        local = 0i;\n    } else {\n        let _e109 = first;\n        local = (_e109 + 1i);\n    }\n    let _e111 = local;\n    second = _e111;\n    let _e112 = wrapped;\n    let _e113 = first;\n    blend = clamp((_e112 - f32(_e113)), 0f, 1f);\n    let _e117 = aGrain_1;\n    let _e121 = unnamed.uBoneClip[1u];\n    let _e127 = size[0u];\n    bone = clamp(i32(floor((((-1f - _e117) * _e121) + 0.5f))), 0i, (_e127 - 1i));\n    let _e130 = bone;\n    let _e131 = first;\n    let _e133 = textureLoad(uBoneTurns_t, vec2<i32>(_e130, _e131), 0i);\n    q0_ = _e133;\n    let _e134 = bone;\n    let _e135 = second;\n    let _e137 = textureLoad(uBoneTurns_t, vec2<i32>(_e134, _e135), 0i);\n    q1_ = _e137;\n    let _e138 = q0_;\n    let _e139 = q1_;\n    if (dot(_e138, _e139) < 0f) {\n        let _e142 = q1_;\n        q1_ = -(_e142);\n    }\n    let _e144 = q0_;\n    let _e145 = q1_;\n    let _e146 = blend;\n    q_1 = normalize(mix(_e144, _e145, vec4(_e146)));\n    let _e150 = bone;\n    let _e151 = first;\n    let _e153 = textureLoad(uBonePlaces_t, vec2<i32>(_e150, _e151), 0i);\n    let _e155 = bone;\n    let _e156 = second;\n    let _e158 = textureLoad(uBonePlaces_t, vec2<i32>(_e155, _e156), 0i);\n    let _e160 = blend;\n    place = mix(_e153.xyz, _e158.xyz, vec3(_e160));\n    let _e163 = q_1;\n    param = _e163;\n    let _e164 = (*normal);\n    param_1 = _e164;\n    let _e165 = boneTurn_u0028_vf4_u003b_vf3_u003b((&param), (&param_1));\n    (*normal) = _e165;\n    let _e166 = q_1;\n    param_2 = _e166;\n    let _e167 = (*tangent);\n    param_3 = _e167;\n    let _e168 = boneTurn_u0028_vf4_u003b_vf3_u003b((&param_2), (&param_3));\n    (*tangent) = _e168;\n    let _e169 = q_1;\n    param_4 = _e169;\n    let _e170 = (*position);\n    param_5 = _e170;\n    let _e171 = boneTurn_u0028_vf4_u003b_vf3_u003b((&param_4), (&param_5));\n    let _e172 = place;\n    return (_e171 + _e172);\n}\n\nfn main_1() {\n    var local_1: vec4<f32>;\n    var animatedNormal: vec3<f32>;\n    var animatedTangent: vec3<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n    var param_8: vec3<f32>;\n    var model: mat4x4<f32>;\n    var instanceCell: vec4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e40 = aPosition_1;\n    local_1 = vec4<f32>(_e40.x, _e40.y, _e40.z, 1f);\n    animatedNormal = vec3<f32>(0f, 1f, 0f);\n    animatedTangent = vec3<f32>(1f, 0f, 0f);\n    let _e45 = local_1;\n    param_6 = _e45.xyz;\n    let _e47 = animatedNormal;\n    param_7 = _e47;\n    let _e48 = animatedTangent;\n    param_8 = _e48;\n    let _e49 = boneAnimate_u0028_vf3_u003b_vf3_u003b_vf3_u003b((&param_6), (&param_7), (&param_8));\n    let _e50 = param_7;\n    animatedNormal = _e50;\n    let _e51 = param_8;\n    animatedTangent = _e51;\n    local_1 = vec4<f32>(_e49.x, _e49.y, _e49.z, 1f);\n    let _e56 = aInstanceModel0_1;\n    let _e57 = aInstanceModel1_1;\n    let _e58 = aInstanceModel2_1;\n    let _e59 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e56.x, _e56.y, _e56.z, _e56.w), vec4<f32>(_e57.x, _e57.y, _e57.z, _e57.w), vec4<f32>(_e58.x, _e58.y, _e58.z, _e58.w), vec4<f32>(_e59.x, _e59.y, _e59.z, _e59.w));\n    let _e83 = model[0][3u];\n    let _e86 = model[1][3u];\n    let _e89 = model[2][3u];\n    let _e92 = model[3][3u];\n    instanceCell = vec4<f32>(_e83, _e86, _e89, _e92);\n    model[0][3u] = 0f;\n    model[1][3u] = 0f;\n    model[2][3u] = 0f;\n    model[3][3u] = 1f;\n    let _e102 = model;\n    let _e103 = local_1;\n    world = (_e102 * _e103);\n    let _e105 = world;\n    bent = _e105.xyz;\n    let _e108 = unnamed.uLightViewProj;\n    let _e109 = bent;\n    let _e111 = world[3u];\n    vLightPosition = (_e108 * vec4<f32>(_e109.x, _e109.y, _e109.z, _e111));\n    let _e117 = vLightPosition;\n    unnamed_1.gl_Position = _e117;\n    return;\n}\n\n@vertex \nfn main(@builtin(instance_index) gl_InstanceIndex: u32, @location(8) aGrain: f32, @location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>) -> VertexOutput {\n    gl_InstanceIndex_1 = i32(gl_InstanceIndex);\n    aGrain_1 = aGrain;\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    main_1();\n    let _e19 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e19);\n    let _e21 = vLightPosition;\n    let _e22 = unnamed_1.gl_Position;\n    return VertexOutput(_e21, _e22);\n}\n";

export const DEPTH_INSTANCED_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uUvScale: vec2<f32>,\n    uUvOffset: vec2<f32>,\n    uAlphaCutout: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: vec2<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: vec2<f32>;\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var instanceCell: vec4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e24 = aPosition_1;\n    local = vec4<f32>(_e24.x, _e24.y, _e24.z, 1f);\n    let _e29 = aInstanceModel0_1;\n    let _e30 = aInstanceModel1_1;\n    let _e31 = aInstanceModel2_1;\n    let _e32 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e29.x, _e29.y, _e29.z, _e29.w), vec4<f32>(_e30.x, _e30.y, _e30.z, _e30.w), vec4<f32>(_e31.x, _e31.y, _e31.z, _e31.w), vec4<f32>(_e32.x, _e32.y, _e32.z, _e32.w));\n    let _e56 = model[0][3u];\n    let _e59 = model[1][3u];\n    let _e62 = model[2][3u];\n    let _e65 = model[3][3u];\n    instanceCell = vec4<f32>(_e56, _e59, _e62, _e65);\n    model[0][3u] = 0f;\n    model[1][3u] = 0f;\n    model[2][3u] = 0f;\n    model[3][3u] = 1f;\n    let _e75 = model;\n    let _e76 = local;\n    world = (_e75 * _e76);\n    let _e78 = world;\n    bent = _e78.xyz;\n    let _e81 = unnamed.uLightViewProj;\n    let _e82 = bent;\n    let _e84 = world[3u];\n    vLightPosition = (_e81 * vec4<f32>(_e82.x, _e82.y, _e82.z, _e84));\n    let _e90 = vLightPosition;\n    unnamed_1.gl_Position = _e90;\n    let _e92 = aUv_1;\n    let _e94 = instanceCell;\n    let _e97 = instanceCell;\n    let _e101 = unnamed.uUvScale;\n    let _e104 = unnamed.uUvOffset;\n    let _e105 = ((((_e92.xy * _e94.xy) + _e97.zw) * _e101) + _e104);\n    let _e107 = aUv_1[2u];\n    vUv = vec3<f32>(_e105.x, _e105.y, _e107);\n    let _e112 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e112;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    aUv_1 = aUv;\n    main_1();\n    let _e18 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e18);\n    let _e20 = vLightPosition;\n    let _e21 = unnamed_1.gl_Position;\n    let _e22 = vUv;\n    let _e23 = vAlphaCutout;\n    return VertexOutput(_e20, _e21, _e22, _e23);\n}\n";

export const DEPTH_INSTANCED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var instanceCell: vec4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e20 = aPosition_1;\n    local = vec4<f32>(_e20.x, _e20.y, _e20.z, 1f);\n    let _e25 = aInstanceModel0_1;\n    let _e26 = aInstanceModel1_1;\n    let _e27 = aInstanceModel2_1;\n    let _e28 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e25.x, _e25.y, _e25.z, _e25.w), vec4<f32>(_e26.x, _e26.y, _e26.z, _e26.w), vec4<f32>(_e27.x, _e27.y, _e27.z, _e27.w), vec4<f32>(_e28.x, _e28.y, _e28.z, _e28.w));\n    let _e52 = model[0][3u];\n    let _e55 = model[1][3u];\n    let _e58 = model[2][3u];\n    let _e61 = model[3][3u];\n    instanceCell = vec4<f32>(_e52, _e55, _e58, _e61);\n    model[0][3u] = 0f;\n    model[1][3u] = 0f;\n    model[2][3u] = 0f;\n    model[3][3u] = 1f;\n    let _e71 = model;\n    let _e72 = local;\n    world = (_e71 * _e72);\n    let _e74 = world;\n    bent = _e74.xyz;\n    let _e77 = unnamed.uLightViewProj;\n    let _e78 = bent;\n    let _e80 = world[3u];\n    vLightPosition = (_e77 * vec4<f32>(_e78.x, _e78.y, _e78.z, _e80));\n    let _e86 = vLightPosition;\n    unnamed_1.gl_Position = _e86;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    main_1();\n    let _e14 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e14);\n    let _e16 = vLightPosition;\n    let _e17 = unnamed_1.gl_Position;\n    return VertexOutput(_e16, _e17);\n}\n";

export const DEPTH_SKINNED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@id(0) override SKIN_EIGHT: bool = false;\n@id(1) override CLOTH_BOUND: bool = false;\n\n@group(0) @binding(16) \nvar uJointPalette_t: texture_2d<f32>;\nvar<private> aJoints_1: vec4<f32>;\nvar<private> aWeights_1: vec4<f32>;\nvar<private> aJoints2_1: vec4<f32>;\nvar<private> aWeights2_1: vec4<f32>;\n@group(0) @binding(18) \nvar uClothBinding_t: texture_2d<f32>;\n@group(0) @binding(20) \nvar uClothParticles_t: texture_2d<f32>;\n@group(0) @binding(22) \nvar uClothRest_t: texture_2d<f32>;\nvar<private> gl_VertexIndex_1: i32;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n@group(0) @binding(17) \nvar uJointPalette_s: sampler;\n@group(0) @binding(19) \nvar uClothBinding_s: sampler;\n@group(0) @binding(21) \nvar uClothParticles_s: sampler;\n@group(0) @binding(23) \nvar uClothRest_s: sampler;\n\nfn clothFrame_u0028_vf3_u003b_vf3_u003b_vf3_u003b(a: ptr<function, vec3<f32>>, b: ptr<function, vec3<f32>>, c: ptr<function, vec3<f32>>) -> mat3x3<f32> {\n    var edge: vec3<f32>;\n    var n: vec3<f32>;\n    var t: vec3<f32>;\n\n    let _e43 = (*b);\n    let _e44 = (*a);\n    edge = (_e43 - _e44);\n    let _e46 = edge;\n    let _e47 = (*c);\n    let _e48 = (*a);\n    n = normalize(cross(_e46, (_e47 - _e48)));\n    let _e52 = edge;\n    t = normalize(_e52);\n    let _e54 = t;\n    let _e55 = n;\n    let _e56 = t;\n    let _e57 = cross(_e55, _e56);\n    let _e58 = n;\n    return mat3x3<f32>(vec3<f32>(_e54.x, _e54.y, _e54.z), vec3<f32>(_e57.x, _e57.y, _e57.z), vec3<f32>(_e58.x, _e58.y, _e58.z));\n}\n\nfn clothTexel_u0028_i1_u003b_i1_u003b(i: ptr<function, i32>, width: ptr<function, i32>) -> vec2<i32> {\n    let _e39 = (*i);\n    let _e40 = (*width);\n    let _e48 = (*i);\n    let _e49 = (*width);\n    return vec2<i32>((_e39 - (i32(floor((f32(_e39) / f32(_e40)))) * _e40)), (_e48 / _e49));\n}\n\nfn clothPlace_u0028_vf3_u003b_mf33_u003b(position: ptr<function, vec3<f32>>, turn: ptr<function, mat3x3<f32>>) -> f32 {\n    var bindingWidth: i32;\n    var particleWidth: i32;\n    var restWidth: i32;\n    var indices: vec4<f32>;\n    var param: i32;\n    var param_1: i32;\n    var at: vec4<f32>;\n    var param_2: i32;\n    var param_3: i32;\n    var a_1: i32;\n    var b_1: i32;\n    var c_1: i32;\n    var pa: vec3<f32>;\n    var param_4: i32;\n    var param_5: i32;\n    var pb: vec3<f32>;\n    var param_6: i32;\n    var param_7: i32;\n    var pc: vec3<f32>;\n    var param_8: i32;\n    var param_9: i32;\n    var now: mat3x3<f32>;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var param_12: vec3<f32>;\n    var rest: mat3x3<f32>;\n    var param_13: i32;\n    var param_14: i32;\n    var param_15: i32;\n    var param_16: i32;\n    var param_17: i32;\n    var param_18: i32;\n    var param_19: vec3<f32>;\n    var param_20: vec3<f32>;\n    var param_21: vec3<f32>;\n\n    let _e74 = textureDimensions(uClothBinding_t, 0i);\n    bindingWidth = vec2<i32>(_e74).x;\n    let _e77 = textureDimensions(uClothParticles_t, 0i);\n    particleWidth = vec2<i32>(_e77).x;\n    let _e80 = textureDimensions(uClothRest_t, 0i);\n    restWidth = vec2<i32>(_e80).x;\n    let _e83 = gl_VertexIndex_1;\n    param = (_e83 * 2i);\n    let _e85 = bindingWidth;\n    param_1 = _e85;\n    let _e86 = clothTexel_u0028_i1_u003b_i1_u003b((&param), (&param_1));\n    let _e87 = textureLoad(uClothBinding_t, _e86, 0i);\n    indices = _e87;\n    let _e88 = gl_VertexIndex_1;\n    param_2 = ((_e88 * 2i) + 1i);\n    let _e91 = bindingWidth;\n    param_3 = _e91;\n    let _e92 = clothTexel_u0028_i1_u003b_i1_u003b((&param_2), (&param_3));\n    let _e93 = textureLoad(uClothBinding_t, _e92, 0i);\n    at = _e93;\n    let _e95 = indices[0u];\n    a_1 = i32(_e95);\n    let _e98 = indices[1u];\n    b_1 = i32(_e98);\n    let _e101 = indices[2u];\n    c_1 = i32(_e101);\n    let _e103 = a_1;\n    param_4 = _e103;\n    let _e104 = particleWidth;\n    param_5 = _e104;\n    let _e105 = clothTexel_u0028_i1_u003b_i1_u003b((&param_4), (&param_5));\n    let _e106 = textureLoad(uClothParticles_t, _e105, 0i);\n    pa = _e106.xyz;\n    let _e108 = a_1;\n    let _e109 = b_1;\n    let _e111 = b_1;\n    let _e112 = c_1;\n    if ((_e108 == _e109) && (_e111 == _e112)) {\n        let _e115 = pa;\n        (*position) = _e115;\n        (*turn) = mat3x3<f32>(vec3<f32>(1f, 0f, 0f), vec3<f32>(0f, 1f, 0f), vec3<f32>(0f, 0f, 1f));\n        let _e117 = indices[3u];\n        return _e117;\n    }\n    let _e118 = b_1;\n    param_6 = _e118;\n    let _e119 = particleWidth;\n    param_7 = _e119;\n    let _e120 = clothTexel_u0028_i1_u003b_i1_u003b((&param_6), (&param_7));\n    let _e121 = textureLoad(uClothParticles_t, _e120, 0i);\n    pb = _e121.xyz;\n    let _e123 = c_1;\n    param_8 = _e123;\n    let _e124 = particleWidth;\n    param_9 = _e124;\n    let _e125 = clothTexel_u0028_i1_u003b_i1_u003b((&param_8), (&param_9));\n    let _e126 = textureLoad(uClothParticles_t, _e125, 0i);\n    pc = _e126.xyz;\n    let _e128 = pa;\n    param_10 = _e128;\n    let _e129 = pb;\n    param_11 = _e129;\n    let _e130 = pc;\n    param_12 = _e130;\n    let _e131 = clothFrame_u0028_vf3_u003b_vf3_u003b_vf3_u003b((&param_10), (&param_11), (&param_12));\n    now = _e131;\n    let _e132 = a_1;\n    param_13 = _e132;\n    let _e133 = restWidth;\n    param_14 = _e133;\n    let _e134 = clothTexel_u0028_i1_u003b_i1_u003b((&param_13), (&param_14));\n    let _e135 = textureLoad(uClothRest_t, _e134, 0i);\n    let _e136 = b_1;\n    param_15 = _e136;\n    let _e137 = restWidth;\n    param_16 = _e137;\n    let _e138 = clothTexel_u0028_i1_u003b_i1_u003b((&param_15), (&param_16));\n    let _e139 = textureLoad(uClothRest_t, _e138, 0i);\n    let _e140 = c_1;\n    param_17 = _e140;\n    let _e141 = restWidth;\n    param_18 = _e141;\n    let _e142 = clothTexel_u0028_i1_u003b_i1_u003b((&param_17), (&param_18));\n    let _e143 = textureLoad(uClothRest_t, _e142, 0i);\n    param_19 = _e135.xyz;\n    param_20 = _e139.xyz;\n    param_21 = _e143.xyz;\n    let _e147 = clothFrame_u0028_vf3_u003b_vf3_u003b_vf3_u003b((&param_19), (&param_20), (&param_21));\n    rest = _e147;\n    let _e148 = pa;\n    let _e150 = at[0u];\n    let _e153 = at[1u];\n    let _e156 = pb;\n    let _e158 = at[0u];\n    let _e161 = pc;\n    let _e163 = at[1u];\n    let _e167 = now[2];\n    let _e169 = at[2u];\n    (*position) = ((((_e148 * ((1f - _e150) - _e153)) + (_e156 * _e158)) + (_e161 * _e163)) + (_e167 * _e169));\n    let _e172 = now;\n    let _e173 = rest;\n    (*turn) = (_e172 * transpose(_e173));\n    let _e177 = indices[3u];\n    return _e177;\n}\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e41 = (*sway);\n    if (_e41 <= 0f) {\n        let _e43 = (*worldPos);\n        return _e43;\n    }\n    let _e44 = (*worldPos);\n    let _e47 = unnamed.uWindSpatialPhase;\n    let _e50 = unnamed.uWindTime;\n    phase = (dot(_e44.xz, _e47) + _e50);\n    let _e53 = unnamed.uWindSpeed;\n    let _e55 = unnamed.uWindGust;\n    let _e57 = phase;\n    let _e60 = (*sway);\n    bend = (((_e53 + _e55) * sin(_e57)) * _e60);\n    let _e63 = (*worldPos)[0u];\n    let _e66 = unnamed.uWindDirection[0u];\n    let _e67 = bend;\n    let _e71 = (*worldPos)[1u];\n    let _e73 = (*worldPos)[2u];\n    let _e76 = unnamed.uWindDirection[1u];\n    let _e77 = bend;\n    return vec3<f32>((_e63 + (_e66 * _e67)), _e71, (_e73 + (_e76 * _e77)));\n}\n\nfn jointMatrix_u0028_i1_u003b(index: ptr<function, i32>) -> mat4x4<f32> {\n    var x: i32;\n\n    let _e39 = (*index);\n    x = (_e39 * 4i);\n    let _e41 = x;\n    let _e43 = textureLoad(uJointPalette_t, vec2<i32>(_e41, 0i), 0i);\n    let _e44 = x;\n    let _e47 = textureLoad(uJointPalette_t, vec2<i32>((_e44 + 1i), 0i), 0i);\n    let _e48 = x;\n    let _e51 = textureLoad(uJointPalette_t, vec2<i32>((_e48 + 2i), 0i), 0i);\n    let _e52 = x;\n    let _e55 = textureLoad(uJointPalette_t, vec2<i32>((_e52 + 3i), 0i), 0i);\n    return mat4x4<f32>(vec4<f32>(_e43.x, _e43.y, _e43.z, _e43.w), vec4<f32>(_e47.x, _e47.y, _e47.z, _e47.w), vec4<f32>(_e51.x, _e51.y, _e51.z, _e51.w), vec4<f32>(_e55.x, _e55.y, _e55.z, _e55.w));\n}\n\nfn skinMatrix_u0028_() -> mat4x4<f32> {\n    var m: mat4x4<f32>;\n    var param_22: i32;\n    var param_23: i32;\n    var param_24: i32;\n    var param_25: i32;\n    var param_26: i32;\n    var param_27: i32;\n    var param_28: i32;\n    var param_29: i32;\n\n    let _e47 = aJoints_1[0u];\n    param_22 = i32(_e47);\n    let _e49 = jointMatrix_u0028_i1_u003b((&param_22));\n    let _e51 = aWeights_1[0u];\n    let _e52 = (_e49 * _e51);\n    let _e54 = aJoints_1[1u];\n    param_23 = i32(_e54);\n    let _e56 = jointMatrix_u0028_i1_u003b((&param_23));\n    let _e58 = aWeights_1[1u];\n    let _e59 = (_e56 * _e58);\n    let _e72 = mat4x4<f32>((_e52[0] + _e59[0]), (_e52[1] + _e59[1]), (_e52[2] + _e59[2]), (_e52[3] + _e59[3]));\n    let _e74 = aJoints_1[2u];\n    param_24 = i32(_e74);\n    let _e76 = jointMatrix_u0028_i1_u003b((&param_24));\n    let _e78 = aWeights_1[2u];\n    let _e79 = (_e76 * _e78);\n    let _e92 = mat4x4<f32>((_e72[0] + _e79[0]), (_e72[1] + _e79[1]), (_e72[2] + _e79[2]), (_e72[3] + _e79[3]));\n    let _e94 = aJoints_1[3u];\n    param_25 = i32(_e94);\n    let _e96 = jointMatrix_u0028_i1_u003b((&param_25));\n    let _e98 = aWeights_1[3u];\n    let _e99 = (_e96 * _e98);\n    m = mat4x4<f32>((_e92[0] + _e99[0]), (_e92[1] + _e99[1]), (_e92[2] + _e99[2]), (_e92[3] + _e99[3]));\n    if SKIN_EIGHT {\n        let _e114 = aJoints2_1[0u];\n        param_26 = i32(_e114);\n        let _e116 = jointMatrix_u0028_i1_u003b((&param_26));\n        let _e118 = aWeights2_1[0u];\n        let _e119 = (_e116 * _e118);\n        let _e121 = aJoints2_1[1u];\n        param_27 = i32(_e121);\n        let _e123 = jointMatrix_u0028_i1_u003b((&param_27));\n        let _e125 = aWeights2_1[1u];\n        let _e126 = (_e123 * _e125);\n        let _e139 = mat4x4<f32>((_e119[0] + _e126[0]), (_e119[1] + _e126[1]), (_e119[2] + _e126[2]), (_e119[3] + _e126[3]));\n        let _e141 = aJoints2_1[2u];\n        param_28 = i32(_e141);\n        let _e143 = jointMatrix_u0028_i1_u003b((&param_28));\n        let _e145 = aWeights2_1[2u];\n        let _e146 = (_e143 * _e145);\n        let _e159 = mat4x4<f32>((_e139[0] + _e146[0]), (_e139[1] + _e146[1]), (_e139[2] + _e146[2]), (_e139[3] + _e146[3]));\n        let _e161 = aJoints2_1[3u];\n        param_29 = i32(_e161);\n        let _e163 = jointMatrix_u0028_i1_u003b((&param_29));\n        let _e165 = aWeights2_1[3u];\n        let _e166 = (_e163 * _e165);\n        let _e179 = mat4x4<f32>((_e159[0] + _e166[0]), (_e159[1] + _e166[1]), (_e159[2] + _e166[2]), (_e159[3] + _e166[3]));\n        let _e180 = m;\n        m = mat4x4<f32>((_e180[0] + _e179[0]), (_e180[1] + _e179[1]), (_e180[2] + _e179[2]), (_e180[3] + _e179[3]));\n    }\n    let _e194 = m;\n    return _e194;\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param_30: vec3<f32>;\n    var param_31: f32;\n    var follow: f32;\n    var clothPosition: vec3<f32>;\n    var turn_1: mat3x3<f32>;\n    var param_32: vec3<f32>;\n    var param_33: mat3x3<f32>;\n\n    let _e48 = skinMatrix_u0028_();\n    let _e49 = aPosition_1;\n    local = (_e48 * vec4<f32>(_e49.x, _e49.y, _e49.z, 1f));\n    let _e56 = unnamed.uModel;\n    model = _e56;\n    let _e57 = model;\n    let _e58 = local;\n    world = (_e57 * _e58);\n    let _e60 = world;\n    param_30 = _e60.xyz;\n    let _e63 = aChannel_1[0u];\n    param_31 = _e63;\n    let _e64 = channelBend_u0028_vf3_u003b_f1_u003b((&param_30), (&param_31));\n    bent = _e64;\n    if CLOTH_BOUND {\n        let _e65 = clothPlace_u0028_vf3_u003b_mf33_u003b((&param_32), (&param_33));\n        let _e66 = param_32;\n        clothPosition = _e66;\n        let _e67 = param_33;\n        turn_1 = _e67;\n        follow = _e65;\n        let _e68 = bent;\n        let _e69 = clothPosition;\n        let _e70 = follow;\n        bent = mix(_e68, _e69, vec3(_e70));\n    }\n    let _e74 = unnamed.uLightViewProj;\n    let _e75 = bent;\n    let _e77 = world[3u];\n    vLightPosition = (_e74 * vec4<f32>(_e75.x, _e75.y, _e75.z, _e77));\n    let _e83 = vLightPosition;\n    unnamed_1.gl_Position = _e83;\n    return;\n}\n\n@vertex \nfn main(@location(11) aJoints: vec4<f32>, @location(12) aWeights: vec4<f32>, @location(14) aJoints2_: vec4<f32>, @location(15) aWeights2_: vec4<f32>, @builtin(vertex_index) gl_VertexIndex: u32, @location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aJoints_1 = aJoints;\n    aWeights_1 = aWeights;\n    aJoints2_1 = aJoints2_;\n    aWeights2_1 = aWeights2_;\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e19 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e19);\n    let _e21 = vLightPosition;\n    let _e22 = unnamed_1.gl_Position;\n    return VertexOutput(_e21, _e22);\n}\n";

export const DEPTH_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e22 = (*sway);\n    if (_e22 <= 0f) {\n        let _e24 = (*worldPos);\n        return _e24;\n    }\n    let _e25 = (*worldPos);\n    let _e28 = unnamed.uWindSpatialPhase;\n    let _e31 = unnamed.uWindTime;\n    phase = (dot(_e25.xz, _e28) + _e31);\n    let _e34 = unnamed.uWindSpeed;\n    let _e36 = unnamed.uWindGust;\n    let _e38 = phase;\n    let _e41 = (*sway);\n    bend = (((_e34 + _e36) * sin(_e38)) * _e41);\n    let _e44 = (*worldPos)[0u];\n    let _e47 = unnamed.uWindDirection[0u];\n    let _e48 = bend;\n    let _e52 = (*worldPos)[1u];\n    let _e54 = (*worldPos)[2u];\n    let _e57 = unnamed.uWindDirection[1u];\n    let _e58 = bend;\n    return vec3<f32>((_e44 + (_e47 * _e48)), _e52, (_e54 + (_e57 * _e58)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e24 = aPosition_1;\n    local = vec4<f32>(_e24.x, _e24.y, _e24.z, 1f);\n    let _e30 = unnamed.uModel;\n    model = _e30;\n    let _e31 = model;\n    let _e32 = local;\n    world = (_e31 * _e32);\n    let _e34 = world;\n    param = _e34.xyz;\n    let _e37 = aChannel_1[0u];\n    param_1 = _e37;\n    let _e38 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e38;\n    let _e40 = unnamed.uLightViewProj;\n    let _e41 = bent;\n    let _e43 = world[3u];\n    vLightPosition = (_e40 * vec4<f32>(_e41.x, _e41.y, _e41.z, _e43));\n    let _e49 = vLightPosition;\n    unnamed_1.gl_Position = _e49;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e8 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e8);\n    let _e10 = vLightPosition;\n    let _e11 = unnamed_1.gl_Position;\n    return VertexOutput(_e10, _e11);\n}\n";

export const GLASS_TINT_CUTOUT_FRAG_WGSL = "struct Uniforms {\n    uGlassPane: vec4<f32>,\n    uGlassLight: vec4<f32>,\n}\n\nvar<private> vUv_1: vec3<f32>;\n@group(0) @binding(32) \nvar uCutoutMap_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uCutoutMap_s: sampler;\nvar<private> vGlassWorld_1: vec3<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> outTint: vec4<f32>;\nvar<private> vAlphaCutout_1: vec2<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\nvar<private> vLightPosition_1: vec4<f32>;\n\nfn cutoutKeeps_u0028_f1_u003b_vf2_u003b_f1_u003b(share: ptr<function, f32>, pixel: ptr<function, vec2<f32>>, frame: ptr<function, f32>) -> bool {\n    var p: vec2<f32>;\n    var noise: f32;\n\n    let _e34 = (*pixel);\n    let _e35 = (*frame);\n    p = (_e34 + vec2((5.588238f * _e35)));\n    let _e39 = p;\n    noise = fract((52.982918f * fract(dot(_e39, vec2<f32>(0.06711056f, 0.00583715f)))));\n    let _e44 = (*share);\n    let _e45 = noise;\n    return (_e44 > _e45);\n}\n\nfn cutoutShare_u0028_f1_u003b_f1_u003b(alpha: ptr<function, f32>, cutoff: ptr<function, f32>) -> f32 {\n    var band: f32;\n\n    let _e32 = (*cutoff);\n    let _e33 = (*cutoff);\n    band = max((2f * min(_e32, (1f - _e33))), 0.0001f);\n    let _e38 = (*alpha);\n    let _e39 = (*cutoff);\n    let _e41 = band;\n    return clamp((((_e38 - _e39) / _e41) + 0.5f), 0f, 1f);\n}\n\nfn cutoutAlpha_u0028_f1_u003b_vf2_u003b(alpha_1: ptr<function, f32>, texels: ptr<function, vec2<f32>>) -> f32 {\n    var dx: vec2<f32>;\n    var dy: vec2<f32>;\n    var level: f32;\n\n    let _e34 = (*texels);\n    let _e35 = dpdx(_e34);\n    dx = _e35;\n    let _e36 = (*texels);\n    let _e37 = dpdy(_e36);\n    dy = _e37;\n    let _e38 = dx;\n    let _e39 = dx;\n    let _e41 = dy;\n    let _e42 = dy;\n    level = max(0f, (0.5f * log2(max(dot(_e38, _e39), dot(_e41, _e42)))));\n    let _e48 = (*alpha_1);\n    let _e49 = level;\n    return (_e48 * (1f + (_e49 * 0.25f)));\n}\n\nfn main_1() {\n    var at: vec3<f32>;\n    var alpha_2: f32;\n    var param: f32;\n    var param_1: vec2<f32>;\n    var n: vec3<f32>;\n    var toLight: vec3<f32>;\n    var local: vec3<f32>;\n    var cosLight: f32;\n    var reflected: f32;\n    var param_2: f32;\n    var param_3: f32;\n    var param_4: f32;\n    var param_5: vec2<f32>;\n    var param_6: f32;\n\n    let _e43 = vUv_1;\n    let _e44 = _e43.xy;\n    let _e46 = vUv_1[2u];\n    at = vec3<f32>(_e44.x, _e44.y, floor((_e46 + 0.5f)));\n    let _e52 = at;\n    let _e58 = textureSample(uCutoutMap_t, uCutoutMap_s, vec2<f32>(_e52.x, _e52.y), i32(_e52.z));\n    let _e59 = vUv_1;\n    let _e61 = textureDimensions(uCutoutMap_t, 0i);\n    param = _e58.w;\n    param_1 = (_e59.xy * vec2<f32>(vec2<i32>(_e61).xy));\n    let _e67 = cutoutAlpha_u0028_f1_u003b_vf2_u003b((&param), (&param_1));\n    alpha_2 = _e67;\n    let _e68 = vGlassWorld_1;\n    let _e69 = dpdx(_e68);\n    let _e70 = vGlassWorld_1;\n    let _e71 = dpdy(_e70);\n    n = normalize(cross(_e69, _e71));\n    let _e76 = unnamed.uGlassLight[3u];\n    if (_e76 > 0.5f) {\n        let _e79 = unnamed.uGlassLight;\n        let _e81 = vGlassWorld_1;\n        local = normalize((_e79.xyz - _e81));\n    } else {\n        let _e85 = unnamed.uGlassLight;\n        local = _e85.xyz;\n    }\n    let _e87 = local;\n    toLight = _e87;\n    let _e88 = n;\n    let _e89 = toLight;\n    cosLight = abs(dot(_e88, _e89));\n    let _e92 = cosLight;\n    reflected = (0.04f + (0.96f * pow((1f - _e92), 5f)));\n    let _e98 = unnamed.uGlassPane;\n    let _e100 = reflected;\n    let _e102 = (_e98.xyz * (1f - _e100));\n    let _e105 = unnamed.uGlassPane[3u];\n    outTint = vec4<f32>(_e102.x, _e102.y, _e102.z, _e105);\n    let _e111 = vAlphaCutout_1[1u];\n    if (_e111 > 0.5f) {\n        let _e113 = alpha_2;\n        param_2 = _e113;\n        let _e115 = vAlphaCutout_1[0u];\n        param_3 = _e115;\n        let _e116 = cutoutShare_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n        param_4 = _e116;\n        let _e117 = gl_FragCoord_1;\n        param_5 = _e117.xy;\n        param_6 = 0f;\n        let _e119 = cutoutKeeps_u0028_f1_u003b_vf2_u003b_f1_u003b((&param_4), (&param_5), (&param_6));\n        if !(_e119) {\n            discard;\n        }\n    } else {\n        let _e121 = alpha_2;\n        let _e123 = vAlphaCutout_1[0u];\n        if (_e121 < _e123) {\n            discard;\n        }\n    }\n    return;\n}\n\n@fragment \nfn main(@location(1) vUv: vec3<f32>, @location(3) vGlassWorld: vec3<f32>, @location(2) @interpolate(flat) vAlphaCutout: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(0) vLightPosition: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    vGlassWorld_1 = vGlassWorld;\n    vAlphaCutout_1 = vAlphaCutout;\n    gl_FragCoord_1 = gl_FragCoord;\n    vLightPosition_1 = vLightPosition;\n    main_1();\n    let _e11 = outTint;\n    return _e11;\n}\n";

export const GLASS_TINT_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n    uUvScale: vec2<f32>,\n    uUvOffset: vec2<f32>,\n    uAlphaCutout: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: vec2<f32>,\n    @location(3) member_3: vec3<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: vec2<f32>;\nvar<private> vGlassWorld: vec3<f32>;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e29 = (*sway);\n    if (_e29 <= 0f) {\n        let _e31 = (*worldPos);\n        return _e31;\n    }\n    let _e32 = (*worldPos);\n    let _e35 = unnamed.uWindSpatialPhase;\n    let _e38 = unnamed.uWindTime;\n    phase = (dot(_e32.xz, _e35) + _e38);\n    let _e41 = unnamed.uWindSpeed;\n    let _e43 = unnamed.uWindGust;\n    let _e45 = phase;\n    let _e48 = (*sway);\n    bend = (((_e41 + _e43) * sin(_e45)) * _e48);\n    let _e51 = (*worldPos)[0u];\n    let _e54 = unnamed.uWindDirection[0u];\n    let _e55 = bend;\n    let _e59 = (*worldPos)[1u];\n    let _e61 = (*worldPos)[2u];\n    let _e64 = unnamed.uWindDirection[1u];\n    let _e65 = bend;\n    return vec3<f32>((_e51 + (_e54 * _e55)), _e59, (_e61 + (_e64 * _e65)));\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param: vec3<f32>;\n    var param_1: f32;\n\n    let _e31 = aPosition_1;\n    local = vec4<f32>(_e31.x, _e31.y, _e31.z, 1f);\n    let _e37 = unnamed.uModel;\n    model = _e37;\n    let _e38 = model;\n    let _e39 = local;\n    world = (_e38 * _e39);\n    let _e41 = world;\n    param = _e41.xyz;\n    let _e44 = aChannel_1[0u];\n    param_1 = _e44;\n    let _e45 = channelBend_u0028_vf3_u003b_f1_u003b((&param), (&param_1));\n    bent = _e45;\n    let _e47 = unnamed.uLightViewProj;\n    let _e48 = bent;\n    let _e50 = world[3u];\n    vLightPosition = (_e47 * vec4<f32>(_e48.x, _e48.y, _e48.z, _e50));\n    let _e56 = vLightPosition;\n    unnamed_1.gl_Position = _e56;\n    let _e58 = aUv_1;\n    let _e61 = unnamed.uUvScale;\n    let _e64 = unnamed.uUvOffset;\n    let _e65 = ((_e58.xy * _e61) + _e64);\n    let _e67 = aUv_1[2u];\n    vUv = vec3<f32>(_e65.x, _e65.y, _e67);\n    let _e72 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e72;\n    let _e73 = bent;\n    vGlassWorld = _e73;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    aUv_1 = aUv;\n    main_1();\n    let _e13 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e13);\n    let _e15 = vLightPosition;\n    let _e16 = unnamed_1.gl_Position;\n    let _e17 = vUv;\n    let _e18 = vAlphaCutout;\n    let _e19 = vGlassWorld;\n    return VertexOutput(_e15, _e16, _e17, _e18, _e19);\n}\n";

export const GLASS_TINT_FRAG_WGSL = "struct Uniforms {\n    uGlassPane: vec4<f32>,\n    uGlassLight: vec4<f32>,\n}\n\nvar<private> vGlassWorld_1: vec3<f32>;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> outTint: vec4<f32>;\nvar<private> vLightPosition_1: vec4<f32>;\n\nfn main_1() {\n    var n: vec3<f32>;\n    var toLight: vec3<f32>;\n    var local: vec3<f32>;\n    var cosLight: f32;\n    var reflected: f32;\n\n    let _e17 = vGlassWorld_1;\n    let _e18 = dpdx(_e17);\n    let _e19 = vGlassWorld_1;\n    let _e20 = dpdy(_e19);\n    n = normalize(cross(_e18, _e20));\n    let _e25 = unnamed.uGlassLight[3u];\n    if (_e25 > 0.5f) {\n        let _e28 = unnamed.uGlassLight;\n        let _e30 = vGlassWorld_1;\n        local = normalize((_e28.xyz - _e30));\n    } else {\n        let _e34 = unnamed.uGlassLight;\n        local = _e34.xyz;\n    }\n    let _e36 = local;\n    toLight = _e36;\n    let _e37 = n;\n    let _e38 = toLight;\n    cosLight = abs(dot(_e37, _e38));\n    let _e41 = cosLight;\n    reflected = (0.04f + (0.96f * pow((1f - _e41), 5f)));\n    let _e47 = unnamed.uGlassPane;\n    let _e49 = reflected;\n    let _e51 = (_e47.xyz * (1f - _e49));\n    let _e54 = unnamed.uGlassPane[3u];\n    outTint = vec4<f32>(_e51.x, _e51.y, _e51.z, _e54);\n    return;\n}\n\n@fragment \nfn main(@location(1) vGlassWorld: vec3<f32>, @location(0) vLightPosition: vec4<f32>) -> @location(0) vec4<f32> {\n    vGlassWorld_1 = vGlassWorld;\n    vLightPosition_1 = vLightPosition;\n    main_1();\n    let _e5 = outTint;\n    return _e5;\n}\n";

export const GLASS_TINT_INSTANCED_CUTOUT_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uUvScale: vec2<f32>,\n    uUvOffset: vec2<f32>,\n    uAlphaCutout: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) @interpolate(flat) member_2: vec2<f32>,\n    @location(3) member_3: vec3<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vUv: vec3<f32>;\nvar<private> aUv_1: vec3<f32>;\nvar<private> vAlphaCutout: vec2<f32>;\nvar<private> vGlassWorld: vec3<f32>;\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var instanceCell: vec4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e25 = aPosition_1;\n    local = vec4<f32>(_e25.x, _e25.y, _e25.z, 1f);\n    let _e30 = aInstanceModel0_1;\n    let _e31 = aInstanceModel1_1;\n    let _e32 = aInstanceModel2_1;\n    let _e33 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e30.x, _e30.y, _e30.z, _e30.w), vec4<f32>(_e31.x, _e31.y, _e31.z, _e31.w), vec4<f32>(_e32.x, _e32.y, _e32.z, _e32.w), vec4<f32>(_e33.x, _e33.y, _e33.z, _e33.w));\n    let _e57 = model[0][3u];\n    let _e60 = model[1][3u];\n    let _e63 = model[2][3u];\n    let _e66 = model[3][3u];\n    instanceCell = vec4<f32>(_e57, _e60, _e63, _e66);\n    model[0][3u] = 0f;\n    model[1][3u] = 0f;\n    model[2][3u] = 0f;\n    model[3][3u] = 1f;\n    let _e76 = model;\n    let _e77 = local;\n    world = (_e76 * _e77);\n    let _e79 = world;\n    bent = _e79.xyz;\n    let _e82 = unnamed.uLightViewProj;\n    let _e83 = bent;\n    let _e85 = world[3u];\n    vLightPosition = (_e82 * vec4<f32>(_e83.x, _e83.y, _e83.z, _e85));\n    let _e91 = vLightPosition;\n    unnamed_1.gl_Position = _e91;\n    let _e93 = aUv_1;\n    let _e95 = instanceCell;\n    let _e98 = instanceCell;\n    let _e102 = unnamed.uUvScale;\n    let _e105 = unnamed.uUvOffset;\n    let _e106 = ((((_e93.xy * _e95.xy) + _e98.zw) * _e102) + _e105);\n    let _e108 = aUv_1[2u];\n    vUv = vec3<f32>(_e106.x, _e106.y, _e108);\n    let _e113 = unnamed.uAlphaCutout;\n    vAlphaCutout = _e113;\n    let _e114 = bent;\n    vGlassWorld = _e114;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>, @location(5) aUv: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    aUv_1 = aUv;\n    main_1();\n    let _e19 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e19);\n    let _e21 = vLightPosition;\n    let _e22 = unnamed_1.gl_Position;\n    let _e23 = vUv;\n    let _e24 = vAlphaCutout;\n    let _e25 = vGlassWorld;\n    return VertexOutput(_e21, _e22, _e23, _e24, _e25);\n}\n";

export const GLASS_TINT_INSTANCED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n}\n\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstanceModel0_1: vec4<f32>;\nvar<private> aInstanceModel1_1: vec4<f32>;\nvar<private> aInstanceModel2_1: vec4<f32>;\nvar<private> aInstanceModel3_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vGlassWorld: vec3<f32>;\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var instanceCell: vec4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n\n    let _e21 = aPosition_1;\n    local = vec4<f32>(_e21.x, _e21.y, _e21.z, 1f);\n    let _e26 = aInstanceModel0_1;\n    let _e27 = aInstanceModel1_1;\n    let _e28 = aInstanceModel2_1;\n    let _e29 = aInstanceModel3_1;\n    model = mat4x4<f32>(vec4<f32>(_e26.x, _e26.y, _e26.z, _e26.w), vec4<f32>(_e27.x, _e27.y, _e27.z, _e27.w), vec4<f32>(_e28.x, _e28.y, _e28.z, _e28.w), vec4<f32>(_e29.x, _e29.y, _e29.z, _e29.w));\n    let _e53 = model[0][3u];\n    let _e56 = model[1][3u];\n    let _e59 = model[2][3u];\n    let _e62 = model[3][3u];\n    instanceCell = vec4<f32>(_e53, _e56, _e59, _e62);\n    model[0][3u] = 0f;\n    model[1][3u] = 0f;\n    model[2][3u] = 0f;\n    model[3][3u] = 1f;\n    let _e72 = model;\n    let _e73 = local;\n    world = (_e72 * _e73);\n    let _e75 = world;\n    bent = _e75.xyz;\n    let _e78 = unnamed.uLightViewProj;\n    let _e79 = bent;\n    let _e81 = world[3u];\n    vLightPosition = (_e78 * vec4<f32>(_e79.x, _e79.y, _e79.z, _e81));\n    let _e87 = vLightPosition;\n    unnamed_1.gl_Position = _e87;\n    let _e89 = bent;\n    vGlassWorld = _e89;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(11) aInstanceModel0_: vec4<f32>, @location(12) aInstanceModel1_: vec4<f32>, @location(13) aInstanceModel2_: vec4<f32>, @location(14) aInstanceModel3_: vec4<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstanceModel0_1 = aInstanceModel0_;\n    aInstanceModel1_1 = aInstanceModel1_;\n    aInstanceModel2_1 = aInstanceModel2_;\n    aInstanceModel3_1 = aInstanceModel3_;\n    main_1();\n    let _e15 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e15);\n    let _e17 = vLightPosition;\n    let _e18 = unnamed_1.gl_Position;\n    let _e19 = vGlassWorld;\n    return VertexOutput(_e17, _e18, _e19);\n}\n";

export const GLASS_TINT_SKINNED_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(1) member_1: vec3<f32>,\n}\n\n@id(0) override SKIN_EIGHT: bool = false;\n\n@group(0) @binding(16) \nvar uJointPalette_t: texture_2d<f32>;\nvar<private> aJoints_1: vec4<f32>;\nvar<private> aWeights_1: vec4<f32>;\nvar<private> aJoints2_1: vec4<f32>;\nvar<private> aWeights2_1: vec4<f32>;\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aChannel_1: vec4<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vGlassWorld: vec3<f32>;\n@group(0) @binding(17) \nvar uJointPalette_s: sampler;\n\nfn channelBend_u0028_vf3_u003b_f1_u003b(worldPos: ptr<function, vec3<f32>>, sway: ptr<function, f32>) -> vec3<f32> {\n    var phase: f32;\n    var bend: f32;\n\n    let _e30 = (*sway);\n    if (_e30 <= 0f) {\n        let _e32 = (*worldPos);\n        return _e32;\n    }\n    let _e33 = (*worldPos);\n    let _e36 = unnamed.uWindSpatialPhase;\n    let _e39 = unnamed.uWindTime;\n    phase = (dot(_e33.xz, _e36) + _e39);\n    let _e42 = unnamed.uWindSpeed;\n    let _e44 = unnamed.uWindGust;\n    let _e46 = phase;\n    let _e49 = (*sway);\n    bend = (((_e42 + _e44) * sin(_e46)) * _e49);\n    let _e52 = (*worldPos)[0u];\n    let _e55 = unnamed.uWindDirection[0u];\n    let _e56 = bend;\n    let _e60 = (*worldPos)[1u];\n    let _e62 = (*worldPos)[2u];\n    let _e65 = unnamed.uWindDirection[1u];\n    let _e66 = bend;\n    return vec3<f32>((_e52 + (_e55 * _e56)), _e60, (_e62 + (_e65 * _e66)));\n}\n\nfn jointMatrix_u0028_i1_u003b(index: ptr<function, i32>) -> mat4x4<f32> {\n    var x: i32;\n\n    let _e28 = (*index);\n    x = (_e28 * 4i);\n    let _e30 = x;\n    let _e32 = textureLoad(uJointPalette_t, vec2<i32>(_e30, 0i), 0i);\n    let _e33 = x;\n    let _e36 = textureLoad(uJointPalette_t, vec2<i32>((_e33 + 1i), 0i), 0i);\n    let _e37 = x;\n    let _e40 = textureLoad(uJointPalette_t, vec2<i32>((_e37 + 2i), 0i), 0i);\n    let _e41 = x;\n    let _e44 = textureLoad(uJointPalette_t, vec2<i32>((_e41 + 3i), 0i), 0i);\n    return mat4x4<f32>(vec4<f32>(_e32.x, _e32.y, _e32.z, _e32.w), vec4<f32>(_e36.x, _e36.y, _e36.z, _e36.w), vec4<f32>(_e40.x, _e40.y, _e40.z, _e40.w), vec4<f32>(_e44.x, _e44.y, _e44.z, _e44.w));\n}\n\nfn skinMatrix_u0028_() -> mat4x4<f32> {\n    var m: mat4x4<f32>;\n    var param: i32;\n    var param_1: i32;\n    var param_2: i32;\n    var param_3: i32;\n    var param_4: i32;\n    var param_5: i32;\n    var param_6: i32;\n    var param_7: i32;\n\n    let _e36 = aJoints_1[0u];\n    param = i32(_e36);\n    let _e38 = jointMatrix_u0028_i1_u003b((&param));\n    let _e40 = aWeights_1[0u];\n    let _e41 = (_e38 * _e40);\n    let _e43 = aJoints_1[1u];\n    param_1 = i32(_e43);\n    let _e45 = jointMatrix_u0028_i1_u003b((&param_1));\n    let _e47 = aWeights_1[1u];\n    let _e48 = (_e45 * _e47);\n    let _e61 = mat4x4<f32>((_e41[0] + _e48[0]), (_e41[1] + _e48[1]), (_e41[2] + _e48[2]), (_e41[3] + _e48[3]));\n    let _e63 = aJoints_1[2u];\n    param_2 = i32(_e63);\n    let _e65 = jointMatrix_u0028_i1_u003b((&param_2));\n    let _e67 = aWeights_1[2u];\n    let _e68 = (_e65 * _e67);\n    let _e81 = mat4x4<f32>((_e61[0] + _e68[0]), (_e61[1] + _e68[1]), (_e61[2] + _e68[2]), (_e61[3] + _e68[3]));\n    let _e83 = aJoints_1[3u];\n    param_3 = i32(_e83);\n    let _e85 = jointMatrix_u0028_i1_u003b((&param_3));\n    let _e87 = aWeights_1[3u];\n    let _e88 = (_e85 * _e87);\n    m = mat4x4<f32>((_e81[0] + _e88[0]), (_e81[1] + _e88[1]), (_e81[2] + _e88[2]), (_e81[3] + _e88[3]));\n    if SKIN_EIGHT {\n        let _e103 = aJoints2_1[0u];\n        param_4 = i32(_e103);\n        let _e105 = jointMatrix_u0028_i1_u003b((&param_4));\n        let _e107 = aWeights2_1[0u];\n        let _e108 = (_e105 * _e107);\n        let _e110 = aJoints2_1[1u];\n        param_5 = i32(_e110);\n        let _e112 = jointMatrix_u0028_i1_u003b((&param_5));\n        let _e114 = aWeights2_1[1u];\n        let _e115 = (_e112 * _e114);\n        let _e128 = mat4x4<f32>((_e108[0] + _e115[0]), (_e108[1] + _e115[1]), (_e108[2] + _e115[2]), (_e108[3] + _e115[3]));\n        let _e130 = aJoints2_1[2u];\n        param_6 = i32(_e130);\n        let _e132 = jointMatrix_u0028_i1_u003b((&param_6));\n        let _e134 = aWeights2_1[2u];\n        let _e135 = (_e132 * _e134);\n        let _e148 = mat4x4<f32>((_e128[0] + _e135[0]), (_e128[1] + _e135[1]), (_e128[2] + _e135[2]), (_e128[3] + _e135[3]));\n        let _e150 = aJoints2_1[3u];\n        param_7 = i32(_e150);\n        let _e152 = jointMatrix_u0028_i1_u003b((&param_7));\n        let _e154 = aWeights2_1[3u];\n        let _e155 = (_e152 * _e154);\n        let _e168 = mat4x4<f32>((_e148[0] + _e155[0]), (_e148[1] + _e155[1]), (_e148[2] + _e155[2]), (_e148[3] + _e155[3]));\n        let _e169 = m;\n        m = mat4x4<f32>((_e169[0] + _e168[0]), (_e169[1] + _e168[1]), (_e169[2] + _e168[2]), (_e169[3] + _e168[3]));\n    }\n    let _e183 = m;\n    return _e183;\n}\n\nfn main_1() {\n    var local: vec4<f32>;\n    var model: mat4x4<f32>;\n    var world: vec4<f32>;\n    var bent: vec3<f32>;\n    var param_8: vec3<f32>;\n    var param_9: f32;\n\n    let _e32 = skinMatrix_u0028_();\n    let _e33 = aPosition_1;\n    local = (_e32 * vec4<f32>(_e33.x, _e33.y, _e33.z, 1f));\n    let _e40 = unnamed.uModel;\n    model = _e40;\n    let _e41 = model;\n    let _e42 = local;\n    world = (_e41 * _e42);\n    let _e44 = world;\n    param_8 = _e44.xyz;\n    let _e47 = aChannel_1[0u];\n    param_9 = _e47;\n    let _e48 = channelBend_u0028_vf3_u003b_f1_u003b((&param_8), (&param_9));\n    bent = _e48;\n    let _e50 = unnamed.uLightViewProj;\n    let _e51 = bent;\n    let _e53 = world[3u];\n    vLightPosition = (_e50 * vec4<f32>(_e51.x, _e51.y, _e51.z, _e53));\n    let _e59 = vLightPosition;\n    unnamed_1.gl_Position = _e59;\n    let _e61 = bent;\n    vGlassWorld = _e61;\n    return;\n}\n\n@vertex \nfn main(@location(11) aJoints: vec4<f32>, @location(12) aWeights: vec4<f32>, @location(14) aJoints2_: vec4<f32>, @location(15) aWeights2_: vec4<f32>, @location(0) aPosition: vec3<f32>, @location(13) aChannel: vec4<f32>) -> VertexOutput {\n    aJoints_1 = aJoints;\n    aWeights_1 = aWeights;\n    aJoints2_1 = aJoints2_;\n    aWeights2_1 = aWeights2_;\n    aPosition_1 = aPosition;\n    aChannel_1 = aChannel;\n    main_1();\n    let _e17 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e17);\n    let _e19 = vLightPosition;\n    let _e20 = unnamed_1.gl_Position;\n    let _e21 = vGlassWorld;\n    return VertexOutput(_e19, _e20, _e21);\n}\n";

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
    "uniformSize": 192,
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
      "uUvOffset": {
        "offset": 168,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 176,
        "size": 8,
        "type": "vec2"
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
  "DEPTH_INSTANCED_ANIMATED_CUTOUT_VERT": {
    "uniforms": 0,
    "uniformSize": 112,
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
      "uUvOffset": {
        "offset": 72,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 80,
        "size": 8,
        "type": "vec2"
      },
      "uSceneTime": {
        "offset": 88,
        "size": 4,
        "type": "float"
      },
      "uBoneClip": {
        "offset": 96,
        "size": 8,
        "type": "vec2"
      }
    },
    "textures": {
      "uBonePlaces": {
        "texture": 16,
        "sampler": 17,
        "type": "sampler2D"
      },
      "uBoneTurns": {
        "texture": 18,
        "sampler": 19,
        "type": "sampler2D"
      },
      "uInstanceClocks": {
        "texture": 20,
        "sampler": 21,
        "type": "sampler2D"
      }
    }
  },
  "DEPTH_INSTANCED_ANIMATED_VERT": {
    "uniforms": 0,
    "uniformSize": 80,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uSceneTime": {
        "offset": 64,
        "size": 4,
        "type": "float"
      },
      "uBoneClip": {
        "offset": 72,
        "size": 8,
        "type": "vec2"
      }
    },
    "textures": {
      "uBonePlaces": {
        "texture": 16,
        "sampler": 17,
        "type": "sampler2D"
      },
      "uBoneTurns": {
        "texture": 18,
        "sampler": 19,
        "type": "sampler2D"
      },
      "uInstanceClocks": {
        "texture": 20,
        "sampler": 21,
        "type": "sampler2D"
      }
    }
  },
  "DEPTH_INSTANCED_CUTOUT_VERT": {
    "uniforms": 0,
    "uniformSize": 96,
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
      "uUvOffset": {
        "offset": 72,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 80,
        "size": 8,
        "type": "vec2"
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
      },
      "uClothBinding": {
        "texture": 18,
        "sampler": 19,
        "type": "sampler2D"
      },
      "uClothParticles": {
        "texture": 20,
        "sampler": 21,
        "type": "sampler2D"
      },
      "uClothRest": {
        "texture": 22,
        "sampler": 23,
        "type": "sampler2D"
      }
    },
    "overrides": {
      "SKIN_EIGHT": 0,
      "CLOTH_BOUND": 1
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
    "uniformSize": 192,
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
      "uUvOffset": {
        "offset": 168,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 176,
        "size": 8,
        "type": "vec2"
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
    "uniformSize": 96,
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
      "uUvOffset": {
        "offset": 72,
        "size": 8,
        "type": "vec2"
      },
      "uAlphaCutout": {
        "offset": 80,
        "size": 8,
        "type": "vec2"
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
    },
    "overrides": {
      "SKIN_EIGHT": 0
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
