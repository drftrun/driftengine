/*
 * Generated from ../globalMedium.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const MEDIUM_FRAG_WGSL = "struct Uniforms {\n    uDepthToWorld: mat4x4<f32>,\n    uCameraPos: vec3<f32>,\n    uSunDir: vec3<f32>,\n    uSunColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uDensity: f32,\n    uHeight: vec2<f32>,\n    uLayer2_: vec3<f32>,\n    uAlbedo: vec3<f32>,\n    uScatter: vec2<f32>,\n    uAnisotropy: f32,\n    uMaxDistance: f32,\n    uSteps: i32,\n    uSunShadow: f32,\n    uLightViewProj: mat4x4<f32>,\n    uMovingLightViewProj: mat4x4<f32>,\n    uPeeledShadowEnabled: i32,\n    uLampCount: i32,\n    uLampFalloff: i32,\n    uLampPosition: array<vec4<f32>, 16>,\n    uLampColor: array<vec4<f32>, 16>,\n    uLampAim: array<vec4<f32>, 16>,\n    uLampCone: array<vec4<f32>, 16>,\n    uLampShadow: array<vec4<f32>, 16>,\n    uLampShadowAt: array<vec4<f32>, 16>,\n    uLampLive: array<vec4<f32>, 16>,\n    uLampLiveAt: array<vec4<f32>, 16>,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uSunShadows_t: texture_2d_array<f32>;\n@group(0) @binding(35) \nvar uSunShadows_s: sampler;\n@group(0) @binding(36) \nvar uPointShadows_t: texture_2d_array<f32>;\n@group(0) @binding(37) \nvar uPointShadows_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n\nfn phase_u0028_f1_u003b_f1_u003b(cosTheta: ptr<function, f32>, g: ptr<function, f32>) -> f32 {\n    var g2_: f32;\n    var d: f32;\n\n    let _e71 = (*g);\n    let _e72 = (*g);\n    g2_ = (_e71 * _e72);\n    let _e74 = g2_;\n    let _e76 = (*g);\n    let _e78 = (*cosTheta);\n    d = max(((1f + _e74) - ((2f * _e76) * _e78)), 0.0001f);\n    let _e82 = g2_;\n    let _e84 = d;\n    let _e86 = d;\n    return ((1f - _e82) / ((12.566371f * _e84) * sqrt(_e86)));\n}\n\nfn occlusion_u0028_f1_u003b_f1_u003b(stored: ptr<function, f32>, compare: ptr<function, f32>) -> f32 {\n    let _e69 = (*compare);\n    let _e70 = (*stored);\n    return smoothstep(-0.0025f, 0.0025f, (_e69 - _e70));\n}\n\nfn octEncode_u0028_vf3_u003b(d_1: ptr<function, vec3<f32>>) -> vec2<f32> {\n    var n: vec3<f32>;\n    var p: vec2<f32>;\n    var local: vec2<f32>;\n\n    let _e71 = (*d_1);\n    let _e73 = (*d_1)[0u];\n    let _e76 = (*d_1)[1u];\n    let _e80 = (*d_1)[2u];\n    n = (_e71 / vec3(((abs(_e73) + abs(_e76)) + abs(_e80))));\n    let _e86 = n[2u];\n    if (_e86 >= 0f) {\n        let _e88 = n;\n        local = _e88.xy;\n    } else {\n        let _e91 = n[1u];\n        let _e93 = n[0u];\n        let _e99 = n[0u];\n        let _e103 = n[1u];\n        local = ((vec2(1f) - abs(vec2<f32>(_e91, _e93))) * vec2<f32>(select(-1f, 1f, (_e99 >= 0f)), select(-1f, 1f, (_e103 >= 0f))));\n    }\n    let _e108 = local;\n    p = _e108;\n    let _e109 = p;\n    return ((_e109 * 0.5f) + vec2(0.5f));\n}\n\nfn lampMapReach_u0028_vf4_u003b_vf4_u003b_vf3_u003b(map: ptr<function, vec4<f32>>, at: ptr<function, vec4<f32>>, p_1: ptr<function, vec3<f32>>) -> f32 {\n    var toPoint: vec3<f32>;\n    var dist: f32;\n    var stored_1: f32;\n    var param: vec3<f32>;\n    var param_1: f32;\n    var param_2: f32;\n\n    let _e77 = (*map)[0u];\n    if (_e77 < 0f) {\n        return 1f;\n    }\n    let _e79 = (*p_1);\n    let _e80 = (*at);\n    toPoint = (_e79 - _e80.xyz);\n    let _e83 = toPoint;\n    dist = length(_e83);\n    let _e85 = dist;\n    let _e87 = (*map)[1u];\n    if (_e85 <= _e87) {\n        return 1f;\n    }\n    let _e89 = toPoint;\n    param = _e89;\n    let _e90 = octEncode_u0028_vf3_u003b((&param));\n    let _e92 = (*map)[0u];\n    let _e95 = vec3<f32>(_e90.x, _e90.y, _e92);\n    let _e101 = textureSampleLevel(uPointShadows_t, uPointShadows_s, vec2<f32>(_e95.x, _e95.y), i32(_e95.z), 0f);\n    stored_1 = _e101.x;\n    let _e103 = dist;\n    let _e106 = (*at)[3u];\n    let _e108 = stored_1;\n    param_1 = _e108;\n    param_2 = ((_e103 - 0.05f) / _e106);\n    let _e109 = occlusion_u0028_f1_u003b_f1_u003b((&param_1), (&param_2));\n    let _e111 = (*map)[2u];\n    return (1f - (_e109 * _e111));\n}\n\nfn lampsAt_u0028_vf3_u003b_vf3_u003b(p_2: ptr<function, vec3<f32>>, dir: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var sum: vec3<f32>;\n    var i: i32;\n    var toLamp: vec3<f32>;\n    var dist_1: f32;\n    var radius: f32;\n    var exponent: f32;\n    var reach: f32;\n    var falloff: f32;\n    var window: f32;\n    var l: vec3<f32>;\n    var cone: f32;\n    var reach_1: f32;\n    var param_3: vec4<f32>;\n    var param_4: vec4<f32>;\n    var param_5: vec3<f32>;\n    var param_6: vec4<f32>;\n    var param_7: vec4<f32>;\n    var param_8: vec3<f32>;\n    var param_9: f32;\n    var param_10: f32;\n\n    sum = vec3<f32>(0f, 0f, 0f);\n    i = 0i;\n    loop {\n        let _e89 = i;\n        if (_e89 < 16i) {\n            let _e91 = i;\n            let _e93 = unnamed.uLampCount;\n            if (_e91 >= _e93) {\n                break;\n            }\n            let _e95 = i;\n            let _e98 = unnamed.uLampPosition[_e95];\n            let _e100 = (*p_2);\n            toLamp = (_e98.xyz - _e100);\n            let _e102 = toLamp;\n            dist_1 = length(_e102);\n            let _e104 = i;\n            let _e108 = unnamed.uLampPosition[_e104][3u];\n            radius = max(_e108, 0.0001f);\n            let _e110 = i;\n            let _e114 = unnamed.uLampColor[_e110][3u];\n            exponent = _e114;\n            let _e115 = exponent;\n            if (_e115 > 0f) {\n                let _e117 = dist_1;\n                let _e118 = radius;\n                reach = (_e117 / _e118);\n                let _e120 = reach;\n                let _e121 = reach;\n                let _e125 = exponent;\n                falloff = pow(clamp((1f - (_e120 * _e121)), 0f, 1f), _e125);\n            } else {\n                let _e128 = unnamed.uLampFalloff;\n                if (_e128 == 1i) {\n                    let _e130 = dist_1;\n                    let _e131 = radius;\n                    window = clamp((1f - pow((_e130 / _e131), 4f)), 0f, 1f);\n                    let _e136 = window;\n                    let _e137 = window;\n                    let _e139 = dist_1;\n                    let _e140 = dist_1;\n                    falloff = ((_e136 * _e137) / max((_e139 * _e140), 0.01f));\n                } else {\n                    let _e144 = dist_1;\n                    let _e145 = radius;\n                    falloff = clamp((1f - (_e144 / _e145)), 0f, 1f);\n                    let _e149 = falloff;\n                    let _e150 = falloff;\n                    falloff = (_e150 * _e149);\n                }\n            }\n            let _e152 = falloff;\n            if (_e152 <= 0f) {\n                continue;\n            }\n            let _e154 = toLamp;\n            let _e155 = dist_1;\n            l = (_e154 / vec3(max(_e155, 0.0001f)));\n            let _e159 = i;\n            let _e163 = unnamed.uLampCone[_e159][1u];\n            let _e164 = i;\n            let _e168 = unnamed.uLampCone[_e164][0u];\n            let _e169 = l;\n            let _e171 = i;\n            let _e174 = unnamed.uLampAim[_e171];\n            cone = smoothstep(_e163, _e168, dot(-(_e169), _e174.xyz));\n            let _e178 = cone;\n            if (_e178 <= 0f) {\n                continue;\n            }\n            let _e180 = i;\n            let _e181 = i;\n            let _e184 = unnamed.uLampShadow[_e180];\n            param_3 = _e184;\n            let _e187 = unnamed.uLampShadowAt[_e181];\n            param_4 = _e187;\n            let _e188 = (*p_2);\n            param_5 = _e188;\n            let _e189 = lampMapReach_u0028_vf4_u003b_vf4_u003b_vf3_u003b((&param_3), (&param_4), (&param_5));\n            let _e190 = i;\n            let _e191 = i;\n            let _e194 = unnamed.uLampLive[_e190];\n            param_6 = _e194;\n            let _e197 = unnamed.uLampLiveAt[_e191];\n            param_7 = _e197;\n            let _e198 = (*p_2);\n            param_8 = _e198;\n            let _e199 = lampMapReach_u0028_vf4_u003b_vf4_u003b_vf3_u003b((&param_6), (&param_7), (&param_8));\n            reach_1 = min(_e189, _e199);\n            let _e201 = i;\n            let _e204 = unnamed.uLampColor[_e201];\n            let _e206 = falloff;\n            let _e207 = cone;\n            let _e209 = reach_1;\n            let _e211 = (*dir);\n            let _e212 = l;\n            param_9 = dot(_e211, _e212);\n            let _e215 = unnamed.uAnisotropy;\n            param_10 = _e215;\n            let _e216 = phase_u0028_f1_u003b_f1_u003b((&param_9), (&param_10));\n            let _e219 = sum;\n            sum = (_e219 + (_e204.xyz * (((_e206 * _e207) * _e209) * _e216)));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e221 = i;\n            i = (_e221 + 1i);\n        }\n    }\n    let _e223 = sum;\n    return _e223;\n}\n\nfn sunReach_u0028_vf3_u003b(worldPos: ptr<function, vec3<f32>>) -> f32 {\n    var lightPos: vec4<f32>;\n    var p_3: vec3<f32>;\n    var fromCentre: vec2<f32>;\n    var edgeFade: f32;\n    var compare_1: f32;\n    var blocked: f32;\n    var param_11: f32;\n    var param_12: f32;\n    var param_13: f32;\n    var param_14: f32;\n    var movingPos: vec4<f32>;\n    var pm: vec3<f32>;\n    var param_15: f32;\n    var param_16: f32;\n    var phi_138_: bool;\n    var phi_145_: bool;\n    var phi_153_: bool;\n    var phi_160_: bool;\n    var phi_273_: bool;\n    var phi_279_: bool;\n    var phi_285_: bool;\n    var phi_291_: bool;\n    var phi_297_: bool;\n\n    let _e83 = unnamed.uLightViewProj;\n    let _e84 = (*worldPos);\n    lightPos = (_e83 * vec4<f32>(_e84.x, _e84.y, _e84.z, 1f));\n    let _e91 = lightPos[3u];\n    if (_e91 <= 0f) {\n        return 1f;\n    }\n    let _e93 = lightPos;\n    let _e96 = lightPos[3u];\n    p_3 = (((_e93.xyz / vec3(_e96)) * 0.5f) + vec3(0.5f));\n    let _e103 = p_3[2u];\n    let _e104 = (_e103 > 1f);\n    phi_138_ = _e104;\n    if !(_e104) {\n        let _e107 = p_3[0u];\n        phi_138_ = (_e107 < 0f);\n    }\n    let _e110 = phi_138_;\n    phi_145_ = _e110;\n    if !(_e110) {\n        let _e113 = p_3[0u];\n        phi_145_ = (_e113 > 1f);\n    }\n    let _e116 = phi_145_;\n    phi_153_ = _e116;\n    if !(_e116) {\n        let _e119 = p_3[1u];\n        phi_153_ = (_e119 < 0f);\n    }\n    let _e122 = phi_153_;\n    phi_160_ = _e122;\n    if !(_e122) {\n        let _e125 = p_3[1u];\n        phi_160_ = (_e125 > 1f);\n    }\n    let _e128 = phi_160_;\n    if _e128 {\n        return 1f;\n    }\n    let _e129 = p_3;\n    fromCentre = (abs((_e129.xy - vec2(0.5f))) * 2f);\n    let _e136 = fromCentre[0u];\n    let _e138 = fromCentre[1u];\n    edgeFade = (1f - smoothstep(0.72f, 0.98f, max(_e136, _e138)));\n    let _e143 = p_3[2u];\n    let _e146 = edgeFade;\n    edgeFade = (_e146 * (1f - smoothstep(0.9f, 1f, _e143)));\n    let _e148 = edgeFade;\n    if (_e148 <= 0f) {\n        return 1f;\n    }\n    let _e151 = p_3[2u];\n    compare_1 = (_e151 - 0.0015f);\n    let _e153 = p_3;\n    let _e154 = _e153.xy;\n    let _e157 = vec3<f32>(_e154.x, _e154.y, 0f);\n    let _e163 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e157.x, _e157.y), i32(_e157.z), 0f);\n    param_11 = _e163.x;\n    let _e165 = compare_1;\n    param_12 = _e165;\n    let _e166 = occlusion_u0028_f1_u003b_f1_u003b((&param_11), (&param_12));\n    blocked = _e166;\n    let _e168 = unnamed.uPeeledShadowEnabled;\n    if (_e168 != 0i) {\n        let _e170 = blocked;\n        let _e171 = p_3;\n        let _e172 = _e171.xy;\n        let _e175 = vec3<f32>(_e172.x, _e172.y, 2f);\n        let _e181 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e175.x, _e175.y), i32(_e175.z), 0f);\n        param_13 = _e181.x;\n        let _e183 = compare_1;\n        param_14 = _e183;\n        let _e184 = occlusion_u0028_f1_u003b_f1_u003b((&param_13), (&param_14));\n        blocked = max(_e170, _e184);\n    }\n    let _e187 = unnamed.uMovingLightViewProj;\n    let _e188 = (*worldPos);\n    movingPos = (_e187 * vec4<f32>(_e188.x, _e188.y, _e188.z, 1f));\n    let _e194 = movingPos;\n    let _e197 = movingPos[3u];\n    pm = (((_e194.xyz / vec3(_e197)) * 0.5f) + vec3(0.5f));\n    let _e204 = movingPos[3u];\n    let _e205 = (_e204 > 0f);\n    phi_273_ = _e205;\n    if _e205 {\n        let _e207 = pm[2u];\n        phi_273_ = (_e207 <= 1f);\n    }\n    let _e210 = phi_273_;\n    phi_279_ = _e210;\n    if _e210 {\n        let _e212 = pm[0u];\n        phi_279_ = (_e212 >= 0f);\n    }\n    let _e215 = phi_279_;\n    phi_285_ = _e215;\n    if _e215 {\n        let _e217 = pm[0u];\n        phi_285_ = (_e217 <= 1f);\n    }\n    let _e220 = phi_285_;\n    phi_291_ = _e220;\n    if _e220 {\n        let _e222 = pm[1u];\n        phi_291_ = (_e222 >= 0f);\n    }\n    let _e225 = phi_291_;\n    phi_297_ = _e225;\n    if _e225 {\n        let _e227 = pm[1u];\n        phi_297_ = (_e227 <= 1f);\n    }\n    let _e230 = phi_297_;\n    if _e230 {\n        let _e231 = blocked;\n        let _e232 = pm;\n        let _e233 = _e232.xy;\n        let _e236 = vec3<f32>(_e233.x, _e233.y, 1f);\n        let _e242 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e236.x, _e236.y), i32(_e236.z), 0f);\n        let _e244 = pm[2u];\n        param_15 = _e242.x;\n        param_16 = (_e244 - 0.0015f);\n        let _e247 = occlusion_u0028_f1_u003b_f1_u003b((&param_15), (&param_16));\n        blocked = max(_e231, _e247);\n    }\n    let _e249 = blocked;\n    let _e252 = unnamed.uSunShadow;\n    let _e253 = edgeFade;\n    return mix(1f, (1f - _e249), (_e252 * _e253));\n}\n\nfn layerDepth_u0028_f1_u003b_f1_u003b_f1_u003b_f1_u003b_f1_u003b_vf3_u003b(density: ptr<function, f32>, falloff_1: ptr<function, f32>, baseY: ptr<function, f32>, s0_: ptr<function, f32>, s1_: ptr<function, f32>, dir_1: ptr<function, vec3<f32>>) -> f32 {\n    var len: f32;\n    var climb: f32;\n    var shape: f32;\n    var local_1: f32;\n    var start: f32;\n\n    let _e78 = (*s1_);\n    let _e79 = (*s0_);\n    len = (_e78 - _e79);\n    let _e81 = (*falloff_1);\n    let _e83 = (*dir_1)[1u];\n    let _e85 = len;\n    climb = ((_e81 * _e83) * _e85);\n    let _e87 = climb;\n    if (abs(_e87) < 0.0001f) {\n        let _e90 = climb;\n        local_1 = (1f - (0.5f * _e90));\n    } else {\n        let _e93 = climb;\n        let _e97 = climb;\n        local_1 = ((1f - exp(-(_e93))) / _e97);\n    }\n    let _e99 = local_1;\n    shape = _e99;\n    let _e100 = (*falloff_1);\n    let _e104 = unnamed.uCameraPos[1u];\n    let _e106 = (*dir_1)[1u];\n    let _e107 = (*s0_);\n    let _e110 = (*baseY);\n    start = exp(min((-(_e100) * ((_e104 + (_e106 * _e107)) - _e110)), 80f));\n    let _e115 = (*density);\n    let _e116 = start;\n    let _e118 = len;\n    let _e120 = shape;\n    return (((_e115 * _e116) * _e118) * _e120);\n}\n\nfn segmentDepth_u0028_f1_u003b_f1_u003b_vf3_u003b(s0_1: ptr<function, f32>, s1_1: ptr<function, f32>, dir_2: ptr<function, vec3<f32>>) -> f32 {\n    var depth: f32;\n    var param_17: f32;\n    var param_18: f32;\n    var param_19: f32;\n    var param_20: f32;\n    var param_21: f32;\n    var param_22: vec3<f32>;\n    var param_23: f32;\n    var param_24: f32;\n    var param_25: f32;\n    var param_26: f32;\n    var param_27: f32;\n    var param_28: vec3<f32>;\n\n    let _e84 = unnamed.uDensity;\n    param_17 = _e84;\n    let _e87 = unnamed.uHeight[0u];\n    param_18 = _e87;\n    let _e90 = unnamed.uHeight[1u];\n    param_19 = _e90;\n    let _e91 = (*s0_1);\n    param_20 = _e91;\n    let _e92 = (*s1_1);\n    param_21 = _e92;\n    let _e93 = (*dir_2);\n    param_22 = _e93;\n    let _e94 = layerDepth_u0028_f1_u003b_f1_u003b_f1_u003b_f1_u003b_f1_u003b_vf3_u003b((&param_17), (&param_18), (&param_19), (&param_20), (&param_21), (&param_22));\n    depth = _e94;\n    let _e97 = unnamed.uLayer2_[0u];\n    if (_e97 > 0f) {\n        let _e101 = unnamed.uLayer2_[0u];\n        param_23 = _e101;\n        let _e104 = unnamed.uLayer2_[1u];\n        param_24 = _e104;\n        let _e107 = unnamed.uLayer2_[2u];\n        param_25 = _e107;\n        let _e108 = (*s0_1);\n        param_26 = _e108;\n        let _e109 = (*s1_1);\n        param_27 = _e109;\n        let _e110 = (*dir_2);\n        param_28 = _e110;\n        let _e111 = layerDepth_u0028_f1_u003b_f1_u003b_f1_u003b_f1_u003b_f1_u003b_vf3_u003b((&param_23), (&param_24), (&param_25), (&param_26), (&param_27), (&param_28));\n        let _e112 = depth;\n        depth = (_e112 + _e111);\n    }\n    let _e114 = depth;\n    return _e114;\n}\n\nfn hash21_u0028_vf2_u003b(p_4: ptr<function, vec2<f32>>) -> f32 {\n    let _e68 = (*p_4);\n    return fract((sin(dot(_e68, vec2<f32>(127.1f, 311.7f))) * 43758.547f));\n}\n\nfn main_1() {\n    var ndc: vec2<f32>;\n    var probe: vec4<f32>;\n    var dir_3: vec3<f32>;\n    var stored_2: f32;\n    var far: f32;\n    var hit: vec4<f32>;\n    var steps: i32;\n    var dither: f32;\n    var param_29: vec2<f32>;\n    var scatter: vec3<f32>;\n    var param_30: f32;\n    var param_31: f32;\n    var sunLit: vec3<f32>;\n    var skyLit: vec3<f32>;\n    var inscatter: vec3<f32>;\n    var transmittance: f32;\n    var previous: f32;\n    var i_1: i32;\n    var u: f32;\n    var next: f32;\n    var segment: f32;\n    var travelled: f32;\n    var segmentTransmittance: f32;\n    var param_32: f32;\n    var param_33: f32;\n    var param_34: vec3<f32>;\n    var scattered: f32;\n    var at_1: vec3<f32>;\n    var lit: f32;\n    var param_35: vec3<f32>;\n    var light: vec3<f32>;\n    var param_36: vec3<f32>;\n    var param_37: vec3<f32>;\n\n    let _e100 = vUv_1;\n    ndc = ((_e100 * 2f) - vec2(1f));\n    let _e105 = unnamed.uDepthToWorld;\n    let _e106 = ndc;\n    probe = (_e105 * vec4<f32>(_e106.x, _e106.y, 0.5f, 1f));\n    let _e111 = probe;\n    let _e114 = probe[3u];\n    let _e118 = unnamed.uCameraPos;\n    dir_3 = normalize(((_e111.xyz / vec3(_e114)) - _e118));\n    let _e121 = vUv_1;\n    let _e122 = textureSampleLevel(uDepth_t, uDepth_s, _e121, 0f);\n    stored_2 = _e122.x;\n    let _e125 = unnamed.uMaxDistance;\n    far = _e125;\n    let _e126 = stored_2;\n    if !((_e126 <= 0f)) {\n        let _e130 = unnamed.uDepthToWorld;\n        let _e131 = ndc;\n        let _e132 = stored_2;\n        hit = (_e130 * vec4<f32>(_e131.x, _e131.y, _e132, 1f));\n        let _e138 = hit[3u];\n        if (_e138 > 0.000001f) {\n            let _e140 = far;\n            let _e141 = hit;\n            let _e144 = hit[3u];\n            let _e148 = unnamed.uCameraPos;\n            let _e150 = dir_3;\n            far = min(_e140, dot(((_e141.xyz / vec3(_e144)) - _e148), _e150));\n        }\n    }\n    let _e153 = far;\n    if (_e153 <= 0f) {\n        fragColor = vec4<f32>(0f, 0f, 0f, 1f);\n        return;\n    }\n    let _e156 = unnamed.uSteps;\n    steps = clamp(_e156, 1i, 64i);\n    let _e158 = gl_FragCoord_1;\n    param_29 = _e158.xy;\n    let _e160 = hash21_u0028_vf2_u003b((&param_29));\n    dither = (_e160 - 0.5f);\n    let _e163 = unnamed.uAlbedo;\n    let _e166 = unnamed.uScatter[0u];\n    let _e167 = dir_3;\n    let _e169 = unnamed.uSunDir;\n    param_30 = dot(_e167, _e169);\n    let _e172 = unnamed.uAnisotropy;\n    param_31 = _e172;\n    let _e173 = phase_u0028_f1_u003b_f1_u003b((&param_30), (&param_31));\n    scatter = (_e163 * (_e166 * _e173));\n    let _e177 = unnamed.uSunColor;\n    let _e178 = scatter;\n    sunLit = (_e177 * _e178);\n    let _e181 = unnamed.uAmbient;\n    let _e183 = unnamed.uAlbedo;\n    let _e187 = unnamed.uScatter[1u];\n    skyLit = ((_e181 * _e183) * (_e187 / 12.566371f));\n    inscatter = vec3<f32>(0f, 0f, 0f);\n    transmittance = 1f;\n    previous = 0f;\n    i_1 = 0i;\n    loop {\n        let _e190 = i_1;\n        if (_e190 < 64i) {\n            let _e192 = i_1;\n            let _e193 = steps;\n            if (_e192 >= _e193) {\n                break;\n            }\n            let _e195 = i_1;\n            let _e198 = steps;\n            u = (f32((_e195 + 1i)) / f32(_e198));\n            let _e201 = far;\n            let _e202 = u;\n            next = (_e201 * pow(_e202, 2f));\n            let _e205 = next;\n            let _e206 = previous;\n            segment = (_e205 - _e206);\n            let _e208 = previous;\n            let _e209 = next;\n            travelled = (0.5f * (_e208 + _e209));\n            let _e212 = next;\n            previous = _e212;\n            let _e213 = next;\n            let _e214 = segment;\n            param_32 = (_e213 - _e214);\n            let _e216 = next;\n            param_33 = _e216;\n            let _e217 = dir_3;\n            param_34 = _e217;\n            let _e218 = segmentDepth_u0028_f1_u003b_f1_u003b_vf3_u003b((&param_32), (&param_33), (&param_34));\n            segmentTransmittance = exp(-(_e218));\n            let _e221 = segmentTransmittance;\n            scattered = (1f - _e221);\n            let _e224 = unnamed.uCameraPos;\n            let _e225 = dir_3;\n            let _e226 = travelled;\n            let _e227 = dither;\n            let _e228 = segment;\n            at_1 = (_e224 + (_e225 * (_e226 + (_e227 * _e228))));\n            lit = 1f;\n            let _e234 = unnamed.uSunShadow;\n            if (_e234 > 0f) {\n                let _e236 = at_1;\n                param_35 = _e236;\n                let _e237 = sunReach_u0028_vf3_u003b((&param_35));\n                lit = _e237;\n            }\n            let _e238 = sunLit;\n            let _e239 = lit;\n            let _e241 = skyLit;\n            light = ((_e238 * _e239) + _e241);\n            let _e244 = unnamed.uLampCount;\n            if (_e244 > 0i) {\n                let _e247 = unnamed.uAlbedo;\n                let _e248 = at_1;\n                param_36 = _e248;\n                let _e249 = dir_3;\n                param_37 = _e249;\n                let _e250 = lampsAt_u0028_vf3_u003b_vf3_u003b((&param_36), (&param_37));\n                let _e252 = light;\n                light = (_e252 + (_e247 * _e250));\n            }\n            let _e254 = transmittance;\n            let _e255 = scattered;\n            let _e257 = light;\n            let _e259 = inscatter;\n            inscatter = (_e259 + (_e257 * (_e254 * _e255)));\n            let _e261 = segmentTransmittance;\n            let _e262 = transmittance;\n            transmittance = (_e262 * _e261);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e264 = i_1;\n            i_1 = (_e264 + 1i);\n        }\n    }\n    let _e266 = inscatter;\n    let _e267 = (_e266 * 12.566371f);\n    let _e268 = transmittance;\n    fragColor = vec4<f32>(_e267.x, _e267.y, _e267.z, _e268);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>, @builtin(position) gl_FragCoord: vec4<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    gl_FragCoord_1 = gl_FragCoord;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

export const MEDIUM_UPSAMPLE_FRAG_WGSL = "struct Uniforms {\n    uMediumTexel: vec2<f32>,\n    uDepthToViewZ: vec4<f32>,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uMedium_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uMedium_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e71 = (*c);\n    low = (_e71 * 12.92f);\n    let _e73 = (*c);\n    high = ((pow(max(_e73, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e79 = high;\n    let _e80 = low;\n    let _e81 = (*c);\n    return mix(_e79, _e80, step(_e81, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e72 = (*c_1)[0u];\n    let _e74 = (*c_1)[1u];\n    let _e76 = (*c_1)[2u];\n    m = max(_e72, max(_e74, _e76));\n    let _e79 = m;\n    if (_e79 <= 0.8f) {\n        let _e81 = (*c_1);\n        return _e81;\n    }\n    let _e82 = m;\n    e = (_e82 - 0.8f);\n    let _e84 = (*c_1);\n    let _e85 = e;\n    let _e87 = e;\n    let _e91 = m;\n    return (_e84 * ((0.8f + ((0.2f * _e85) / (_e87 + 0.2f))) / _e91));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e71 = (*v);\n    let _e72 = (*v);\n    a = ((_e71 * (_e72 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e78 = (*v);\n    let _e79 = (*v);\n    b = ((_e78 * ((_e79 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e86 = a;\n    let _e87 = b;\n    return (_e86 / _e87);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e71 = unnamed.uOutputExposure;\n    let _e72 = (*x);\n    (*x) = (_e72 * _e71);\n    let _e74 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e74);\n    let _e76 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e76), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e73 = unnamed.uOutputTransform;\n    if (_e73 == 0i) {\n        let _e75 = (*c_2);\n        return _e75;\n    }\n    let _e77 = unnamed.uOutputTransform;\n    if (_e77 == 2i) {\n        let _e79 = (*c_2);\n        param_1 = _e79;\n        let _e80 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e80;\n    }\n    let _e82 = unnamed.uOutputTransform;\n    if (_e82 == 3i) {\n        let _e84 = (*c_2);\n        let _e86 = unnamed.uOutputExposure;\n        param_2 = (_e84 * _e86);\n        let _e88 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e88;\n    }\n    let _e89 = (*c_2);\n    param_3 = _e89;\n    let _e90 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e90;\n}\n\nfn viewDistance_u0028_f1_u003b(stored: ptr<function, f32>) -> f32 {\n    var ndc: f32;\n\n    let _e70 = (*stored);\n    ndc = (1f - (_e70 * 2f));\n    let _e75 = unnamed.uDepthToViewZ[0u];\n    let _e76 = ndc;\n    let _e80 = unnamed.uDepthToViewZ[1u];\n    let _e84 = unnamed.uDepthToViewZ[2u];\n    let _e85 = ndc;\n    let _e89 = unnamed.uDepthToViewZ[3u];\n    return abs((((_e75 * _e76) + _e80) / ((_e84 * _e85) + _e89)));\n}\n\nfn main_1() {\n    var here: f32;\n    var param_4: f32;\n    var coord: vec2<f32>;\n    var base: vec2<f32>;\n    var f: vec2<f32>;\n    var total: vec4<f32>;\n    var weight: f32;\n    var nearest: vec4<f32>;\n    var nearestGap: f32;\n    var i: i32;\n    var offset: vec2<f32>;\n    var uv: vec2<f32>;\n    var bilinear: f32;\n    var there: f32;\n    var param_5: f32;\n    var gap: f32;\n    var sampled: vec4<f32>;\n    var depthWeight: f32;\n    var medium: vec4<f32>;\n    var local: vec4<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec3<f32>;\n\n    let _e90 = vUv_1;\n    let _e91 = textureSampleLevel(uDepth_t, uDepth_s, _e90, 0f);\n    param_4 = _e91.x;\n    let _e93 = viewDistance_u0028_f1_u003b((&param_4));\n    here = _e93;\n    let _e94 = vUv_1;\n    let _e96 = unnamed.uMediumTexel;\n    coord = ((_e94 / _e96) - vec2(0.5f));\n    let _e100 = coord;\n    base = floor(_e100);\n    let _e102 = coord;\n    let _e103 = base;\n    f = (_e102 - _e103);\n    total = vec4<f32>(0f, 0f, 0f, 0f);\n    weight = 0f;\n    nearest = vec4<f32>(0f, 0f, 0f, 1f);\n    nearestGap = 1000000000000000000000000000000f;\n    i = 0i;\n    loop {\n        let _e105 = i;\n        if (_e105 < 4i) {\n            let _e107 = i;\n            let _e110 = i;\n            offset = vec2<f32>(f32((_e107 & 1i)), f32(((_e110 >> bitcast<u32>(1i)) & 1i)));\n            let _e116 = base;\n            let _e117 = offset;\n            let _e122 = unnamed.uMediumTexel;\n            uv = (((_e116 + _e117) + vec2(0.5f)) * _e122);\n            let _e125 = f[0u];\n            let _e128 = f[0u];\n            let _e130 = offset[0u];\n            let _e133 = f[1u];\n            let _e136 = f[1u];\n            let _e138 = offset[1u];\n            bilinear = (mix((1f - _e125), _e128, _e130) * mix((1f - _e133), _e136, _e138));\n            let _e141 = uv;\n            let _e142 = textureSampleLevel(uDepth_t, uDepth_s, _e141, 0f);\n            param_5 = _e142.x;\n            let _e144 = viewDistance_u0028_f1_u003b((&param_5));\n            there = _e144;\n            let _e145 = there;\n            let _e146 = here;\n            let _e149 = there;\n            let _e150 = here;\n            gap = (abs((_e145 - _e146)) / max(min(_e149, _e150), 0.001f));\n            let _e154 = uv;\n            let _e155 = textureSampleLevel(uMedium_t, uMedium_s, _e154, 0f);\n            sampled = _e155;\n            let _e156 = gap;\n            let _e157 = nearestGap;\n            if (_e156 < _e157) {\n                let _e159 = gap;\n                nearestGap = _e159;\n                let _e160 = sampled;\n                nearest = _e160;\n            }\n            let _e161 = gap;\n            depthWeight = (1f - smoothstep(0.04f, 0.05f, _e161));\n            let _e164 = sampled;\n            let _e165 = bilinear;\n            let _e167 = depthWeight;\n            let _e169 = total;\n            total = (_e169 + ((_e164 * _e165) * _e167));\n            let _e171 = bilinear;\n            let _e172 = depthWeight;\n            let _e174 = weight;\n            weight = (_e174 + (_e171 * _e172));\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e176 = i;\n            i = (_e176 + 1i);\n        }\n    }\n    let _e178 = weight;\n    if (_e178 > 0.0001f) {\n        let _e180 = total;\n        let _e181 = weight;\n        local = (_e180 / vec4(_e181));\n    } else {\n        let _e184 = nearest;\n        local = _e184;\n    }\n    let _e185 = local;\n    medium = _e185;\n    let _e187 = unnamed.uOutputTransform;\n    if (_e187 != 0i) {\n        let _e189 = medium;\n        param_6 = _e189.xyz;\n        let _e191 = applyOutputTransform_u0028_vf3_u003b((&param_6));\n        let _e192 = medium;\n        medium = vec4<f32>(_e191.x, _e191.y, _e191.z, _e192.w);\n        let _e199 = medium[3u];\n        param_7 = vec3(_e199);\n        let _e201 = linearToSrgb_u0028_vf3_u003b((&param_7));\n        medium[3u] = _e201.x;\n    }\n    let _e204 = medium;\n    fragColor = _e204;\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const GLOBALMEDIUM_BINDINGS = {
  "MEDIUM_FRAG": {
    "uniforms": 1,
    "uniformSize": 2400,
    "fields": {
      "uDepthToWorld": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uCameraPos": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uSunDir": {
        "offset": 80,
        "size": 12,
        "type": "vec3"
      },
      "uSunColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uAmbient": {
        "offset": 112,
        "size": 12,
        "type": "vec3"
      },
      "uDensity": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uHeight": {
        "offset": 128,
        "size": 8,
        "type": "vec2"
      },
      "uLayer2": {
        "offset": 144,
        "size": 12,
        "type": "vec3"
      },
      "uAlbedo": {
        "offset": 160,
        "size": 12,
        "type": "vec3"
      },
      "uScatter": {
        "offset": 176,
        "size": 8,
        "type": "vec2"
      },
      "uAnisotropy": {
        "offset": 184,
        "size": 4,
        "type": "float"
      },
      "uMaxDistance": {
        "offset": 188,
        "size": 4,
        "type": "float"
      },
      "uSteps": {
        "offset": 192,
        "size": 4,
        "type": "int"
      },
      "uSunShadow": {
        "offset": 196,
        "size": 4,
        "type": "float"
      },
      "uLightViewProj": {
        "offset": 208,
        "size": 64,
        "type": "mat4"
      },
      "uMovingLightViewProj": {
        "offset": 272,
        "size": 64,
        "type": "mat4"
      },
      "uPeeledShadowEnabled": {
        "offset": 336,
        "size": 4,
        "type": "int"
      },
      "uLampCount": {
        "offset": 340,
        "size": 4,
        "type": "int"
      },
      "uLampFalloff": {
        "offset": 344,
        "size": 4,
        "type": "int"
      },
      "uLampPosition": {
        "offset": 352,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampColor": {
        "offset": 608,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampAim": {
        "offset": 864,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampCone": {
        "offset": 1120,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampShadow": {
        "offset": 1376,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampShadowAt": {
        "offset": 1632,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampLive": {
        "offset": 1888,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      },
      "uLampLiveAt": {
        "offset": 2144,
        "size": 256,
        "type": "vec4",
        "length": 16,
        "stride": 16
      }
    },
    "textures": {
      "uDepth": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uSunShadows": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2DArray"
      },
      "uPointShadows": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2DArray"
      }
    }
  },
  "MEDIUM_UPSAMPLE_FRAG": {
    "uniforms": 1,
    "uniformSize": 48,
    "fields": {
      "uMediumTexel": {
        "offset": 0,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToViewZ": {
        "offset": 16,
        "size": 16,
        "type": "vec4"
      },
      "uOutputTransform": {
        "offset": 32,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 36,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uMedium": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      }
    }
  }
} as const;
