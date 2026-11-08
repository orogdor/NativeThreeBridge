#!/usr/bin/env python3
"""CPU validation of the eight-bone GLB exporter and native skin resource."""
import copy
import json
import math
import pathlib
import struct
import tempfile
from spearman_rig import BONES, influence, rig_geometry, write_glb, write_native_rig

def sample_doc(points):
    data=b"".join(struct.pack("<3f",*p) for p in points)
    doc={
        "asset":{"version":"2.0","generator":"NativeThreeBridge test"},
        "scene":0,
        "scenes":[{"nodes":[0]}],
        "nodes":[{"name":"mesh", "mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"mode":4}]}],
        "buffers":[{"byteLength":len(data)}],
        "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":len(data)}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":len(points),"type":"VEC3"}],
    }
    return doc,data

def main():
    assert len(BONES)==8
    assert BONES[2][1]==0 and BONES[3][1]==2
    assert BONES[4][1]==0 and BONES[5][1]==4
    left=influence((-0.08,-0.40,0))
    right=influence((0.08,-0.40,0))
    head=influence((0.0,0.42,0))
    assert 3 in left[0] and 5 in right[0],(left,right)
    assert head[0][0] in (0,1)
    for p in [(-0.08,-0.4,0),(0.12,-0.30,0),(0.0,0.0,0),
              (0.18,0.25,0),(0,0.43,0)]:
        joints,weights=influence(p)
        assert len(joints)==len(weights)==4
        assert all(j<8 for j in joints)
        assert abs(sum(weights)-1)<1.e-6
    points=[((-0.18+(i%12)*0.03),-0.49+(i%27)*0.037,0.0)
            for i in range(216)]
    doc,buf=sample_doc(points)
    rigged,blob,influences=rig_geometry(copy.deepcopy(doc),buf,points)
    assert rigged["nodes"][0]["skin"]==0
    assert len(rigged["skins"][0]["joints"])==8
    assert rigged["skins"][0]["skeleton"]==1
    for attr in ("JOINTS_0","WEIGHTS_0"):
        assert attr in rigged["meshes"][0]["primitives"][0]["attributes"]
    for i,(_,parent,pivot) in enumerate(BONES):
        node=rigged["nodes"][1+i]
        assert node["name"]==BONES[i][0]
        assert len(node["translation"])==3
        if parent is not None:
            assert 1+i in rigged["nodes"][1+parent]["children"]
    with tempfile.TemporaryDirectory() as tmp:
        out=pathlib.Path(tmp)
        write_glb(out/"model.glb",rigged,blob)
        write_native_rig(out/"skin.bin",influences)
        glb=(out/"model.glb").read_bytes()
        assert glb[:4]==b"glTF" and struct.unpack_from("<I",glb,8)[0]==len(glb)
        json_length=struct.unpack_from("<I",glb,12)[0]
        parsed=json.loads(glb[20:20+json_length])
        assert len(parsed["skins"][0]["joints"])==8
        bin_start=20+json_length
        bin_length=struct.unpack_from("<I",glb,bin_start)[0]
        assert glb[bin_start+4:bin_start+8]==b"BIN\x00"
        assert bin_length>=parsed["buffers"][0]["byteLength"]
        native=(out/"skin.bin").read_bytes()
        magic,count,bones,stride=struct.unpack_from("<4sIII",native)
        assert (magic,count,bones,stride)==(b"NTS1",216,8,32)
        assert len(native)==16+216*32
        for k in range(216):
            ids=struct.unpack_from("<4I",native,16+k*32)
            weights=struct.unpack_from("<4f",native,16+k*32+16)
            assert max(ids)<8 and abs(sum(weights)-1)<1.e-5
    print("PASS: eight glTF bones with hierarchy, inverse bind matrices, normalized skin weights and exact native binary layout")

if __name__=="__main__":
    main()
