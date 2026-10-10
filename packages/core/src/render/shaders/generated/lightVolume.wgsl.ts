/*
 * Generated from ../lightVolume.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const LIGHT_VOLUME_VERT_WGSL = "struct Uniforms {\n    uViewProj: mat4x4<f32>,\n    uModel: mat4x4<f32>,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @location(3) member: vec3<f32>,\n    @location(4) member_1: vec3<f32>,\n    @location(2) member_2: vec3<f32>,\n    @location(0) member_3: vec3<f32>,\n    @location(1) member_4: f32,\n    @builtin(position) gl_Position: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\nvar<private> aPosition_1: vec3<f32>;\nvar<private> vWorldPos: vec3<f32>;\nvar<private> vLocal: vec3<f32>;\nvar<private> vNormal: vec3<f32>;\nvar<private> aNormal_1: vec3<f32>;\nvar<private> vColor: vec3<f32>;\nvar<private> aColor_1: vec3<f32>;\nvar<private> vEnergy: f32;\nvar<private> aEmissive_1: f32;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\n\nfn main_1() {\n    var world: vec4<f32>;\n\n    let _e16 = unnamed.uModel;\n    let _e17 = aPosition_1;\n    world = (_e16 * vec4<f32>(_e17.x, _e17.y, _e17.z, 1f));\n    let _e23 = world;\n    vWorldPos = _e23.xyz;\n    let _e25 = aPosition_1;\n    vLocal = _e25;\n    let _e27 = unnamed.uModel;\n    let _e35 = aNormal_1;\n    vNormal = (mat3x3<f32>(_e27[0].xyz, _e27[1].xyz, _e27[2].xyz) * _e35);\n    let _e37 = aColor_1;\n    vColor = _e37;\n    let _e38 = aEmissive_1;\n    vEnergy = _e38;\n    let _e40 = unnamed.uViewProj;\n    let _e41 = world;\n    unnamed_1.gl_Position = (_e40 * _e41);\n    return;\n}\n\n@vertex \nfn main(@location(0) aPosition: vec3<f32>, @location(1) aNormal: vec3<f32>, @location(2) aColor: vec3<f32>, @location(3) aEmissive: f32) -> VertexOutput {\n    aPosition_1 = aPosition;\n    aNormal_1 = aNormal;\n    aColor_1 = aColor;\n    aEmissive_1 = aEmissive;\n    main_1();\n    let _e16 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e16);\n    let _e18 = vWorldPos;\n    let _e19 = vLocal;\n    let _e20 = vNormal;\n    let _e21 = vColor;\n    let _e22 = vEnergy;\n    let _e23 = unnamed_1.gl_Position;\n    return VertexOutput(_e18, _e19, _e20, _e21, _e22, _e23);\n}\n";

/** Every distinct top-level item of the permutations below, once. See `wgsl/share.mjs`. */
const PARTS: readonly string[] = ["struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uStrength: f32,\n    uLength: f32,\n    uSpread: f32,\n    uDust: f32,\n    uDustScale: f32,\n    uDustOffset: vec3<f32>,\n    uNear: f32,\n    uCameraLocal: vec3<f32>,\n    uModelWorld: mat4x4<f32>,\n    uSamples: i32,\n    uSceneDepthEnabled: i32,\n    uInvViewport: vec2<f32>,\n    uDepthToLocal: mat4x4<f32>,\n}","@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vLocal_1: vec3<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(32) \nvar uSceneDepth_t: texture_2d<f32>;\n@group(0) @binding(33) \nvar uSceneDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vEnergy_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;","fn hash31_u0028_vf3_u003b(_l0: ptr<function, vec3<f32>>) -> f32 {\n    let _e0 = (*_l0);\n    return fract((sin(dot(_e0, vec3<f32>(127.1f, 311.7f, 74.7f))) * 43758.547f));\n}","fn volumeNoise_u0028_vf3_u003b(_l0: ptr<function, vec3<f32>>) -> f32 {\n    var _l1: vec3<f32>;\n    var _l2: vec3<f32>;\n    var _l3: vec3<f32>;\n    var _l4: f32;\n    var _l5: vec3<f32>;\n    var _l6: vec3<f32>;\n    var _l7: f32;\n    var _l8: vec3<f32>;\n    var _l9: vec3<f32>;\n    var _l10: f32;\n    var _l11: vec3<f32>;\n    var _l12: vec3<f32>;\n    var _l13: f32;\n    var _l14: vec3<f32>;\n    var _l15: vec3<f32>;\n\n    let _e0 = (*_l0);\n    _l1 = floor(_e0);\n    let _e1 = (*_l0);\n    _l2 = fract(_e1);\n    let _e2 = _l2;\n    let _e3 = _l2;\n    let _e4 = _l2;\n    _l3 = ((_e2 * _e3) * (vec3(3f) - (_e4 * 2f)));\n    let _e5 = _l1;\n    _l5 = (_e5 + vec3<f32>(0f, 0f, 0f));\n    let _e6 = hash31_u0028_vf3_u003b((&_l5));\n    let _e7 = _l1;\n    _l6 = (_e7 + vec3<f32>(1f, 0f, 0f));\n    let _e8 = hash31_u0028_vf3_u003b((&_l6));\n    let _e9 = _l3[0u];\n    _l4 = mix(_e6, _e8, _e9);\n    let _e10 = _l1;\n    _l8 = (_e10 + vec3<f32>(0f, 1f, 0f));\n    let _e11 = hash31_u0028_vf3_u003b((&_l8));\n    let _e12 = _l1;\n    _l9 = (_e12 + vec3<f32>(1f, 1f, 0f));\n    let _e13 = hash31_u0028_vf3_u003b((&_l9));\n    let _e14 = _l3[0u];\n    _l7 = mix(_e11, _e13, _e14);\n    let _e15 = _l1;\n    _l11 = (_e15 + vec3<f32>(0f, 0f, 1f));\n    let _e16 = hash31_u0028_vf3_u003b((&_l11));\n    let _e17 = _l1;\n    _l12 = (_e17 + vec3<f32>(1f, 0f, 1f));\n    let _e18 = hash31_u0028_vf3_u003b((&_l12));\n    let _e19 = _l3[0u];\n    _l10 = mix(_e16, _e18, _e19);\n    let _e20 = _l1;\n    _l14 = (_e20 + vec3<f32>(0f, 1f, 1f));\n    let _e21 = hash31_u0028_vf3_u003b((&_l14));\n    let _e22 = _l1;\n    _l15 = (_e22 + vec3<f32>(1f, 1f, 1f));\n    let _e23 = hash31_u0028_vf3_u003b((&_l15));\n    let _e24 = _l3[0u];\n    _l13 = mix(_e21, _e23, _e24);\n    let _e25 = _l4;\n    let _e26 = _l7;\n    let _e27 = _l3[1u];\n    let _e28 = _l10;\n    let _e29 = _l13;\n    let _e30 = _l3[1u];\n    let _e31 = _l3[2u];\n    return mix(mix(_e25, _e26, _e27), mix(_e28, _e29, _e30), _e31);\n}","fn dustField_u0028_vf3_u003b(_l0: ptr<function, vec3<f32>>) -> f32 {\n    var _l1: vec3<f32>;\n    var _l2: vec3<f32>;\n\n    let _e0 = (*_l0);\n    _l1 = _e0;\n    let _e1 = volumeNoise_u0028_vf3_u003b((&_l1));\n    let _e2 = (*_l0);\n    _l2 = ((_e2 * 2.17f) + vec3(19.3f));\n    let _e3 = volumeNoise_u0028_vf3_u003b((&_l2));\n    return ((_e1 * 0.65f) + (_e3 * 0.35f));\n}","fn densityAt_u0028_vf3_u003b_f1_u003b(_l0: ptr<function, vec3<f32>>, _l1: ptr<function, f32>) -> f32 {\n    var _l2: f32;\n    var _l3: f32;\n    var _l4: f32;\n    var _l5: f32;\n\n    let _e0 = unnamed.uLength;\n    let _e1 = (*_l1);\n    _l2 = max((_e0 - _e1), 0.0001f);\n    let _e2 = (*_l0)[2u];\n    let _e3 = (*_l1);\n    let _e4 = _l2;\n    _l3 = clamp(((_e2 - _e3) / _e4), 0f, 1f);\n    let _e5 = (*_l0);\n    let _e6 = (*_l0)[2u];\n    _l4 = (length(_e5.xy) / max(_e6, 0.001f));\n    let _e7 = _l4;\n    let _e8 = unnamed.uSpread;\n    _l5 = clamp((_e7 / max(_e8, 0.0001f)), 0f, 1f);\n    let _e9 = _l3;\n    let _e10 = _l5;\n    return (pow((1f - _e9), 1.3f) * pow((1f - _e10), 2f));\n}","fn main_1() {\n    var _l0: vec3<f32>;\n    var _l1: vec3<f32>;\n    var _l2: f32;\n    var _l3: vec3<f32>;\n    var _l4: vec3<f32>;\n    var _l5: f32;\n    var _l6: f32;\n    var _l7: f32;\n    var _l8: f32;\n    var _l9: f32;\n    var _l10: f32;\n    var _l11: f32;\n    var _l12: f32;\n    var _l13: f32;\n    var _l14: f32;\n    var _l15: f32;\n    var _l16: vec2<f32>;\n    var _l17: f32;\n    var _l18: vec4<f32>;\n    var _l19: i32;\n    var _l20: f32;\n    var _l21: i32;\n    var _l22: f32;\n    var _l23: array<f32, 16>;\n    var _l24: vec3<f32>;\n    var _l25: f32;\n    var _l26: i32;\n    var _l27: f32;\n    var _l28: vec3<f32>;\n    var _l29: f32;\n    var _l30: vec3<f32>;\n    var _l31: f32;\n    var _l32: vec3<f32>;\n    var _l33: vec3<f32>;\n    var _l34: f32;\n    var _l35: f32;\n    var _l36: bool;\n\n    let _e0 = unnamed.uCameraLocal;\n    _l0 = _e0;\n    let _e1 = vLocal_1;\n    let _e2 = _l0;\n    _l1 = (_e1 - _e2);\n    let _e3 = _l1;\n    _l2 = length(_e3);\n    let _e4 = _l2;\n    if (_e4 > 0.00001f) {\n        let _e5 = _l1;\n        let _e6 = _l2;\n        _l4 = (_e5 / vec3(_e6));\n    } else {\n        _l4 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e7 = _l4;\n    _l3 = _e7;\n    let _e8 = unnamed.uNear;\n    let _e9 = unnamed.uLength;\n    _l5 = min(_e8, _e9);\n    _l6 = 0f;\n    let _e10 = unnamed.uLength;\n    _l7 = (_e10 * 2f);\n    let _e11 = _l3[2u];\n    if (abs(_e11) > 0.00001f) {\n        let _e12 = _l5;\n        let _e13 = _l0[2u];\n        let _e14 = _l3[2u];\n        _l8 = ((_e12 - _e13) / _e14);\n        let _e15 = unnamed.uLength;\n        let _e16 = _l0[2u];\n        let _e17 = _l3[2u];\n        _l9 = ((_e15 - _e16) / _e17);\n        let _e18 = _l8;\n        let _e19 = _l9;\n        _l6 = min(_e18, _e19);\n        let _e20 = _l8;\n        let _e21 = _l9;\n        _l7 = max(_e20, _e21);\n    } else {\n        let _e22 = _l0[2u];\n        let _e23 = _l5;\n        let _e24 = (_e22 < _e23);\n        _l36 = _e24;\n        if !(_e24) {\n            let _e25 = _l0[2u];\n            let _e26 = unnamed.uLength;\n            _l36 = (_e25 > _e26);\n        }\n        let _e27 = _l36;\n        if _e27 {\n            discard;\n        }\n    }\n    let _e28 = unnamed.uSpread;\n    let _e29 = unnamed.uLength;\n    _l10 = ((_e28 * _e29) * 1.05f);\n    let _e30 = _l3;\n    let _e31 = _l3;\n    _l11 = dot(_e30.xy, _e31.xy);\n    let _e32 = _l0;\n    let _e33 = _l3;\n    _l12 = (2f * dot(_e32.xy, _e33.xy));\n    let _e34 = _l0;\n    let _e35 = _l0;\n    let _e36 = _l10;\n    let _e37 = _l10;\n    _l13 = (dot(_e34.xy, _e35.xy) - (_e36 * _e37));\n    let _e38 = _l11;\n    if (_e38 > 0.00000001f) {\n        let _e39 = _l12;\n        let _e40 = _l12;\n        let _e41 = _l11;\n        let _e42 = _l13;\n        _l14 = ((_e39 * _e40) - ((4f * _e41) * _e42));\n        let _e43 = _l14;\n        if (_e43 <= 0f) {\n            discard;\n        }\n        let _e44 = _l14;\n        _l15 = sqrt(_e44);\n        let _e45 = _l6;\n        let _e46 = _l12;\n        let _e47 = _l15;\n        let _e48 = _l11;\n        _l6 = max(_e45, ((-(_e46) - _e47) / (2f * _e48)));\n        let _e49 = _l7;\n        let _e50 = _l12;\n        let _e51 = _l15;\n        let _e52 = _l11;\n        _l7 = min(_e49, ((-(_e50) + _e51) / (2f * _e52)));\n    } else {\n        let _e53 = _l13;\n        if (_e53 > 0f) {\n            discard;\n        }\n    }\n    let _e54 = _l6;\n    _l6 = max(_e54, 0f);\n    let _e55 = _l7;\n    let _e56 = _l6;\n    let _e57 = unnamed.uLength;\n    _l7 = min(_e55, (_e56 + (_e57 * 2f)));\n    let _e58 = unnamed.uSceneDepthEnabled;\n    if (_e58 != 0i) {\n        let _e59 = gl_FragCoord_1;\n        let _e60 = unnamed.uInvViewport;\n        _l16 = (_e59.xy * _e60);\n        let _e61 = _l16;\n        let _e62 = textureSampleLevel(uSceneDepth_t, uSceneDepth_s, _e61, 0f);\n        _l17 = _e62.x;\n        let _e63 = unnamed.uDepthToLocal;\n        let _e64 = _l16;\n        let _e65 = ((_e64 * 2f) - vec2(1f));\n        let _e66 = _l17;\n        _l18 = (_e63 * vec4<f32>(_e65.x, _e65.y, _e66, 1f));\n        let _e67 = _l18[3u];\n        if (_e67 > 0.000001f) {\n            let _e68 = _l7;\n            let _e69 = _l18;\n            let _e70 = _l18[3u];\n            let _e71 = _l0;\n            let _e72 = _l3;\n            _l7 = min(_e68, dot(((_e69.xyz / vec3(_e70)) - _e71), _e72));\n        }\n    }\n    let _e73 = _l7;\n    let _e74 = _l6;\n    if (_e73 <= _e74) {\n        discard;\n    }\n    let _e75 = unnamed.uSamples;\n    _l19 = clamp(_e75, 2i, 64i);\n    let _e76 = _l7;\n    let _e77 = _l6;\n    let _e78 = _l19;\n    _l20 = ((_e76 - _e77) / f32(_e78));\n    let _e79 = gl_FragCoord_1[1u];\n    let _e80 = gl_FragCoord_1[0u];\n    _l21 = ((i32((_e79 - (floor((_e79 / 4f)) * 4f))) * 4i) + i32((_e80 - (floor((_e80 / 4f)) * 4f))));\n    let _e81 = _l21;\n    _l23 = array<f32, 16>(0f, 8f, 2f, 10f, 12f, 4f, 14f, 6f, 3f, 11f, 1f, 9f, 15f, 7f, 13f, 5f);\n    let _e82 = _l23[_e81];\n    let _e83 = gl_FragCoord_1;\n    let _e84 = _e83.xy;\n    _l24 = vec3<f32>(_e84.x, _e84.y, 3.7f);\n    let _e85 = hash31_u0028_vf3_u003b((&_l24));\n    let _e86 = _l20;\n    _l22 = ((((_e82 + _e85) / 16f) - 0.5f) * _e86);\n    _l25 = 0f;\n    _l26 = 0i;\n    loop {\n        let _e87 = _l26;\n        if (_e87 < 64i) {\n            let _e88 = _l26;\n            let _e89 = _l19;\n            if (_e88 >= _e89) {\n                break;\n            }\n            let _e90 = _l6;\n            let _e91 = _l26;\n            let _e92 = _l20;\n            _l27 = (_e90 + ((f32(_e91) + 0.5f) * _e92));\n            let _e93 = _l0;\n            let _e94 = _l3;\n            let _e95 = _l27;\n            _l28 = (_e93 + (_e94 * _e95));\n            let _e96 = _l28;\n            _l30 = _e96;\n            let _e97 = _l5;\n            _l31 = _e97;\n            let _e98 = densityAt_u0028_vf3_u003b_f1_u003b((&_l30), (&_l31));\n            _l29 = _e98;\n            let _e99 = _l29;\n            if (_e99 <= 0f) {\n                continue;\n            }\n            let _e100 = unnamed.uModelWorld;\n            let _e101 = _l28;\n            _l32 = (_e100 * vec4<f32>(_e101.x, _e101.y, _e101.z, 1f)).xyz;\n            let _e102 = unnamed.uDust;\n            if (_e102 > 0f) {\n                let _e103 = _l32;\n                let _e104 = unnamed.uDustOffset;\n                let _e105 = unnamed.uDustScale;\n                _l33 = ((_e103 + _e104) / vec3(max(_e105, 0.001f)));\n                let _e106 = dustField_u0028_vf3_u003b((&_l33));\n                let _e107 = unnamed.uDust;\n                let _e108 = _l29;\n                _l29 = (_e108 * mix(1f, _e106, _e107));\n            }\n            let _e109 = _l29;\n            let _e110 = _l25;\n            _l25 = (_e110 + _e109);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e111 = _l26;\n            _l26 = (_e111 + 1i);\n        }\n    }\n    let _e112 = unnamed.uSpread;\n    let _e113 = unnamed.uLength;\n    _l34 = max((_e112 * _e113), 0.0001f);\n    let _e114 = _l25;\n    let _e115 = _l20;\n    let _e116 = _l34;\n    _l35 = (1f - exp((((-(_e114) * _e115) / _e116) * 3f)));\n    let _e117 = vColor_1;\n    let _e118 = vEnergy_1;\n    let _e119 = _l35;\n    let _e120 = unnamed.uStrength;\n    let _e121 = (_e117 * ((_e118 * _e119) * _e120));\n    fragColor = vec4<f32>(_e121.x, _e121.y, _e121.z, 1f);\n    return;\n}","@fragment \nfn main(@location(4) vLocal: vec3<f32>, @builtin(position) gl_FragCoord: vec4<f32>, @location(0) vColor: vec3<f32>, @location(1) vEnergy: f32, @location(2) vNormal: vec3<f32>, @location(3) vWorldPos: vec3<f32>) -> @location(0) vec4<f32> {\n    vLocal_1 = vLocal;\n    gl_FragCoord_1 = gl_FragCoord;\n    vColor_1 = vColor;\n    vEnergy_1 = vEnergy;\n    vNormal_1 = vNormal;\n    vWorldPos_1 = vWorldPos;\n    main_1();\n    let _e0 = fragColor;\n    return _e0;\n}\n","struct Uniforms {\n    uCameraPos: vec3<f32>,\n    uStrength: f32,\n    uLength: f32,\n    uSpread: f32,\n    uDust: f32,\n    uDustScale: f32,\n    uDustOffset: vec3<f32>,\n    uSunShadow: f32,\n    uLightViewProj: mat4x4<f32>,\n    uMovingLightViewProj: mat4x4<f32>,\n    uShadowMapSize: f32,\n    uPeeledShadowEnabled: i32,\n    uNear: f32,\n    uCameraLocal: vec3<f32>,\n    uModelWorld: mat4x4<f32>,\n    uSamples: i32,\n    uSceneDepthEnabled: i32,\n    uInvViewport: vec2<f32>,\n    uDepthToLocal: mat4x4<f32>,\n}","@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(32) \nvar uSunShadows_t: texture_2d_array<f32>;\n@group(0) @binding(33) \nvar uSunShadows_s: sampler;\nvar<private> vLocal_1: vec3<f32>;\nvar<private> gl_FragCoord_1: vec4<f32>;\n@group(0) @binding(34) \nvar uSceneDepth_t: texture_2d<f32>;\n@group(0) @binding(35) \nvar uSceneDepth_s: sampler;\nvar<private> fragColor: vec4<f32>;\nvar<private> vColor_1: vec3<f32>;\nvar<private> vEnergy_1: f32;\nvar<private> vNormal_1: vec3<f32>;\nvar<private> vWorldPos_1: vec3<f32>;","fn occlusion_u0028_f1_u003b_f1_u003b(_l0: ptr<function, f32>, _l1: ptr<function, f32>) -> f32 {\n    let _e0 = (*_l1);\n    let _e1 = (*_l0);\n    return smoothstep(-0.0025f, 0.0025f, (_e0 - _e1));\n}","fn sunReach_u0028_vf3_u003b(_l0: ptr<function, vec3<f32>>) -> f32 {\n    var _l1: vec4<f32>;\n    var _l2: vec3<f32>;\n    var _l3: vec2<f32>;\n    var _l4: f32;\n    var _l5: f32;\n    var _l6: f32;\n    var _l7: f32;\n    var _l8: f32;\n    var _l9: f32;\n    var _l10: f32;\n    var _l11: vec4<f32>;\n    var _l12: vec3<f32>;\n    var _l13: f32;\n    var _l14: f32;\n    var _l15: bool;\n    var _l16: bool;\n    var _l17: bool;\n    var _l18: bool;\n    var _l19: bool;\n    var _l20: bool;\n    var _l21: bool;\n    var _l22: bool;\n    var _l23: bool;\n\n    let _e0 = unnamed.uLightViewProj;\n    let _e1 = (*_l0);\n    _l1 = (_e0 * vec4<f32>(_e1.x, _e1.y, _e1.z, 1f));\n    let _e2 = _l1[3u];\n    if (_e2 <= 0f) {\n        return 1f;\n    }\n    let _e3 = _l1;\n    let _e4 = _l1[3u];\n    _l2 = (((_e3.xyz / vec3(_e4)) * 0.5f) + vec3(0.5f));\n    let _e5 = _l2[2u];\n    let _e6 = (_e5 > 1f);\n    _l15 = _e6;\n    if !(_e6) {\n        let _e7 = _l2[0u];\n        _l15 = (_e7 < 0f);\n    }\n    let _e8 = _l15;\n    _l16 = _e8;\n    if !(_e8) {\n        let _e9 = _l2[0u];\n        _l16 = (_e9 > 1f);\n    }\n    let _e10 = _l16;\n    _l17 = _e10;\n    if !(_e10) {\n        let _e11 = _l2[1u];\n        _l17 = (_e11 < 0f);\n    }\n    let _e12 = _l17;\n    _l18 = _e12;\n    if !(_e12) {\n        let _e13 = _l2[1u];\n        _l18 = (_e13 > 1f);\n    }\n    let _e14 = _l18;\n    if _e14 {\n        return 1f;\n    }\n    let _e15 = _l2;\n    _l3 = (abs((_e15.xy - vec2(0.5f))) * 2f);\n    let _e16 = _l3[0u];\n    let _e17 = _l3[1u];\n    _l4 = (1f - smoothstep(0.72f, 0.98f, max(_e16, _e17)));\n    let _e18 = _l2[2u];\n    let _e19 = _l4;\n    _l4 = (_e19 * (1f - smoothstep(0.9f, 1f, _e18)));\n    let _e20 = _l4;\n    if (_e20 <= 0f) {\n        return 1f;\n    }\n    let _e21 = _l2[2u];\n    _l5 = (_e21 - 0.0015f);\n    let _e22 = _l2;\n    let _e23 = _e22.xy;\n    let _e24 = vec3<f32>(_e23.x, _e23.y, 0f);\n    let _e25 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e24.x, _e24.y), i32(_e24.z), 0f);\n    _l7 = _e25.x;\n    let _e26 = _l5;\n    _l8 = _e26;\n    let _e27 = occlusion_u0028_f1_u003b_f1_u003b((&_l7), (&_l8));\n    _l6 = _e27;\n    let _e28 = unnamed.uPeeledShadowEnabled;\n    if (_e28 != 0i) {\n        let _e29 = _l6;\n        let _e30 = _l2;\n        let _e31 = _e30.xy;\n        let _e32 = vec3<f32>(_e31.x, _e31.y, 2f);\n        let _e33 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e32.x, _e32.y), i32(_e32.z), 0f);\n        _l9 = _e33.x;\n        let _e34 = _l5;\n        _l10 = _e34;\n        let _e35 = occlusion_u0028_f1_u003b_f1_u003b((&_l9), (&_l10));\n        _l6 = max(_e29, _e35);\n    }\n    let _e36 = unnamed.uMovingLightViewProj;\n    let _e37 = (*_l0);\n    _l11 = (_e36 * vec4<f32>(_e37.x, _e37.y, _e37.z, 1f));\n    let _e38 = _l11;\n    let _e39 = _l11[3u];\n    _l12 = (((_e38.xyz / vec3(_e39)) * 0.5f) + vec3(0.5f));\n    let _e40 = _l11[3u];\n    let _e41 = (_e40 > 0f);\n    _l19 = _e41;\n    if _e41 {\n        let _e42 = _l12[2u];\n        _l19 = (_e42 <= 1f);\n    }\n    let _e43 = _l19;\n    _l20 = _e43;\n    if _e43 {\n        let _e44 = _l12[0u];\n        _l20 = (_e44 >= 0f);\n    }\n    let _e45 = _l20;\n    _l21 = _e45;\n    if _e45 {\n        let _e46 = _l12[0u];\n        _l21 = (_e46 <= 1f);\n    }\n    let _e47 = _l21;\n    _l22 = _e47;\n    if _e47 {\n        let _e48 = _l12[1u];\n        _l22 = (_e48 >= 0f);\n    }\n    let _e49 = _l22;\n    _l23 = _e49;\n    if _e49 {\n        let _e50 = _l12[1u];\n        _l23 = (_e50 <= 1f);\n    }\n    let _e51 = _l23;\n    if _e51 {\n        let _e52 = _l6;\n        let _e53 = _l12;\n        let _e54 = _e53.xy;\n        let _e55 = vec3<f32>(_e54.x, _e54.y, 1f);\n        let _e56 = textureSampleLevel(uSunShadows_t, uSunShadows_s, vec2<f32>(_e55.x, _e55.y), i32(_e55.z), 0f);\n        let _e57 = _l12[2u];\n        _l13 = _e56.x;\n        _l14 = (_e57 - 0.0015f);\n        let _e58 = occlusion_u0028_f1_u003b_f1_u003b((&_l13), (&_l14));\n        _l6 = max(_e52, _e58);\n    }\n    let _e59 = _l6;\n    let _e60 = unnamed.uSunShadow;\n    let _e61 = _l4;\n    return mix(1f, (1f - _e59), (_e60 * _e61));\n}","fn main_1() {\n    var _l0: vec3<f32>;\n    var _l1: vec3<f32>;\n    var _l2: f32;\n    var _l3: vec3<f32>;\n    var _l4: vec3<f32>;\n    var _l5: f32;\n    var _l6: f32;\n    var _l7: f32;\n    var _l8: f32;\n    var _l9: f32;\n    var _l10: f32;\n    var _l11: f32;\n    var _l12: f32;\n    var _l13: f32;\n    var _l14: f32;\n    var _l15: f32;\n    var _l16: vec2<f32>;\n    var _l17: f32;\n    var _l18: vec4<f32>;\n    var _l19: i32;\n    var _l20: f32;\n    var _l21: i32;\n    var _l22: f32;\n    var _l23: array<f32, 16>;\n    var _l24: vec3<f32>;\n    var _l25: f32;\n    var _l26: i32;\n    var _l27: f32;\n    var _l28: vec3<f32>;\n    var _l29: f32;\n    var _l30: vec3<f32>;\n    var _l31: f32;\n    var _l32: vec3<f32>;\n    var _l33: vec3<f32>;\n    var _l34: vec3<f32>;\n    var _l35: vec3<f32>;\n    var _l36: f32;\n    var _l37: f32;\n    var _l38: bool;\n\n    let _e0 = unnamed.uCameraLocal;\n    _l0 = _e0;\n    let _e1 = vLocal_1;\n    let _e2 = _l0;\n    _l1 = (_e1 - _e2);\n    let _e3 = _l1;\n    _l2 = length(_e3);\n    let _e4 = _l2;\n    if (_e4 > 0.00001f) {\n        let _e5 = _l1;\n        let _e6 = _l2;\n        _l4 = (_e5 / vec3(_e6));\n    } else {\n        _l4 = vec3<f32>(0f, 0f, 1f);\n    }\n    let _e7 = _l4;\n    _l3 = _e7;\n    let _e8 = unnamed.uNear;\n    let _e9 = unnamed.uLength;\n    _l5 = min(_e8, _e9);\n    _l6 = 0f;\n    let _e10 = unnamed.uLength;\n    _l7 = (_e10 * 2f);\n    let _e11 = _l3[2u];\n    if (abs(_e11) > 0.00001f) {\n        let _e12 = _l5;\n        let _e13 = _l0[2u];\n        let _e14 = _l3[2u];\n        _l8 = ((_e12 - _e13) / _e14);\n        let _e15 = unnamed.uLength;\n        let _e16 = _l0[2u];\n        let _e17 = _l3[2u];\n        _l9 = ((_e15 - _e16) / _e17);\n        let _e18 = _l8;\n        let _e19 = _l9;\n        _l6 = min(_e18, _e19);\n        let _e20 = _l8;\n        let _e21 = _l9;\n        _l7 = max(_e20, _e21);\n    } else {\n        let _e22 = _l0[2u];\n        let _e23 = _l5;\n        let _e24 = (_e22 < _e23);\n        _l38 = _e24;\n        if !(_e24) {\n            let _e25 = _l0[2u];\n            let _e26 = unnamed.uLength;\n            _l38 = (_e25 > _e26);\n        }\n        let _e27 = _l38;\n        if _e27 {\n            discard;\n        }\n    }\n    let _e28 = unnamed.uSpread;\n    let _e29 = unnamed.uLength;\n    _l10 = ((_e28 * _e29) * 1.05f);\n    let _e30 = _l3;\n    let _e31 = _l3;\n    _l11 = dot(_e30.xy, _e31.xy);\n    let _e32 = _l0;\n    let _e33 = _l3;\n    _l12 = (2f * dot(_e32.xy, _e33.xy));\n    let _e34 = _l0;\n    let _e35 = _l0;\n    let _e36 = _l10;\n    let _e37 = _l10;\n    _l13 = (dot(_e34.xy, _e35.xy) - (_e36 * _e37));\n    let _e38 = _l11;\n    if (_e38 > 0.00000001f) {\n        let _e39 = _l12;\n        let _e40 = _l12;\n        let _e41 = _l11;\n        let _e42 = _l13;\n        _l14 = ((_e39 * _e40) - ((4f * _e41) * _e42));\n        let _e43 = _l14;\n        if (_e43 <= 0f) {\n            discard;\n        }\n        let _e44 = _l14;\n        _l15 = sqrt(_e44);\n        let _e45 = _l6;\n        let _e46 = _l12;\n        let _e47 = _l15;\n        let _e48 = _l11;\n        _l6 = max(_e45, ((-(_e46) - _e47) / (2f * _e48)));\n        let _e49 = _l7;\n        let _e50 = _l12;\n        let _e51 = _l15;\n        let _e52 = _l11;\n        _l7 = min(_e49, ((-(_e50) + _e51) / (2f * _e52)));\n    } else {\n        let _e53 = _l13;\n        if (_e53 > 0f) {\n            discard;\n        }\n    }\n    let _e54 = _l6;\n    _l6 = max(_e54, 0f);\n    let _e55 = _l7;\n    let _e56 = _l6;\n    let _e57 = unnamed.uLength;\n    _l7 = min(_e55, (_e56 + (_e57 * 2f)));\n    let _e58 = unnamed.uSceneDepthEnabled;\n    if (_e58 != 0i) {\n        let _e59 = gl_FragCoord_1;\n        let _e60 = unnamed.uInvViewport;\n        _l16 = (_e59.xy * _e60);\n        let _e61 = _l16;\n        let _e62 = textureSampleLevel(uSceneDepth_t, uSceneDepth_s, _e61, 0f);\n        _l17 = _e62.x;\n        let _e63 = unnamed.uDepthToLocal;\n        let _e64 = _l16;\n        let _e65 = ((_e64 * 2f) - vec2(1f));\n        let _e66 = _l17;\n        _l18 = (_e63 * vec4<f32>(_e65.x, _e65.y, _e66, 1f));\n        let _e67 = _l18[3u];\n        if (_e67 > 0.000001f) {\n            let _e68 = _l7;\n            let _e69 = _l18;\n            let _e70 = _l18[3u];\n            let _e71 = _l0;\n            let _e72 = _l3;\n            _l7 = min(_e68, dot(((_e69.xyz / vec3(_e70)) - _e71), _e72));\n        }\n    }\n    let _e73 = _l7;\n    let _e74 = _l6;\n    if (_e73 <= _e74) {\n        discard;\n    }\n    let _e75 = unnamed.uSamples;\n    _l19 = clamp(_e75, 2i, 64i);\n    let _e76 = _l7;\n    let _e77 = _l6;\n    let _e78 = _l19;\n    _l20 = ((_e76 - _e77) / f32(_e78));\n    let _e79 = gl_FragCoord_1[1u];\n    let _e80 = gl_FragCoord_1[0u];\n    _l21 = ((i32((_e79 - (floor((_e79 / 4f)) * 4f))) * 4i) + i32((_e80 - (floor((_e80 / 4f)) * 4f))));\n    let _e81 = _l21;\n    _l23 = array<f32, 16>(0f, 8f, 2f, 10f, 12f, 4f, 14f, 6f, 3f, 11f, 1f, 9f, 15f, 7f, 13f, 5f);\n    let _e82 = _l23[_e81];\n    let _e83 = gl_FragCoord_1;\n    let _e84 = _e83.xy;\n    _l24 = vec3<f32>(_e84.x, _e84.y, 3.7f);\n    let _e85 = hash31_u0028_vf3_u003b((&_l24));\n    let _e86 = _l20;\n    _l22 = ((((_e82 + _e85) / 16f) - 0.5f) * _e86);\n    _l25 = 0f;\n    _l26 = 0i;\n    loop {\n        let _e87 = _l26;\n        if (_e87 < 64i) {\n            let _e88 = _l26;\n            let _e89 = _l19;\n            if (_e88 >= _e89) {\n                break;\n            }\n            let _e90 = _l6;\n            let _e91 = _l26;\n            let _e92 = _l20;\n            _l27 = (_e90 + ((f32(_e91) + 0.5f) * _e92));\n            let _e93 = _l0;\n            let _e94 = _l3;\n            let _e95 = _l27;\n            _l28 = (_e93 + (_e94 * _e95));\n            let _e96 = _l28;\n            _l30 = _e96;\n            let _e97 = _l5;\n            _l31 = _e97;\n            let _e98 = densityAt_u0028_vf3_u003b_f1_u003b((&_l30), (&_l31));\n            _l29 = _e98;\n            let _e99 = _l29;\n            if (_e99 <= 0f) {\n                continue;\n            }\n            let _e100 = unnamed.uModelWorld;\n            let _e101 = _l28;\n            _l32 = (_e100 * vec4<f32>(_e101.x, _e101.y, _e101.z, 1f)).xyz;\n            let _e102 = unnamed.uDust;\n            if (_e102 > 0f) {\n                let _e103 = _l32;\n                let _e104 = unnamed.uDustOffset;\n                let _e105 = unnamed.uDustScale;\n                _l33 = ((_e103 + _e104) / vec3(max(_e105, 0.001f)));\n                let _e106 = dustField_u0028_vf3_u003b((&_l33));\n                let _e107 = unnamed.uDust;\n                let _e108 = _l29;\n                _l29 = (_e108 * mix(1f, _e106, _e107));\n            }\n            let _e109 = unnamed.uSunShadow;\n            if (_e109 > 0f) {\n                let _e110 = unnamed.uModelWorld;\n                let _e111 = _l0;\n                let _e112 = _l3;\n                let _e113 = _l27;\n                let _e114 = _l22;\n                let _e115 = (_e111 + (_e112 * (_e113 + _e114)));\n                _l34 = (_e110 * vec4<f32>(_e115.x, _e115.y, _e115.z, 1f)).xyz;\n                let _e116 = _l34;\n                _l35 = _e116;\n                let _e117 = sunReach_u0028_vf3_u003b((&_l35));\n                let _e118 = _l29;\n                _l29 = (_e118 * _e117);\n            }\n            let _e119 = _l29;\n            let _e120 = _l25;\n            _l25 = (_e120 + _e119);\n            continue;\n        } else {\n            break;\n        }\n        continuing {\n            let _e121 = _l26;\n            _l26 = (_e121 + 1i);\n        }\n    }\n    let _e122 = unnamed.uSpread;\n    let _e123 = unnamed.uLength;\n    _l36 = max((_e122 * _e123), 0.0001f);\n    let _e124 = _l25;\n    let _e125 = _l20;\n    let _e126 = _l36;\n    _l37 = (1f - exp((((-(_e124) * _e125) / _e126) * 3f)));\n    let _e127 = vColor_1;\n    let _e128 = vEnergy_1;\n    let _e129 = _l37;\n    let _e130 = unnamed.uStrength;\n    let _e131 = (_e127 * ((_e128 * _e129) * _e130));\n    fragColor = vec4<f32>(_e131.x, _e131.y, _e131.z, 1f);\n    return;\n}"];

/** A permutation from its items, joined the first time it is asked for and kept. */
function permutations(table: Readonly<Record<string, readonly number[]>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, at] of Object.entries(table)) {
    let text: string | null = null;
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => (text ??= at.map((i) => PARTS[i] as string).join('\n\n')),
    });
  }
  return out;
}

/** One entry per permutation, keyed by the flags that are on. See `variantKey`. */
export const LIGHT_VOLUME_FRAG_WGSL: Readonly<Record<string, string>> = permutations({
  "none": [0,1,2,3,4,5,6,7],
  "directionalShadows": [8,9,10,11,2,3,4,5,12,7],
});

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
      "uniformSize": 352,
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
        "uMovingLightViewProj": {
          "offset": 112,
          "size": 64,
          "type": "mat4"
        },
        "uShadowMapSize": {
          "offset": 176,
          "size": 4,
          "type": "float"
        },
        "uPeeledShadowEnabled": {
          "offset": 180,
          "size": 4,
          "type": "int"
        },
        "uNear": {
          "offset": 184,
          "size": 4,
          "type": "float"
        },
        "uCameraLocal": {
          "offset": 192,
          "size": 12,
          "type": "vec3"
        },
        "uModelWorld": {
          "offset": 208,
          "size": 64,
          "type": "mat4"
        },
        "uSamples": {
          "offset": 272,
          "size": 4,
          "type": "int"
        },
        "uSceneDepthEnabled": {
          "offset": 276,
          "size": 4,
          "type": "int"
        },
        "uInvViewport": {
          "offset": 280,
          "size": 8,
          "type": "vec2"
        },
        "uDepthToLocal": {
          "offset": 288,
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
