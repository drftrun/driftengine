/*
 * Generated from ../splat.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SPLAT_FRAG_WGSL = "struct Uniforms {\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vCorner_1: vec2<f32>;\nvar<private> vColor_1: vec4<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e60 = (*c);\n    low = (_e60 * 12.92f);\n    let _e62 = (*c);\n    high = ((pow(max(_e62, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e68 = high;\n    let _e69 = low;\n    let _e70 = (*c);\n    return mix(_e68, _e69, step(_e70, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn highlightShoulder_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var m: f32;\n    var e: f32;\n\n    let _e61 = (*c_1)[0u];\n    let _e63 = (*c_1)[1u];\n    let _e65 = (*c_1)[2u];\n    m = max(_e61, max(_e63, _e65));\n    let _e68 = m;\n    if (_e68 <= 0.8f) {\n        let _e70 = (*c_1);\n        return _e70;\n    }\n    let _e71 = m;\n    e = (_e71 - 0.8f);\n    let _e73 = (*c_1);\n    let _e74 = e;\n    let _e76 = e;\n    let _e80 = m;\n    return (_e73 * ((0.8f + ((0.2f * _e74) / (_e76 + 0.2f))) / _e80));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e60 = (*v);\n    let _e61 = (*v);\n    a = ((_e60 * (_e61 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e67 = (*v);\n    let _e68 = (*v);\n    b = ((_e67 * ((_e68 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e75 = a;\n    let _e76 = b;\n    return (_e75 / _e76);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e60 = unnamed.uOutputExposure;\n    let _e61 = (*x);\n    (*x) = (_e61 * _e60);\n    let _e63 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e63);\n    let _e65 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e65), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_2: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e62 = unnamed.uOutputTransform;\n    if (_e62 == 0i) {\n        let _e64 = (*c_2);\n        return _e64;\n    }\n    let _e66 = unnamed.uOutputTransform;\n    if (_e66 == 2i) {\n        let _e68 = (*c_2);\n        param_1 = _e68;\n        let _e69 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_2) = _e69;\n    }\n    let _e71 = unnamed.uOutputTransform;\n    if (_e71 == 3i) {\n        let _e73 = (*c_2);\n        let _e75 = unnamed.uOutputExposure;\n        param_2 = (_e73 * _e75);\n        let _e77 = highlightShoulder_u0028_vf3_u003b((&param_2));\n        (*c_2) = _e77;\n    }\n    let _e78 = (*c_2);\n    param_3 = _e78;\n    let _e79 = linearToSrgb_u0028_vf3_u003b((&param_3));\n    return _e79;\n}\n\nfn main_1() {\n    var power: f32;\n    var alpha: f32;\n    var colour: vec3<f32>;\n    var param_4: vec3<f32>;\n\n    let _e61 = vCorner_1;\n    let _e62 = vCorner_1;\n    power = dot(_e61, _e62);\n    let _e65 = vColor_1[3u];\n    let _e66 = power;\n    alpha = (_e65 * exp((-0.5f * _e66)));\n    let _e70 = alpha;\n    if (_e70 < 0.003921569f) {\n        discard;\n    }\n    let _e72 = vColor_1;\n    param_4 = _e72.xyz;\n    let _e74 = applyOutputTransform_u0028_vf3_u003b((&param_4));\n    colour = _e74;\n    let _e75 = colour;\n    let _e76 = alpha;\n    let _e77 = (_e75 * _e76);\n    let _e78 = alpha;\n    fragColor = vec4<f32>(_e77.x, _e77.y, _e77.z, _e78);\n    return;\n}\n\n@fragment \nfn main(@location(0) vCorner: vec2<f32>, @location(1) vColor: vec4<f32>) -> @location(0) vec4<f32> {\n    vCorner_1 = vCorner;\n    vColor_1 = vColor;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

export const SPLAT_VERT_WGSL = "struct Uniforms {\n    uSplatCount: i32,\n    uSplatStride: i32,\n    uSplatTexels: i32,\n    uView: mat4x4<f32>,\n    uProjection: mat4x4<f32>,\n    uViewport: vec2<f32>,\n    uModel: mat4x4<f32>,\n    uSplatCameraLocal: vec3<f32>,\n    uSplatShDegree: i32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(16) \nvar uSplatData_t: texture_2d<u32>;\nvar<private> gl_VertexIndex_1: i32;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vCorner: vec2<f32>;\nvar<private> vColor: vec4<f32>;\n@group(0) @binding(18) \nvar uSplatOrder_t: texture_2d<u32>;\n@group(0) @binding(17) \nvar uSplatData_s: sampler;\n@group(0) @binding(19) \nvar uSplatOrder_s: sampler;\n\nfn decodeSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e60 = (*c);\n    low = (_e60 / vec3(12.92f));\n    let _e63 = (*c);\n    high = pow(((_e63 + vec3(0.055f)) / vec3(1.055f)), vec3<f32>(2.4f, 2.4f, 2.4f));\n    let _e69 = high;\n    let _e70 = low;\n    let _e71 = (*c);\n    return mix(_e69, _e70, select(vec3<f32>(0f, 0f, 0f), vec3<f32>(1f, 1f, 1f), (_e71 <= vec3<f32>(0.04045f, 0.04045f, 0.04045f))));\n}\n\nfn unpackRgba8_u0028_u1_u003b(packed: ptr<function, u32>) -> vec4<f32> {\n    let _e58 = (*packed);\n    let _e61 = (*packed);\n    let _e66 = (*packed);\n    let _e71 = (*packed);\n    return (vec4<f32>(f32((_e58 & 255u)), f32(((_e61 >> bitcast<u32>(8i)) & 255u)), f32(((_e66 >> bitcast<u32>(16i)) & 255u)), f32(((_e71 >> bitcast<u32>(24i)) & 255u))) / vec4(255f));\n}\n\nfn viewDependentColour_u0028_vu4_u003b_vf3_u003b(sh: ptr<function, vec4<u32>>, direction: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var scale: f32;\n    var a: vec4<f32>;\n    var param: u32;\n    var b: vec4<f32>;\n    var param_1: u32;\n    var c_1: vec4<f32>;\n    var param_2: u32;\n    var c0_: vec3<f32>;\n    var c1_: vec3<f32>;\n    var c2_: vec3<f32>;\n\n    let _e70 = (*sh)[3u];\n    scale = bitcast<f32>(_e70);\n    let _e72 = scale;\n    if (_e72 == 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e75 = (*sh)[0u];\n    param = _e75;\n    let _e76 = unpackRgba8_u0028_u1_u003b((&param));\n    a = _e76;\n    let _e78 = (*sh)[1u];\n    param_1 = _e78;\n    let _e79 = unpackRgba8_u0028_u1_u003b((&param_1));\n    b = _e79;\n    let _e81 = (*sh)[2u];\n    param_2 = _e81;\n    let _e82 = unpackRgba8_u0028_u1_u003b((&param_2));\n    c_1 = _e82;\n    let _e84 = a[0u];\n    let _e86 = a[1u];\n    let _e88 = a[2u];\n    let _e95 = scale;\n    c0_ = ((((vec3<f32>(_e84, _e86, _e88) * 255f) - vec3(128f)) / vec3(127f)) * _e95);\n    let _e98 = a[3u];\n    let _e100 = b[0u];\n    let _e102 = b[1u];\n    let _e109 = scale;\n    c1_ = ((((vec3<f32>(_e98, _e100, _e102) * 255f) - vec3(128f)) / vec3(127f)) * _e109);\n    let _e112 = b[2u];\n    let _e114 = b[3u];\n    let _e116 = c_1[0u];\n    let _e123 = scale;\n    c2_ = ((((vec3<f32>(_e112, _e114, _e116) * 255f) - vec3(128f)) / vec3(127f)) * _e123);\n    let _e126 = (*direction)[1u];\n    let _e128 = c0_;\n    let _e131 = (*direction)[2u];\n    let _e132 = c1_;\n    let _e136 = (*direction)[0u];\n    let _e137 = c2_;\n    return ((((_e128 * -(_e126)) + (_e132 * _e131)) - (_e137 * _e136)) * 0.48860252f);\n}\n\nfn fetchTexel_u0028_i1_u003b_i1_u003b(splat: ptr<function, i32>, which: ptr<function, i32>) -> vec4<u32> {\n    var at: i32;\n    var width: i32;\n\n    let _e61 = (*splat);\n    let _e63 = unnamed.uSplatTexels;\n    let _e65 = (*which);\n    at = ((_e61 * _e63) + _e65);\n    let _e68 = unnamed.uSplatStride;\n    let _e70 = unnamed.uSplatTexels;\n    width = (_e68 * _e70);\n    let _e72 = at;\n    let _e73 = width;\n    let _e81 = at;\n    let _e82 = width;\n    let _e85 = textureLoad(uSplatData_t, vec2<i32>((_e72 - (i32(floor((f32(_e72) / f32(_e73)))) * _e73)), (_e81 / _e82)), 0i);\n    return _e85;\n}\n\nfn main_1() {\n    var vertex: i32;\n    var slot: i32;\n    var corner: i32;\n    var splat_1: i32;\n    var texel0_: vec4<u32>;\n    var param_3: i32;\n    var param_4: i32;\n    var texel1_: vec4<u32>;\n    var param_5: i32;\n    var param_6: i32;\n    var centre: vec3<f32>;\n    var param_7: u32;\n    var direction_1: vec3<f32>;\n    var param_8: i32;\n    var param_9: i32;\n    var param_10: vec4<u32>;\n    var param_11: vec3<f32>;\n    var param_12: vec3<f32>;\n    var c01_: vec2<f32>;\n    var c23_: vec2<f32>;\n    var c45_: vec2<f32>;\n    var sigma: mat3x3<f32>;\n    var world: vec4<f32>;\n    var view: vec4<f32>;\n    var clip: vec4<f32>;\n    var focalX: f32;\n    var focalY: f32;\n    var invZ: f32;\n    var invZ2_: f32;\n    var jacobian: mat3x2<f32>;\n    var rotation: mat3x3<f32>;\n    var world3_: mat3x3<f32>;\n    var screen: mat2x2<f32>;\n    var a_1: f32;\n    var b_1: f32;\n    var d: f32;\n    var mid: f32;\n    var discriminant: f32;\n    var lambda1_: f32;\n    var lambda2_: f32;\n    var major: vec2<f32>;\n    var minor: vec2<f32>;\n    var radius1_: f32;\n    var radius2_: f32;\n    var offsets: array<vec2<f32>, 6>;\n    var unit: vec2<f32>;\n    var offsetPx: vec2<f32>;\n    var phi_396_: bool;\n    var phi_407_: bool;\n\n    let _e104 = gl_VertexIndex_1;\n    vertex = _e104;\n    let _e105 = vertex;\n    slot = (_e105 / 6i);\n    let _e107 = vertex;\n    corner = (_e107 - (i32(floor((f32(_e107) / f32(6i)))) * 6i));\n    let _e115 = slot;\n    let _e117 = unnamed.uSplatCount;\n    if (_e115 >= _e117) {\n        unnamed_1.gl_Position = vec4<f32>(2f, 2f, 2f, 1f);\n        vCorner = vec2<f32>(0f, 0f);\n        vColor = vec4<f32>(0f, 0f, 0f, 0f);\n        return;\n    }\n    let _e120 = slot;\n    let _e122 = unnamed.uSplatStride;\n    let _e130 = slot;\n    let _e132 = unnamed.uSplatStride;\n    let _e135 = textureLoad(uSplatOrder_t, vec2<i32>((_e120 - (i32(floor((f32(_e120) / f32(_e122)))) * _e122)), (_e130 / _e132)), 0i);\n    splat_1 = bitcast<i32>(_e135.x);\n    let _e138 = splat_1;\n    param_3 = _e138;\n    param_4 = 0i;\n    let _e139 = fetchTexel_u0028_i1_u003b_i1_u003b((&param_3), (&param_4));\n    texel0_ = _e139;\n    let _e140 = splat_1;\n    param_5 = _e140;\n    param_6 = 1i;\n    let _e141 = fetchTexel_u0028_i1_u003b_i1_u003b((&param_5), (&param_6));\n    texel1_ = _e141;\n    let _e142 = texel0_;\n    centre = bitcast<vec3<f32>>(_e142.xyz);\n    let _e146 = texel0_[3u];\n    param_7 = _e146;\n    let _e147 = unpackRgba8_u0028_u1_u003b((&param_7));\n    vColor = _e147;\n    let _e149 = unnamed.uSplatShDegree;\n    if (_e149 > 0i) {\n        let _e151 = centre;\n        let _e153 = unnamed.uSplatCameraLocal;\n        direction_1 = normalize((_e151 - _e153));\n        let _e156 = vColor;\n        let _e158 = splat_1;\n        param_8 = _e158;\n        param_9 = 2i;\n        let _e159 = fetchTexel_u0028_i1_u003b_i1_u003b((&param_8), (&param_9));\n        param_10 = _e159;\n        let _e160 = direction_1;\n        param_11 = _e160;\n        let _e161 = viewDependentColour_u0028_vu4_u003b_vf3_u003b((&param_10), (&param_11));\n        let _e163 = max((_e156.xyz + _e161), vec3<f32>(0f, 0f, 0f));\n        let _e164 = vColor;\n        vColor = vec4<f32>(_e163.x, _e163.y, _e163.z, _e164.w);\n    }\n    let _e170 = vColor;\n    param_12 = _e170.xyz;\n    let _e172 = decodeSrgb_u0028_vf3_u003b((&param_12));\n    let _e173 = vColor;\n    vColor = vec4<f32>(_e172.x, _e172.y, _e172.z, _e173.w);\n    let _e180 = texel1_[0u];\n    c01_ = unpack2x16float(_e180);\n    let _e183 = texel1_[1u];\n    c23_ = unpack2x16float(_e183);\n    let _e186 = texel1_[2u];\n    c45_ = unpack2x16float(_e186);\n    let _e189 = c01_[0u];\n    let _e191 = c01_[1u];\n    let _e193 = c23_[0u];\n    let _e195 = c01_[1u];\n    let _e197 = c23_[1u];\n    let _e199 = c45_[0u];\n    let _e201 = c23_[0u];\n    let _e203 = c45_[0u];\n    let _e205 = c45_[1u];\n    sigma = mat3x3<f32>(vec3<f32>(_e189, _e191, _e193), vec3<f32>(_e195, _e197, _e199), vec3<f32>(_e201, _e203, _e205));\n    let _e211 = unnamed.uModel;\n    let _e212 = centre;\n    world = (_e211 * vec4<f32>(_e212.x, _e212.y, _e212.z, 1f));\n    let _e219 = unnamed.uView;\n    let _e220 = world;\n    view = (_e219 * _e220);\n    let _e223 = unnamed.uProjection;\n    let _e224 = view;\n    clip = (_e223 * _e224);\n    let _e227 = view[2u];\n    let _e228 = (_e227 > -0.01f);\n    phi_396_ = _e228;\n    if !(_e228) {\n        let _e231 = clip[0u];\n        let _e234 = clip[3u];\n        phi_396_ = (abs(_e231) > (_e234 * 1.3f));\n    }\n    let _e238 = phi_396_;\n    phi_407_ = _e238;\n    if !(_e238) {\n        let _e241 = clip[1u];\n        let _e244 = clip[3u];\n        phi_407_ = (abs(_e241) > (_e244 * 1.3f));\n    }\n    let _e248 = phi_407_;\n    if _e248 {\n        unnamed_1.gl_Position = vec4<f32>(2f, 2f, 2f, 1f);\n        vCorner = vec2<f32>(0f, 0f);\n        return;\n    }\n    let _e253 = unnamed.uProjection[0][0u];\n    let _e256 = unnamed.uViewport[0u];\n    focalX = ((_e253 * _e256) * 0.5f);\n    let _e262 = unnamed.uProjection[1][1u];\n    let _e265 = unnamed.uViewport[1u];\n    focalY = ((_e262 * _e265) * 0.5f);\n    let _e269 = view[2u];\n    invZ = (1f / _e269);\n    let _e271 = invZ;\n    let _e272 = invZ;\n    invZ2_ = (_e271 * _e272);\n    let _e274 = focalX;\n    let _e275 = invZ;\n    let _e277 = focalY;\n    let _e278 = invZ;\n    let _e280 = focalX;\n    let _e283 = view[0u];\n    let _e285 = invZ2_;\n    let _e287 = focalY;\n    let _e290 = view[1u];\n    let _e292 = invZ2_;\n    jacobian = mat3x2<f32>(vec2<f32>((_e274 * _e275), 0f), vec2<f32>(0f, (_e277 * _e278)), vec2<f32>(((-(_e280) * _e283) * _e285), ((-(_e287) * _e290) * _e292)));\n    let _e299 = unnamed.uView;\n    let _e301 = unnamed.uModel;\n    let _e302 = (_e299 * _e301);\n    rotation = mat3x3<f32>(_e302[0].xyz, _e302[1].xyz, _e302[2].xyz);\n    let _e310 = rotation;\n    let _e311 = sigma;\n    let _e313 = rotation;\n    world3_ = ((_e310 * _e311) * transpose(_e313));\n    let _e316 = jacobian;\n    let _e317 = world3_;\n    let _e319 = jacobian;\n    screen = ((_e316 * _e317) * transpose(_e319));\n    let _e324 = screen[0][0u];\n    screen[0][0u] = (_e324 + 0.3f);\n    let _e330 = screen[1][1u];\n    screen[1][1u] = (_e330 + 0.3f);\n    let _e336 = screen[0][0u];\n    a_1 = _e336;\n    let _e339 = screen[0][1u];\n    b_1 = _e339;\n    let _e342 = screen[1][1u];\n    d = _e342;\n    let _e343 = a_1;\n    let _e344 = d;\n    mid = (0.5f * (_e343 + _e344));\n    let _e347 = mid;\n    let _e348 = mid;\n    let _e350 = a_1;\n    let _e351 = d;\n    let _e353 = b_1;\n    let _e354 = b_1;\n    discriminant = sqrt(max(0.1f, ((_e347 * _e348) - ((_e350 * _e351) - (_e353 * _e354)))));\n    let _e360 = mid;\n    let _e361 = discriminant;\n    lambda1_ = (_e360 + _e361);\n    let _e363 = mid;\n    let _e364 = discriminant;\n    lambda2_ = (_e363 - _e364);\n    let _e366 = lambda2_;\n    if (_e366 <= 0f) {\n        unnamed_1.gl_Position = vec4<f32>(2f, 2f, 2f, 1f);\n        vCorner = vec2<f32>(0f, 0f);\n        return;\n    }\n    let _e369 = b_1;\n    let _e370 = lambda1_;\n    let _e371 = a_1;\n    major = normalize(vec2<f32>(_e369, (_e370 - _e371)));\n    let _e376 = major[1u];\n    let _e379 = major[0u];\n    minor = vec2<f32>(-(_e376), _e379);\n    let _e381 = lambda1_;\n    radius1_ = min((2f * sqrt(_e381)), 512f);\n    let _e385 = lambda2_;\n    radius2_ = min((2f * sqrt(_e385)), 512f);\n    offsets = array<vec2<f32>, 6>(vec2<f32>(-1f, -1f), vec2<f32>(1f, -1f), vec2<f32>(-1f, 1f), vec2<f32>(-1f, 1f), vec2<f32>(1f, -1f), vec2<f32>(1f, 1f));\n    let _e389 = corner;\n    let _e391 = offsets[_e389];\n    unit = _e391;\n    let _e392 = unit;\n    vCorner = (_e392 * 2f);\n    let _e395 = unit[0u];\n    let _e396 = major;\n    let _e398 = radius1_;\n    let _e401 = unit[1u];\n    let _e402 = minor;\n    let _e404 = radius2_;\n    offsetPx = (((_e396 * _e395) * _e398) + ((_e402 * _e401) * _e404));\n    let _e407 = clip;\n    let _e409 = offsetPx;\n    let _e411 = unnamed.uViewport;\n    let _e415 = clip[3u];\n    let _e417 = (_e407.xy + (((_e409 / _e411) * 2f) * _e415));\n    let _e419 = clip[2u];\n    let _e421 = clip[3u];\n    unnamed_1.gl_Position = vec4<f32>(_e417.x, _e417.y, _e419, _e421);\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32) -> VertexOutput {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    main_1();\n    let _e8 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e8);\n    let _e10 = unnamed_1.gl_Position;\n    let _e11 = vCorner;\n    let _e12 = vColor;\n    return VertexOutput(_e10, _e11, _e12);\n}\n";

/**
 * What the transform assigned, so the renderer binds the same numbers.
 *
 * A permuted shader has one entry per variant, keyed as `FLAT_FRAG_WGSL` is.
 */
export const SPLAT_BINDINGS = {
  "SPLAT_FRAG": {
    "uniforms": 1,
    "uniformSize": 16,
    "fields": {
      "uOutputTransform": {
        "offset": 0,
        "size": 4,
        "type": "int"
      },
      "uOutputExposure": {
        "offset": 4,
        "size": 4,
        "type": "float"
      }
    },
    "textures": {}
  },
  "SPLAT_VERT": {
    "uniforms": 0,
    "uniformSize": 240,
    "fields": {
      "uSplatCount": {
        "offset": 0,
        "size": 4,
        "type": "int"
      },
      "uSplatStride": {
        "offset": 4,
        "size": 4,
        "type": "int"
      },
      "uSplatTexels": {
        "offset": 8,
        "size": 4,
        "type": "int"
      },
      "uView": {
        "offset": 16,
        "size": 64,
        "type": "mat4"
      },
      "uProjection": {
        "offset": 80,
        "size": 64,
        "type": "mat4"
      },
      "uViewport": {
        "offset": 144,
        "size": 8,
        "type": "vec2"
      },
      "uModel": {
        "offset": 160,
        "size": 64,
        "type": "mat4"
      },
      "uSplatCameraLocal": {
        "offset": 224,
        "size": 12,
        "type": "vec3"
      },
      "uSplatShDegree": {
        "offset": 236,
        "size": 4,
        "type": "int"
      }
    },
    "textures": {
      "uSplatData": {
        "texture": 16,
        "sampler": 17,
        "type": "usampler2D"
      },
      "uSplatOrder": {
        "texture": 18,
        "sampler": 19,
        "type": "usampler2D"
      }
    }
  }
} as const;
