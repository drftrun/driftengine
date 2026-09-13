/*
 * Generated from ../lightVolume.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const LIGHT_VOLUME_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(3) member: vec3<f32>,\n    @location(4) member_1: vec3<f32>,\n    @location(2) member_2: vec3<f32>,\n    @location(0) member_3: vec3<f32>,\n    @location(1) member_4: f32,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vLocal: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vColor: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vEnergy: f32;\nvar<private> aEmissive_1: f32;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var world: vec4<f32>;\n\n    let _e16 = unnamed.uModel;\n    let _e17 = aPosition_1;\n    world = (_e16 * vec4<f32>(_e17.x, _e17.y, _e17.z, 1f));\n    let _e23 = world;\n    vWorldPos = _e23.xyz;\n    let _e25 = aPosition_1;\n    vLocal = _e25;\n    let _e27 = unnamed.uModel;\n    let _e35 = aNormal_1;\n    vNormal = (mat3x3<f32>(_e27[0].xyz, _e27[1].xyz, _e27[2].xyz) * _e35);\n    let _e37 = aColor_1;\n    vColor = _e37;\n    let _e38 = aEmissive_1;\n    vEnergy = _e38;\n    let _e40 = unnamed.uViewProj;\n    let _e41 = world;\n    unnamed_1.gl_Position = (_e40 * _e41);\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(1) aNormal: vec3<f32>, @location(2) aColor: vec3<f32>, @location(3) aEmissive: f32) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aNormal_1 = aNormal;\n    aColor_1 = aColor;\n    aEmissive_1 = aEmissive;\n    main_1();\n    let _e16 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e16);\n    let _e18 = vWorldPos;\n    let _e19 = vLocal;\n    let _e20 = vNormal;\n    let _e21 = vColor;\n    let _e22 = vEnergy;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e18, _e19, _e20, _e21, _e22, _e23);\n}\n";

/** One entry per permutation, keyed by the flags that are on. See `variantKey`. */
export const LIGHT_VOLUME_FRAG_WGSL: Readonly<Record<string, string>> = {
  "none": "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uStrength: f32,\n    uLength: f32,\n    uSpread: f32,\n    uDust: f32,\n    uDustScale: f32,\n    uDustOffset: vec3<f32>,\n    uNear: f32,\n    uCameraLocal: vec3<f32>,\n    uModelWorld: mat4x4<f32>,\n    uSamples: i32,\n    uSceneDepthEnabled: i32,\n    uInvViewport: vec2<f32>,\n    uDepthToLocal: mat4x4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLocal_1: vec3<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(32) \nvar uSceneDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSceneDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vEnergy_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\n\nfn hash31_u0028_vf3_u003b(p: ptr<function, vec3<f32>>) -> f32 {\n    let _e77 = (*p);\n    return fract((sin(dot(_e77, vec3<f32>(127.1f, 311.7f, 74.7f))) * 43758.547f));\n}\n\nfn volumeNoise_u0028_vf3_u003b(p_1: ptr<function, vec3<f32>>) -> f32 {\n    var i: vec3<f32>;\n    var f: vec3<f32>;\n    var u: vec3<f32>;\n    var x00_: f32;\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n    var x10_: f32;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n    var x01_: f32;\n    var param_4: vec3<f32>;\n    var param_5: vec3<f32>;\n    var x11_: f32;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n\n    let _e92 = (*p_1);\n    i = floor(_e92);\n    let _e94 = (*p_1);\n    f = fract(_e94);\n    let _e96 = f;\n    let _e97 = f;\n    let _e99 = f;\n    u = ((_e96 * _e97) * (vec3(3f) - (_e99 * 2f)));\n    let _e104 = i;\n    param = (_e104 + vec3<f32>(0f, 0f, 0f));\n    let _e106 = hash31_u0028_vf3_u003b((&param));\n    let _e107 = i;\n    param_1 = (_e107 + vec3<f32>(1f, 0f, 0f));\n    let _e109 = hash31_u0028_vf3_u003b((&param_1));\n    let _e111 = u[0u];\n    x00_ = mix(_e106, _e109, _e111);\n    let _e113 = i;\n    param_2 = (_e113 + vec3<f32>(0f, 1f, 0f));\n    let _e115 = hash31_u0028_vf3_u003b((&param_2));\n    let _e116 = i;\n    param_3 = (_e116 + vec3<f32>(1f, 1f, 0f));\n    let _e118 = hash31_u0028_vf3_u003b((&param_3));\n    let _e120 = u[0u];\n    x10_ = mix(_e115, _e118, _e120);\n    let _e122 = i;\n    param_4 = (_e122 + vec3<f32>(0f, 0f, 1f));\n    let _e124 = hash31_u0028_vf3_u003b((&param_4));\n    let _e125 = i;\n    param_5 = (_e125 + vec3<f32>(1f, 0f, 1f));\n    let _e127 = hash31_u0028_vf3_u003b((&param_5));\n    let _e129 = u[0u];\n    x01_ = mix(_e124, _e127, _e129);\n    let _e131 = i;\n    param_6 = (_e131 + vec3<f32>(0f, 1f, 1f));\n    let _e133 = hash31_u0028_vf3_u003b((&param_6));\n    let _e134 = i;\n    param_7 = (_e134 + vec3<f32>(1f, 1f, 1f));\n    let _e136 = hash31_u0028_vf3_u003b((&param_7));\n    let _e138 = u[0u];\n    x11_ = mix(_e133, _e136, _e138);\n    let _e140 = x00_;\n    let _e141 = x10_;\n    let _e143 = u[1u];\n    let _e145 = x01_;\n    let _e146 = x11_;\n    let _e148 = u[1u];\n    let _e151 = u[2u];\n    return mix(mix(_e140, _e141, _e143), mix(_e145, _e146, _e148), _e151);\n}\n\nfn dustField_u0028_vf3_u003b(p_2: ptr<function, vec3<f32>>) -> f32 {\n    var param_8: vec3<f32>;\n    var param_9: vec3<f32>;\n\n    let _e79 = (*p_2);\n    param_8 = _e79;\n    let _e80 = volumeNoise_u0028_vf3_u003b((&param_8));\n    let _e82 = (*p_2);\n    param_9 = ((_e82 * 2.17f) + vec3(19.3f));\n    let _e86 = volumeNoise_u0028_vf3_u003b((&param_9));\n    return ((_e80 * 0.65f) + (_e86 * 0.35f));\n}\n\nfn densityAt_u0028_vf3_u003b_f1_u003b(local: ptr<function, vec3<f32>>, near: ptr<function, f32>) -> f32 {\n    var drawn: f32;\n    var along: f32;\n    var openness: f32;\n    var across: f32;\n\n    let _e83 = unnamed.uLength;\n    let _e84 = (*near);\n    drawn = max((_e83 - _e84), 0.0001f);\n    let _e88 = (*local)[2u];\n    let _e89 = (*near);\n    let _e91 = drawn;\n    along = clamp(((_e88 - _e89) / _e91), 0f, 1f);\n    let _e94 = (*local);\n    let _e98 = (*local)[2u];\n    openness = (length(_e94.xy) / max(_e98, 0.001f));\n    let _e101 = openness;\n    let _e103 = unnamed.uSpread;\n    across = clamp((_e101 / max(_e103, 0.0001f)), 0f, 1f);\n    let _e107 = along;\n    let _e110 = across;\n    return (pow((1f - _e107), 1.3f) * pow((1f - _e110), 2f));\n}\n\nfn main_1() {\n    var origin: vec3<f32>;\n    var toFragment: vec3<f32>;\n    var span: f32;\n    var dir: vec3<f32>;\n    var local_1: vec3<f32>;\n    var near_1: f32;\n    var enter: f32;\n    var leave: f32;\n    var toNear: f32;\n    var toFar: f32;\n    var reach: f32;\n    var ca: f32;\n    var cb: f32;\n    var cc: f32;\n    var disc: f32;\n    var root: f32;\n    var uv: vec2<f32>;\n    var stored: f32;\n    var hit: vec4<f32>;\n    var samples: i32;\n    var step_: f32;\n    var cell: i32;\n    var shadowOffset: f32;\n    var indexable: array<f32, 16>;\n    var param_10: vec3<f32>;\n    var total: f32;\n    var i_1: i32;\n    var travelled: f32;\n    var local_2: vec3<f32>;\n    var density: f32;\n    var param_11: vec3<f32>;\n    var param_12: f32;\n    var world: vec3<f32>;\n    var param_13: vec3<f32>;\n    var reference: f32;\n    var lit: f32;\n    var phi_282_: bool;\n\n    let _e113 = unnamed.uCameraLocal;\n    origin = _e113;\n    let _e114 = vLocal_1;\n    let _e115 = origin;\n    toFragment = (_e114 - _e115);\n    let _e117 = toFragment;\n    span = length(_e117);\n    let _e119 = span;\n    if (_e119 > 0.00001f) {\n        let _e121 = toFragment;\n        let _e122 = span;\n        local_1 = (_e121 / vec3(_e122));\n    } else {\n        local_1 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e125 = local_1;\n    dir = _e125;\n    let _e127 = unnamed.uNear;\n    let _e129 = unnamed.uLength;\n    near_1 = min(_e127, _e129);\n    enter = 0f;\n    let _e132 = unnamed.uLength;\n    leave = (_e132 * 2f);\n    let _e135 = dir[2u];\n    if (abs(_e135) > 0.00001f) {\n        let _e138 = near_1;\n        let _e140 = origin[2u];\n        let _e143 = dir[2u];\n        toNear = ((_e138 - _e140) / _e143);\n        let _e146 = unnamed.uLength;\n        let _e148 = origin[2u];\n        let _e151 = dir[2u];\n        toFar = ((_e146 - _e148) / _e151);\n        let _e153 = toNear;\n        let _e154 = toFar;\n        enter = min(_e153, _e154);\n        let _e156 = toNear;\n        let _e157 = toFar;\n        leave = max(_e156, _e157);\n    } else {\n        let _e160 = origin[2u];\n        let _e161 = near_1;\n        let _e162 = (_e160 < _e161);\n        phi_282_ = _e162;\n        if !(_e162) {\n            let _e165 = origin[2u];\n            let _e167 = unnamed.uLength;\n            phi_282_ = (_e165 > _e167);\n        }\n        let _e170 = phi_282_;\n        if _e170 {\n            discard;\n        }\n    }\n    let _e172 = unnamed.uSpread;\n    let _e174 = unnamed.uLength;\n    reach = ((_e172 * _e174) * 1.05f);\n    let _e177 = dir;\n    let _e179 = dir;\n    ca = dot(_e177.xy, _e179.xy);\n    let _e182 = origin;\n    let _e184 = dir;\n    cb = (2f * dot(_e182.xy, _e184.xy));\n    let _e188 = origin;\n    let _e190 = origin;\n    let _e193 = reach;\n    let _e194 = reach;\n    cc = (dot(_e188.xy, _e190.xy) - (_e193 * _e194));\n    let _e197 = ca;\n    if (_e197 > 0.00000001f) {\n        let _e199 = cb;\n        let _e200 = cb;\n        let _e202 = ca;\n        let _e204 = cc;\n        disc = ((_e199 * _e200) - ((4f * _e202) * _e204));\n        let _e207 = disc;\n        if (_e207 <= 0f) {\n            discard;\n        }\n        let _e209 = disc;\n        root = sqrt(_e209);\n        let _e211 = enter;\n        let _e212 = cb;\n        let _e214 = root;\n        let _e216 = ca;\n        enter = max(_e211, ((-(_e212) - _e214) / (2f * _e216)));\n        let _e220 = leave;\n        let _e221 = cb;\n        let _e223 = root;\n        let _e225 = ca;\n        leave = min(_e220, ((-(_e221) + _e223) / (2f * _e225)));\n    } else {\n        let _e229 = cc;\n        if (_e229 > 0f) {\n            discard;\n        }\n    }\n    let _e231 = enter;\n    enter = max(_e231, 0f);\n    let _e233 = leave;\n    let _e234 = enter;\n    let _e236 = unnamed.uLength;\n    leave = min(_e233, (_e234 + (_e236 * 2f)));\n    let _e241 = unnamed.uSceneDepthEnabled;\n    if (_e241 != 0i) {\n        let _e243 = gl_FragCoord_1;\n        let _e246 = unnamed.uInvViewport;\n        uv = (_e243.xy * _e246);\n        let _e248 = uv;\n        let _e249 = textureSampleLevel(uSceneDepth_t, uSceneDepth_s, _e248, 0f);\n        stored = _e249.x;\n        let _e252 = unnamed.uDepthToLocal;\n        let _e253 = uv;\n        let _e256 = ((_e253 * 2f) - vec2(1f));\n        let _e257 = stored;\n        hit = (_e252 * vec4<f32>(_e256.x, _e256.y, _e257, 1f));\n        let _e263 = hit[3u];\n        if (_e263 > 0.000001f) {\n            let _e265 = leave;\n            let _e266 = hit;\n            let _e269 = hit[3u];\n            let _e272 = origin;\n            let _e274 = dir;\n            leave = min(_e265, dot(((_e266.xyz / vec3(_e269)) - _e272), _e274));\n        }\n    }\n    let _e277 = leave;\n    let _e278 = enter;\n    if (_e277 <= _e278) {\n        discard;\n    }\n    let _e281 = unnamed.uSamples;\n    samples = clamp(_e281, 2i, 64i);\n    let _e283 = leave;\n    let _e284 = enter;\n    let _e286 = samples;\n    step_ = ((_e283 - _e284) / f32(_e286));\n    let _e290 = gl_FragCoord_1[1u];\n    let _e298 = gl_FragCoord_1[0u];\n    cell = ((i32((_e290 - (floor((_e290 / 4f)) * 4f))) * 4i) + i32((_e298 - (floor((_e298 / 4f)) * 4f))));\n    let _e305 = cell;\n    indexable = array<f32, 16>(0f, 8f, 2f, 10f, 12f, 4f, 14f, 6f, 3f, 11f, 1f, 9f, 15f, 7f, 13f, 5f);\n    let _e307 = indexable[_e305];\n    let _e308 = gl_FragCoord_1;\n    let _e309 = _e308.xy;\n    param_10 = vec3<f32>(_e309.x, _e309.y, 3.7f);\n    let _e313 = hash31_u0028_vf3_u003b((&param_10));\n    let _e317 = step_;\n    shadowOffset = ((((_e307 + _e313) / 16f) - 0.5f) * _e317);\n    total = 0f;\n    i_1 = 0i;\n    loop {\n        let _e319 = i_1;\n        if (_e319 < 64i) {\n            let _e321 = i_1;\n            let _e322 = samples;\n            if (_e321 >= _e322) {\n                break;\n            }\n            let _e324 = enter;\n            let _e325 = i_1;\n            let _e328 = step_;\n            travelled = (_e324 + ((f32(_e325) + 0.5f) * _e328));\n            let _e331 = origin;\n            let _e332 = dir;\n            let _e333 = travelled;\n            local_2 = (_e331 + (_e332 * _e333));\n            let _e336 = local_2;\n            param_11 = _e336;\n            let _e337 = near_1;\n            param_12 = _e337;\n            let _e338 = densityAt_u0028_vf3_u003b_f1_u003b((&param_11), (&param_12));\n            density = _e338;\n            let _e339 = density;\n            if (_e339 <= 0f) {\n                continue;\n            }\n            let _e342 = unnamed.uModelWorld;\n            let _e343 = local_2;\n            world = (_e342 * vec4<f32>(_e343.x, _e343.y, _e343.z, 1f)).xyz;\n            let _e351 = unnamed.uDust;\n            if (_e351 > 0f) {\n                let _e353 = world;\n                let _e355 = unnamed.uDustOffset;\n                let _e358 = unnamed.uDustScale;\n                param_13 = ((_e353 + _e355) / vec3(max(_e358, 0.001f)));\n                let _e362 = dustField_u0028_vf3_u003b((&param_13));\n                let _e364 = unnamed.uDust;\n                let _e366 = density;\n                density = (_e366 * mix(1f, _e362, _e364));\n            }\n            let _e368 = density;\n            let _e369 = total;\n            total = (_e369 + _e368);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e371 = i_1;\n            i_1 = (_e371 + 1i);\n        }\n    }\n    let _e374 = unnamed.uSpread;\n    let _e376 = unnamed.uLength;\n    reference = max((_e374 * _e376), 0.0001f);\n    let _e379 = total;\n    let _e381 = step_;\n    let _e383 = reference;\n    lit = (1f - exp((((-(_e379) * _e381) / _e383) * 3f)));\n    let _e388 = vColor_1;\n    let _e389 = vEnergy_1;\n    let _e390 = lit;\n    let _e393 = unnamed.uStrength;\n    let _e395 = (_e388 * ((_e389 * _e390) * _e393));\n    fragColor = vec4<f32>(_e395.x, _e395.y, _e395.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(4) vLocal: vec3<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(0) vColor: vec3<f32>, @location(1) vEnergy: f32, @location(2) vNormal: vec3<f32>, @location(3) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vLocal_1 = vLocal;\n    gl_FragCoord_1 = gl_FragCoord;\n    vColor_1 = vColor;\n    vEnergy_1 = vEnergy;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e13 = fragColor;\n    return _e13;\n}\n",
  "directionalShadows": "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uStrength: f32,\n    uLength: f32,\n    uSpread: f32,\n    uDust: f32,\n    uDustScale: f32,\n    uDustOffset: vec3<f32>,\n    uSunShadow: f32,\n    uLightViewProj: mat4x4<f32>,\n    uShadowMapSize: f32,\n    uPeeledShadowEnabled: i32,\n    uNear: f32,\n    uCameraLocal: vec3<f32>,\n    uModelWorld: mat4x4<f32>,\n    uSamples: i32,\n    uSceneDepthEnabled: i32,\n    uInvViewport: vec2<f32>,\n    uDepthToLocal: mat4x4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uStaticShadowMap_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uStaticShadowMap_s: sampler;\n@group(0) @binding(34) \nvar uPeeledShadowMap_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uPeeledShadowMap_s: sampler;\n@group(0) @binding(36) \nvar uDynamicShadowMap_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uDynamicShadowMap_s: sampler;\nvar<private> vLocal_1: vec3<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(38) \nvar uSceneDepth_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uSceneDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vEnergy_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\n\nfn occlusion_u0028_f1_u003b_f1_u003b(stored: ptr<function, f32>, compare: ptr<function, f32>) -> f32 {\n    let _e91 = (*compare);\n    let _e92 = (*stored);\n    return smoothstep(-0.0025f, 0.0025f, (_e91 - _e92));\n}\n\nfn sunReach_u0028_vf3_u003b(worldPos: ptr<function, vec3<f32>>) -> f32 {\n    var lightPos: vec4<f32>;\n    var p: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var edgeFade: f32;\n    var compare_1: f32;\n    var blocked: f32;\n    var param: f32;\n    var param_1: f32;\n    var param_2: f32;\n    var param_3: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var phi_212_: bool;\n    var phi_219_: bool;\n    var phi_226_: bool;\n    var phi_233_: bool;\n\n    let _e103 = unnamed.uLightViewProj;\n    let _e104 = (*worldPos);\n    lightPos = (_e103 * vec4<f32>(_e104.x, _e104.y, _e104.z, 1f));\n    let _e111 = lightPos[3u];\n    if (_e111 <= 0f) {\n        return 1f;\n    }\n    let _e113 = lightPos;\n    let _e116 = lightPos[3u];\n    p = (((_e113.xyz / vec3(_e116)) * 0.5f) + vec3(0.5f));\n    let _e123 = p[2u];\n    let _e124 = (_e123 > 1f);\n    phi_212_ = _e124;\n    if !(_e124) {\n        let _e127 = p[0u];\n        phi_212_ = (_e127 < 0f);\n    }\n    let _e130 = phi_212_;\n    phi_219_ = _e130;\n    if !(_e130) {\n        let _e133 = p[0u];\n        phi_219_ = (_e133 > 1f);\n    }\n    let _e136 = phi_219_;\n    phi_226_ = _e136;\n    if !(_e136) {\n        let _e139 = p[1u];\n        phi_226_ = (_e139 < 0f);\n    }\n    let _e142 = phi_226_;\n    phi_233_ = _e142;\n    if !(_e142) {\n        let _e145 = p[1u];\n        phi_233_ = (_e145 > 1f);\n    }\n    let _e148 = phi_233_;\n    if _e148 {\n        return 1f;\n    }\n    let _e149 = p;\n    fromCentre = (abs((_e149.xy - vec2(0.5f))) * 2f);\n    let _e156 = fromCentre[0u];\n    let _e158 = fromCentre[1u];\n    edgeFade = (1f - smoothstep(0.72f, 0.98f, max(_e156, _e158)));\n    let _e163 = p[2u];\n    let _e166 = edgeFade;\n    edgeFade = (_e166 * (1f - smoothstep(0.9f, 1f, _e163)));\n    let _e168 = edgeFade;\n    if (_e168 <= 0f) {\n        return 1f;\n    }\n    let _e171 = p[2u];\n    compare_1 = (_e171 - 0.0015f);\n    let _e173 = p;\n    let _e175 = textureSampleLevel(uStaticShadowMap_t, uStaticShadowMap_s, _e173.xy, 0f);\n    param = _e175.x;\n    let _e177 = compare_1;\n    param_1 = _e177;\n    let _e178 = occlusion_u0028_f1_u003b_f1_u003b((&param), (&param_1));\n    blocked = _e178;\n    let _e180 = unnamed.uPeeledShadowEnabled;\n    if (_e180 != 0i) {\n        let _e182 = blocked;\n        let _e183 = p;\n        let _e185 = textureSampleLevel(uPeeledShadowMap_t, uPeeledShadowMap_s, _e183.xy, 0f);\n        param_2 = _e185.x;\n        let _e187 = compare_1;\n        param_3 = _e187;\n        let _e188 = occlusion_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n        blocked = max(_e182, _e188);\n    }\n    let _e190 = blocked;\n    let _e191 = p;\n    let _e193 = textureSampleLevel(uDynamicShadowMap_t, uDynamicShadowMap_s, _e191.xy, 0f);\n    param_4 = _e193.x;\n    let _e195 = compare_1;\n    param_5 = _e195;\n    let _e196 = occlusion_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    blocked = max(_e190, _e196);\n    let _e198 = blocked;\n    let _e201 = unnamed.uSunShadow;\n    let _e202 = edgeFade;\n    return mix(1f, (1f - _e198), (_e201 * _e202));\n}\n\nfn hash31_u0028_vf3_u003b(p_1: ptr<function, vec3<f32>>) -> f32 {\n    let _e90 = (*p_1);\n    return fract((sin(dot(_e90, vec3<f32>(127.1f, 311.7f, 74.7f))) * 43758.547f));\n}\n\nfn volumeNoise_u0028_vf3_u003b(p_2: ptr<function, vec3<f32>>) -> f32 {\n    var i: vec3<f32>;\n    var f: vec3<f32>;\n    var u: vec3<f32>;\n    var x00_: f32;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n    var x10_: f32;\n    var param_8: vec3<f32>;\n    var param_9: vec3<f32>;\n    var x01_: f32;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var x11_: f32;\n    var param_12: vec3<f32>;\n    var param_13: vec3<f32>;\n\n    let _e105 = (*p_2);\n    i = floor(_e105);\n    let _e107 = (*p_2);\n    f = fract(_e107);\n    let _e109 = f;\n    let _e110 = f;\n    let _e112 = f;\n    u = ((_e109 * _e110) * (vec3(3f) - (_e112 * 2f)));\n    let _e117 = i;\n    param_6 = (_e117 + vec3<f32>(0f, 0f, 0f));\n    let _e119 = hash31_u0028_vf3_u003b((&param_6));\n    let _e120 = i;\n    param_7 = (_e120 + vec3<f32>(1f, 0f, 0f));\n    let _e122 = hash31_u0028_vf3_u003b((&param_7));\n    let _e124 = u[0u];\n    x00_ = mix(_e119, _e122, _e124);\n    let _e126 = i;\n    param_8 = (_e126 + vec3<f32>(0f, 1f, 0f));\n    let _e128 = hash31_u0028_vf3_u003b((&param_8));\n    let _e129 = i;\n    param_9 = (_e129 + vec3<f32>(1f, 1f, 0f));\n    let _e131 = hash31_u0028_vf3_u003b((&param_9));\n    let _e133 = u[0u];\n    x10_ = mix(_e128, _e131, _e133);\n    let _e135 = i;\n    param_10 = (_e135 + vec3<f32>(0f, 0f, 1f));\n    let _e137 = hash31_u0028_vf3_u003b((&param_10));\n    let _e138 = i;\n    param_11 = (_e138 + vec3<f32>(1f, 0f, 1f));\n    let _e140 = hash31_u0028_vf3_u003b((&param_11));\n    let _e142 = u[0u];\n    x01_ = mix(_e137, _e140, _e142);\n    let _e144 = i;\n    param_12 = (_e144 + vec3<f32>(0f, 1f, 1f));\n    let _e146 = hash31_u0028_vf3_u003b((&param_12));\n    let _e147 = i;\n    param_13 = (_e147 + vec3<f32>(1f, 1f, 1f));\n    let _e149 = hash31_u0028_vf3_u003b((&param_13));\n    let _e151 = u[0u];\n    x11_ = mix(_e146, _e149, _e151);\n    let _e153 = x00_;\n    let _e154 = x10_;\n    let _e156 = u[1u];\n    let _e158 = x01_;\n    let _e159 = x11_;\n    let _e161 = u[1u];\n    let _e164 = u[2u];\n    return mix(mix(_e153, _e154, _e156), mix(_e158, _e159, _e161), _e164);\n}\n\nfn dustField_u0028_vf3_u003b(p_3: ptr<function, vec3<f32>>) -> f32 {\n    var param_14: vec3<f32>;\n    var param_15: vec3<f32>;\n\n    let _e92 = (*p_3);\n    param_14 = _e92;\n    let _e93 = volumeNoise_u0028_vf3_u003b((&param_14));\n    let _e95 = (*p_3);\n    param_15 = ((_e95 * 2.17f) + vec3(19.3f));\n    let _e99 = volumeNoise_u0028_vf3_u003b((&param_15));\n    return ((_e93 * 0.65f) + (_e99 * 0.35f));\n}\n\nfn densityAt_u0028_vf3_u003b_f1_u003b(local: ptr<function, vec3<f32>>, near: ptr<function, f32>) -> f32 {\n    var drawn: f32;\n    var along: f32;\n    var openness: f32;\n    var across: f32;\n\n    let _e96 = unnamed.uLength;\n    let _e97 = (*near);\n    drawn = max((_e96 - _e97), 0.0001f);\n    let _e101 = (*local)[2u];\n    let _e102 = (*near);\n    let _e104 = drawn;\n    along = clamp(((_e101 - _e102) / _e104), 0f, 1f);\n    let _e107 = (*local);\n    let _e111 = (*local)[2u];\n    openness = (length(_e107.xy) / max(_e111, 0.001f));\n    let _e114 = openness;\n    let _e116 = unnamed.uSpread;\n    across = clamp((_e114 / max(_e116, 0.0001f)), 0f, 1f);\n    let _e120 = along;\n    let _e123 = across;\n    return (pow((1f - _e120), 1.3f) * pow((1f - _e123), 2f));\n}\n\nfn main_1() {\n    var origin: vec3<f32>;\n    var toFragment: vec3<f32>;\n    var span: f32;\n    var dir: vec3<f32>;\n    var local_1: vec3<f32>;\n    var near_1: f32;\n    var enter: f32;\n    var leave: f32;\n    var toNear: f32;\n    var toFar: f32;\n    var reach: f32;\n    var ca: f32;\n    var cb: f32;\n    var cc: f32;\n    var disc: f32;\n    var root: f32;\n    var uv: vec2<f32>;\n    var stored_1: f32;\n    var hit: vec4<f32>;\n    var samples: i32;\n    var step_: f32;\n    var cell: i32;\n    var shadowOffset: f32;\n    var indexable: array<f32, 16>;\n    var param_16: vec3<f32>;\n    var total: f32;\n    var i_1: i32;\n    var travelled: f32;\n    var local_2: vec3<f32>;\n    var density: f32;\n    var param_17: vec3<f32>;\n    var param_18: f32;\n    var world: vec3<f32>;\n    var param_19: vec3<f32>;\n    var dithered: vec3<f32>;\n    var param_20: vec3<f32>;\n    var reference: f32;\n    var lit: f32;\n    var phi_464_: bool;\n\n    let _e128 = unnamed.uCameraLocal;\n    origin = _e128;\n    let _e129 = vLocal_1;\n    let _e130 = origin;\n    toFragment = (_e129 - _e130);\n    let _e132 = toFragment;\n    span = length(_e132);\n    let _e134 = span;\n    if (_e134 > 0.00001f) {\n        let _e136 = toFragment;\n        let _e137 = span;\n        local_1 = (_e136 / vec3(_e137));\n    } else {\n        local_1 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e140 = local_1;\n    dir = _e140;\n    let _e142 = unnamed.uNear;\n    let _e144 = unnamed.uLength;\n    near_1 = min(_e142, _e144);\n    enter = 0f;\n    let _e147 = unnamed.uLength;\n    leave = (_e147 * 2f);\n    let _e150 = dir[2u];\n    if (abs(_e150) > 0.00001f) {\n        let _e153 = near_1;\n        let _e155 = origin[2u];\n        let _e158 = dir[2u];\n        toNear = ((_e153 - _e155) / _e158);\n        let _e161 = unnamed.uLength;\n        let _e163 = origin[2u];\n        let _e166 = dir[2u];\n        toFar = ((_e161 - _e163) / _e166);\n        let _e168 = toNear;\n        let _e169 = toFar;\n        enter = min(_e168, _e169);\n        let _e171 = toNear;\n        let _e172 = toFar;\n        leave = max(_e171, _e172);\n    } else {\n        let _e175 = origin[2u];\n        let _e176 = near_1;\n        let _e177 = (_e175 < _e176);\n        phi_464_ = _e177;\n        if !(_e177) {\n            let _e180 = origin[2u];\n            let _e182 = unnamed.uLength;\n            phi_464_ = (_e180 > _e182);\n        }\n        let _e185 = phi_464_;\n        if _e185 {\n            discard;\n        }\n    }\n    let _e187 = unnamed.uSpread;\n    let _e189 = unnamed.uLength;\n    reach = ((_e187 * _e189) * 1.05f);\n    let _e192 = dir;\n    let _e194 = dir;\n    ca = dot(_e192.xy, _e194.xy);\n    let _e197 = origin;\n    let _e199 = dir;\n    cb = (2f * dot(_e197.xy, _e199.xy));\n    let _e203 = origin;\n    let _e205 = origin;\n    let _e208 = reach;\n    let _e209 = reach;\n    cc = (dot(_e203.xy, _e205.xy) - (_e208 * _e209));\n    let _e212 = ca;\n    if (_e212 > 0.00000001f) {\n        let _e214 = cb;\n        let _e215 = cb;\n        let _e217 = ca;\n        let _e219 = cc;\n        disc = ((_e214 * _e215) - ((4f * _e217) * _e219));\n        let _e222 = disc;\n        if (_e222 <= 0f) {\n            discard;\n        }\n        let _e224 = disc;\n        root = sqrt(_e224);\n        let _e226 = enter;\n        let _e227 = cb;\n        let _e229 = root;\n        let _e231 = ca;\n        enter = max(_e226, ((-(_e227) - _e229) / (2f * _e231)));\n        let _e235 = leave;\n        let _e236 = cb;\n        let _e238 = root;\n        let _e240 = ca;\n        leave = min(_e235, ((-(_e236) + _e238) / (2f * _e240)));\n    } else {\n        let _e244 = cc;\n        if (_e244 > 0f) {\n            discard;\n        }\n    }\n    let _e246 = enter;\n    enter = max(_e246, 0f);\n    let _e248 = leave;\n    let _e249 = enter;\n    let _e251 = unnamed.uLength;\n    leave = min(_e248, (_e249 + (_e251 * 2f)));\n    let _e256 = unnamed.uSceneDepthEnabled;\n    if (_e256 != 0i) {\n        let _e258 = gl_FragCoord_1;\n        let _e261 = unnamed.uInvViewport;\n        uv = (_e258.xy * _e261);\n        let _e263 = uv;\n        let _e264 = textureSampleLevel(uSceneDepth_t, uSceneDepth_s, _e263, 0f);\n        stored_1 = _e264.x;\n        let _e267 = unnamed.uDepthToLocal;\n        let _e268 = uv;\n        let _e271 = ((_e268 * 2f) - vec2(1f));\n        let _e272 = stored_1;\n        hit = (_e267 * vec4<f32>(_e271.x, _e271.y, _e272, 1f));\n        let _e278 = hit[3u];\n        if (_e278 > 0.000001f) {\n            let _e280 = leave;\n            let _e281 = hit;\n            let _e284 = hit[3u];\n            let _e287 = origin;\n            let _e289 = dir;\n            leave = min(_e280, dot(((_e281.xyz / vec3(_e284)) - _e287), _e289));\n        }\n    }\n    let _e292 = leave;\n    let _e293 = enter;\n    if (_e292 <= _e293) {\n        discard;\n    }\n    let _e296 = unnamed.uSamples;\n    samples = clamp(_e296, 2i, 64i);\n    let _e298 = leave;\n    let _e299 = enter;\n    let _e301 = samples;\n    step_ = ((_e298 - _e299) / f32(_e301));\n    let _e305 = gl_FragCoord_1[1u];\n    let _e313 = gl_FragCoord_1[0u];\n    cell = ((i32((_e305 - (floor((_e305 / 4f)) * 4f))) * 4i) + i32((_e313 - (floor((_e313 / 4f)) * 4f))));\n    let _e320 = cell;\n    indexable = array<f32, 16>(0f, 8f, 2f, 10f, 12f, 4f, 14f, 6f, 3f, 11f, 1f, 9f, 15f, 7f, 13f, 5f);\n    let _e322 = indexable[_e320];\n    let _e323 = gl_FragCoord_1;\n    let _e324 = _e323.xy;\n    param_16 = vec3<f32>(_e324.x, _e324.y, 3.7f);\n    let _e328 = hash31_u0028_vf3_u003b((&param_16));\n    let _e332 = step_;\n    shadowOffset = ((((_e322 + _e328) / 16f) - 0.5f) * _e332);\n    total = 0f;\n    i_1 = 0i;\n    loop {\n        let _e334 = i_1;\n        if (_e334 < 64i) {\n            let _e336 = i_1;\n            let _e337 = samples;\n            if (_e336 >= _e337) {\n                break;\n            }\n            let _e339 = enter;\n            let _e340 = i_1;\n            let _e343 = step_;\n            travelled = (_e339 + ((f32(_e340) + 0.5f) * _e343));\n            let _e346 = origin;\n            let _e347 = dir;\n            let _e348 = travelled;\n            local_2 = (_e346 + (_e347 * _e348));\n            let _e351 = local_2;\n            param_17 = _e351;\n            let _e352 = near_1;\n            param_18 = _e352;\n            let _e353 = densityAt_u0028_vf3_u003b_f1_u003b((&param_17), (&param_18));\n            density = _e353;\n            let _e354 = density;\n            if (_e354 <= 0f) {\n                continue;\n            }\n            let _e357 = unnamed.uModelWorld;\n            let _e358 = local_2;\n            world = (_e357 * vec4<f32>(_e358.x, _e358.y, _e358.z, 1f)).xyz;\n            let _e366 = unnamed.uDust;\n            if (_e366 > 0f) {\n                let _e368 = world;\n                let _e370 = unnamed.uDustOffset;\n                let _e373 = unnamed.uDustScale;\n                param_19 = ((_e368 + _e370) / vec3(max(_e373, 0.001f)));\n                let _e377 = dustField_u0028_vf3_u003b((&param_19));\n                let _e379 = unnamed.uDust;\n                let _e381 = density;\n                density = (_e381 * mix(1f, _e377, _e379));\n            }\n            let _e384 = unnamed.uSunShadow;\n            if (_e384 > 0f) {\n                let _e387 = unnamed.uModelWorld;\n                let _e388 = origin;\n                let _e389 = dir;\n                let _e390 = travelled;\n                let _e391 = shadowOffset;\n                let _e394 = (_e388 + (_e389 * (_e390 + _e391)));\n                dithered = (_e387 * vec4<f32>(_e394.x, _e394.y, _e394.z, 1f)).xyz;\n                let _e401 = dithered;\n                param_20 = _e401;\n                let _e402 = sunReach_u0028_vf3_u003b((&param_20));\n                let _e403 = density;\n                density = (_e403 * _e402);\n            }\n            let _e405 = density;\n            let _e406 = total;\n            total = (_e406 + _e405);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e408 = i_1;\n            i_1 = (_e408 + 1i);\n        }\n    }\n    let _e411 = unnamed.uSpread;\n    let _e413 = unnamed.uLength;\n    reference = max((_e411 * _e413), 0.0001f);\n    let _e416 = total;\n    let _e418 = step_;\n    let _e420 = reference;\n    lit = (1f - exp((((-(_e416) * _e418) / _e420) * 3f)));\n    let _e425 = vColor_1;\n    let _e426 = vEnergy_1;\n    let _e427 = lit;\n    let _e430 = unnamed.uStrength;\n    let _e432 = (_e425 * ((_e426 * _e427) * _e430));\n    fragColor = vec4<f32>(_e432.x, _e432.y, _e432.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(4) vLocal: vec3<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(0) vColor: vec3<f32>, @location(1) vEnergy: f32, @location(2) vNormal: vec3<f32>, @location(3) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vLocal_1 = vLocal;\n    gl_FragCoord_1 = gl_FragCoord;\n    vColor_1 = vColor;\n    vEnergy_1 = vEnergy;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e13 = fragColor;\n    return _e13;\n}\n",
};

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const LIGHTVOLUME_BINDINGS = {
  "LIGHT_VOLUME_VERT": {
    "uniforms": 0,
    "uniformSize": 128,
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
      }
    },
    "textures": {}
  },
  "lightVolumeFrag": {
    "none": {
      "uniforms": 1,
      "uniformSize": 208,
      "fields": {
        "uCameraPos": {
          "offset": 0,
          "size": 12,
          "type": "vec3"
        },
        "uStrength": {
          "offset": 12,
          "size": 4,
          "type": "float"
        },
        "uLength": {
          "offset": 16,
          "size": 4,
          "type": "float"
        },
        "uSpread": {
          "offset": 20,
          "size": 4,
          "type": "float"
        },
        "uDust": {
          "offset": 24,
          "size": 4,
          "type": "float"
        },
        "uDustScale": {
          "offset": 28,
          "size": 4,
          "type": "float"
        },
        "uDustOffset": {
          "offset": 32,
          "size": 12,
          "type": "vec3"
        },
        "uNear": {
          "offset": 44,
          "size": 4,
          "type": "float"
        },
        "uCameraLocal": {
          "offset": 48,
          "size": 12,
          "type": "vec3"
        },
        "uModelWorld": {
          "offset": 64,
          "size": 64,
          "type": "mat4"
        },
        "uSamples": {
          "offset": 128,
          "size": 4,
          "type": "int"
        },
        "uSceneDepthEnabled": {
          "offset": 132,
          "size": 4,
          "type": "int"
        },
        "uInvViewport": {
          "offset": 136,
          "size": 8,
          "type": "vec2"
        },
        "uDepthToLocal": {
          "offset": 144,
          "size": 64,
          "type": "mat4"
        }
      },
      "textures": {
        "uSceneDepth": {
          "texture": 32,
          "sampler": 33,
          "type": "sampler2D"
        }
      }
    },
    "directionalShadows": {
      "uniforms": 1,
      "uniformSize": 288,
      "fields": {
        "uCameraPos": {
          "offset": 0,
          "size": 12,
          "type": "vec3"
        },
        "uStrength": {
          "offset": 12,
          "size": 4,
          "type": "float"
        },
        "uLength": {
          "offset": 16,
          "size": 4,
          "type": "float"
        },
        "uSpread": {
          "offset": 20,
          "size": 4,
          "type": "float"
        },
        "uDust": {
          "offset": 24,
          "size": 4,
          "type": "float"
        },
        "uDustScale": {
          "offset": 28,
          "size": 4,
          "type": "float"
        },
        "uDustOffset": {
          "offset": 32,
          "size": 12,
          "type": "vec3"
        },
        "uSunShadow": {
          "offset": 44,
          "size": 4,
          "type": "float"
        },
        "uLightViewProj": {
          "offset": 48,
          "size": 64,
          "type": "mat4"
        },
        "uShadowMapSize": {
          "offset": 112,
          "size": 4,
          "type": "float"
        },
        "uPeeledShadowEnabled": {
          "offset": 116,
          "size": 4,
          "type": "int"
        },
        "uNear": {
          "offset": 120,
          "size": 4,
          "type": "float"
        },
        "uCameraLocal": {
          "offset": 128,
          "size": 12,
          "type": "vec3"
        },
        "uModelWorld": {
          "offset": 144,
          "size": 64,
          "type": "mat4"
        },
        "uSamples": {
          "offset": 208,
          "size": 4,
          "type": "int"
        },
        "uSceneDepthEnabled": {
          "offset": 212,
          "size": 4,
          "type": "int"
        },
        "uInvViewport": {
          "offset": 216,
          "size": 8,
          "type": "vec2"
        },
        "uDepthToLocal": {
          "offset": 224,
          "size": 64,
          "type": "mat4"
        }
      },
      "textures": {
        "uStaticShadowMap": {
          "texture": 32,
          "sampler": 33,
          "type": "sampler2D"
        },
        "uPeeledShadowMap": {
          "texture": 34,
          "sampler": 35,
          "type": "sampler2D"
        },
        "uDynamicShadowMap": {
          "texture": 36,
          "sampler": 37,
          "type": "sampler2D"
        },
        "uSceneDepth": {
          "texture": 38,
          "sampler": 39,
          "type": "sampler2D"
        }
      }
    }
  }
} as const;
