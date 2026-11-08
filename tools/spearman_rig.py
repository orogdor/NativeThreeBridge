"""Automatic 8-bone rig for the pinned, originally unskinned odamees.glb.

Builds a valid glTF 2.0 skin with JOINTS_0 / WEIGHTS_0 and inverse bind
matrices in the original mesh local coordinates. This is deliberately a
first-pass envelope rig, not artist-painted weights.  It is used by the red
army only in NativeThreeBridge; blue soldiers remain the v0.21 baseline.
"""
from __future__ import annotations
import json
import math
import struct
from pathlib import Path

# Ordered joints and their absolute rest-pose pivots (model units). Indices
# are part of the shader contract; do not reorder without updating it.
BONES = (
    ("Pelvis", None, (0.0, -0.12, 0.0)),
    ("Spine", 0, (0.0, 0.11, 0.0)),
    ("Thigh.L", 0, (-0.07, -0.13, 0.0)),
    ("Shin.L", 2, (-0.07, -0.31, 0.0)),
    ("Thigh.R", 0, (0.07, -0.13, 0.0)),
    ("Shin.R", 4, (0.07, -0.31, 0.0)),
    ("Arm.L", 1, (-0.17, 0.18, 0.0)),
    ("Arm.R", 1, (0.17, 0.18, 0.0)),
)
SKIN_MAGIC = b"NTS1"
SKIN_STRIDE = 32  # uint4 joint + float4 weights

def clamp(v: float) -> float:
    return max(0.0, min(1.0, v))

def smooth(a: float, b: float, v: float) -> float:
    t=clamp((v-a)/(b-a))
    return t*t*(3.0-2.0*t)

def influence(position):
    x,y,z=(float(c) for c in position)
    side=smooth(-0.045,0.045,x)
    leg=smooth(-0.075,-0.22,y)*(1.0-smooth(0.17,0.255,abs(x)))*0.98
    shin=smooth(-0.25,-0.37,y)
    arm=smooth(0.08,0.20,y)*smooth(0.085,0.165,abs(x)) * (1.0-smooth(0.205,0.27,abs(x)))*0.88
    # Leg and arm envelopes never take more than the full vertex mass.
    arm*=1.0-leg
    spine=smooth(-0.035,0.10,y)*0.48*(1.0-leg-arm)
    weights={
        0:max(0.0,1.0-leg-arm-spine),
        1:spine,
        2:leg*(1.0-side)*(1.0-shin),
        3:leg*(1.0-side)*shin,
        4:leg*side*(1.0-shin),
        5:leg*side*shin,
        6:arm*(1.0-side),
        7:arm*side,
    }
    ranked=sorted(((i,w) for i,w in weights.items() if w>1.e-8),
                  key=lambda x:(-x[1],x[0]))[:4]
    if not ranked:
        ranked=[(0,1.0)]
    total=sum(w for _,w in ranked)
    indices=[i for i,_ in ranked]+[0]*(4-len(ranked))
    values=[w/total for _,w in ranked]+[0.0]*(4-len(ranked))
    assert len(indices)==len(values)==4 and abs(sum(values)-1)<1.e-6
    return tuple(indices),tuple(values)

def _align(buffer: bytearray, alignment: int=4):
    buffer.extend(b"\\x00"*((-len(buffer))%alignment))

def _append_accessor(doc, blob, content, component_type, kind, count, target=None):
    _align(blob)
    offset=len(blob)
    blob.extend(content)
    view={"buffer":0,"byteOffset":offset,"byteLength":len(content)}
    if target is not None:
        view["target"]=target
    vi=len(doc.setdefault("bufferViews",[]))
    doc["bufferViews"].append(view)
    ai=len(doc.setdefault("accessors",[]))
    doc["accessors"].append({
        "bufferView":vi,"byteOffset":0,"componentType":component_type,
        "count":count,"type":kind
    })
    return ai

def rig_geometry(doc, original_bin: bytes, positions):
    if doc.get("skins") or doc.get("animations"):
        raise ValueError("Pinned original mesh is no longer unrigged; inspect before changing")
    primitive=doc["meshes"][0]["primitives"][0]
    if "JOINTS_0" in primitive["attributes"]:
        raise ValueError("Original mesh already contains skin weights")
    if len(positions)<100:
        raise ValueError("Expected original spearman mesh with hundreds of vertices")
    influences=[influence(v) for v in positions]
    blob=bytearray(original_bin)
    joint_bytes=b"".join(struct.pack("<4H",*ids) for ids,_ in influences)
    weight_bytes=b"".join(struct.pack("<4f",*values) for _,values in influences)
    joints=_append_accessor(doc,blob,joint_bytes,5123,"VEC4",len(positions),34962)
    weights=_append_accessor(doc,blob,weight_bytes,5126,"VEC4",len(positions),34962)
    primitive["attributes"]["JOINTS_0"]=joints
    primitive["attributes"]["WEIGHTS_0"]=weights
    nodes=doc["nodes"]
    first=len(nodes)
    for name,parent,pivot in BONES:
        absolute_parent=(0.0,0.0,0.0) if parent is None else BONES[parent][2]
        relative=[pivot[i]-absolute_parent[i] for i in range(3)]
        nodes.append({"name":name,"translation":relative,"children":[]})
    for i,(_,parent,_) in enumerate(BONES):
        if parent is not None:
            nodes[first+parent]["children"].append(first+i)
    for bone in nodes[first:]:
        if not bone["children"]:
            del bone["children"]
    mesh_node=next(i for i,n in enumerate(nodes[:first]) if n.get("mesh")==0)
    nodes[mesh_node]["skin"]=len(doc.setdefault("skins",[]))
    parent_node=next((n for n in nodes[:first]
        if mesh_node in n.get("children",[])),None)
    if parent_node is not None:
        parent_node["children"].append(first)
    else:
        doc["scenes"][doc.get("scene",0)]["nodes"].append(first)
    inverse_matrices=bytearray()
    for _,_,(x,y,z) in BONES:
        inverse_matrices.extend(struct.pack("<16f",
            1,0,0,0,0,1,0,0,0,0,1,0,-x,-y,-z,1))
    inverse=_append_accessor(doc,blob,inverse_matrices,5126,"MAT4",len(BONES))
    doc["skins"].append({
        "name":"OdameesAutoRig8",
        "joints":[first+i for i in range(len(BONES))],
        "skeleton":first,
        "inverseBindMatrices":inverse
    })
    doc["buffers"][0]["byteLength"]=len(blob)
    doc.setdefault("extras",{})["nativeThreeRig"]={
        "name":"OdameesAutoRig8","method":"procedural-envelope-v1",
        "boneCount":len(BONES),
        "boneNames":[b[0] for b in BONES],
        "army":"red"
    }
    return doc,bytes(blob),influences

def write_glb(path: Path, doc, binary: bytes):
    js=json.dumps(doc,separators=(",",":"),ensure_ascii=False).encode("utf-8")
    js+=b" "*((-len(js))%4)
    binary+=b"\\x00"*((-len(binary))%4)
    total=12+8+len(js)+8+len(binary)
    path.write_bytes(
        struct.pack("<4sII",b"glTF",2,total)
        +struct.pack("<I4s",len(js),b"JSON")+js
        +struct.pack("<I4s",len(binary),b"BIN\\x00")+binary
    )

def write_native_rig(path: Path,influences):
    out=bytearray(struct.pack("<4sIII",SKIN_MAGIC,len(influences),
                    len(BONES),SKIN_STRIDE))
    for joints,weights in influences:
        out.extend(struct.pack("<4I4f",*joints,*weights))
    path.write_bytes(out)
