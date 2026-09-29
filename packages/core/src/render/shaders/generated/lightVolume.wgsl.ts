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
  "directionalShadows": "struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uStrength: f32,\n    uLength: f32,\n    uSpread: f32,\n    uDust: f32,\n    uDustScale: f32,\n    uDustOffset: vec3<f32>,\n    uSunShadow: f32,\n    uLightViewProj: mat4x4<f32>,\n    uShadowMapSize: f32,\n    uPeeledShadowEnabled: i32,\n    uNear: f32,\n    uCameraLocal: vec3<f32>,\n    uModelWorld: mat4x4<f32>,\n    uSamples: i32,\n    uSceneDepthEnabled: i32,\n    uInvViewport: vec2<f32>,\n    uDepthToLocal: mat4x4<f32>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSunShadows_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uSunShadows_s: sampler;\nvar<private> vLocal_1: vec3<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(34) \nvar uSceneDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uSceneDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vEnergy_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\n\nfn occlusion_u0028_f1_u003b_f1_u003b(stored: ptr<function, f32>, compare: ptr<function, f32>) -> f32 {\n    let _e87 = (*compare);\n    let _e88 = (*stored);\n    return smoothstep(-0.0025f, 0.0025f, (_e87 - _e88));\n}\n\nfn sunReach_u0028_vf3_u003b(worldPos: ptr<function, vec3<f32>>) -> f32 {\n    var lightPos: vec4<f32>;\n    var p: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var edgeFade: f32;\n    var compare_1: f32;\n    var blocked: f32;\n    var param: f32;\n    var param_1: f32;\n    var param_2: f32;\n    var param_3: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var phi_212_: bool;\n    var phi_219_: bool;\n    var phi_226_: bool;\n    var phi_233_: bool;\n\n    let _e99 = unnamed.uLightViewProj;\n    let _e100 = (*worldPos);\n    lightPos = (_e99 * vec4<f32>(_e100.x, _e100.y, _e100.z, 1f));\n    let _e107 = lightPos[3u];\n    if (_e107 <= 0f) {\n        return 1f;\n    }\n    let _e109 = lightPos;\n    let _e112 = lightPos[3u];\n    p = (((_e109.xyz / vec3(_e112)) * 0.5f) + vec3(0.5f));\n    let _e119 = p[2u];\n    let _e120 = (_e119 > 1f);\n    phi_212_ = _e120;\n    if !(_e120) {\n        let _e123 = p[0u];\n        phi_212_ = (_e123 < 0f);\n    }\n    let _e126 = phi_212_;\n    phi_219_ = _e126;\n    if !(_e126) {\n        let _e129 = p[0u];\n        phi_219_ = (_e129 > 1f);\n    }\n    let _e132 = phi_219_;\n    phi_226_ = _e132;\n    if !(_e132) {\n        let _e135 = p[1u];\n        phi_226_ = (_e135 < 0f);\n    }\n    let _e138 = phi_226_;\n    phi_233_ = _e138;\n    if !(_e138) {\n        let _e141 = p[1u];\n        phi_233_ = (_e141 > 1f);\n    }\n    let _e144 = phi_233_;\n    if _e144 {\n        return 1f;\n    }\n    let _e145 = p;\n    fromCentre = (abs((_e145.xy - vec2(0.5f))) * 2f);\n    let _e152 = fromCentre[0u];\n    let _e154 = fromCentre[1u];\n    edgeFade = (1f - smoothstep(0.72f, 0.98f, max(_e152, _e154)));\n    let _e159 = p[2u];\n    let _e162 = edgeFade;\n    edgeFade = (_e162 * (1f - smoothstep(0.9f, 1f, _e159)));\n    let _e164 = edgeFade;\n    if (_e164 <= 0f) {\n        return 1f;\n    }\n    let _e167 = p[2u];\n    compare_1 = (_e167 - 0.0015f);\n    let _e169 = p;\n    let _e170 = _e169.xy;\n    let _e173 = vec3<f32>(_e170.x, _e170.y, 0f);\n    let _e179 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e173.x, _e173.y), i32(_e173.z), 0f);\n    param = _e179.x;\n    let _e181 = compare_1;\n    param_1 = _e181;\n    let _e182 = occlusion_u0028_f1_u003b_f1_u003b((&param), (&param_1));\n    blocked = _e182;\n    let _e184 = unnamed.uPeeledShadowEnabled;\n    if (_e184 != 0i) {\n        let _e186 = blocked;\n        let _e187 = p;\n        let _e188 = _e187.xy;\n        let _e191 = vec3<f32>(_e188.x, _e188.y, 2f);\n        let _e197 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e191.x, _e191.y), i32(_e191.z), 0f);\n        param_2 = _e197.x;\n        let _e199 = compare_1;\n        param_3 = _e199;\n        let _e200 = occlusion_u0028_f1_u003b_f1_u003b((&param_2), (&param_3));\n        blocked = max(_e186, _e200);\n    }\n    let _e202 = blocked;\n    let _e203 = p;\n    let _e204 = _e203.xy;\n    let _e207 = vec3<f32>(_e204.x, _e204.y, 1f);\n    let _e213 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e207.x, _e207.y), i32(_e207.z), 0f);\n    param_4 = _e213.x;\n    let _e215 = compare_1;\n    param_5 = _e215;\n    let _e216 = occlusion_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    blocked = max(_e202, _e216);\n    let _e218 = blocked;\n    let _e221 = unnamed.uSunShadow;\n    let _e222 = edgeFade;\n    return mix(1f, (1f - _e218), (_e221 * _e222));\n}\n\nfn hash31_u0028_vf3_u003b(p_1: ptr<function, vec3<f32>>) -> f32 {\n    let _e86 = (*p_1);\n    return fract((sin(dot(_e86, vec3<f32>(127.1f, 311.7f, 74.7f))) * 43758.547f));\n}\n\nfn volumeNoise_u0028_vf3_u003b(p_2: ptr<function, vec3<f32>>) -> f32 {\n    var i: vec3<f32>;\n    var f: vec3<f32>;\n    var u: vec3<f32>;\n    var x00_: f32;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n    var x10_: f32;\n    var param_8: vec3<f32>;\n    var param_9: vec3<f32>;\n    var x01_: f32;\n    var param_10: vec3<f32>;\n    var param_11: vec3<f32>;\n    var x11_: f32;\n    var param_12: vec3<f32>;\n    var param_13: vec3<f32>;\n\n    let _e101 = (*p_2);\n    i = floor(_e101);\n    let _e103 = (*p_2);\n    f = fract(_e103);\n    let _e105 = f;\n    let _e106 = f;\n    let _e108 = f;\n    u = ((_e105 * _e106) * (vec3(3f) - (_e108 * 2f)));\n    let _e113 = i;\n    param_6 = (_e113 + vec3<f32>(0f, 0f, 0f));\n    let _e115 = hash31_u0028_vf3_u003b((&param_6));\n    let _e116 = i;\n    param_7 = (_e116 + vec3<f32>(1f, 0f, 0f));\n    let _e118 = hash31_u0028_vf3_u003b((&param_7));\n    let _e120 = u[0u];\n    x00_ = mix(_e115, _e118, _e120);\n    let _e122 = i;\n    param_8 = (_e122 + vec3<f32>(0f, 1f, 0f));\n    let _e124 = hash31_u0028_vf3_u003b((&param_8));\n    let _e125 = i;\n    param_9 = (_e125 + vec3<f32>(1f, 1f, 0f));\n    let _e127 = hash31_u0028_vf3_u003b((&param_9));\n    let _e129 = u[0u];\n    x10_ = mix(_e124, _e127, _e129);\n    let _e131 = i;\n    param_10 = (_e131 + vec3<f32>(0f, 0f, 1f));\n    let _e133 = hash31_u0028_vf3_u003b((&param_10));\n    let _e134 = i;\n    param_11 = (_e134 + vec3<f32>(1f, 0f, 1f));\n    let _e136 = hash31_u0028_vf3_u003b((&param_11));\n    let _e138 = u[0u];\n    x01_ = mix(_e133, _e136, _e138);\n    let _e140 = i;\n    param_12 = (_e140 + vec3<f32>(0f, 1f, 1f));\n    let _e142 = hash31_u0028_vf3_u003b((&param_12));\n    let _e143 = i;\n    param_13 = (_e143 + vec3<f32>(1f, 1f, 1f));\n    let _e145 = hash31_u0028_vf3_u003b((&param_13));\n    let _e147 = u[0u];\n    x11_ = mix(_e142, _e145, _e147);\n    let _e149 = x00_;\n    let _e150 = x10_;\n    let _e152 = u[1u];\n    let _e154 = x01_;\n    let _e155 = x11_;\n    let _e157 = u[1u];\n    let _e160 = u[2u];\n    return mix(mix(_e149, _e150, _e152), mix(_e154, _e155, _e157), _e160);\n}\n\nfn dustField_u0028_vf3_u003b(p_3: ptr<function, vec3<f32>>) -> f32 {\n    var param_14: vec3<f32>;\n    var param_15: vec3<f32>;\n\n    let _e88 = (*p_3);\n    param_14 = _e88;\n    let _e89 = volumeNoise_u0028_vf3_u003b((&param_14));\n    let _e91 = (*p_3);\n    param_15 = ((_e91 * 2.17f) + vec3(19.3f));\n    let _e95 = volumeNoise_u0028_vf3_u003b((&param_15));\n    return ((_e89 * 0.65f) + (_e95 * 0.35f));\n}\n\nfn densityAt_u0028_vf3_u003b_f1_u003b(local: ptr<function, vec3<f32>>, near: ptr<function, f32>) -> f32 {\n    var drawn: f32;\n    var along: f32;\n    var openness: f32;\n    var across: f32;\n\n    let _e92 = unnamed.uLength;\n    let _e93 = (*near);\n    drawn = max((_e92 - _e93), 0.0001f);\n    let _e97 = (*local)[2u];\n    let _e98 = (*near);\n    let _e100 = drawn;\n    along = clamp(((_e97 - _e98) / _e100), 0f, 1f);\n    let _e103 = (*local);\n    let _e107 = (*local)[2u];\n    openness = (length(_e103.xy) / max(_e107, 0.001f));\n    let _e110 = openness;\n    let _e112 = unnamed.uSpread;\n    across = clamp((_e110 / max(_e112, 0.0001f)), 0f, 1f);\n    let _e116 = along;\n    let _e119 = across;\n    return (pow((1f - _e116), 1.3f) * pow((1f - _e119), 2f));\n}\n\nfn main_1() {\n    var origin: vec3<f32>;\n    var toFragment: vec3<f32>;\n    var span: f32;\n    var dir: vec3<f32>;\n    var local_1: vec3<f32>;\n    var near_1: f32;\n    var enter: f32;\n    var leave: f32;\n    var toNear: f32;\n    var toFar: f32;\n    var reach: f32;\n    var ca: f32;\n    var cb: f32;\n    var cc: f32;\n    var disc: f32;\n    var root: f32;\n    var uv: vec2<f32>;\n    var stored_1: f32;\n    var hit: vec4<f32>;\n    var samples: i32;\n    var step_: f32;\n    var cell: i32;\n    var shadowOffset: f32;\n    var indexable: array<f32, 16>;\n    var param_16: vec3<f32>;\n    var total: f32;\n    var i_1: i32;\n    var travelled: f32;\n    var local_2: vec3<f32>;\n    var density: f32;\n    var param_17: vec3<f32>;\n    var param_18: f32;\n    var world: vec3<f32>;\n    var param_19: vec3<f32>;\n    var dithered: vec3<f32>;\n    var param_20: vec3<f32>;\n    var reference: f32;\n    var lit: f32;\n    var phi_469_: bool;\n\n    let _e124 = unnamed.uCameraLocal;\n    origin = _e124;\n    let _e125 = vLocal_1;\n    let _e126 = origin;\n    toFragment = (_e125 - _e126);\n    let _e128 = toFragment;\n    span = length(_e128);\n    let _e130 = span;\n    if (_e130 > 0.00001f) {\n        let _e132 = toFragment;\n        let _e133 = span;\n        local_1 = (_e132 / vec3(_e133));\n    } else {\n        local_1 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e136 = local_1;\n    dir = _e136;\n    let _e138 = unnamed.uNear;\n    let _e140 = unnamed.uLength;\n    near_1 = min(_e138, _e140);\n    enter = 0f;\n    let _e143 = unnamed.uLength;\n    leave = (_e143 * 2f);\n    let _e146 = dir[2u];\n    if (abs(_e146) > 0.00001f) {\n        let _e149 = near_1;\n        let _e151 = origin[2u];\n        let _e154 = dir[2u];\n        toNear = ((_e149 - _e151) / _e154);\n        let _e157 = unnamed.uLength;\n        let _e159 = origin[2u];\n        let _e162 = dir[2u];\n        toFar = ((_e157 - _e159) / _e162);\n        let _e164 = toNear;\n        let _e165 = toFar;\n        enter = min(_e164, _e165);\n        let _e167 = toNear;\n        let _e168 = toFar;\n        leave = max(_e167, _e168);\n    } else {\n        let _e171 = origin[2u];\n        let _e172 = near_1;\n        let _e173 = (_e171 < _e172);\n        phi_469_ = _e173;\n        if !(_e173) {\n            let _e176 = origin[2u];\n            let _e178 = unnamed.uLength;\n            phi_469_ = (_e176 > _e178);\n        }\n        let _e181 = phi_469_;\n        if _e181 {\n            discard;\n        }\n    }\n    let _e183 = unnamed.uSpread;\n    let _e185 = unnamed.uLength;\n    reach = ((_e183 * _e185) * 1.05f);\n    let _e188 = dir;\n    let _e190 = dir;\n    ca = dot(_e188.xy, _e190.xy);\n    let _e193 = origin;\n    let _e195 = dir;\n    cb = (2f * dot(_e193.xy, _e195.xy));\n    let _e199 = origin;\n    let _e201 = origin;\n    let _e204 = reach;\n    let _e205 = reach;\n    cc = (dot(_e199.xy, _e201.xy) - (_e204 * _e205));\n    let _e208 = ca;\n    if (_e208 > 0.00000001f) {\n        let _e210 = cb;\n        let _e211 = cb;\n        let _e213 = ca;\n        let _e215 = cc;\n        disc = ((_e210 * _e211) - ((4f * _e213) * _e215));\n        let _e218 = disc;\n        if (_e218 <= 0f) {\n            discard;\n        }\n        let _e220 = disc;\n        root = sqrt(_e220);\n        let _e222 = enter;\n        let _e223 = cb;\n        let _e225 = root;\n        let _e227 = ca;\n        enter = max(_e222, ((-(_e223) - _e225) / (2f * _e227)));\n        let _e231 = leave;\n        let _e232 = cb;\n        let _e234 = root;\n        let _e236 = ca;\n        leave = min(_e231, ((-(_e232) + _e234) / (2f * _e236)));\n    } else {\n        let _e240 = cc;\n        if (_e240 > 0f) {\n            discard;\n        }\n    }\n    let _e242 = enter;\n    enter = max(_e242, 0f);\n    let _e244 = leave;\n    let _e245 = enter;\n    let _e247 = unnamed.uLength;\n    leave = min(_e244, (_e245 + (_e247 * 2f)));\n    let _e252 = unnamed.uSceneDepthEnabled;\n    if (_e252 != 0i) {\n        let _e254 = gl_FragCoord_1;\n        let _e257 = unnamed.uInvViewport;\n        uv = (_e254.xy * _e257);\n        let _e259 = uv;\n        let _e260 = textureSampleLevel(uSceneDepth_t, uSceneDepth_s, _e259, 0f);\n        stored_1 = _e260.x;\n        let _e263 = unnamed.uDepthToLocal;\n        let _e264 = uv;\n        let _e267 = ((_e264 * 2f) - vec2(1f));\n        let _e268 = stored_1;\n        hit = (_e263 * vec4<f32>(_e267.x, _e267.y, _e268, 1f));\n        let _e274 = hit[3u];\n        if (_e274 > 0.000001f) {\n            let _e276 = leave;\n            let _e277 = hit;\n            let _e280 = hit[3u];\n            let _e283 = origin;\n            let _e285 = dir;\n            leave = min(_e276, dot(((_e277.xyz / vec3(_e280)) - _e283), _e285));\n        }\n    }\n    let _e288 = leave;\n    let _e289 = enter;\n    if (_e288 <= _e289) {\n        discard;\n    }\n    let _e292 = unnamed.uSamples;\n    samples = clamp(_e292, 2i, 64i);\n    let _e294 = leave;\n    let _e295 = enter;\n    let _e297 = samples;\n    step_ = ((_e294 - _e295) / f32(_e297));\n    let _e301 = gl_FragCoord_1[1u];\n    let _e309 = gl_FragCoord_1[0u];\n    cell = ((i32((_e301 - (floor((_e301 / 4f)) * 4f))) * 4i) + i32((_e309 - (floor((_e309 / 4f)) * 4f))));\n    let _e316 = cell;\n    indexable = array<f32, 16>(0f, 8f, 2f, 10f, 12f, 4f, 14f, 6f, 3f, 11f, 1f, 9f, 15f, 7f, 13f, 5f);\n    let _e318 = indexable[_e316];\n    let _e319 = gl_FragCoord_1;\n    let _e320 = _e319.xy;\n    param_16 = vec3<f32>(_e320.x, _e320.y, 3.7f);\n    let _e324 = hash31_u0028_vf3_u003b((&param_16));\n    let _e328 = step_;\n    shadowOffset = ((((_e318 + _e324) / 16f) - 0.5f) * _e328);\n    total = 0f;\n    i_1 = 0i;\n    loop {\n        let _e330 = i_1;\n        if (_e330 < 64i) {\n            let _e332 = i_1;\n            let _e333 = samples;\n            if (_e332 >= _e333) {\n                break;\n            }\n            let _e335 = enter;\n            let _e336 = i_1;\n            let _e339 = step_;\n            travelled = (_e335 + ((f32(_e336) + 0.5f) * _e339));\n            let _e342 = origin;\n            let _e343 = dir;\n            let _e344 = travelled;\n            local_2 = (_e342 + (_e343 * _e344));\n            let _e347 = local_2;\n            param_17 = _e347;\n            let _e348 = near_1;\n            param_18 = _e348;\n            let _e349 = densityAt_u0028_vf3_u003b_f1_u003b((&param_17), (&param_18));\n            density = _e349;\n            let _e350 = density;\n            if (_e350 <= 0f) {\n                continue;\n            }\n            let _e353 = unnamed.uModelWorld;\n            let _e354 = local_2;\n            world = (_e353 * vec4<f32>(_e354.x, _e354.y, _e354.z, 1f)).xyz;\n            let _e362 = unnamed.uDust;\n            if (_e362 > 0f) {\n                let _e364 = world;\n                let _e366 = unnamed.uDustOffset;\n                let _e369 = unnamed.uDustScale;\n                param_19 = ((_e364 + _e366) / vec3(max(_e369, 0.001f)));\n                let _e373 = dustField_u0028_vf3_u003b((&param_19));\n                let _e375 = unnamed.uDust;\n                let _e377 = density;\n                density = (_e377 * mix(1f, _e373, _e375));\n            }\n            let _e380 = unnamed.uSunShadow;\n            if (_e380 > 0f) {\n                let _e383 = unnamed.uModelWorld;\n                let _e384 = origin;\n                let _e385 = dir;\n                let _e386 = travelled;\n                let _e387 = shadowOffset;\n                let _e390 = (_e384 + (_e385 * (_e386 + _e387)));\n                dithered = (_e383 * vec4<f32>(_e390.x, _e390.y, _e390.z, 1f)).xyz;\n                let _e397 = dithered;\n                param_20 = _e397;\n                let _e398 = sunReach_u0028_vf3_u003b((&param_20));\n                let _e399 = density;\n                density = (_e399 * _e398);\n            }\n            let _e401 = density;\n            let _e402 = total;\n            total = (_e402 + _e401);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e404 = i_1;\n            i_1 = (_e404 + 1i);\n        }\n    }\n    let _e407 = unnamed.uSpread;\n    let _e409 = unnamed.uLength;\n    reference = max((_e407 * _e409), 0.0001f);\n    let _e412 = total;\n    let _e414 = step_;\n    let _e416 = reference;\n    lit = (1f - exp((((-(_e412) * _e414) / _e416) * 3f)));\n    let _e421 = vColor_1;\n    let _e422 = vEnergy_1;\n    let _e423 = lit;\n    let _e426 = unnamed.uStrength;\n    let _e428 = (_e421 * ((_e422 * _e423) * _e426));\n    fragColor = vec4<f32>(_e428.x, _e428.y, _e428.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(4) vLocal: vec3<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(0) vColor: vec3<f32>, @location(1) vEnergy: f32, @location(2) vNormal: vec3<f32>, @location(3) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vLocal_1 = vLocal;\n    gl_FragCoord_1 = gl_FragCoord;\n    vColor_1 = vColor;\n    vEnergy_1 = vEnergy;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e13 = fragColor;\n    return _e13;\n}\n",
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
        "uSunShadows": {
          "texture": 32,
          "sampler": 33,
          "type": "sampler2DArray"
        },
        "uSceneDepth": {
          "texture": 34,
          "sampler": 35,
          "type": "sampler2D"
        }
      }
    }
  }
} as const;
