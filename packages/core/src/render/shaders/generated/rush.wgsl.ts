/*
 * Generated from ../rush.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const RUSH_FRAG_WGSL = "struct Uniforms {\n    uStrength: f32,\n    uReach: f32,\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n    uReprojection: mat4x4<f32>,\n    uMotionStrength: f32,\n    uMotionMax: f32,\n    uAoStrength: f32,\n    uBloomStrength: f32,\n    uVeilColor: vec3<f32>,\n    uVeilAlpha: f32,\n    uGradeStrength: f32,\n    uGradeSize: f32,\n    uFocusDistance: f32,\n    uFocusRange: f32,\n    uDofStrength: f32,\n    uDofAspect: vec2<f32>,\n    uDepthToView: vec4<f32>,\n}\n\n@group(0) @binding(34) \nvar uDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uDepth_s: sampler;\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(32) \nvar uScene_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uScene_s: sampler;\n@group(0) @binding(38) \nvar uBloom_t: texture_2d<f32>;\n@group(0) @binding(39) \nvar uBloom_s: sampler;\n@group(0) @binding(40) \nvar uGradeLut_t: texture_3d<f32>;\n@group(0) @binding(41) \nvar uGradeLut_s: sampler;\n@group(0) @binding(36) \nvar uAo_t: texture_2d<f32>;\n@group(0) @binding(37) \nvar uAo_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn withVeil_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e113 = unnamed.uVeilAlpha;\n    if (_e113 <= 0f) {\n        let _e115 = (*c);\n        return _e115;\n    }\n    let _e116 = (*c);\n    let _e118 = unnamed.uVeilColor;\n    let _e120 = unnamed.uVeilAlpha;\n    return mix(_e116, _e118, vec3(_e120));\n}\n\nfn applyColourGrade_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var clamped: vec3<f32>;\n    var uvw: vec3<f32>;\n\n    let _e115 = unnamed.uGradeStrength;\n    if (_e115 <= 0f) {\n        let _e117 = (*c_1);\n        return _e117;\n    }\n    let _e118 = (*c_1);\n    clamped = clamp(_e118, vec3(0f), vec3(1f));\n    let _e122 = clamped;\n    let _e124 = unnamed.uGradeSize;\n    let _e130 = unnamed.uGradeSize;\n    uvw = (((_e122 * (_e124 - 1f)) + vec3(0.5f)) / vec3(_e130));\n    let _e133 = (*c_1);\n    let _e134 = uvw;\n    let _e135 = textureSampleLevel(uGradeLut_t, uGradeLut_s, _e134, 0f);\n    let _e138 = unnamed.uGradeStrength;\n    return mix(_e133, _e135.xyz, vec3(_e138));\n}\n\nfn linearToSrgb_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e114 = (*c_2);\n    low = (_e114 * 12.92f);\n    let _e116 = (*c_2);\n    high = ((pow(max(_e116, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e122 = low;\n    let _e123 = high;\n    let _e124 = (*c_2);\n    return mix(_e122, _e123, step(vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f), _e124));\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var v: vec3<f32>;\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e116 = unnamed.uOutputExposure;\n    let _e117 = (*x);\n    (*x) = (_e117 * _e116);\n    let _e119 = (*x);\n    v = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e119);\n    let _e121 = v;\n    let _e122 = v;\n    a = ((_e121 * (_e122 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e128 = v;\n    let _e129 = v;\n    b = ((_e128 * ((_e129 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e136 = a;\n    let _e137 = b;\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * (_e136 / _e137)), vec3(0f), vec3(1f));\n}\n\nfn grade_u0028_vf3_u003b(c_3: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n    var param_1: vec3<f32>;\n\n    let _e115 = unnamed.uOutputTransform;\n    if (_e115 == 0i) {\n        let _e117 = (*c_3);\n        return _e117;\n    }\n    let _e119 = unnamed.uOutputTransform;\n    if (_e119 == 2i) {\n        let _e121 = (*c_3);\n        param = _e121;\n        let _e122 = acesFilmic_u0028_vf3_u003b((&param));\n        (*c_3) = _e122;\n    }\n    let _e123 = (*c_3);\n    param_1 = _e123;\n    let _e124 = linearToSrgb_u0028_vf3_u003b((&param_1));\n    return _e124;\n}\n\nfn withBloom_u0028_vf3_u003b(c_4: ptr<function, vec3<f32>>) -> vec3<f32> {\n    let _e113 = unnamed.uBloomStrength;\n    if (_e113 <= 0f) {\n        let _e115 = (*c_4);\n        return _e115;\n    }\n    let _e116 = (*c_4);\n    let _e117 = vUv_1;\n    let _e118 = textureSampleLevel(uBloom_t, uBloom_s, _e117, 0f);\n    let _e121 = unnamed.uBloomStrength;\n    return (_e116 + (_e118.xyz * _e121));\n}\n\nfn circleOfConfusion_u0028_f1_u003b(viewDepth: ptr<function, f32>) -> f32 {\n    var offPlane: f32;\n\n    let _e113 = (*viewDepth);\n    let _e115 = unnamed.uFocusDistance;\n    let _e119 = unnamed.uFocusRange;\n    offPlane = (abs((_e113 - _e115)) - _e119);\n    let _e121 = offPlane;\n    let _e123 = unnamed.uFocusRange;\n    return clamp((_e121 / _e123), 0f, 1f);\n}\n\nfn viewDepthOf_u0028_vf2_u003b(uv: ptr<function, vec2<f32>>) -> f32 {\n    var z: f32;\n\n    let _e113 = (*uv);\n    let _e114 = textureSampleLevel(uDepth_t, uDepth_s, _e113, 0f);\n    z = (1f - (_e114.x * 2f));\n    let _e120 = unnamed.uDepthToView[0u];\n    let _e121 = z;\n    let _e125 = unnamed.uDepthToView[1u];\n    let _e130 = unnamed.uDepthToView[2u];\n    let _e131 = z;\n    let _e135 = unnamed.uDepthToView[3u];\n    return (-(((_e120 * _e121) + _e125)) / ((_e130 * _e131) + _e135));\n}\n\nfn dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b(direction: ptr<function, vec2<f32>>, radius: ptr<function, f32>, centreDepth: ptr<function, f32>) -> vec4<f32> {\n    var uv_1: vec2<f32>;\n    var depth: f32;\n    var param_2: vec2<f32>;\n    var weight: f32;\n    var local: f32;\n    var param_3: f32;\n\n    let _e120 = vUv_1;\n    let _e121 = (*direction);\n    let _e122 = (*radius);\n    let _e125 = unnamed.uDofAspect;\n    uv_1 = (_e120 + ((_e121 * _e122) * _e125));\n    let _e128 = uv_1;\n    param_2 = _e128;\n    let _e129 = viewDepthOf_u0028_vf2_u003b((&param_2));\n    depth = _e129;\n    let _e130 = depth;\n    let _e131 = (*centreDepth);\n    if (_e130 >= _e131) {\n        local = 1f;\n    } else {\n        let _e133 = depth;\n        param_3 = _e133;\n        let _e134 = circleOfConfusion_u0028_f1_u003b((&param_3));\n        local = _e134;\n    }\n    let _e135 = local;\n    weight = _e135;\n    let _e136 = uv_1;\n    let _e137 = textureSampleLevel(uScene_t, uScene_s, _e136, 0f);\n    let _e139 = weight;\n    let _e140 = (_e137.xyz * _e139);\n    let _e141 = weight;\n    return vec4<f32>(_e140.x, _e140.y, _e140.z, _e141);\n}\n\nfn depthOfField_u0028_vf3_u003b(centre: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_1: f32;\n    var param_4: vec2<f32>;\n    var coc: f32;\n    var param_5: f32;\n    var radius_1: f32;\n    var sum: vec4<f32>;\n    var param_6: vec2<f32>;\n    var param_7: f32;\n    var param_8: f32;\n    var param_9: vec2<f32>;\n    var param_10: f32;\n    var param_11: f32;\n    var param_12: vec2<f32>;\n    var param_13: f32;\n    var param_14: f32;\n    var param_15: vec2<f32>;\n    var param_16: f32;\n    var param_17: f32;\n    var param_18: vec2<f32>;\n    var param_19: f32;\n    var param_20: f32;\n    var param_21: vec2<f32>;\n    var param_22: f32;\n    var param_23: f32;\n    var param_24: vec2<f32>;\n    var param_25: f32;\n    var param_26: f32;\n    var param_27: vec2<f32>;\n    var param_28: f32;\n    var param_29: f32;\n\n    let _e142 = vUv_1;\n    param_4 = _e142;\n    let _e143 = viewDepthOf_u0028_vf2_u003b((&param_4));\n    depth_1 = _e143;\n    let _e144 = depth_1;\n    param_5 = _e144;\n    let _e145 = circleOfConfusion_u0028_f1_u003b((&param_5));\n    coc = _e145;\n    let _e146 = coc;\n    if (_e146 <= 0f) {\n        let _e148 = (*centre);\n        return _e148;\n    }\n    let _e149 = coc;\n    let _e151 = unnamed.uDofStrength;\n    radius_1 = (_e149 * _e151);\n    let _e153 = (*centre);\n    sum = vec4<f32>(_e153.x, _e153.y, _e153.z, 1f);\n    param_6 = vec2<f32>(0.25f, 0f);\n    let _e158 = radius_1;\n    param_7 = _e158;\n    let _e159 = depth_1;\n    param_8 = _e159;\n    let _e160 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_6), (&param_7), (&param_8));\n    let _e161 = sum;\n    sum = (_e161 + _e160);\n    param_9 = vec2<f32>(-0.31929f, 0.292496f);\n    let _e163 = radius_1;\n    param_10 = _e163;\n    let _e164 = depth_1;\n    param_11 = _e164;\n    let _e165 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_9), (&param_10), (&param_11));\n    let _e166 = sum;\n    sum = (_e166 + _e165);\n    param_12 = vec2<f32>(0.048872f, -0.556877f);\n    let _e168 = radius_1;\n    param_13 = _e168;\n    let _e169 = depth_1;\n    param_14 = _e169;\n    let _e170 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_12), (&param_13), (&param_14));\n    let _e171 = sum;\n    sum = (_e171 + _e170);\n    param_15 = vec2<f32>(0.402444f, 0.524918f);\n    let _e173 = radius_1;\n    param_16 = _e173;\n    let _e174 = depth_1;\n    param_17 = _e174;\n    let _e175 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_15), (&param_16), (&param_17));\n    let _e176 = sum;\n    sum = (_e176 + _e175);\n    param_18 = vec2<f32>(-0.738535f, -0.130636f);\n    let _e178 = radius_1;\n    param_19 = _e178;\n    let _e179 = depth_1;\n    param_20 = _e179;\n    let _e180 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_18), (&param_19), (&param_20));\n    let _e181 = sum;\n    sum = (_e181 + _e180);\n    param_21 = vec2<f32>(0.699605f, -0.445031f);\n    let _e183 = radius_1;\n    param_22 = _e183;\n    let _e184 = depth_1;\n    param_23 = _e184;\n    let _e185 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_21), (&param_22), (&param_23));\n    let _e186 = sum;\n    sum = (_e186 + _e185);\n    param_24 = vec2<f32>(-0.234004f, 0.870484f);\n    let _e188 = radius_1;\n    param_25 = _e188;\n    let _e189 = depth_1;\n    param_26 = _e189;\n    let _e190 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_24), (&param_25), (&param_26));\n    let _e191 = sum;\n    sum = (_e191 + _e190);\n    param_27 = vec2<f32>(-0.446271f, -0.859268f);\n    let _e193 = radius_1;\n    param_28 = _e193;\n    let _e194 = depth_1;\n    param_29 = _e194;\n    let _e195 = dofTap_u0028_vf2_u003b_f1_u003b_f1_u003b((&param_27), (&param_28), (&param_29));\n    let _e196 = sum;\n    sum = (_e196 + _e195);\n    let _e198 = sum;\n    let _e201 = sum[3u];\n    return (_e198.xyz / vec3(_e201));\n}\n\nfn cameraBlur_u0028_vf3_u003b(scene: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var depth_2: f32;\n    var clip: vec4<f32>;\n    var previous: vec4<f32>;\n    var wasUv: vec2<f32>;\n    var velocity: vec2<f32>;\n    var distance_: f32;\n    var sum_1: vec3<f32>;\n    var i: i32;\n    var t: f32;\n\n    let _e121 = vUv_1;\n    let _e122 = textureSampleLevel(uDepth_t, uDepth_s, _e121, 0f);\n    depth_2 = _e122.x;\n    let _e124 = vUv_1;\n    let _e127 = ((_e124 * 2f) - vec2(1f));\n    let _e128 = depth_2;\n    clip = vec4<f32>(_e127.x, _e127.y, (1f - (_e128 * 2f)), 1f);\n    let _e135 = unnamed.uReprojection;\n    let _e136 = clip;\n    previous = (_e135 * _e136);\n    let _e139 = previous[3u];\n    if (_e139 <= 0f) {\n        let _e141 = (*scene);\n        return _e141;\n    }\n    let _e142 = previous;\n    let _e145 = previous[3u];\n    wasUv = (((_e142.xy / vec2(_e145)) * 0.5f) + vec2(0.5f));\n    let _e151 = vUv_1;\n    let _e152 = wasUv;\n    let _e155 = unnamed.uMotionStrength;\n    velocity = ((_e151 - _e152) * _e155);\n    let _e157 = velocity;\n    distance_ = length(_e157);\n    let _e159 = distance_;\n    if (_e159 < 0.0001f) {\n        let _e161 = (*scene);\n        return _e161;\n    }\n    let _e162 = distance_;\n    let _e164 = unnamed.uMotionMax;\n    if (_e162 > _e164) {\n        let _e167 = unnamed.uMotionMax;\n        let _e168 = distance_;\n        let _e170 = velocity;\n        velocity = (_e170 * (_e167 / _e168));\n    }\n    let _e172 = (*scene);\n    sum_1 = _e172;\n    i = 1i;\n    loop {\n        let _e173 = i;\n        if (_e173 <= 4i) {\n            let _e175 = i;\n            t = ((f32(_e175) / 4f) * 0.5f);\n            let _e179 = vUv_1;\n            let _e180 = velocity;\n            let _e181 = t;\n            let _e184 = textureSampleLevel(uScene_t, uScene_s, (_e179 + (_e180 * _e181)), 0f);\n            let _e186 = sum_1;\n            sum_1 = (_e186 + _e184.xyz);\n            let _e188 = vUv_1;\n            let _e189 = velocity;\n            let _e190 = t;\n            let _e193 = textureSampleLevel(uScene_t, uScene_s, (_e188 - (_e189 * _e190)), 0f);\n            let _e195 = sum_1;\n            sum_1 = (_e195 + _e193.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e197 = i;\n            i = (_e197 + 1i);\n        }\n    }\n    let _e199 = sum_1;\n    return (_e199 / vec3(9f));\n}\n\nfn main_1() {\n    var scene_1: vec3<f32>;\n    var param_30: vec3<f32>;\n    var param_31: vec3<f32>;\n    var ao: f32;\n    var fromCentre: vec2<f32>;\n    var radius_2: f32;\n    var inner: f32;\n    var edge: f32;\n    var amount: f32;\n    var param_32: vec3<f32>;\n    var param_33: vec3<f32>;\n    var param_34: vec3<f32>;\n    var param_35: vec3<f32>;\n    var step_: vec2<f32>;\n    var sum_2: vec3<f32>;\n    var i_1: i32;\n    var blurred: vec3<f32>;\n    var param_36: vec3<f32>;\n    var param_37: vec3<f32>;\n    var param_38: vec3<f32>;\n    var param_39: vec3<f32>;\n\n    let _e132 = vUv_1;\n    let _e133 = textureSampleLevel(uScene_t, uScene_s, _e132, 0f);\n    scene_1 = _e133.xyz;\n    let _e136 = unnamed.uMotionStrength;\n    if (_e136 > 0f) {\n        let _e138 = scene_1;\n        param_30 = _e138;\n        let _e139 = cameraBlur_u0028_vf3_u003b((&param_30));\n        scene_1 = _e139;\n    }\n    let _e141 = unnamed.uDofStrength;\n    if (_e141 > 0f) {\n        let _e143 = scene_1;\n        param_31 = _e143;\n        let _e144 = depthOfField_u0028_vf3_u003b((&param_31));\n        scene_1 = _e144;\n    }\n    let _e145 = vUv_1;\n    let _e146 = textureSampleLevel(uAo_t, uAo_s, _e145, 0f);\n    let _e149 = unnamed.uAoStrength;\n    ao = mix(1f, _e146.x, _e149);\n    let _e151 = vUv_1;\n    fromCentre = (_e151 - vec2(0.5f));\n    let _e154 = fromCentre;\n    radius_2 = (length((_e154 * vec2<f32>(1f, 0.62f))) * 2f);\n    let _e159 = unnamed.uStrength;\n    inner = mix(0.62f, 0.3f, _e159);\n    let _e161 = inner;\n    let _e162 = radius_2;\n    edge = smoothstep(_e161, 1f, _e162);\n    let _e164 = edge;\n    let _e166 = unnamed.uStrength;\n    amount = (_e164 * _e166);\n    let _e168 = amount;\n    if (_e168 <= 0f) {\n        let _e170 = scene_1;\n        let _e171 = ao;\n        param_32 = (_e170 * _e171);\n        let _e173 = withBloom_u0028_vf3_u003b((&param_32));\n        param_33 = _e173;\n        let _e174 = grade_u0028_vf3_u003b((&param_33));\n        param_34 = _e174;\n        let _e175 = applyColourGrade_u0028_vf3_u003b((&param_34));\n        param_35 = _e175;\n        let _e176 = withVeil_u0028_vf3_u003b((&param_35));\n        fragColor = vec4<f32>(_e176.x, _e176.y, _e176.z, 1f);\n        return;\n    }\n    let _e181 = fromCentre;\n    let _e185 = unnamed.uReach;\n    let _e187 = amount;\n    step_ = ((normalize((_e181 + vec2<f32>(0.000001f, 0.000001f))) * _e185) * _e187);\n    let _e189 = scene_1;\n    sum_2 = _e189;\n    i_1 = 1i;\n    loop {\n        let _e190 = i_1;\n        if (_e190 <= 6i) {\n            let _e192 = vUv_1;\n            let _e193 = step_;\n            let _e194 = i_1;\n            let _e199 = textureSampleLevel(uScene_t, uScene_s, (_e192 + (_e193 * (f32(_e194) / 6f))), 0f);\n            let _e201 = sum_2;\n            sum_2 = (_e201 + _e199.xyz);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e203 = i_1;\n            i_1 = (_e203 + 1i);\n        }\n    }\n    let _e205 = sum_2;\n    blurred = (_e205 / vec3(7f));\n    let _e208 = scene_1;\n    let _e209 = blurred;\n    let _e210 = amount;\n    let _e213 = ao;\n    param_36 = (mix(_e208, _e209, vec3(_e210)) * _e213);\n    let _e215 = withBloom_u0028_vf3_u003b((&param_36));\n    param_37 = _e215;\n    let _e216 = grade_u0028_vf3_u003b((&param_37));\n    param_38 = _e216;\n    let _e217 = applyColourGrade_u0028_vf3_u003b((&param_38));\n    param_39 = _e217;\n    let _e218 = withVeil_u0028_vf3_u003b((&param_39));\n    fragColor = vec4<f32>(_e218.x, _e218.y, _e218.z, 1f);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const RUSH_BINDINGS = {
  "RUSH_FRAG": {
    "uniforms": 1,
    "uniformSize": 160,
    "fields": {
      "uStrength": {
        "offset": 0,
        "size": 4,
        "type": "float"
      },
      "uReach": {
        "offset": 4,
        "size": 4,
        "type": "float"
      },
      "uOutputTransform": {
        "offset": 8,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 12,
        "size": 4,
        "type": "float"
      },
      "uReprojection": {
        "offset": 16,
        "size": 64,
        "type": "mat4"
      },
      "uMotionStrength": {
        "offset": 80,
        "size": 4,
        "type": "float"
      },
      "uMotionMax": {
        "offset": 84,
        "size": 4,
        "type": "float"
      },
      "uAoStrength": {
        "offset": 88,
        "size": 4,
        "type": "float"
      },
      "uBloomStrength": {
        "offset": 92,
        "size": 4,
        "type": "float"
      },
      "uVeilColor": {
        "offset": 96,
        "size": 12,
        "type": "vec3"
      },
      "uVeilAlpha": {
        "offset": 108,
        "size": 4,
        "type": "float"
      },
      "uGradeStrength": {
        "offset": 112,
        "size": 4,
        "type": "float"
      },
      "uGradeSize": {
        "offset": 116,
        "size": 4,
        "type": "float"
      },
      "uFocusDistance": {
        "offset": 120,
        "size": 4,
        "type": "float"
      },
      "uFocusRange": {
        "offset": 124,
        "size": 4,
        "type": "float"
      },
      "uDofStrength": {
        "offset": 128,
        "size": 4,
        "type": "float"
      },
      "uDofAspect": {
        "offset": 136,
        "size": 8,
        "type": "vec2"
      },
      "uDepthToView": {
        "offset": 144,
        "size": 16,
        "type": "vec4"
      }
    },
    "textures": {
      "uScene": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uDepth": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      },
      "uAo": {
        "texture": 36,
        "sampler": 37,
        "type": "sampler2D"
      },
      "uBloom": {
        "texture": 38,
        "sampler": 39,
        "type": "sampler2D"
      },
      "uGradeLut": {
        "texture": 40,
        "sampler": 41,
        "type": "sampler3D"
      }
    }
  }
} as const;
