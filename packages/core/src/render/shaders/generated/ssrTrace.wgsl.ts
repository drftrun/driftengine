/*
 * Generated from ../ssrTrace.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SSR_TRACE_FRAG_WGSL = "struct Uniforms {\n    uSsrDepthToWorld: mat4x4<f32>,\n    uSsrViewProj: mat4x4<f32>,\n    uWorldToSurface: mat4x4<f32>,\n    uSsrEye: vec3<f32>,\n    uSsrAxis: vec3<f32>,\n    uSsrTint: vec3<f32>,\n    uSsrStrength: f32,\n    uSsrFresnel: vec2<f32>,\n    uSsrFacingCos: f32,\n    uSsrReach: f32,\n    uSsrThickness: f32,\n    uSsrSteps: f32,\n    uSsrEdgeFade: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSsrDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSsrDepth_s: sampler;\nvar<private> vUv_1: vec2<f32>;\n@group(0) @binding(34) \nvar uSsrScene_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uSsrScene_s: sampler;\nvar<private> fragColor: vec4<f32>;\n\nfn worldAt_u0028_vf2_u003b_f1_u003b(uv: ptr<function, vec2<f32>>, stored: ptr<function, f32>) -> vec3<f32> {\n    var world: vec4<f32>;\n\n    let _e53 = unnamed.uSsrDepthToWorld;\n    let _e54 = (*uv);\n    let _e57 = ((_e54 * 2f) - vec2(1f));\n    let _e58 = (*stored);\n    world = (_e53 * vec4<f32>(_e57.x, _e57.y, _e58, 1f));\n    let _e63 = world;\n    let _e66 = world[3u];\n    return (_e63.xyz / vec3(_e66));\n}\n\nfn sceneDistanceAt_u0028_vf2_u003b(uv_1: ptr<function, vec2<f32>>) -> f32 {\n    var stored_1: f32;\n    var param: vec2<f32>;\n    var param_1: f32;\n\n    let _e53 = (*uv_1);\n    let _e54 = textureSampleLevel(uSsrDepth_t, uSsrDepth_s, _e53, 0f);\n    stored_1 = _e54.x;\n    let _e56 = stored_1;\n    if (_e56 <= 0f) {\n        return 1000000000f;\n    }\n    let _e58 = (*uv_1);\n    param = _e58;\n    let _e59 = stored_1;\n    param_1 = _e59;\n    let _e60 = worldAt_u0028_vf2_u003b_f1_u003b((&param), (&param_1));\n    let _e62 = unnamed.uSsrEye;\n    return length((_e60 - _e62));\n}\n\nfn projectPoint_u0028_vf3_u003b_vf2_u003b(point: ptr<function, vec3<f32>>, uv_2: ptr<function, vec2<f32>>) -> bool {\n    var clip: vec4<f32>;\n    var phi_175_: bool;\n    var phi_181_: bool;\n    var phi_187_: bool;\n\n    let _e53 = unnamed.uSsrViewProj;\n    let _e54 = (*point);\n    clip = (_e53 * vec4<f32>(_e54.x, _e54.y, _e54.z, 1f));\n    let _e61 = clip[3u];\n    if (_e61 <= 0f) {\n        return false;\n    }\n    let _e63 = clip;\n    let _e66 = clip[3u];\n    (*uv_2) = (((_e63.xy / vec2(_e66)) * 0.5f) + vec2(0.5f));\n    let _e73 = (*uv_2)[0u];\n    let _e74 = (_e73 >= 0f);\n    phi_175_ = _e74;\n    if _e74 {\n        let _e76 = (*uv_2)[0u];\n        phi_175_ = (_e76 <= 1f);\n    }\n    let _e79 = phi_175_;\n    phi_181_ = _e79;\n    if _e79 {\n        let _e81 = (*uv_2)[1u];\n        phi_181_ = (_e81 >= 0f);\n    }\n    let _e84 = phi_181_;\n    phi_187_ = _e84;\n    if _e84 {\n        let _e86 = (*uv_2)[1u];\n        phi_187_ = (_e86 <= 1f);\n    }\n    let _e89 = phi_187_;\n    return _e89;\n}\n\nfn envBrdfApprox_u0028_f1_u003b_f1_u003b(ndv: ptr<function, f32>, roughness: ptr<function, f32>) -> vec2<f32> {\n    var r: vec4<f32>;\n    var a004_: f32;\n\n    let _e53 = (*roughness);\n    r = ((vec4<f32>(-1f, -0.0275f, -0.572f, 0.022f) * _e53) + vec4<f32>(1f, 0.0425f, 1.04f, -0.04f));\n    let _e57 = r[0u];\n    let _e59 = r[0u];\n    let _e61 = (*ndv);\n    let _e66 = r[0u];\n    let _e69 = r[1u];\n    a004_ = ((min((_e57 * _e59), exp2((-9.28f * _e61))) * _e66) + _e69);\n    let _e71 = a004_;\n    let _e73 = r;\n    return ((vec2<f32>(-1.04f, 1.04f) * _e71) + _e73.zw);\n}\n\nfn main_1() {\n    var stored_2: f32;\n    var point_1: vec3<f32>;\n    var param_2: vec2<f32>;\n    var param_3: f32;\n    var plane: vec3<f32>;\n    var span: f32;\n    var normal: vec3<f32>;\n    var local: vec3<f32>;\n    var toEye: vec3<f32>;\n    var box: vec3<f32>;\n    var inside: vec3<f32>;\n    var mask: f32;\n    var facing: f32;\n    var returned: f32;\n    var dfg: vec2<f32>;\n    var param_4: f32;\n    var param_5: f32;\n    var found: vec3<f32>;\n    var weight: f32;\n    var view: vec3<f32>;\n    var ray: vec3<f32>;\n    var steps: f32;\n    var behind: f32;\n    var previous: f32;\n    var hitUv: vec2<f32>;\n    var hitDistance: f32;\n    var found_hit: bool;\n    var i: i32;\n    var at: f32;\n    var t: f32;\n    var sample_point: vec3<f32>;\n    var uv_3: vec2<f32>;\n    var param_6: vec3<f32>;\n    var param_7: vec2<f32>;\n    var scene: f32;\n    var param_8: vec2<f32>;\n    var gap: f32;\n    var near: f32;\n    var far: f32;\n    var refinedUv: vec2<f32>;\n    var refinedGap: f32;\n    var refine: i32;\n    var mid: f32;\n    var midPoint: vec3<f32>;\n    var midUv: vec2<f32>;\n    var param_9: vec3<f32>;\n    var param_10: vec2<f32>;\n    var midScene: f32;\n    var param_11: vec2<f32>;\n    var midGap: f32;\n    var edge: f32;\n    var away: f32;\n    var reach: f32;\n\n    let _e102 = vUv_1;\n    let _e103 = textureSampleLevel(uSsrDepth_t, uSsrDepth_s, _e102, 0f);\n    stored_2 = _e103.x;\n    let _e105 = vUv_1;\n    param_2 = _e105;\n    let _e106 = stored_2;\n    param_3 = _e106;\n    let _e107 = worldAt_u0028_vf2_u003b_f1_u003b((&param_2), (&param_3));\n    point_1 = _e107;\n    let _e108 = point_1;\n    let _e109 = dpdx(_e108);\n    let _e110 = point_1;\n    let _e111 = dpdy(_e110);\n    plane = cross(_e109, _e111);\n    let _e113 = plane;\n    span = length(_e113);\n    let _e115 = span;\n    if (_e115 > 0f) {\n        let _e117 = plane;\n        let _e118 = span;\n        local = (_e117 / vec3(_e118));\n    } else {\n        let _e122 = unnamed.uSsrAxis;\n        local = -(_e122);\n    }\n    let _e124 = local;\n    normal = _e124;\n    let _e126 = unnamed.uSsrEye;\n    let _e127 = point_1;\n    toEye = (_e126 - _e127);\n    let _e129 = toEye;\n    let _e130 = normal;\n    let _e133 = normal;\n    normal = (_e133 * sign(dot(_e129, _e130)));\n    let _e136 = unnamed.uWorldToSurface;\n    let _e137 = point_1;\n    box = (_e136 * vec4<f32>(_e137.x, _e137.y, _e137.z, 1f)).xyz;\n    let _e144 = box;\n    inside = step(abs(_e144), vec3<f32>(1f, 1f, 1f));\n    let _e148 = inside[0u];\n    let _e150 = inside[1u];\n    let _e153 = inside[2u];\n    mask = ((_e148 * _e150) * _e153);\n    let _e155 = normal;\n    let _e157 = unnamed.uSsrAxis;\n    facing = dot(_e155, -(_e157));\n    let _e161 = unnamed.uSsrFacingCos;\n    let _e163 = unnamed.uSsrFacingCos;\n    let _e166 = facing;\n    let _e168 = mask;\n    mask = (_e168 * smoothstep(_e161, min(1f, (_e163 + 0.25f)), _e166));\n    let _e170 = stored_2;\n    let _e173 = mask;\n    mask = (_e173 * select(1f, 0f, (_e170 <= 0f)));\n    let _e176 = unnamed.uSsrStrength;\n    returned = _e176;\n    let _e179 = unnamed.uSsrFresnel[0u];\n    if (_e179 > 0.5f) {\n        let _e181 = normal;\n        let _e182 = toEye;\n        param_4 = clamp(dot(_e181, normalize(_e182)), 0f, 1f);\n        let _e188 = unnamed.uSsrFresnel[1u];\n        param_5 = _e188;\n        let _e189 = envBrdfApprox_u0028_f1_u003b_f1_u003b((&param_4), (&param_5));\n        dfg = _e189;\n        let _e191 = unnamed.uSsrStrength;\n        let _e193 = dfg[0u];\n        let _e196 = dfg[1u];\n        returned = clamp(((_e191 * _e193) + _e196), 0f, 1f);\n    }\n    let _e199 = returned;\n    let _e200 = mask;\n    mask = (_e200 * _e199);\n    found = vec3<f32>(0f, 0f, 0f);\n    weight = 0f;\n    let _e202 = mask;\n    if (_e202 > 0f) {\n        let _e204 = point_1;\n        let _e206 = unnamed.uSsrEye;\n        view = normalize((_e204 - _e206));\n        let _e209 = view;\n        let _e210 = normal;\n        ray = reflect(_e209, _e210);\n        let _e213 = unnamed.uSsrSteps;\n        steps = max(1f, _e213);\n        behind = 0f;\n        previous = 0f;\n        hitUv = vec2<f32>(0f, 0f);\n        hitDistance = 0f;\n        found_hit = false;\n        i = 1i;\n        loop {\n            let _e215 = i;\n            if (_e215 <= 32i) {\n                let _e217 = i;\n                let _e219 = steps;\n                if (f32(_e217) > _e219) {\n                    break;\n                }\n                let _e221 = i;\n                let _e223 = steps;\n                at = (f32(_e221) / _e223);\n                let _e226 = unnamed.uSsrReach;\n                let _e227 = at;\n                let _e229 = at;\n                t = ((_e226 * _e227) * _e229);\n                let _e231 = point_1;\n                let _e232 = ray;\n                let _e233 = t;\n                sample_point = (_e231 + (_e232 * _e233));\n                let _e236 = sample_point;\n                param_6 = _e236;\n                let _e237 = projectPoint_u0028_vf3_u003b_vf2_u003b((&param_6), (&param_7));\n                let _e238 = param_7;\n                uv_3 = _e238;\n                if !(_e237) {\n                    break;\n                }\n                let _e240 = uv_3;\n                param_8 = _e240;\n                let _e241 = sceneDistanceAt_u0028_vf2_u003b((&param_8));\n                scene = _e241;\n                let _e242 = sample_point;\n                let _e244 = unnamed.uSsrEye;\n                let _e247 = scene;\n                gap = (length((_e242 - _e244)) - _e247);\n                let _e249 = behind;\n                let _e251 = gap;\n                if ((_e249 < 0f) && (_e251 >= 0f)) {\n                    let _e254 = previous;\n                    near = _e254;\n                    let _e255 = t;\n                    far = _e255;\n                    let _e256 = uv_3;\n                    refinedUv = _e256;\n                    let _e257 = gap;\n                    refinedGap = _e257;\n                    refine = 0i;\n                    loop {\n                        let _e258 = refine;\n                        if (_e258 < 6i) {\n                            let _e260 = near;\n                            let _e261 = far;\n                            mid = ((_e260 + _e261) * 0.5f);\n                            let _e264 = point_1;\n                            let _e265 = ray;\n                            let _e266 = mid;\n                            midPoint = (_e264 + (_e265 * _e266));\n                            let _e269 = midPoint;\n                            param_9 = _e269;\n                            let _e270 = projectPoint_u0028_vf3_u003b_vf2_u003b((&param_9), (&param_10));\n                            let _e271 = param_10;\n                            midUv = _e271;\n                            if !(_e270) {\n                                break;\n                            }\n                            let _e273 = midUv;\n                            param_11 = _e273;\n                            let _e274 = sceneDistanceAt_u0028_vf2_u003b((&param_11));\n                            midScene = _e274;\n                            let _e275 = midPoint;\n                            let _e277 = unnamed.uSsrEye;\n                            let _e280 = midScene;\n                            midGap = (length((_e275 - _e277)) - _e280);\n                            let _e282 = midGap;\n                            if (_e282 >= 0f) {\n                                let _e284 = mid;\n                                far = _e284;\n                                let _e285 = midUv;\n                                refinedUv = _e285;\n                                let _e286 = midGap;\n                                refinedGap = _e286;\n                            } else {\n                                let _e287 = mid;\n                                near = _e287;\n                            }\n                            continue;\n                        } else {\n                            break;\n                        }\n                        continuing {\n                            let _e288 = refine;\n                            refine = (_e288 + 1i);\n                        }\n                    }\n                    let _e290 = refinedGap;\n                    let _e292 = unnamed.uSsrThickness;\n                    if (_e290 <= _e292) {\n                        found_hit = true;\n                        let _e294 = refinedUv;\n                        hitUv = _e294;\n                        let _e295 = far;\n                        hitDistance = _e295;\n                    }\n                    break;\n                }\n                let _e296 = gap;\n                behind = _e296;\n                let _e297 = t;\n                previous = _e297;\n                continue;\n            } else {\n                break;\n            }\n            continuing {\n                let _e298 = i;\n                i = (_e298 + 1i);\n            }\n        }\n        let _e300 = found_hit;\n        if _e300 {\n            let _e302 = hitUv[0u];\n            let _e304 = hitUv[0u];\n            let _e308 = hitUv[1u];\n            let _e310 = hitUv[1u];\n            let _e315 = unnamed.uSsrEdgeFade;\n            edge = clamp((min(min(_e302, (1f - _e304)), min(_e308, (1f - _e310))) / max(_e315, 0.0001f)), 0f, 1f);\n            let _e319 = ray;\n            let _e321 = view;\n            away = clamp(((dot(normalize(_e319), _e321) + 1f) * 0.5f), 0f, 1f);\n            let _e326 = hitDistance;\n            let _e328 = unnamed.uSsrReach;\n            reach = (1f - clamp((_e326 / max(_e328, 0.0001f)), 0f, 1f));\n            let _e333 = mask;\n            let _e334 = edge;\n            let _e336 = away;\n            let _e338 = reach;\n            weight = (((_e333 * _e334) * _e336) * _e338);\n            let _e340 = hitUv;\n            let _e341 = textureSampleLevel(uSsrScene_t, uSsrScene_s, _e340, 0f);\n            let _e344 = unnamed.uSsrTint;\n            found = (_e341.xyz * _e344);\n        }\n    }\n    let _e346 = found;\n    let _e347 = weight;\n    let _e348 = (_e346 * _e347);\n    let _e349 = weight;\n    fragColor = vec4<f32>(_e348.x, _e348.y, _e348.z, _e349);\n    return;\n}\n\n@fragment \nfn main(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {\n    vUv_1 = vUv;\n    main_1();\n    let _e3 = fragColor;\n    return _e3;\n}\n";

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
      "uSsrFresnel": {
        "offset": 240,
        "size": 8,
        "type": "vec2"
      },
      "uSsrFacingCos": {
        "offset": 248,
        "size": 4,
        "type": "float"
      },
      "uSsrReach": {
        "offset": 252,
        "size": 4,
        "type": "float"
      },
      "uSsrThickness": {
        "offset": 256,
        "size": 4,
        "type": "float"
      },
      "uSsrSteps": {
        "offset": 260,
        "size": 4,
        "type": "float"
      },
      "uSsrEdgeFade": {
        "offset": 264,
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
