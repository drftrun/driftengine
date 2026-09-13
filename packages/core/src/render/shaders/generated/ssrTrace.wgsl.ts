/*
 * Generated from ../ssrTrace.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SSR_TRACE_FRAG_WGSL = "struct Uniforms {\n    uSsrDepthToWorld: mat4x4<f32>,\n    uSsrViewProj: mat4x4<f32>,\n    uWorldToSurface: mat4x4<f32>,\n    uSsrEye: vec3<f32>,\n    uSsrAxis: vec3<f32>,\n    uSsrTint: vec3<f32>,\n    uSsrStrength: f32,\n    uSsrFacingCos: f32,\n    uSsrReach: f32,\n    uSsrThickness: f32,\n    uSsrSteps: f32,\n    uSsrEdgeFade: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSsrDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSsrDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(34) \nvar uSsrScene_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uSsrScene_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn worldAt_u0028_vf2_u003b_f1_u003b(uv: ptr<function, vec2<f32>>, stored: ptr<function, f32>) -> vec3<f32> {\n    var world: vec4<f32>;\n\n    let _e40 = unnamed.uSsrDepthToWorld;\n    let _e41 = (*uv);\n    let _e44 = ((_e41 * 2f) - vec2(1f));\n    let _e45 = (*stored);\n    world = (_e40 * vec4<f32>(_e44.x, _e44.y, _e45, 1f));\n    let _e50 = world;\n    let _e53 = world[3u];\n    return (_e50.xyz / vec3(_e53));\n}\n\nfn sceneDistanceAt_u0028_vf2_u003b(uv_1: ptr<function, vec2<f32>>) -> f32 {\n    var stored_1: f32;\n    var param: vec2<f32>;\n    var param_1: f32;\n\n    let _e40 = (*uv_1);\n    let _e41 = textureSampleLevel(uSsrDepth_t, uSsrDepth_s, _e40, 0f);\n    stored_1 = _e41.x;\n    let _e43 = stored_1;\n    if (_e43 <= 0f) {\n        return 1000000000f;\n    }\n    let _e45 = (*uv_1);\n    param = _e45;\n    let _e46 = stored_1;\n    param_1 = _e46;\n    let _e47 = worldAt_u0028_vf2_u003b_f1_u003b((&param), (&param_1));\n    let _e49 = unnamed.uSsrEye;\n    return length((_e47 - _e49));\n}\n\nfn projectPoint_u0028_vf3_u003b_vf2_u003b(point: ptr<function, vec3<f32>>, uv_2: ptr<function, vec2<f32>>) -> bool {\n    var clip: vec4<f32>;\n    var phi_130_: bool;\n    var phi_137_: bool;\n    var phi_143_: bool;\n\n    let _e40 = unnamed.uSsrViewProj;\n    let _e41 = (*point);\n    clip = (_e40 * vec4<f32>(_e41.x, _e41.y, _e41.z, 1f));\n    let _e48 = clip[3u];\n    if (_e48 <= 0f) {\n        return false;\n    }\n    let _e50 = clip;\n    let _e53 = clip[3u];\n    (*uv_2) = (((_e50.xy / vec2(_e53)) * 0.5f) + vec2(0.5f));\n    let _e60 = (*uv_2)[0u];\n    let _e61 = (_e60 >= 0f);\n    phi_130_ = _e61;\n    if _e61 {\n        let _e63 = (*uv_2)[0u];\n        phi_130_ = (_e63 <= 1f);\n    }\n    let _e66 = phi_130_;\n    phi_137_ = _e66;\n    if _e66 {\n        let _e68 = (*uv_2)[1u];\n        phi_137_ = (_e68 >= 0f);\n    }\n    let _e71 = phi_137_;\n    phi_143_ = _e71;\n    if _e71 {\n        let _e73 = (*uv_2)[1u];\n        phi_143_ = (_e73 <= 1f);\n    }\n    let _e76 = phi_143_;\n    return _e76;\n}\n\nfn main_1() {\n    var stored_2: f32;\n    var point_1: vec3<f32>;\n    var param_2: vec2<f32>;\n    var param_3: f32;\n    var plane: vec3<f32>;\n    var span: f32;\n    var normal: vec3<f32>;\n    var local: vec3<f32>;\n    var toEye: vec3<f32>;\n    var box: vec3<f32>;\n    var inside: vec3<f32>;\n    var mask: f32;\n    var facing: f32;\n    var found: vec3<f32>;\n    var weight: f32;\n    var view: vec3<f32>;\n    var ray: vec3<f32>;\n    var steps: f32;\n    var behind: f32;\n    var previous: f32;\n    var hitUv: vec2<f32>;\n    var hitDistance: f32;\n    var found_hit: bool;\n    var i: i32;\n    var at: f32;\n    var t: f32;\n    var sample_point: vec3<f32>;\n    var uv_3: vec2<f32>;\n    var param_4: vec3<f32>;\n    var param_5: vec2<f32>;\n    var scene: f32;\n    var param_6: vec2<f32>;\n    var gap: f32;\n    var near: f32;\n    var far: f32;\n    var refinedUv: vec2<f32>;\n    var refinedGap: f32;\n    var refine: i32;\n    var mid: f32;\n    var midPoint: vec3<f32>;\n    var midUv: vec2<f32>;\n    var param_7: vec3<f32>;\n    var param_8: vec2<f32>;\n    var midScene: f32;\n    var param_9: vec2<f32>;\n    var midGap: f32;\n    var edge: f32;\n    var away: f32;\n    var reach: f32;\n\n    let _e85 = vUv_1;\n    let _e86 = textureSampleLevel(uSsrDepth_t, uSsrDepth_s, _e85, 0f);\n    stored_2 = _e86.x;\n    let _e88 = vUv_1;\n    param_2 = _e88;\n    let _e89 = stored_2;\n    param_3 = _e89;\n    let _e90 = worldAt_u0028_vf2_u003b_f1_u003b((&param_2), (&param_3));\n    point_1 = _e90;\n    let _e91 = point_1;\n    let _e92 = dpdx(_e91);\n    let _e93 = point_1;\n    let _e94 = dpdy(_e93);\n    plane = cross(_e92, _e94);\n    let _e96 = plane;\n    span = length(_e96);\n    let _e98 = span;\n    if (_e98 > 0f) {\n        let _e100 = plane;\n        let _e101 = span;\n        local = (_e100 / vec3(_e101));\n    } else {\n        let _e105 = unnamed.uSsrAxis;\n        local = -(_e105);\n    }\n    let _e107 = local;\n    normal = _e107;\n    let _e109 = unnamed.uSsrEye;\n    let _e110 = point_1;\n    toEye = (_e109 - _e110);\n    let _e112 = toEye;\n    let _e113 = normal;\n    let _e116 = normal;\n    normal = (_e116 * sign(dot(_e112, _e113)));\n    let _e119 = unnamed.uWorldToSurface;\n    let _e120 = point_1;\n    box = (_e119 * vec4<f32>(_e120.x, _e120.y, _e120.z, 1f)).xyz;\n    let _e127 = box;\n    inside = step(abs(_e127), vec3<f32>(1f, 1f, 1f));\n    let _e131 = inside[0u];\n    let _e133 = inside[1u];\n    let _e136 = inside[2u];\n    mask = ((_e131 * _e133) * _e136);\n    let _e138 = normal;\n    let _e140 = unnamed.uSsrAxis;\n    facing = dot(_e138, -(_e140));\n    let _e144 = unnamed.uSsrFacingCos;\n    let _e146 = unnamed.uSsrFacingCos;\n    let _e149 = facing;\n    let _e151 = mask;\n    mask = (_e151 * smoothstep(_e144, min(1f, (_e146 + 0.25f)), _e149));\n    let _e153 = stored_2;\n    let _e156 = mask;\n    mask = (_e156 * select(1f, 0f, (_e153 <= 0f)));\n    let _e159 = unnamed.uSsrStrength;\n    let _e160 = mask;\n    mask = (_e160 * _e159);\n    found = vec3<f32>(0f, 0f, 0f);\n    weight = 0f;\n    let _e162 = mask;\n    if (_e162 > 0f) {\n        let _e164 = point_1;\n        let _e166 = unnamed.uSsrEye;\n        view = normalize((_e164 - _e166));\n        let _e169 = view;\n        let _e170 = normal;\n        ray = reflect(_e169, _e170);\n        let _e173 = unnamed.uSsrSteps;\n        steps = max(1f, _e173);\n        behind = 0f;\n        previous = 0f;\n        hitUv = vec2<f32>(0f, 0f);\n        hitDistance = 0f;\n        found_hit = false;\n        i = 1i;\n        loop {\n            let _e175 = i;\n            if (_e175 <= 32i) {\n                let _e177 = i;\n                let _e179 = steps;\n                if (f32(_e177) > _e179) {\n                    break;\n                }\n                let _e181 = i;\n                let _e183 = steps;\n                at = (f32(_e181) / _e183);\n                let _e186 = unnamed.uSsrReach;\n                let _e187 = at;\n                let _e189 = at;\n                t = ((_e186 * _e187) * _e189);\n                let _e191 = point_1;\n                let _e192 = ray;\n                let _e193 = t;\n                sample_point = (_e191 + (_e192 * _e193));\n                let _e196 = sample_point;\n                param_4 = _e196;\n                let _e197 = projectPoint_u0028_vf3_u003b_vf2_u003b((&param_4), (&param_5));\n                let _e198 = param_5;\n                uv_3 = _e198;\n                if !(_e197) {\n                    break;\n                }\n                let _e200 = uv_3;\n                param_6 = _e200;\n                let _e201 = sceneDistanceAt_u0028_vf2_u003b((&param_6));\n                scene = _e201;\n                let _e202 = sample_point;\n                let _e204 = unnamed.uSsrEye;\n                let _e207 = scene;\n                gap = (length((_e202 - _e204)) - _e207);\n                let _e209 = behind;\n                let _e211 = gap;\n                if ((_e209 < 0f) && (_e211 >= 0f)) {\n                    let _e214 = previous;\n                    near = _e214;\n                    let _e215 = t;\n                    far = _e215;\n                    let _e216 = uv_3;\n                    refinedUv = _e216;\n                    let _e217 = gap;\n                    refinedGap = _e217;\n                    refine = 0i;\n                    loop {\n                        let _e218 = refine;\n                        if (_e218 < 6i) {\n                            let _e220 = near;\n                            let _e221 = far;\n                            mid = ((_e220 + _e221) * 0.5f);\n                            let _e224 = point_1;\n                            let _e225 = ray;\n                            let _e226 = mid;\n                            midPoint = (_e224 + (_e225 * _e226));\n                            let _e229 = midPoint;\n                            param_7 = _e229;\n                            let _e230 = projectPoint_u0028_vf3_u003b_vf2_u003b((&param_7), (&param_8));\n                            let _e231 = param_8;\n                            midUv = _e231;\n                            if !(_e230) {\n                                break;\n                            }\n                            let _e233 = midUv;\n                            param_9 = _e233;\n                            let _e234 = sceneDistanceAt_u0028_vf2_u003b((&param_9));\n                            midScene = _e234;\n                            let _e235 = midPoint;\n                            let _e237 = unnamed.uSsrEye;\n                            let _e240 = midScene;\n                            midGap = (length((_e235 - _e237)) - _e240);\n                            let _e242 = midGap;\n                            if (_e242 >= 0f) {\n                                let _e244 = mid;\n                                far = _e244;\n                                let _e245 = midUv;\n                                refinedUv = _e245;\n                                let _e246 = midGap;\n                                refinedGap = _e246;\n                            } else {\n                                let _e247 = mid;\n                                near = _e247;\n                            }\n                            continue;\n                        } else {\n                            break;\n                        }\n                        continuing {\n                            let _e248 = refine;\n                            refine = (_e248 + 1i);\n                        }\n                    }\n                    let _e250 = refinedGap;\n                    let _e252 = unnamed.uSsrThickness;\n                    if (_e250 <= _e252) {\n                        found_hit = true;\n                        let _e254 = refinedUv;\n                        hitUv = _e254;\n                        let _e255 = far;\n                        hitDistance = _e255;\n                    }\n                    break;\n                }\n                let _e256 = gap;\n                behind = _e256;\n                let _e257 = t;\n                previous = _e257;\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e258 = i;\n                i = (_e258 + 1i);\n            }\n        }\n        let _e260 = found_hit;\n        if _e260 {\n            let _e262 = hitUv[0u];\n            let _e264 = hitUv[0u];\n            let _e268 = hitUv[1u];\n            let _e270 = hitUv[1u];\n            let _e275 = unnamed.uSsrEdgeFade;\n            edge = clamp((min(min(_e262, (1f - _e264)), min(_e268, (1f - _e270))) / max(_e275, 0.0001f)), 0f, 1f);\n            let _e279 = ray;\n            let _e281 = view;\n            away = clamp(((dot(normalize(_e279), _e281) + 1f) * 0.5f), 0f, 1f);\n            let _e286 = hitDistance;\n            let _e288 = unnamed.uSsrReach;\n            reach = (1f - clamp((_e286 / max(_e288, 0.0001f)), 0f, 1f));\n            let _e293 = mask;\n            let _e294 = edge;\n            let _e296 = away;\n            let _e298 = reach;\n            weight = (((_e293 * _e294) * _e296) * _e298);\n            let _e300 = hitUv;\n            let _e301 = textureSampleLevel(uSsrScene_t, uSsrScene_s, _e300, 0f);\n            let _e304 = unnamed.uSsrTint;\n            found = (_e301.xyz * _e304);\n        }\n    }\n    let _e306 = found;\n    let _e307 = weight;\n    let _e308 = (_e306 * _e307);\n    let _e309 = weight;\n    fragColor = vec4<f32>(_e308.x, _e308.y, _e308.z, _e309);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SSRTRACE_BINDINGS = {
  "SSR_TRACE_FRAG": {
    "uniforms": 1,
    "uniformSize": 272,
    "fields": {
      "uSsrDepthToWorld": {
        "offset": 0,
        "size": 64,
        "type": "mat4"
      },
      "uSsrViewProj": {
        "offset": 64,
        "size": 64,
        "type": "mat4"
      },
      "uWorldToSurface": {
        "offset": 128,
        "size": 64,
        "type": "mat4"
      },
      "uSsrEye": {
        "offset": 192,
        "size": 12,
        "type": "vec3"
      },
      "uSsrAxis": {
        "offset": 208,
        "size": 12,
        "type": "vec3"
      },
      "uSsrTint": {
        "offset": 224,
        "size": 12,
        "type": "vec3"
      },
      "uSsrStrength": {
        "offset": 236,
        "size": 4,
        "type": "float"
      },
      "uSsrFacingCos": {
        "offset": 240,
        "size": 4,
        "type": "float"
      },
      "uSsrReach": {
        "offset": 244,
        "size": 4,
        "type": "float"
      },
      "uSsrThickness": {
        "offset": 248,
        "size": 4,
        "type": "float"
      },
      "uSsrSteps": {
        "offset": 252,
        "size": 4,
        "type": "float"
      },
      "uSsrEdgeFade": {
        "offset": 256,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {
      "uSsrDepth": {
        "texture": 32,
        "sampler": 33,
        "type": "sampler2D"
      },
      "uSsrScene": {
        "texture": 34,
        "sampler": 35,
        "type": "sampler2D"
      }
    }
  }
} as const;
