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
};
cbuffer Draw : register(b1) {
    float4x4 gModel;
    float4 gColor;    // linear rgb, opacity
    float4 gEmissive; // linear rgb, w shininess (<0: physical)
    float4 gParams;   // roughness, metalness, flags, unused
};
static const uint F_VERTEX_COLORS = 8, F_UNLIT = 16, F_NORMAL_COLOR = 512, F_INSTANCE_COLORS = 1024, F_FLAT = 2048;
static const float PI = 3.14159265;

struct VSIn {
    float3 pos : POSITION; float3 nrm : NORMAL; float3 col : COLOR;
    float4 r0 : IROW0; float4 r1 : IROW1; float4 r2 : IROW2; float4 r3 : IROW3;
    float3 icol : ICOLOR;
};
struct VSOut {
    float4 pos : SV_Position; float3 world : WORLDPOS; float3 nrm : NORMAL; float3 col : COLOR;
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
    float4 clip = mul(gProj, mul(gView, world));
    clip.z = 0.5 * (clip.z + clip.w);                       // OpenGL depth range -> D3D
    o.pos = clip;
    o.world = world.xyz;
    float3x3 w = mul((float3x3)gModel, transpose((float3x3)instT));
    o.nrm = cofactorNormal(w, i.nrm);
    float3 c = (flags & F_VERTEX_COLORS) ? i.col : float3(1, 1, 1);
    if (flags & F_INSTANCE_COLORS) c *= i.icol;
    o.col = c;
    return o;
}

float3 toSRGB(float3 c) {
    c = saturate(c);
    return c < 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
float3 fresnel(float3 f0, float vh) { return f0 + (1 - f0) * pow(1 - vh, 5); }

float4 PSMain(VSOut i, bool front : SV_IsFrontFace) : SV_Target {
    uint flags = (uint)gParams.z;
    float3 albedo = gColor.rgb * i.col;
    if (flags & F_UNLIT) return float4(toSRGB(albedo), gColor.a);
    float3 V = normalize(gCamera.xyz - i.world);
    float3 flatN = normalize(cross(ddx(i.world), ddy(i.world)));
    if (dot(flatN, V) < 0) flatN = -flatN;
    float3 N = normalize(i.nrm);
    if (!front) N = -N;
    if (flags & F_FLAT) N = flatN;
    if (flags & F_NORMAL_COLOR) {
        float3 vn = normalize(mul((float3x3)gView, N));
        return float4(vn * 0.5 + 0.5, gColor.a);
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
    return float4(toSRGB(lit * gAmbient.w), gColor.a);
}
)HLSL";
