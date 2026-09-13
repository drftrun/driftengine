/*
 * Generated from ../splat.ts by `npm run wgsl`. Do not edit.
 *
 * The GLSL beside this file is the source of truth. A hand edit here is discarded by
 * the next generation, and `npm run wgsl:check` fails the build when this is stale.
 */

export const SPLAT_FRAG_WGSL = "struct Uniforms {\n    uOutputTransform: i32,\n    uOutputExposure: f32,\n}\n\n@group(0) @binding(1) \nvar<uniform> unnamed: Uniforms;\nvar<private> vCorner_1: vec2<f32>;\nvar<private> vColor_1: vec4<f32>;\nvar<private> fragColor: vec4<f32>;\n\nfn linearToSrgb_u0028_vf3_u003b(c: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var low: vec3<f32>;\n    var high: vec3<f32>;\n\n    let _e54 = (*c);\n    low = (_e54 * 12.92f);\n    let _e56 = (*c);\n    high = ((pow(max(_e56, vec3<f32>(0f, 0f, 0f)), vec3<f32>(0.41666666f, 0.41666666f, 0.41666666f)) * 1.055f) - vec3(0.055f));\n    let _e62 = high;\n    let _e63 = low;\n    let _e64 = (*c);\n    return mix(_e62, _e63, step(_e64, vec3<f32>(0.0031308f, 0.0031308f, 0.0031308f)));\n}\n\nfn rrtAndOdtFit_u0028_vf3_u003b(v: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var a: vec3<f32>;\n    var b: vec3<f32>;\n\n    let _e54 = (*v);\n    let _e55 = (*v);\n    a = ((_e54 * (_e55 + vec3(0.0245786f))) - vec3(0.000090537f));\n    let _e61 = (*v);\n    let _e62 = (*v);\n    b = ((_e61 * ((_e62 * 0.983729f) + vec3(0.432951f))) + vec3(0.238081f));\n    let _e69 = a;\n    let _e70 = b;\n    return (_e69 / _e70);\n}\n\nfn acesFilmic_u0028_vf3_u003b(x: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param: vec3<f32>;\n\n    let _e54 = unnamed.uOutputExposure;\n    let _e55 = (*x);\n    (*x) = (_e55 * _e54);\n    let _e57 = (*x);\n    param = (mat3x3<f32>(vec3<f32>(0.59719f, 0.076f, 0.0284f), vec3<f32>(0.35458f, 0.90834f, 0.13383f), vec3<f32>(0.04823f, 0.01566f, 0.83777f)) * _e57);\n    let _e59 = rrtAndOdtFit_u0028_vf3_u003b((&param));\n    return clamp((mat3x3<f32>(vec3<f32>(1.60475f, -0.10208f, -0.00327f), vec3<f32>(-0.53108f, 1.10813f, -0.07276f), vec3<f32>(-0.07367f, -0.00605f, 1.07602f)) * _e59), vec3(0f), vec3(1f));\n}\n\nfn applyOutputTransform_u0028_vf3_u003b(c_1: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var param_1: vec3<f32>;\n    var param_2: vec3<f32>;\n\n    let _e55 = unnamed.uOutputTransform;\n    if (_e55 == 0i) {\n        let _e57 = (*c_1);\n        return _e57;\n    }\n    let _e59 = unnamed.uOutputTransform;\n    if (_e59 == 2i) {\n        let _e61 = (*c_1);\n        param_1 = _e61;\n        let _e62 = acesFilmic_u0028_vf3_u003b((&param_1));\n        (*c_1) = _e62;\n    }\n    let _e63 = (*c_1);\n    param_2 = _e63;\n    let _e64 = linearToSrgb_u0028_vf3_u003b((&param_2));\n    return _e64;\n}\n\nfn main_1() {\n    var power: f32;\n    var alpha: f32;\n    var colour: vec3<f32>;\n    var param_3: vec3<f32>;\n\n    let _e55 = vCorner_1;\n    let _e56 = vCorner_1;\n    power = dot(_e55, _e56);\n    let _e59 = vColor_1[3u];\n    let _e60 = power;\n    alpha = (_e59 * exp((-0.5f * _e60)));\n    let _e64 = alpha;\n    if (_e64 < 0.003921569f) {\n        discard;\n    }\n    let _e66 = vColor_1;\n    param_3 = _e66.xyz;\n    let _e68 = applyOutputTransform_u0028_vf3_u003b((&param_3));\n    colour = _e68;\n    let _e69 = colour;\n    let _e70 = alpha;\n    let _e71 = (_e69 * _e70);\n    let _e72 = alpha;\n    fragColor = vec4<f32>(_e71.x, _e71.y, _e71.z, _e72);\n    return;\n}\n\n@fragment \nfn main(@location(0) vCorner: vec2<f32>, @location(1) vColor: vec4<f32>) -> @location(0) vec4<f32> {\n    vCorner_1 = vCorner;\n    vColor_1 = vColor;\n    main_1();\n    let _e5 = fragColor;\n    return _e5;\n}\n";

export const SPLAT_VERT_WGSL = "struct Uniforms {\n    uSplatCount: i32,\n    uSplatStride: i32,\n    uSplatTexels: i32,\n    uView: mat4x4<f32>,\n    uProjection: mat4x4<f32>,\n    uViewport: vec2<f32>,\n    uModel: mat4x4<f32>,\n    uSplatCameraLocal: vec3<f32>,\n    uSplatShDegree: i32,\n}\n\nstruct gl_PerVertex {\n    @builtin(position) gl_Position: vec4<f32>,\n    gl_PointSize: f32,\n}\n\nstruct VertexOutput {\n    @builtin(position) gl_Position: vec4<f32>,\n    @location(0) member: vec2<f32>,\n    @location(1) member_1: vec4<f32>,\n}\n\n@group(0) @binding(0) \nvar<uniform> unnamed: Uniforms;\n@group(0) @binding(16) \nvar uSplatData_t: texture_2d<u32>;\nvar<private> gl_VertexIndex_1: i32;\nvar<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f);\nvar<private> vCorner: vec2<f32>;\nvar<private> vColor: vec4<f32>;\n@group(0) @binding(18) \nvar uSplatOrder_t: texture_2d<u32>;\n@group(0) @binding(17) \nvar uSplatData_s: sampler;\n@group(0) @binding(19) \nvar uSplatOrder_s: sampler;\n\nfn unpackRgba8_u0028_u1_u003b(packed: ptr<function, u32>) -> vec4<f32> {\n    let _e50 = (*packed);\n    let _e53 = (*packed);\n    let _e58 = (*packed);\n    let _e63 = (*packed);\n    return (vec4<f32>(f32((_e50 & 255u)), f32(((_e53 >> bitcast<u32>(8i)) & 255u)), f32(((_e58 >> bitcast<u32>(16i)) & 255u)), f32(((_e63 >> bitcast<u32>(24i)) & 255u))) / vec4(255f));\n}\n\nfn viewDependentColour_u0028_vu4_u003b_vf3_u003b(sh: ptr<function, vec4<u32>>, direction: ptr<function, vec3<f32>>) -> vec3<f32> {\n    var scale: f32;\n    var a: vec4<f32>;\n    var param: u32;\n    var b: vec4<f32>;\n    var param_1: u32;\n    var c: vec4<f32>;\n    var param_2: u32;\n    var c0_: vec3<f32>;\n    var c1_: vec3<f32>;\n    var c2_: vec3<f32>;\n\n    let _e62 = (*sh)[3u];\n    scale = bitcast<f32>(_e62);\n    let _e64 = scale;\n    if (_e64 == 0f) {\n        return vec3<f32>(0f, 0f, 0f);\n    }\n    let _e67 = (*sh)[0u];\n    param = _e67;\n    let _e68 = unpackRgba8_u0028_u1_u003b((&param));\n    a = _e68;\n    let _e70 = (*sh)[1u];\n    param_1 = _e70;\n    let _e71 = unpackRgba8_u0028_u1_u003b((&param_1));\n    b = _e71;\n    let _e73 = (*sh)[2u];\n    param_2 = _e73;\n    let _e74 = unpackRgba8_u0028_u1_u003b((&param_2));\n    c = _e74;\n    let _e76 = a[0u];\n    let _e78 = a[1u];\n    let _e80 = a[2u];\n    let _e87 = scale;\n    c0_ = ((((vec3<f32>(_e76, _e78, _e80) * 255f) - vec3(128f)) / vec3(127f)) * _e87);\n    let _e90 = a[3u];\n    let _e92 = b[0u];\n    let _e94 = b[1u];\n    let _e101 = scale;\n    c1_ = ((((vec3<f32>(_e90, _e92, _e94) * 255f) - vec3(128f)) / vec3(127f)) * _e101);\n    let _e104 = b[2u];\n    let _e106 = b[3u];\n    let _e108 = c[0u];\n    let _e115 = scale;\n    c2_ = ((((vec3<f32>(_e104, _e106, _e108) * 255f) - vec3(128f)) / vec3(127f)) * _e115);\n    let _e118 = (*direction)[1u];\n    let _e120 = c0_;\n    let _e123 = (*direction)[2u];\n    let _e124 = c1_;\n    let _e128 = (*direction)[0u];\n    let _e129 = c2_;\n    return ((((_e120 * -(_e118)) + (_e124 * _e123)) - (_e129 * _e128)) * 0.48860252f);\n}\n\nfn fetchTexel_u0028_i1_u003b_i1_u003b(splat: ptr<function, i32>, which: ptr<function, i32>) -> vec4<u32> {\n    var at: i32;\n    var width: i32;\n\n    let _e53 = (*splat);\n    let _e55 = unnamed.uSplatTexels;\n    let _e57 = (*which);\n    at = ((_e53 * _e55) + _e57);\n    let _e60 = unnamed.uSplatStride;\n    let _e62 = unnamed.uSplatTexels;\n    width = (_e60 * _e62);\n    let _e64 = at;\n    let _e65 = width;\n    let _e73 = at;\n    let _e74 = width;\n    let _e77 = textureLoad(uSplatData_t, vec2<i32>((_e64 - (i32(floor((f32(_e64) / f32(_e65)))) * _e65)), (_e73 / _e74)), 0i);\n    return _e77;\n}\n\nfn main_1() {\n    var vertex: i32;\n    var slot: i32;\n    var corner: i32;\n    var splat_1: i32;\n    var texel0_: vec4<u32>;\n    var param_3: i32;\n    var param_4: i32;\n    var texel1_: vec4<u32>;\n    var param_5: i32;\n    var param_6: i32;\n    var centre: vec3<f32>;\n    var param_7: u32;\n    var direction_1: vec3<f32>;\n    var param_8: i32;\n    var param_9: i32;\n    var param_10: vec4<u32>;\n    var param_11: vec3<f32>;\n    var c01_: vec2<f32>;\n    var c23_: vec2<f32>;\n    var c45_: vec2<f32>;\n    var sigma: mat3x3<f32>;\n    var world: vec4<f32>;\n    var view: vec4<f32>;\n    var clip: vec4<f32>;\n    var focalX: f32;\n    var focalY: f32;\n    var invZ: f32;\n    var invZ2_: f32;\n    var jacobian: mat3x2<f32>;\n    var rotation: mat3x3<f32>;\n    var world3_: mat3x3<f32>;\n    var screen: mat2x2<f32>;\n    var a_1: f32;\n    var b_1: f32;\n    var d: f32;\n    var mid: f32;\n    var discriminant: f32;\n    var lambda1_: f32;\n    var lambda2_: f32;\n    var major: vec2<f32>;\n    var minor: vec2<f32>;\n    var radius1_: f32;\n    var radius2_: f32;\n    var offsets: array<vec2<f32>, 6>;\n    var unit: vec2<f32>;\n    var offsetPx: vec2<f32>;\n    var phi_358_: bool;\n    var phi_369_: bool;\n\n    let _e95 = gl_VertexIndex_1;\n    vertex = _e95;\n    let _e96 = vertex;\n    slot = (_e96 / 6i);\n    let _e98 = vertex;\n    corner = (_e98 - (i32(floor((f32(_e98) / f32(6i)))) * 6i));\n    let _e106 = slot;\n    let _e108 = unnamed.uSplatCount;\n    if (_e106 >= _e108) {\n        unnamed_1.gl_Position = vec4<f32>(2f, 2f, 2f, 1f);\n        vCorner = vec2<f32>(0f, 0f);\n        vColor = vec4<f32>(0f, 0f, 0f, 0f);\n        return;\n    }\n    let _e111 = slot;\n    let _e113 = unnamed.uSplatStride;\n    let _e121 = slot;\n    let _e123 = unnamed.uSplatStride;\n    let _e126 = textureLoad(uSplatOrder_t, vec2<i32>((_e111 - (i32(floor((f32(_e111) / f32(_e113)))) * _e113)), (_e121 / _e123)), 0i);\n    splat_1 = bitcast<i32>(_e126.x);\n    let _e129 = splat_1;\n    param_3 = _e129;\n    param_4 = 0i;\n    let _e130 = fetchTexel_u0028_i1_u003b_i1_u003b((&param_3), (&param_4));\n    texel0_ = _e130;\n    let _e131 = splat_1;\n    param_5 = _e131;\n    param_6 = 1i;\n    let _e132 = fetchTexel_u0028_i1_u003b_i1_u003b((&param_5), (&param_6));\n    texel1_ = _e132;\n    let _e133 = texel0_;\n    centre = bitcast<vec3<f32>>(_e133.xyz);\n    let _e137 = texel0_[3u];\n    param_7 = _e137;\n    let _e138 = unpackRgba8_u0028_u1_u003b((&param_7));\n    vColor = _e138;\n    let _e140 = unnamed.uSplatShDegree;\n    if (_e140 > 0i) {\n        let _e142 = centre;\n        let _e144 = unnamed.uSplatCameraLocal;\n        direction_1 = normalize((_e142 - _e144));\n        let _e147 = vColor;\n        let _e149 = splat_1;\n        param_8 = _e149;\n        param_9 = 2i;\n        let _e150 = fetchTexel_u0028_i1_u003b_i1_u003b((&param_8), (&param_9));\n        param_10 = _e150;\n        let _e151 = direction_1;\n        param_11 = _e151;\n        let _e152 = viewDependentColour_u0028_vu4_u003b_vf3_u003b((&param_10), (&param_11));\n        let _e154 = max((_e147.xyz + _e152), vec3<f32>(0f, 0f, 0f));\n        let _e155 = vColor;\n        vColor = vec4<f32>(_e154.x, _e154.y, _e154.z, _e155.w);\n    }\n    let _e162 = texel1_[0u];\n    c01_ = unpack2x16float(_e162);\n    let _e165 = texel1_[1u];\n    c23_ = unpack2x16float(_e165);\n    let _e168 = texel1_[2u];\n    c45_ = unpack2x16float(_e168);\n    let _e171 = c01_[0u];\n    let _e173 = c01_[1u];\n    let _e175 = c23_[0u];\n    let _e177 = c01_[1u];\n    let _e179 = c23_[1u];\n    let _e181 = c45_[0u];\n    let _e183 = c23_[0u];\n    let _e185 = c45_[0u];\n    let _e187 = c45_[1u];\n    sigma = mat3x3<f32>(vec3<f32>(_e171, _e173, _e175), vec3<f32>(_e177, _e179, _e181), vec3<f32>(_e183, _e185, _e187));\n    let _e193 = unnamed.uModel;\n    let _e194 = centre;\n    world = (_e193 * vec4<f32>(_e194.x, _e194.y, _e194.z, 1f));\n    let _e201 = unnamed.uView;\n    let _e202 = world;\n    view = (_e201 * _e202);\n    let _e205 = unnamed.uProjection;\n    let _e206 = view;\n    clip = (_e205 * _e206);\n    let _e209 = view[2u];\n    let _e210 = (_e209 > -0.01f);\n    phi_358_ = _e210;\n    if !(_e210) {\n        let _e213 = clip[0u];\n        let _e216 = clip[3u];\n        phi_358_ = (abs(_e213) > (_e216 * 1.3f));\n    }\n    let _e220 = phi_358_;\n    phi_369_ = _e220;\n    if !(_e220) {\n        let _e223 = clip[1u];\n        let _e226 = clip[3u];\n        phi_369_ = (abs(_e223) > (_e226 * 1.3f));\n    }\n    let _e230 = phi_369_;\n    if _e230 {\n        unnamed_1.gl_Position = vec4<f32>(2f, 2f, 2f, 1f);\n        vCorner = vec2<f32>(0f, 0f);\n        return;\n    }\n    let _e235 = unnamed.uProjection[0][0u];\n    let _e238 = unnamed.uViewport[0u];\n    focalX = ((_e235 * _e238) * 0.5f);\n    let _e244 = unnamed.uProjection[1][1u];\n    let _e247 = unnamed.uViewport[1u];\n    focalY = ((_e244 * _e247) * 0.5f);\n    let _e251 = view[2u];\n    invZ = (1f / _e251);\n    let _e253 = invZ;\n    let _e254 = invZ;\n    invZ2_ = (_e253 * _e254);\n    let _e256 = focalX;\n    let _e257 = invZ;\n    let _e259 = focalY;\n    let _e260 = invZ;\n    let _e262 = focalX;\n    let _e265 = view[0u];\n    let _e267 = invZ2_;\n    let _e269 = focalY;\n    let _e272 = view[1u];\n    let _e274 = invZ2_;\n    jacobian = mat3x2<f32>(vec2<f32>((_e256 * _e257), 0f), vec2<f32>(0f, (_e259 * _e260)), vec2<f32>(((-(_e262) * _e265) * _e267), ((-(_e269) * _e272) * _e274)));\n    let _e281 = unnamed.uView;\n    let _e283 = unnamed.uModel;\n    let _e284 = (_e281 * _e283);\n    rotation = mat3x3<f32>(_e284[0].xyz, _e284[1].xyz, _e284[2].xyz);\n    let _e292 = rotation;\n    let _e293 = sigma;\n    let _e295 = rotation;\n    world3_ = ((_e292 * _e293) * transpose(_e295));\n    let _e298 = jacobian;\n    let _e299 = world3_;\n    let _e301 = jacobian;\n    screen = ((_e298 * _e299) * transpose(_e301));\n    let _e306 = screen[0][0u];\n    screen[0][0u] = (_e306 + 0.3f);\n    let _e312 = screen[1][1u];\n    screen[1][1u] = (_e312 + 0.3f);\n    let _e318 = screen[0][0u];\n    a_1 = _e318;\n    let _e321 = screen[0][1u];\n    b_1 = _e321;\n    let _e324 = screen[1][1u];\n    d = _e324;\n    let _e325 = a_1;\n    let _e326 = d;\n    mid = (0.5f * (_e325 + _e326));\n    let _e329 = mid;\n    let _e330 = mid;\n    let _e332 = a_1;\n    let _e333 = d;\n    let _e335 = b_1;\n    let _e336 = b_1;\n    discriminant = sqrt(max(0.1f, ((_e329 * _e330) - ((_e332 * _e333) - (_e335 * _e336)))));\n    let _e342 = mid;\n    let _e343 = discriminant;\n    lambda1_ = (_e342 + _e343);\n    let _e345 = mid;\n    let _e346 = discriminant;\n    lambda2_ = (_e345 - _e346);\n    let _e348 = lambda2_;\n    if (_e348 <= 0f) {\n        unnamed_1.gl_Position = vec4<f32>(2f, 2f, 2f, 1f);\n        vCorner = vec2<f32>(0f, 0f);\n        return;\n    }\n    let _e351 = b_1;\n    let _e352 = lambda1_;\n    let _e353 = a_1;\n    major = normalize(vec2<f32>(_e351, (_e352 - _e353)));\n    let _e358 = major[1u];\n    let _e361 = major[0u];\n    minor = vec2<f32>(-(_e358), _e361);\n    let _e363 = lambda1_;\n    radius1_ = min((2f * sqrt(_e363)), 512f);\n    let _e367 = lambda2_;\n    radius2_ = min((2f * sqrt(_e367)), 512f);\n    offsets = array<vec2<f32>, 6>(vec2<f32>(-1f, -1f), vec2<f32>(1f, -1f), vec2<f32>(-1f, 1f), vec2<f32>(-1f, 1f), vec2<f32>(1f, -1f), vec2<f32>(1f, 1f));\n    let _e371 = corner;\n    let _e373 = offsets[_e371];\n    unit = _e373;\n    let _e374 = unit;\n    vCorner = (_e374 * 2f);\n    let _e377 = unit[0u];\n    let _e378 = major;\n    let _e380 = radius1_;\n    let _e383 = unit[1u];\n    let _e384 = minor;\n    let _e386 = radius2_;\n    offsetPx = (((_e378 * _e377) * _e380) + ((_e384 * _e383) * _e386));\n    let _e389 = clip;\n    let _e391 = offsetPx;\n    let _e393 = unnamed.uViewport;\n    let _e397 = clip[3u];\n    let _e399 = (_e389.xy + (((_e391 / _e393) * 2f) * _e397));\n    let _e401 = clip[2u];\n    let _e403 = clip[3u];\n    unnamed_1.gl_Position = vec4<f32>(_e399.x, _e399.y, _e401, _e403);\n    return;\n}\n\n@vertex \nfn main(@builtin(vertex_index) gl_VertexIndex: u32) -> VertexOutput {\n    gl_VertexIndex_1 = i32(gl_VertexIndex);\n    main_1();\n    let _e8 = unnamed_1.gl_Position.y;\n    unnamed_1.gl_Position.y = -(_e8);\n    let _e10 = unnamed_1.gl_Position;\n    let _e11 = vCorner;\n    let _e12 = vColor;\n    return VertexOutput(_e10, _e11, _e12);\n}\n";

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
