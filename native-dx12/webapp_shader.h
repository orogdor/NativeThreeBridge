#pragma once
// HLSL for the generic webapp renderer (webapp_dx12.cpp). Approximates the
// Three.js r181 MeshStandard/Lambert/Phong/Basic lighting with
// physically based light units (same light intensities as WebGLRenderer).
// Kept well below MSVC's 16 KB string-literal limit.
static const char* kWebappShader = R"HLSL(
cbuffer Frame : register(b0) {
    float4x4 gView;
    float4x4 gProj;
    float4 gCamera;   // xyz position, w light count
    float4 gAmbient;  // rgb ambient irradiance, w exposure
    float4 gLights[64];
    float4 gTone;     // x tone mapping curve (THREE.*ToneMapping), y exposure
    float4 gFogColor;
    float4 gFog;      // mode, near or density, far
};
cbuffer Draw : register(b1) {
    float4x4 gModel;
    float4 gColor;    // linear rgb, opacity
    float4 gEmissive; // linear rgb, w shininess (<0: physical)
    float4 gParams;   // roughness, metalness, flags, unused
    float4 gUvU;      // u' = dot(xyz, (u, v, 1)); w alphaTest
    float4 gUvV;      // v' = dot(xyz, (u, v, 1))
};
Texture2D gMap : register(t0);
SamplerState gRepeat : register(s0);
SamplerState gClamp : register(s1);
SamplerState gMirror : register(s2);
static const uint F_VERTEX_COLORS = 8, F_UNLIT = 16, F_NORMAL_COLOR = 512, F_INSTANCE_COLORS = 1024, F_FLAT = 2048,
                  F_MAP = 4096, F_MAP_REPEAT = 8192, F_MAP_MIRROR = 16384, F_FAR_DEPTH = 32768, F_NO_TONE_MAP = 65536, F_FOG = 131072;
static const float PI = 3.14159265;

struct VSIn {
    float3 pos : POSITION; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0;
    float4 r0 : IROW0; float4 r1 : IROW1; float4 r2 : IROW2; float4 r3 : IROW3;
    float3 icol : ICOLOR;
};
struct VSOut {
    float4 pos : SV_Position; float3 world : WORLDPOS; float3 nrm : NORMAL; float4 col : COLOR; float2 uv : TEXCOORD0; float fogDepth : TEXCOORD1;
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
    float4 local = mul(float4(i.pos, 1), instT);
    float4 world = mul(gModel, local);
    float4 view = mul(gView, world);
    float4 clip = mul(gProj, view);
    o.fogDepth = -view.z;
    clip.z = 0.5 * (clip.z + clip.w);                       // OpenGL depth range -> D3D
    if (flags & F_FAR_DEPTH) clip.z = clip.w;               // sky domes: gl_Position.z = gl_Position.w
    o.pos = clip;
    float3 uv1 = float3(i.uv, 1);
    o.uv = float2(dot(gUvU.xyz, uv1), dot(gUvV.xyz, uv1));
    o.world = world.xyz;
    float3x3 w = mul((float3x3)gModel, transpose((float3x3)instT));
    o.nrm = cofactorNormal(w, i.nrm);
    float4 c = (flags & F_VERTEX_COLORS) ? i.col : float4(1, 1, 1, 1);   // rgba vertex colours: alpha too
    if (flags & F_INSTANCE_COLORS) c.rgb *= i.icol;
    o.col = c;
    return o;
}

float3 toSRGB(float3 c) {
    c = saturate(c);
    return c < 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
float3 fresnel(float3 f0, float vh) { return f0 + (1 - f0) * pow(1 - vh, 5); }

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
    float3 color = toSRGB(toneMap(rgb, flags));
    if ((flags & F_FOG) && gFog.x != 0) {
        float d = gFog.y * depth;
        float f = gFog.x == 2 ? 1 - exp(-d * d) : smoothstep(gFog.y, gFog.z, depth);
        color = lerp(color, gFogColor.rgb, f);
    }
    return float4(color, alpha);
}

float4 PSMain(VSOut i, bool front : SV_IsFrontFace) : SV_Target {
    uint flags = (uint)gParams.z;
    float3 albedo = gColor.rgb * i.col.rgb;
    float alphaOut = gColor.a * i.col.a;
    float2 uvDx = ddx(i.uv), uvDy = ddy(i.uv);   // outside flow control (mip selection)
    if (flags & F_MAP) {
        float4 t = (flags & F_MAP_REPEAT) ? gMap.SampleGrad(gRepeat, i.uv, uvDx, uvDy)
                 : (flags & F_MAP_MIRROR) ? gMap.SampleGrad(gMirror, i.uv, uvDx, uvDy) : gMap.SampleGrad(gClamp, i.uv, uvDx, uvDy);
        albedo *= t.rgb;
        alphaOut *= t.a;
    }
    if (alphaOut < gUvU.w) discard;   // material.alphaTest
    if (flags & F_UNLIT) return shadeOutput(albedo, alphaOut, flags, i.fogDepth);
    float3 V = normalize(gCamera.xyz - i.world);
    float3 flatN = normalize(cross(ddx(i.world), ddy(i.world)));
    if (dot(flatN, V) < 0) flatN = -flatN;
    float3 N = normalize(i.nrm);
    if (!front) N = -N;
    if (flags & F_FLAT) N = flatN;
    if (flags & F_NORMAL_COLOR) {
        float3 vn = normalize(mul((float3x3)gView, N));
        return float4(vn * 0.5 + 0.5, alphaOut);
    }
    float metal = saturate(gParams.y);
    float rough = clamp(gParams.x, 0.04, 1.0);
    float alpha = rough * rough;
    float shininess = gEmissive.w;
    float3 diffuse = albedo * (1 - metal);
    float3 f0 = lerp(float3(0.04, 0.04, 0.04), albedo, metal);
    float3 indirect = gAmbient.rgb;
    float3 direct = 0;
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
    float3 lit = indirect * diffuse / PI + direct + gEmissive.rgb;
    return shadeOutput(lit, alphaOut, flags, i.fogDepth);
}
)HLSL";
