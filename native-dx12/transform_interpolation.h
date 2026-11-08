#pragma once
// Generic interpolation of Three.js column-major affine 4x4 instance matrices.
// The renderer runs independently of the 60 Hz simulation. Interpolate BOTH
// position and orientation; copying the latest rotation causes visible micro-
// jumps when the camera follows a soldier at >100 FPS.
// Yaw-only cases (the 1k-unit battle) use the inexpensive common path; any
// other orientation falls back to quaternion nlerp with optional scale.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <initializer_list>

namespace native_three {
struct PoseQuat { float x=0,y=0,z=0,w=1; };
inline PoseQuat quatFromMatrix(const float* m,float sx,float sy,float sz) {
    const float a=m[0]/sx, b=m[4]/sy, c=m[8]/sz;
    const float d=m[1]/sx, e=m[5]/sy, f=m[9]/sz;
    const float g=m[2]/sx, h=m[6]/sy, i=m[10]/sz;
    PoseQuat q;
    const float trace=a+e+i;
    if(trace>0){
        const float s=std::sqrt(trace+1.f)*2.f;
        q.w=0.25f*s;q.x=(h-f)/s;q.y=(c-g)/s;q.z=(d-b)/s;
    }else if(a>e && a>i){
        const float s=std::sqrt(std::max(0.f,1.f+a-e-i))*2.f;
        if(s<1e-6f)return q;
        q.w=(h-f)/s;q.x=0.25f*s;q.y=(b+d)/s;q.z=(c+g)/s;
    }else if(e>i){
        const float s=std::sqrt(std::max(0.f,1.f+e-a-i))*2.f;
        if(s<1e-6f)return q;
        q.w=(c-g)/s;q.x=(b+d)/s;q.y=0.25f*s;q.z=(f+h)/s;
    }else{
        const float s=std::sqrt(std::max(0.f,1.f+i-a-e))*2.f;
        if(s<1e-6f)return q;
        q.w=(d-b)/s;q.x=(c+g)/s;q.y=(f+h)/s;q.z=0.25f*s;
    }
    return q;
}
inline void interpolateAffine(const float* oldM,const float* newM,float fraction,
                              float* out) {
    const float t=std::clamp(fraction,0.f,1.f);
    if(t<=0.f){std::memcpy(out,oldM,16*sizeof(float));return;}
    if(t>=1.f){std::memcpy(out,newM,16*sizeof(float));return;}
    std::memcpy(out,newM,16*sizeof(float));
    for(const int k:{12,13,14})out[k]=oldM[k]+(newM[k]-oldM[k])*t;
    constexpr int rotation[9]={0,1,2,4,5,6,8,9,10};
    bool same=true;
    for(int k:rotation)if(oldM[k]!=newM[k]){same=false;break;}
    if(same)return;
    const bool yawOnly=std::abs(oldM[1])+std::abs(oldM[4])+
        std::abs(oldM[6])+std::abs(oldM[9])+
        std::abs(newM[1])+std::abs(newM[4])+
        std::abs(newM[6])+std::abs(newM[9])<1e-5f &&
        oldM[5]>0 && newM[5]>0;
    if(yawOnly){
        // Follow shortest arc, including crossing the -pi/+pi boundary.
        const float a=std::atan2(oldM[8],oldM[0]);
        const float b=std::atan2(newM[8],newM[0]);
        const float delta=std::atan2(std::sin(b-a),std::cos(b-a));
        const float angle=a+delta*t;
        const float cs=std::cos(angle),sn=std::sin(angle);
        const float oldSX=std::hypot(oldM[0],oldM[2]);
        const float newSX=std::hypot(newM[0],newM[2]);
        const float oldSZ=std::hypot(oldM[8],oldM[10]);
        const float newSZ=std::hypot(newM[8],newM[10]);
        const float sx=oldSX+(newSX-oldSX)*t;
        const float sz=oldSZ+(newSZ-oldSZ)*t;
        out[0]=cs*sx;out[2]=-sn*sx;
        out[5]=oldM[5]+(newM[5]-oldM[5])*t;
        out[8]=sn*sz;out[10]=cs*sz;
        return;
    }
    // Generic 3D rotations (pitch/roll/yaw) and per-axis positive scale.
    const auto magnitude=[](const float* m,int i){
        return std::sqrt(m[i]*m[i]+m[i+1]*m[i+1]+m[i+2]*m[i+2]);
    };
    const float ax=magnitude(oldM,0),ay=magnitude(oldM,4),az=magnitude(oldM,8);
    const float bx=magnitude(newM,0),by=magnitude(newM,4),bz=magnitude(newM,8);
    if(std::min({ax,ay,az,bx,by,bz})<1e-6f)return;
    PoseQuat a=quatFromMatrix(oldM,ax,ay,az);
    PoseQuat b=quatFromMatrix(newM,bx,by,bz);
    const float dot=a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w;
    if(dot<0){b.x=-b.x;b.y=-b.y;b.z=-b.z;b.w=-b.w;}
    PoseQuat q{a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,
               a.z+(b.z-a.z)*t,a.w+(b.w-a.w)*t};
    const float len=std::sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w);
    if(len<1e-6f)return;
    q.x/=len;q.y/=len;q.z/=len;q.w/=len;
    const float xx=q.x*q.x,yy=q.y*q.y,zz=q.z*q.z;
    const float xy=q.x*q.y,xz=q.x*q.z,yz=q.y*q.z;
    const float wx=q.w*q.x,wy=q.w*q.y,wz=q.w*q.z;
    const float sx=ax+(bx-ax)*t,sy=ay+(by-ay)*t,sz=az+(bz-az)*t;
    out[0]=(1.f-2.f*(yy+zz))*sx;
    out[1]=(2.f*(xy+wz))*sx;
    out[2]=(2.f*(xz-wy))*sx;
    out[4]=(2.f*(xy-wz))*sy;
    out[5]=(1.f-2.f*(xx+zz))*sy;
    out[6]=(2.f*(yz+wx))*sy;
    out[8]=(2.f*(xz+wy))*sz;
    out[9]=(2.f*(yz-wx))*sz;
    out[10]=(1.f-2.f*(xx+yy))*sz;
}
} // namespace native_three
