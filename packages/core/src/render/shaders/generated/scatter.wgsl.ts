/*
 * Generated from ../scatter.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SCATTER_DEPTH_VERT_WGSL = "struct Uniforms {\n    uLightViewProj: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n    uTrample: array<vec4<f32>, 8>,\n    uTrampleRadius: f32,\n    uTrampleDepth: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec4<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstancePos_1: vec3<f32>;\nvar<private> aScaleYaw_1: vec2<f32>;\nvar<private> aWindResponse_1: vec3<f32>;\nvar<private> vLightPosition: vec4<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn scatterOffset_u0028_vf3_u003b_vf3_u003b_vf2_u003b_vf3_u003b_vf2_u003b(position: ptr<function, vec3<f32>>, instancePos: ptr<function, vec3<f32>>, scaleYaw: ptr<function, vec2<f32>>, windResponse: ptr<function, vec3<f32>>, yawTrig: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var s: f32;\n    var c: f32;\n    var local: vec3<f32>;\n    var rotated: vec3<f32>;\n    var phase: f32;\n    var rooted: f32;\n    var bend: f32;\n    var pressed: f32;\n    var away: vec2<f32>;\n    var i: i32;\n    var p: vec4<f32>;\n    var offset: vec3<f32>;\n    var dist: f32;\n    var fade: f32;\n    var strength: f32;\n    var local_1: vec2<f32>;\n    var take: f32;\n\n    let _e49 = (*yawTrig)[0u];\n    s = _e49;\n    let _e51 = (*yawTrig)[1u];\n    c = _e51;\n    let _e52 = (*position);\n    let _e54 = (*scaleYaw)[0u];\n    local = (_e52 * _e54);\n    let _e57 = local[0u];\n    let _e58 = c;\n    let _e61 = local[2u];\n    let _e62 = s;\n    let _e66 = local[1u];\n    let _e68 = local[0u];\n    let _e70 = s;\n    let _e73 = local[2u];\n    let _e74 = c;\n    rotated = vec3<f32>(((_e57 * _e58) + (_e61 * _e62)), _e66, ((-(_e68) * _e70) + (_e73 * _e74)));\n    let _e78 = (*instancePos);\n    let _e81 = unnamed.uWindSpatialPhase;\n    let _e84 = unnamed.uWindTime;\n    let _e87 = (*windResponse)[2u];\n    phase = ((dot(_e78.xz, _e81) + _e84) + _e87);\n    let _e90 = rotated[1u];\n    let _e92 = (*windResponse)[0u];\n    rooted = clamp((_e90 * _e92), 0f, 1f);\n    let _e96 = unnamed.uWindSpeed;\n    let _e98 = unnamed.uWindGust;\n    let _e100 = (*windResponse)[1u];\n    let _e103 = phase;\n    let _e106 = rooted;\n    let _e108 = rooted;\n    bend = ((((_e96 + (_e98 * _e100)) * sin(_e103)) * _e106) * _e108);\n    let _e111 = unnamed.uWindDirection;\n    let _e112 = bend;\n    let _e114 = rotated;\n    let _e116 = (_e114.xz + (_e111 * _e112));\n    let _e117 = rotated;\n    rotated = vec3<f32>(_e116.x, _e117.y, _e116.y);\n    pressed = 0f;\n    away = vec2<f32>(0f, 0f);\n    i = 0i;\n    loop {\n        let _e122 = i;\n        if (_e122 < 8i) {\n            let _e124 = i;\n            let _e127 = unnamed.uTrample[_e124];\n            p = _e127;\n            let _e129 = p[3u];\n            if (_e129 <= 0f) {\n                continue;\n            }\n            let _e131 = (*instancePos);\n            let _e132 = p;\n            offset = (_e131 - _e132.xyz);\n            let _e135 = offset;\n            dist = length(_e135);\n            let _e137 = dist;\n            let _e139 = unnamed.uTrampleRadius;\n            if (_e137 >= _e139) {\n                continue;\n            }\n            let _e141 = dist;\n            let _e143 = unnamed.uTrampleRadius;\n            fade = (1f - (_e141 / _e143));\n            let _e147 = p[3u];\n            let _e148 = fade;\n            let _e150 = fade;\n            strength = ((_e147 * _e148) * _e150);\n            let _e152 = strength;\n            let _e153 = pressed;\n            if (_e152 <= _e153) {\n                continue;\n            }\n            let _e155 = strength;\n            pressed = _e155;\n            let _e156 = dist;\n            if (_e156 > 0.0001f) {\n                let _e158 = offset;\n                let _e160 = dist;\n                local_1 = (_e158.xz / vec2(_e160));\n            } else {\n                local_1 = vec2<f32>(0f, 0f);\n            }\n            let _e163 = local_1;\n            away = _e163;\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e164 = i;\n            i = (_e164 + 1i);\n        }\n    }\n    let _e166 = pressed;\n    if (_e166 > 0f) {\n        let _e168 = pressed;\n        let _e170 = unnamed.uTrampleDepth;\n        take = (_e168 * _e170);\n        let _e172 = take;\n        let _e175 = rotated[1u];\n        rotated[1u] = (_e175 * (1f - _e172));\n        let _e178 = away;\n        let _e179 = take;\n        let _e182 = rotated[1u];\n        let _e185 = rotated;\n        let _e187 = (_e185.xz + (((_e178 * _e179) * _e182) * 1.4f));\n        let _e188 = rotated;\n        rotated = vec3<f32>(_e187.x, _e188.y, _e187.y);\n    }\n    let _e193 = rotated;\n    return _e193;\n}\n\nfn scatterYaw_u0028_f1_u003b(yaw: ptr<function, f32>) -> vec2<f32> {\n    let _e27 = (*yaw);\n    let _e29 = (*yaw);\n    return vec2<f32>(sin(_e27), cos(_e29));\n}\n\nfn main_1() {\n    var rotated_1: vec3<f32>;\n    var param: f32;\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec2<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec2<f32>;\n\n    let _e34 = aScaleYaw_1[1u];\n    param = _e34;\n    let _e35 = scatterYaw_u0028_f1_u003b((&param));\n    let _e36 = aPosition_1;\n    param_1 = _e36;\n    let _e37 = aInstancePos_1;\n    param_2 = _e37;\n    let _e38 = aScaleYaw_1;\n    param_3 = _e38;\n    let _e39 = aWindResponse_1;\n    param_4 = _e39;\n    param_5 = _e35;\n    let _e40 = scatterOffset_u0028_vf3_u003b_vf3_u003b_vf2_u003b_vf3_u003b_vf2_u003b((&param_1), (&param_2), (&param_3), (&param_4), (&param_5));\n    rotated_1 = _e40;\n    let _e42 = unnamed.uLightViewProj;\n    let _e43 = aInstancePos_1;\n    let _e44 = rotated_1;\n    let _e45 = (_e43 + _e44);\n    vLightPosition = (_e42 * vec4<f32>(_e45.x, _e45.y, _e45.z, 1f));\n    let _e51 = vLightPosition;\n    unnamed_1.gl_Position = _e51;\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(3) aInstancePos: vec3<f32>, @location(4) aScaleYaw: vec2<f32>, @location(6) aWindResponse: vec3<f32>) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aInstancePos_1 = aInstancePos;\n    aScaleYaw_1 = aScaleYaw;\n    aWindResponse_1 = aWindResponse;\n    main_1();\n    let _e12 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e12);\n    let _e14 = vLightPosition;\n    let _e15 = unnamed_1.gl_Position;\n    return VertexOutput(_e14, _e15);\n}\n";

export const SCATTER_FRAG_WGSL = "struct Uniforms {\n    uDirectionalDir: vec3<f32>,\n    uDirectionalColor: vec3<f32>,\n    uAmbient: vec3<f32>,\n    uCameraPos: vec3<f32>,\n    uFogColor: vec3<f32>,\n    uFogDensity: f32,\n    uFogHeightFalloff: f32,\n    uFogEyeY: f32,\n    uUnderwaterColor: vec3<f32>,\n    uUnderwaterFogDensity: f32,\n    uUnderwaterFactor: f32,\n    uFogMode: i32,\n    uFogNear: f32,\n    uFogFar: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;\nvar<private> outColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e72 = (*c);\n    low = (_e72 * 12.92f);\n    let _e74 = (*c);\n    high = ((pow(max(_e74, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e80 = high;\n    let _e81 = low;\n    let _e82 = (*c);\n    return mix(_e80, _e81, step(_e82, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e73 = (*c_1)[0u];\n    let _e75 = (*c_1)[1u];\n    let _e77 = (*c_1)[2u];\n    m = max(_e73, max(_e75, _e77));\n    let _e80 = m;\n    if (_e80 <= 0.8f) {\n        let _e82 = (*c_1);\n        return _e82;\n    }\n    let _e83 = m;\n    e = (_e83 - 0.8f);\n    let _e85 = (*c_1);\n    let _e86 = e;\n    let _e88 = e;\n    let _e92 = m;\n    return (_e85 * ((0.8f + ((0.2f * _e86) / (_e88 + 0.2f))) / _e92));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e72 = (*v);\n    let _e73 = (*v);\n    a = ((_e72 * (_e73 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e79 = (*v);\n    let _e80 = (*v);\n    b = ((_e79 * ((_e80 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e87 = a;\n    let _e88 = b;\n    return (_e87 / _e88);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e72 = unnamed.uOutputExposure;\n    let _e73 = (*x);\n    (*x) = (_e73 * _e72);\n    let _e75 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e75);\n    let _e77 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e77), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e74 = unnamed.uOutputTransform;\n    if (_e74 == 0i) {\n        let _e76 = (*c_2);\n        return _e76;\n    }\n    let _e78 = unnamed.uOutputTransform;\n    if (_e78 == 2i) {\n        let _e80 = (*c_2);\n        param_1 = _e80;\n        let _e81 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e81;\n    }\n    let _e83 = unnamed.uOutputTransform;\n    if (_e83 == 3i) {\n        let _e85 = (*c_2);\n        let _e87 = unnamed.uOutputExposure;\n        param_2 = (_e85 * _e87);\n        let _e89 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e89;\n    }\n    let _e90 = (*c_2);\n    param_3 = _e90;\n    let _e91 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e91;\n}\n\nfn mediumColor_u0028_() -> vec3<f32> {\n    let _e70 = unnamed.uFogColor;\n    let _e72 = unnamed.uUnderwaterColor;\n    let _e74 = unnamed.uUnderwaterFactor;\n    return mix(_e70, _e72, vec3(_e74));\n}\n\nfn mediumFog_u0028_f1_u003b_f1_u003b(dist: ptr<function, f32>, pointY: ptr<function, f32>) -> f32 {\n    var span: f32;\n    var ramp: f32;\n    var wetLinear: f32;\n    var start: f32;\n    var before: f32;\n    var local: f32;\n    var t: f32;\n    var rest: f32;\n    var denom: f32;\n    var air: f32;\n    var wet: f32;\n\n    let _e83 = unnamed.uFogMode;\n    if (_e83 == 1i) {\n        let _e86 = unnamed.uFogFar;\n        let _e88 = unnamed.uFogNear;\n        span = max((_e86 - _e88), 0.0001f);\n        let _e91 = (*dist);\n        let _e93 = unnamed.uFogNear;\n        let _e95 = span;\n        ramp = clamp(((_e91 - _e93) / _e95), 0f, 1f);\n        let _e99 = unnamed.uUnderwaterFactor;\n        if (_e99 <= 0f) {\n            let _e101 = ramp;\n            return _e101;\n        }\n        let _e103 = unnamed.uUnderwaterFogDensity;\n        let _e104 = (*dist);\n        wetLinear = (_e103 * _e104);\n        let _e106 = ramp;\n        let _e107 = wetLinear;\n        let _e109 = wetLinear;\n        let _e115 = unnamed.uUnderwaterFactor;\n        return mix(_e106, (1f - exp2(((-(_e107) * _e109) * 1.442695f))), _e115);\n    }\n    let _e118 = unnamed.uFogNear;\n    let _e119 = (*dist);\n    start = min(_e118, _e119);\n    let _e121 = (*dist);\n    if (_e121 > 0f) {\n        let _e123 = start;\n        let _e124 = (*dist);\n        local = (_e123 / _e124);\n    } else {\n        local = 0f;\n    }\n    let _e126 = local;\n    before = _e126;\n    let _e127 = (*pointY);\n    let _e129 = unnamed.uFogEyeY;\n    let _e132 = unnamed.uFogHeightFalloff;\n    t = ((_e127 - _e129) * _e132);\n    let _e134 = t;\n    let _e135 = before;\n    rest = (_e134 * (1f - _e135));\n    let _e138 = rest;\n    let _e141 = rest;\n    denom = select(_e141, 0.0001f, (abs(_e138) < 0.0001f));\n    let _e144 = unnamed.uFogDensity;\n    let _e146 = t;\n    let _e148 = before;\n    let _e152 = (*dist);\n    let _e153 = start;\n    let _e156 = denom;\n    let _e161 = denom;\n    air = (1f - exp(((((-(_e144) * exp((-(_e146) * _e148))) * (_e152 - _e153)) * (1f - exp(-(_e156)))) / _e161)));\n    let _e166 = unnamed.uUnderwaterFactor;\n    if (_e166 <= 0f) {\n        let _e168 = air;\n        return _e168;\n    }\n    let _e170 = unnamed.uUnderwaterFogDensity;\n    let _e171 = (*dist);\n    wet = (_e170 * _e171);\n    let _e173 = air;\n    let _e174 = wet;\n    let _e176 = wet;\n    let _e182 = unnamed.uUnderwaterFactor;\n    return mix(_e173, (1f - exp2(((-(_e174) * _e176) * 1.442695f))), _e182);\n}\n\nfn main_1() {\n    var n: vec3<f32>;\n    var ndl: f32;\n    var lit: vec3<f32>;\n    var fog: f32;\n    var param_4: f32;\n    var param_5: f32;\n    var param_6: vec3<f32>;\n\n    let _e76 = vNormal_1;\n    n = normalize(_e76);\n    let _e78 = n;\n    let _e80 = unnamed.uDirectionalDir;\n    ndl = abs(dot(_e78, _e80));\n    let _e83 = vColor_1;\n    let _e85 = unnamed.uAmbient;\n    let _e87 = unnamed.uDirectionalColor;\n    let _e88 = ndl;\n    lit = (_e83 * (_e85 + (_e87 * _e88)));\n    let _e92 = vWorldPos_1;\n    let _e94 = unnamed.uCameraPos;\n    param_4 = distance(_e92, _e94);\n    let _e97 = vWorldPos_1[1u];\n    param_5 = _e97;\n    let _e98 = mediumFog_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n    fog = _e98;\n    let _e99 = lit;\n    let _e100 = mediumColor_u0028_();\n    let _e101 = fog;\n    param_6 = mix(_e99, _e100, vec3(_e101));\n    let _e104 = applyOutputTransform_u0028_vf3_u003b((&param_6));\n    outColor = vec4<f32>(_e104.x, _e104.y, _e104.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(1) vNormal: vec3<f32>, @location(0) vColor: vec3<f32>, @location(2) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vNormal_1 = vNormal;\n    vColor_1 = vColor;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e7 = outColor;\n    return _e7;\n}\n";

export const SCATTER_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uWindDirection: vec2<f32>,\n    uWindSpeed: f32,\n    uWindGust: f32,\n    uWindTime: f32,\n    uWindSpatialPhase: vec2<f32>,\n    uTrample: array<vec4<f32>, 8>,\n    uTrampleRadius: f32,\n    uTrampleDepth: f32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(0) member: vec3<f32>,\n    @location(1) member_1: vec3<f32>,\n    @location(2) member_2: vec3<f32>,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aScaleYaw_1: vec2<f32>;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> aInstancePos_1: vec3<f32>;\nvar<private> aWindResponse_1: vec3<f32>;\nvar<private> vColor: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> aTint_1: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn scatterOffset_u0028_vf3_u003b_vf3_u003b_vf2_u003b_vf3_u003b_vf2_u003b(position: ptr<function, vec3<f32>>, instancePos: ptr<function, vec3<f32>>, scaleYaw: ptr<function, vec2<f32>>, windResponse: ptr<function, vec3<f32>>, yawTrig: ptr<function, vec2<f32>>) -> vec3<f32> {\n    var s: f32;\n    var c: f32;\n    var local: vec3<f32>;\n    var rotated: vec3<f32>;\n    var phase: f32;\n    var rooted: f32;\n    var bend: f32;\n    var pressed: f32;\n    var away: vec2<f32>;\n    var i: i32;\n    var p: vec4<f32>;\n    var offset: vec3<f32>;\n    var dist: f32;\n    var fade: f32;\n    var strength: f32;\n    var local_1: vec2<f32>;\n    var take: f32;\n\n    let _e54 = (*yawTrig)[0u];\n    s = _e54;\n    let _e56 = (*yawTrig)[1u];\n    c = _e56;\n    let _e57 = (*position);\n    let _e59 = (*scaleYaw)[0u];\n    local = (_e57 * _e59);\n    let _e62 = local[0u];\n    let _e63 = c;\n    let _e66 = local[2u];\n    let _e67 = s;\n    let _e71 = local[1u];\n    let _e73 = local[0u];\n    let _e75 = s;\n    let _e78 = local[2u];\n    let _e79 = c;\n    rotated = vec3<f32>(((_e62 * _e63) + (_e66 * _e67)), _e71, ((-(_e73) * _e75) + (_e78 * _e79)));\n    let _e83 = (*instancePos);\n    let _e86 = unnamed.uWindSpatialPhase;\n    let _e89 = unnamed.uWindTime;\n    let _e92 = (*windResponse)[2u];\n    phase = ((dot(_e83.xz, _e86) + _e89) + _e92);\n    let _e95 = rotated[1u];\n    let _e97 = (*windResponse)[0u];\n    rooted = clamp((_e95 * _e97), 0f, 1f);\n    let _e101 = unnamed.uWindSpeed;\n    let _e103 = unnamed.uWindGust;\n    let _e105 = (*windResponse)[1u];\n    let _e108 = phase;\n    let _e111 = rooted;\n    let _e113 = rooted;\n    bend = ((((_e101 + (_e103 * _e105)) * sin(_e108)) * _e111) * _e113);\n    let _e116 = unnamed.uWindDirection;\n    let _e117 = bend;\n    let _e119 = rotated;\n    let _e121 = (_e119.xz + (_e116 * _e117));\n    let _e122 = rotated;\n    rotated = vec3<f32>(_e121.x, _e122.y, _e121.y);\n    pressed = 0f;\n    away = vec2<f32>(0f, 0f);\n    i = 0i;\n    loop {\n        let _e127 = i;\n        if (_e127 < 8i) {\n            let _e129 = i;\n            let _e132 = unnamed.uTrample[_e129];\n            p = _e132;\n            let _e134 = p[3u];\n            if (_e134 <= 0f) {\n                continue;\n            }\n            let _e136 = (*instancePos);\n            let _e137 = p;\n            offset = (_e136 - _e137.xyz);\n            let _e140 = offset;\n            dist = length(_e140);\n            let _e142 = dist;\n            let _e144 = unnamed.uTrampleRadius;\n            if (_e142 >= _e144) {\n                continue;\n            }\n            let _e146 = dist;\n            let _e148 = unnamed.uTrampleRadius;\n            fade = (1f - (_e146 / _e148));\n            let _e152 = p[3u];\n            let _e153 = fade;\n            let _e155 = fade;\n            strength = ((_e152 * _e153) * _e155);\n            let _e157 = strength;\n            let _e158 = pressed;\n            if (_e157 <= _e158) {\n                continue;\n            }\n            let _e160 = strength;\n            pressed = _e160;\n            let _e161 = dist;\n            if (_e161 > 0.0001f) {\n                let _e163 = offset;\n                let _e165 = dist;\n                local_1 = (_e163.xz / vec2(_e165));\n            } else {\n                local_1 = vec2<f32>(0f, 0f);\n            }\n            let _e168 = local_1;\n            away = _e168;\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e169 = i;\n            i = (_e169 + 1i);\n        }\n    }\n    let _e171 = pressed;\n    if (_e171 > 0f) {\n        let _e173 = pressed;\n        let _e175 = unnamed.uTrampleDepth;\n        take = (_e173 * _e175);\n        let _e177 = take;\n        let _e180 = rotated[1u];\n        rotated[1u] = (_e180 * (1f - _e177));\n        let _e183 = away;\n        let _e184 = take;\n        let _e187 = rotated[1u];\n        let _e190 = rotated;\n        let _e192 = (_e190.xz + (((_e183 * _e184) * _e187) * 1.4f));\n        let _e193 = rotated;\n        rotated = vec3<f32>(_e192.x, _e193.y, _e192.y);\n    }\n    let _e198 = rotated;\n    return _e198;\n}\n\nfn scatterYaw_u0028_f1_u003b(yaw: ptr<function, f32>) -> vec2<f32> {\n    let _e32 = (*yaw);\n    let _e34 = (*yaw);\n    return vec2<f32>(sin(_e32), cos(_e34));\n}\n\nfn main_1() {\n    var yawTrig_1: vec2<f32>;\n    var param: f32;\n    var rotated_1: vec3<f32>;\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec2<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec2<f32>;\n    var world: vec3<f32>;\n    var s_1: f32;\n    var c_1: f32;\n\n    let _e43 = aScaleYaw_1[1u];\n    param = _e43;\n    let _e44 = scatterYaw_u0028_f1_u003b((&param));\n    yawTrig_1 = _e44;\n    let _e45 = aPosition_1;\n    param_1 = _e45;\n    let _e46 = aInstancePos_1;\n    param_2 = _e46;\n    let _e47 = aScaleYaw_1;\n    param_3 = _e47;\n    let _e48 = aWindResponse_1;\n    param_4 = _e48;\n    let _e49 = yawTrig_1;\n    param_5 = _e49;\n    let _e50 = scatterOffset_u0028_vf3_u003b_vf3_u003b_vf2_u003b_vf3_u003b_vf2_u003b((&param_1), (&param_2), (&param_3), (&param_4), (&param_5));\n    rotated_1 = _e50;\n    let _e51 = aInstancePos_1;\n    let _e52 = rotated_1;\n    world = (_e51 + _e52);\n    let _e55 = yawTrig_1[0u];\n    s_1 = _e55;\n    let _e57 = yawTrig_1[1u];\n    c_1 = _e57;\n    let _e58 = aColor_1;\n    let _e59 = aTint_1;\n    vColor = (_e58 * _e59);\n    let _e62 = aNormal_1[0u];\n    let _e63 = c_1;\n    let _e66 = aNormal_1[2u];\n    let _e67 = s_1;\n    let _e71 = aNormal_1[1u];\n    let _e73 = aNormal_1[0u];\n    let _e75 = s_1;\n    let _e78 = aNormal_1[2u];\n    let _e79 = c_1;\n    vNormal = vec3<f32>(((_e62 * _e63) + (_e66 * _e67)), _e71, ((-(_e73) * _e75) + (_e78 * _e79)));\n    let _e83 = world;\n    vWorldPos = _e83;\n    let _e85 = unnamed.uViewProj;\n    let _e86 = world;\n    unnamed_1.gl_Position = (_e85 * vec4<f32>(_e86.x, _e86.y, _e86.z, 1f));\n    return;\n}\n\n@vertex \nfn main(@location(4) aScaleYaw: vec2<f32>, @location(0) aPosition: vec3<f32>, @location(3) aInstancePos: vec3<f32>, @location(6) aWindResponse: vec3<f32>, @location(2) aColor: vec3<f32>, @location(5) aTint: vec3<f32>, @location(1) aNormal: vec3<f32>) -> VertexOutput {\n    aScaleYaw_1 = aScaleYaw;\n    aPosition_1 = aPosition;\n    aInstancePos_1 = aInstancePos;\n    aWindResponse_1 = aWindResponse;\n    aColor_1 = aColor;\n    aTint_1 = aTint;\n    aNormal_1 = aNormal;\n    main_1();\n    let _e20 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e20);\n    let _e22 = vColor;\n    let _e23 = vNormal;\n    let _e24 = vWorldPos;\n    let _e25 = unnamed_1.gl_Position;\n    return VertexOutput(_e22, _e23, _e24, _e25);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SCATTER_BINDINGS = {
  "SCATTER_DEPTH_VERT": {
    "uniforms": 0,
    "uniformSize": 240,
    "fields": {
      "uLightViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uWindDirection": {
        "offset": 64,
        "size": 8,
        "type": "vec2"
      },
      "uWindSpeed": {
        "offset": 72,
        "size": 4,
        "type": "float"
      },
      "uWindGust": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uWindTime": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uWindSpatialPhase": {
        "offset": 88,
        "size": 8,
        "type": "vec2"
      },
      "uTrample": {
        "offset": 96,
        "size": 128,
        "type": "vec4",
        "length": 8,
        "stride": 16
      },
      "uTrampleRadius": {
        "offset": 224,
        "size": 4,
        "type": "float"
      },
      "uTrampleDepth": {
        "offset": 228,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "SCATTER_FRAG": {
    "uniforms": 1,
    "uniformSize": 144,
    "fields": {
      "uDirectionalDir": {
        "offset": 0,
        "size": 12,
        "type": "vec3"
      },
      "uDirectionalColor": {
        "offset": 16,
        "size": 12,
        "type": "vec3"
      },
      "uAmbient": {
        "offset": 32,
        "size": 12,
        "type": "vec3"
      },
      "uCameraPos": {
        "offset": 48,
        "size": 12,
        "type": "vec3"
      },
      "uFogColor": {
        "offset": 64,
        "size": 12,
        "type": "vec3"
      },
      "uFogDensity": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uFogHeightFalloff": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uFogEyeY": {
        "offset": 84,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uUnderwaterFogDensity": {
        "offset": 108,
        "size": 4,
        "type": "float"
      },
      "uUnderwaterFactor": {
        "offset": 112,
        "size": 4,
        "type": "float"
      },
      "uFogMode": {
        "offset": 116,
        "size": 4,
        "type": "int"
      },
      "uFogNear": {
        "offset": 120,
        "size": 4,
        "type": "float"
      },
      "uFogFar": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 128,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 132,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "SCATTER_VERT": {
    "uniforms": 0,
    "uniformSize": 240,
    "fields": {
      "uViewProj": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uWindDirection": {
        "offset": 64,
        "size": 8,
        "type": "vec2"
      },
      "uWindSpeed": {
        "offset": 72,
        "size": 4,
        "type": "float"
      },
      "uWindGust": {
        "offset": 76,
        "size": 4,
        "type": "float"
      },
      "uWindTime": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uWindSpatialPhase": {
        "offset": 88,
        "size": 8,
        "type": "vec2"
      },
      "uTrample": {
        "offset": 96,
        "size": 128,
        "type": "vec4",
        "length": 8,
        "stride": 16
      },
      "uTrampleRadius": {
        "offset": 224,
        "size": 4,
        "type": "float"
      },
      "uTrampleDepth": {
        "offset": 228,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  }
} as const;
