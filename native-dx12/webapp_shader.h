#pragma once
// HLSL for the generic webapp renderer (webapp_dx12.cpp). Approximates the
// Three.js r181 MeshStandard/Lambert/Phong/Basic lighting with
// physically based light units (same light intensities as WebGLRenderer).
// Split into adjacent raw literals: MSVC limits each piece to 16 KB.
static const char* kWebappShader = R"HLSL(
cbuffer Frame : register(b0) {
    float4x4 gView;
    float4x4 gProj;
    float4 gCamera;   // xyz position, w light count
    float4 gAmbient;  // rgb ambient irradiance, w exposure
    float4 gLights[64];
    float4 gTone;     // x tone mapping curve (THREE.*ToneMapping), y exposure, z 1 = render target (linear)
    float4 gFogColor;
    float4 gFog;      // mode, near or density, far
    float4x4 gShadowMatrices[16]; // world -> shadow clip, one per shadow map slice (point lights: 6)
    float4 gShadowLight[8];  // first slice, bias, normalBias, intensity
    float4 gShadowLight2[8]; // kind (1 = point light), radius, far, near
    float4 gShadowLight3[8]; // light position, unused
    float4 gShadowPass;      // 1 / map size, slice being drawn, point light near, unused
    float4 gShadowPass2;     // drawn slice's point light position, far
};
cbuffer Draw : register(b1) {
    float4x4 gModel;
    float4 gColor;    // linear rgb, opacity
    float4 gEmissive; // linear rgb, w shininess (<0: physical)
    float4 gParams;   // roughness, metalness, flags, unused
    float4 gUvU;      // u' = dot(xyz, (u, v, 1)); w alphaTest
    float4 gUvV;      // v' = dot(xyz, (u, v, 1))
    float4 gReflection; // sky RGB and blend strength
    float4 gFresnel;    // base, amplitude, exponent, alpha gain (negative: masked)
    float4 gColorStage[3]; // live uniforms from the translated material
    float4 gMaterialOptions; // flip Y, repeat, mirror bitmasks
    float4 gColorStageMore[4]; // translated material uniforms 12..27
    float4 gStdMap;   // normalScale x, y (sign: uv flip), aoMapIntensity, first bone + 1 (0: not skinned)
};
Texture2D gMap : register(t0);
Texture2D gMaterialMap0 : register(t1);
Texture2D gMaterialMap1 : register(t2);
Texture2D gMaterialMap2 : register(t3);
Texture2D gMaterialMap3 : register(t4);
Texture2D gMaterialMap4 : register(t5);
Texture2D gMaterialMap5 : register(t6);
Texture2D gMaterialMap6 : register(t7);
Texture2D gMaterialMap7 : register(t8);
Texture2D gMaterialMap8 : register(t9);
SamplerState gRepeat : register(s0);
SamplerState gClamp : register(s1);
SamplerState gMirror : register(s2);
Texture2DArray<float> gShadowMap : register(t10);
// SkinnedMesh bone matrices of this pass (bindMatrixInverse * bone * bindMatrix).
struct NtBone { column_major float4x4 m; };
StructuredBuffer<NtBone> gBones : register(t11);
SamplerComparisonState gShadowSampler : register(s3);
static const uint F_VERTEX_COLORS = 8, F_UNLIT = 16, F_NORMAL_COLOR = 512, F_INSTANCE_COLORS = 1024, F_FLAT = 2048,
                  F_MAP = 4096, F_MAP_REPEAT = 8192, F_MAP_MIRROR = 16384, F_FAR_DEPTH = 32768, F_NO_TONE_MAP = 65536, F_FOG = 131072, F_FRESNEL = 262144,
                  F_MIRRORED = 524288, F_INSTANCE_MIRRORED = 4194304;
static const float PI = 3.14159265;

struct VSIn {
    float3 pos : POSITION; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0;
    float4 attributes : TEXCOORD1;
    float4 r0 : IROW0; float4 r1 : IROW1; float4 r2 : IROW2; float4 r3 : IROW3;
    float3 icol : ICOLOR;
    float4 skinIndex : SKININDEX; float4 skinWeight : SKINWEIGHT;
};
struct VSOut {
    float4 pos : SV_Position; float3 world : WORLDPOS; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0; float fogDepth : TEXCOORD1;
    float3 localPosition : TEXCOORD2; float3 localNormal : TEXCOORD3;
    float4 attributes : TEXCOORD4; float2 rawUv : TEXCOORD5; float3 origin : TEXCOORD6;
    nointerpolation float mirror : TEXCOORD7; // 1: this instance's matrix is mirrored
};

float3 cofactorNormal(float3x3 m, float3 n) {
    float3 a = float3(m[0][0], m[1][0], m[2][0]);
    float3 b = float3(m[0][1], m[1][1], m[2][1]);
    float3 c = float3(m[0][2], m[1][2], m[2][2]);
    float3 r = n.x * cross(b, c) + n.y * cross(c, a) + n.z * cross(a, b);
    return dot(a, cross(b, c)) < 0 ? -r : r;
}

VSOut VSMain(VSIn i) {
    VSOut o;
    uint flags = (uint)gParams.z;
    float4x4 instT = float4x4(i.r0, i.r1, i.r2, i.r3);      // rows = instance matrix columns
    float3 pos = i.pos, nrm = i.nrm;
    if (gStdMap.w > 0) { // skinning_vertex: weighted bone matrices
        uint b = (uint)gStdMap.w - 1;
        float4x4 skin = gBones[b + (uint)i.skinIndex.x].m * i.skinWeight.x + gBones[b + (uint)i.skinIndex.y].m * i.skinWeight.y +
                        gBones[b + (uint)i.skinIndex.z].m * i.skinWeight.z + gBones[b + (uint)i.skinIndex.w].m * i.skinWeight.w;
        if (dot(i.skinWeight, float4(1, 1, 1, 1)) > 0) {
            pos = mul(skin, float4(pos, 1)).xyz;
            nrm = mul((float3x3)skin, nrm);
        }
    }
    o.mirror = determinant((float3x3)instT) < 0 ? 1 : 0;
    float4 local = mul(float4(pos, 1), instT);
    float4 world = mul(gModel, local);
    float4 view = mul(gView, world);
    float4 clip = mul(gProj, view);
    o.fogDepth = -view.z;
    o.localPosition = pos;
    o.localNormal = normalize(nrm);
    o.attributes = i.attributes;
    o.rawUv = i.uv;
    o.origin = mul(gModel, i.r3).xyz;
    clip.z = 0.5 * (clip.z + clip.w);                       // OpenGL depth range -> D3D
    if (flags & F_FAR_DEPTH) clip.z = clip.w;               // sky domes: gl_Position.z = gl_Position.w
    o.pos = clip;
    float3 uv1 = float3(i.uv, 1);
    o.uv = float2(dot(gUvU.xyz, uv1), dot(gUvV.xyz, uv1));
    o.world = world.xyz;
    float3x3 w = mul((float3x3)gModel, transpose((float3x3)instT));
    o.nrm = cofactorNormal(w, nrm);
    float4 c = (flags & F_VERTEX_COLORS) ? i.col : float4(1, 1, 1, 1);   // rgba vertex colours: alpha too
    if (flags & F_INSTANCE_COLORS) c.rgb *= i.icol;
    o.col = c;
    return o;
}

// Depth pass for light.shadow: one slice of the shadow map array per call
// (directional and spot lights: 1, point lights: 6 cube faces).
VSOut VSShadow(VSIn i) {
    VSOut o = VSMain(i);
    float4 clip = mul(gShadowMatrices[(uint)gShadowPass.y], float4(o.world, 1));
    clip.z = 0.5 * (clip.z + clip.w);
    o.pos = clip;
    return o;
}
void PSShadow(VSOut i) {
    uint flags = (uint)gParams.z;
    if ((flags & F_MAP) && gUvU.w > 0) {
        float a = gColor.a * i.col.a * ((flags & F_MAP_REPEAT) ? gMap.Sample(gRepeat, i.uv).a : gMap.Sample(gClamp, i.uv).a);
        if (a < gUvU.w) discard;   // alphaTest cut-outs (leaves) cast cut-out shadows
    }
}
// Point lights store distance / far (like MeshDistanceMaterial), not depth.
float PSShadowPoint(VSOut i) : SV_Depth {
    PSShadow(i);
    return saturate((length(i.world - gShadowPass2.xyz) - gShadowPass.z) / (gShadowPass2.w - gShadowPass.z));
}
// Three.js PCF for shadow light k: 1 = lit, 0 = in shadow. normalBias moves
// along the normal, bias shifts the compared depth.
float shadowFactor(uint k, float3 world, float3 n) {
    float4 L = gShadowLight[k], L2 = gShadowLight2[k];
    float3 p = world + n * L.z;
    uint slice = (uint)L.x;
    float ref = 0;
    if (L2.x > 0) { // point light: the cube face the point is in
        float3 d = p - gShadowLight3[k].xyz, a = abs(d);
        slice += (a.x >= a.y && a.x >= a.z) ? (d.x > 0 ? 0u : 1u) : (a.y >= a.z) ? (d.y > 0 ? 2u : 3u) : (d.z > 0 ? 4u : 5u);
        ref = (length(d) - L2.w) / (L2.z - L2.w) + L.y;
    }
    float4 s = mul(gShadowMatrices[slice], float4(p, 1));
    if (s.w <= 0) return 1;
    s.xyz /= s.w;
    float2 uv = float2(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
    if (L2.x <= 0) ref = s.z * 0.5 + 0.5 + L.y;
    if (uv.x < 0 || uv.y < 0 || uv.x > 1 || uv.y > 1 || ref > 1) return 1;
    float spread = gShadowPass.x * max(L2.y, 1);
    float sum = 0;
    [unroll] for (int y = -1; y <= 1; y++)
        [unroll] for (int x = -1; x <= 1; x++)
            sum += gShadowMap.SampleCmpLevelZero(gShadowSampler, float3(uv + float2(x, y) * spread, slice), ref);
    return sum / 9;
}

)HLSL" R"HLSL(
float3 toSRGB(float3 c) {
    c = saturate(c);
    return c < 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
float3 fresnel(float3 f0, float vh) { return f0 + (1 - f0) * pow(1 - vh, 5); }
// Three.js <common> helpers used by translated ShaderMaterials.
float luminance(float3 rgb) { return dot(float3(0.2126729, 0.7151522, 0.0721750), rgb); }

// Three.js r181 tone mapping curves (tonemapping_pars_fragment).
float3 rrtOdt(float3 v) { return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081); }
float3 toneMap(float3 c, uint flags) {
    uint curve = (uint)gTone.x;
    if (curve == 0 || (flags & F_NO_TONE_MAP)) return c;
    float e = gTone.y;
    if (curve == 1) return saturate(e * c);
    if (curve == 2) { c *= e; return saturate(c / (1 + c)); }
    if (curve == 3) { c = max(0, c * e - 0.004); return pow((c * (6.2 * c + 0.5)) / (c * (6.2 * c + 1.7) + 0.06), 2.2); }
    if (curve == 7) { // Khronos PBR neutral
        c *= e;
        float x = min(c.r, min(c.g, c.b));
        float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
        c -= off;
        float peak = max(c.r, max(c.g, c.b));
        if (peak < 0.76) return c;
        float d = 1 - 0.76, np = 1 - d * d / (peak + d - 0.76);
        c *= np / peak;
        float g = 1 - 1 / (0.15 * (peak - np) + 1);
        return lerp(c, np * float3(1, 1, 1), g);
    }
    // ACES filmic (AgX is approximated with the same curve)
    c *= e / 0.6;
    c = float3(0.59719, 0.07600, 0.02840) * c.r + float3(0.35458, 0.90834, 0.13383) * c.g + float3(0.04823, 0.01566, 0.83777) * c.b;
    c = rrtOdt(c);
    c = float3(1.60475, -0.10208, -0.00327) * c.r + float3(-0.53108, 1.10813, -0.07276) * c.g + float3(-0.07367, -0.00605, 1.07602) * c.b;
    return saturate(c);
}

float4 shadeOutput(float3 rgb, float alpha, uint flags, float depth) {
    // Render targets keep linear colour without tone mapping (like Three.js);
    // the screen gets tone mapping and sRGB.
    float3 color = gTone.z > 0 ? rgb : toSRGB(toneMap(rgb, flags));
    if ((flags & F_FOG) && gFog.x != 0) {
        float d = gFog.y * depth;
        float f = gFog.x == 2 ? 1 - exp(-d * d) : smoothstep(gFog.y, gFog.z, depth);
        color = lerp(color, gFogColor.rgb, f);
    }
    return float4(color, alpha);
}

// Standard material maps in t1..t6 (normal, roughness, metalness, emissive, ao, alpha).
float4 stdSample(Texture2D t, uint slot, float2 uv, float2 dx, float2 dy) {
    uint bit = 1u << slot;
    if (((uint)gMaterialOptions.y & bit) != 0) return t.SampleGrad(gRepeat, uv, dx, dy);
    if (((uint)gMaterialOptions.z & bit) != 0) return t.SampleGrad(gMirror, uv, dx, dy);
    return t.SampleGrad(gClamp, uv, dx, dy);
}

// NT_COLOR_PATCH_FUNCTION

float4 PSMain(VSOut i, bool front : SV_IsFrontFace) : SV_Target {
    uint flags = (uint)gParams.z;
    if (flags & F_MIRRORED) front = !front;   // reversed winding: SV_IsFrontFace is inverted
    if (flags & F_INSTANCE_MIRRORED) {
        // Some instances are mirrored: drawn without culling, the hidden side is dropped here.
        if (i.mirror > 0.5) front = !front;
        if (!(flags & 2u) && ((flags & 4u) ? front : !front)) discard;
    }
    float3 albedo = gColor.rgb * i.col.rgb;
    float alphaOut = gColor.a * i.col.a;
    float2 uvDx = ddx(i.uv), uvDy = ddy(i.uv);   // outside flow control (mip selection)
    if (flags & F_MAP) {
        float4 t = (flags & F_MAP_REPEAT) ? gMap.SampleGrad(gRepeat, i.uv, uvDx, uvDy)
                 : (flags & F_MAP_MIRROR) ? gMap.SampleGrad(gMirror, i.uv, uvDx, uvDy) : gMap.SampleGrad(gClamp, i.uv, uvDx, uvDy);
        albedo *= t.rgb;
        alphaOut *= t.a;
    }
    float3 dpx = ddx(i.world), dpy = ddy(i.world);
#ifndef NT_COLOR_PATCH
    uint stdMaps = (uint)gMaterialOptions.w;
    if (stdMaps & 32u) alphaOut *= stdSample(gMaterialMap5, 5, i.uv, uvDx, uvDy).g;   // alphaMap
#endif
#ifdef NT_COLOR_PATCH
    float4 patchedColor = float4(albedo, alphaOut);
    float3 patchedNormal = normalize(i.nrm);
    float roughness = gParams.x;
    float skyScale = 1.0;
    float alphaMask = 1.0;
    nativeColorStage(i, patchedColor, patchedNormal, roughness, skyScale, alphaMask);
    albedo = patchedColor.rgb;
    alphaOut = patchedColor.a;
#endif
    if (alphaOut < gUvU.w) discard;   // material.alphaTest
    if (flags & F_UNLIT) {
#ifdef NT_COLOR_PATCH
        alphaOut *= alphaMask;
#endif
        return shadeOutput(albedo, alphaOut, flags, i.fogDepth);
    }
    float3 V = normalize(gCamera.xyz - i.world);
    float3 flatN = normalize(cross(dpx, dpy));
    if (dot(flatN, V) < 0) flatN = -flatN;
    float3 N = normalize(i.nrm);
#ifdef NT_COLOR_PATCH
    N = patchedNormal;
#endif
    if (!front) N = -N;
    if (flags & F_FLAT) N = flatN;
#ifndef NT_COLOR_PATCH
    if ((stdMaps & 1u) && !(flags & F_FLAT)) {
        // normalMap without tangents: Three.js perturbNormal2Arb (screen-space derivatives).
        float3 mapN = stdSample(gMaterialMap0, 0, i.uv, uvDx, uvDy).xyz * 2 - 1;
        mapN.xy *= gStdMap.xy;
        float3 q1perp = cross(dpy, N), q0perp = cross(N, dpx);
        float3 T = q1perp * uvDx.x + q0perp * uvDy.x;
        float3 B = q1perp * uvDx.y + q0perp * uvDy.y;
        float det = max(dot(T, T), dot(B, B));
        float scale = det == 0 ? 0 : rsqrt(det);
        N = normalize(T * (mapN.x * scale) + B * (mapN.y * scale) + N * mapN.z);
    }
#endif
    if (flags & F_NORMAL_COLOR) {
        float3 vn = normalize(mul((float3x3)gView, N));
        return float4(vn * 0.5 + 0.5, alphaOut);
    }
    float metal = saturate(gParams.y);
    float rough = clamp(gParams.x, 0.04, 1.0);
#ifdef NT_COLOR_PATCH
    rough = clamp(roughness, 0.04, 1.0);
#endif
    float3 emissive = gEmissive.rgb;
    float ao = 1;
#ifndef NT_COLOR_PATCH
    if (stdMaps & 2u) rough = clamp(rough * stdSample(gMaterialMap1, 1, i.uv, uvDx, uvDy).g, 0.04, 1.0);
    if (stdMaps & 4u) metal = saturate(metal * stdSample(gMaterialMap2, 2, i.uv, uvDx, uvDy).b);
    if (stdMaps & 8u) emissive *= stdSample(gMaterialMap3, 3, i.uv, uvDx, uvDy).rgb;
    if (stdMaps & 16u) ao = lerp(1, stdSample(gMaterialMap4, 4, i.uv, uvDx, uvDy).r, gStdMap.z);
#endif
    float alpha = rough * rough;
    float shininess = gEmissive.w;
    float3 diffuse = albedo * (1 - metal);
    float3 f0 = lerp(float3(0.04, 0.04, 0.04), albedo, metal);
    float3 indirect = gAmbient.rgb;
    float3 direct = 0;
    bool receive = ((uint)gParams.w & 2u) != 0;   // mesh.receiveShadow
    float3 geometric = normalize(i.nrm);
    if (!front) geometric = -geometric;
    uint count = (uint)gCamera.w;
    for (uint li = 0; li < count; li++) {
        float4 a = gLights[li * 4 + 0], b = gLights[li * 4 + 1], c = gLights[li * 4 + 2], d = gLights[li * 4 + 3];
        uint type = (uint)a.x;
        float3 color = a.yzw;
        if (type == 2) { // hemisphere: sky colour in a, up direction in c, ground colour in d
            float weight = 0.5 * dot(N, c.xyz) + 0.5;
            indirect += lerp(d.xyz, color, weight);
            continue;
        }
        float3 L;
        float attenuation = 1;
        if (type == 3) L = -c.xyz;
        else {
            float3 toLight = b.xyz - i.world;
            float dist = length(toLight);
            L = toLight / max(dist, 1e-5);
            float cutoff = b.w, decay = c.w;
            attenuation = 1.0 / max(pow(dist, decay), 0.01);
            if (cutoff > 0) { float r = saturate(1 - pow(dist / cutoff, 4)); attenuation *= r * r; }
            if (type == 5) attenuation *= smoothstep(d.x, d.y, dot(-L, c.xyz));
        }
        uint sk = (uint)d.w;   // shadow light + 1
        if (sk > 0 && receive && attenuation > 0)
            attenuation *= lerp(1, shadowFactor(sk - 1, i.world, geometric), saturate(gShadowLight[sk - 1].w));
        float nl = saturate(dot(N, L));
        if (nl <= 0 || attenuation <= 0) continue;
        float3 irradiance = color * (nl * attenuation);
        float3 H = normalize(L + V);
        float nh = saturate(dot(N, H)), vh = saturate(dot(V, H)), nv = saturate(dot(N, V)) + 1e-4;
        float3 spec;
        if (shininess >= 0) {
            float D = (shininess * 0.5 + 1) / PI * pow(nh, shininess);
            spec = fresnel(float3(0.0056, 0.0056, 0.0056), vh) * 0.25 * D;
        } else {
            float a2 = alpha * alpha;
            float denom = nh * nh * (a2 - 1) + 1;
            float D = a2 / (PI * denom * denom);
            float gl = nv * sqrt(a2 + (1 - a2) * nl * nl);
            float gv = nl * sqrt(a2 + (1 - a2) * nv * nv);
            float vis = 0.5 / max(gl + gv, 1e-5);
            spec = fresnel(f0, vh) * vis * D;
        }
        direct += irradiance * (diffuse / PI + spec);
    }
    float3 lit = indirect * ao * diffuse / PI + direct + emissive;
    if (flags & F_FRESNEL) {
        float angle = 1 - saturate(dot(N, V));
        float amount = saturate(gFresnel.x + gFresnel.y * pow(angle, gFresnel.z));
        float3 sky = gReflection.rgb;
#ifdef NT_COLOR_PATCH
        sky *= skyScale;
#endif
        lit = lerp(lit, sky, amount * gReflection.w);
        if (gFresnel.w < 0) alphaOut = saturate(gColor.a - amount * gFresnel.w) * i.col.a;
        else alphaOut = saturate(alphaOut + amount * gFresnel.w);
    }
#ifdef NT_COLOR_PATCH
    alphaOut *= alphaMask;
#endif
    return shadeOutput(lit, alphaOut, flags, i.fogDepth);
}
)HLSL";
