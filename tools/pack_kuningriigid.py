#!/usr/bin/env python3
"""Pack two original Kuningriigid GLB assets into the resource-based native DX12 demo.

Requirements (build time only): Python 3.11+ and Pillow.
The Windows executable itself uses no Python, Chromium, Node or Deno.
"""
from __future__ import annotations
import hashlib
import io
import json
import pathlib
import struct
import urllib.request

from PIL import Image

SOURCE_COMMIT = "e2bee672d626429d3f91b6158088eac23eee8c13"
FILES = [
    ("soldier", "models-trellis-v262/odamees.glb",
     "96cdcb8ef0ac5107dc63a494d3b1ddffe840bf46"),
    ("pine", "assets/sapling-trees/pine_01/mid.glb",
     "da4e3cf4f358a742a65e73f5b140b17e3207fa3b"),
]
TYPES = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

def download_assets(folder: pathlib.Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for label, path, digest in FILES:
        url = ("https://raw.githubusercontent.com/orogdor/Kuningriigid/"
               + SOURCE_COMMIT + "/" + path)
        print("Downloading:", url, flush=True)
        req = urllib.request.Request(url, headers={"User-Agent":"NativeThreeBridge-asset-build"})
        with urllib.request.urlopen(req, timeout=90) as res:
            raw = res.read()
        computed = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\x00" + raw).hexdigest()
        if computed != digest:
            raise ValueError(f"Source asset SHA mismatch: {path}: {computed} != {digest}")
        (folder / (label + ".glb")).write_bytes(raw)

def read_glb(path: pathlib.Path):
    raw = path.read_bytes()
    if len(raw) < 28 or raw[:4] != b"glTF":
        raise ValueError("Not a GLB: " + str(path))
    magic, version, total = struct.unpack_from("<III", raw)
    if version != 2 or total != len(raw):
        raise ValueError("Invalid GLB header")
    offset, doc, buffer = 12, None, None
    while offset + 8 <= len(raw):
        length, typ = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        data = raw[offset:offset+length]
        if len(data) != length:
            raise ValueError("Truncated GLB chunk")
        if typ == b"JSON":
            doc = json.loads(data)
        if typ == b"BIN\x00":
            buffer = data
        offset += length
    if doc is None or buffer is None:
        raise ValueError("GLB JSON/BIN missing")
    return doc, buffer

def accessor_values(doc, buf, idx):
    acc = doc["accessors"][idx]
    if "sparse" in acc:
        raise ValueError("Sparse accessors not supported in v0.5")
    view = doc["bufferViews"][acc["bufferView"]]
    n = SIZES[acc["type"]]
    fmt = TYPES[acc["componentType"]]
    width = struct.calcsize("<" + fmt*n)
    start = int(view.get("byteOffset",0)) + int(acc.get("byteOffset",0))
    stride = int(view.get("byteStride",width))
    if stride < width or start + stride*(acc["count"]-1) + width > len(buf):
        raise ValueError("Invalid accessor bounds")
    st = struct.Struct("<" + fmt*n)
    return [st.unpack_from(buf,start + i*stride) for i in range(acc["count"])]

def texture_rgba(doc, buf, mat):
    if not mat:
        return (1,1,b"\xff\xff\xff\xff")
    texture = mat.get("pbrMetallicRoughness",{}).get("baseColorTexture")
    if texture is None:
        return (1,1,b"\xff\xff\xff\xff")
    tex = doc["textures"][texture["index"]]
    source = tex.get("source", tex.get("extensions",{}).get("EXT_texture_webp",{}).get("source"))
    if source is None:
        raise ValueError("Unsupported GLB texture source")
    image = doc["images"][source]
    if "bufferView" not in image:
        raise ValueError("External GLB textures not supported")
    view = doc["bufferViews"][image["bufferView"]]
    offset = int(view.get("byteOffset",0))
    encoded = buf[offset:offset+view["byteLength"]]
    with Image.open(io.BytesIO(encoded)) as img:
        img = img.convert("RGBA")
        if img.width > 4096 or img.height > 4096:
            raise ValueError("Image too large")
        return img.width,img.height,img.tobytes()

def build_mesh(doc, buf, primitive, out_mesh, out_tex):
    pos = accessor_values(doc,buf,primitive["attributes"]["POSITION"])
    norm = accessor_values(doc,buf,primitive["attributes"]["NORMAL"]) if "NORMAL" in primitive["attributes"] else [(0,1,0)]*len(pos)
    uv = accessor_values(doc,buf,primitive["attributes"]["TEXCOORD_0"]) if "TEXCOORD_0" in primitive["attributes"] else [(0,0)]*len(pos)
    idx = accessor_values(doc,buf,primitive["indices"])
    if primitive.get("mode",4) != 4:
        raise ValueError("Only triangles supported")
    if not (len(pos) == len(norm) == len(uv)):
        raise ValueError("Mismatched GLB attributes")
    vertices = b"".join(struct.pack("<8f",*(tuple(map(float,pos[i]))+tuple(map(float,norm[i]))+tuple(map(float,uv[i])))) for i in range(len(pos)))
    indices = b"".join(struct.pack("<I",int(n[0])) for n in idx)
    out_mesh.write_bytes(struct.pack("<4sIII",b"NTM1",len(pos),len(idx),0) + vertices + indices)
    mat = doc.get("materials",[{}])[primitive.get("material",0)]
    w,h,rgba = texture_rgba(doc,buf,mat)
    # Precompute the entire mip pyramid offline instead of regenerating it
    # while loading the game. Keep a single resource with a versioned header.
    texture_image=Image.frombytes("RGBA",(w,h),rgba)
    mipmaps=[]
    original_coverage=sum(a>=102 for a in rgba[3::4])/(w*h)
    while True:
        level=texture_image.copy()
        if mat.get("alphaMode") == "MASK" and len(mipmaps)>0 and original_coverage>0:
            # Histogram-based binary search avoids rescanning millions of pixels
            # on each of the 12 alpha-coverage iterations.
            alpha=level.getchannel("A")
            hist=alpha.histogram()
            lo,hi=0.0,8.0
            for _ in range(12):
                scale=(lo+hi)*0.5
                coverage=sum(hist[v] for v in range(256)
                             if min(255,round(v*scale))>=102)/(level.width*level.height)
                if coverage<original_coverage:lo=scale
                else:hi=scale
            level.putalpha(alpha.point(lambda v:min(255,round(v*hi))))
        mipmaps.append(level.tobytes())
        if texture_image.width==1 and texture_image.height==1:break
        texture_image=texture_image.resize(
            (max(1,texture_image.width//2),max(1,texture_image.height//2)),
            Image.Resampling.BOX)
    out_tex.write_bytes(struct.pack("<4sIII",b"NTX2",w,h,len(mipmaps))+b"".join(mipmaps))
    return {"vertices":len(pos),"triangles":len(idx)//3,
            "texture":f"{w}x{h}","material":mat.get("name",""),
            "alpha_mask":mat.get("alphaMode") == "MASK",
            "color":mat.get("pbrMetallicRoughness",{}).get("baseColorFactor",[1,1,1,1])}

def main():
    work=pathlib.Path("generated")
    download_assets(work)
    print("Converting original Kuningriigid spearman and Sapling pine ...")
    allparts = []
    for name in ("soldier","pine"):
        doc,buf=read_glb(work/(name+".glb"))
        for mesh in doc.get("meshes",[]):
            for primitive in mesh.get("primitives",[]):
                i=len(allparts)
                out_m=work/f"mesh{i}.bin"
                out_t=work/f"tex{i}.bin"
                info=build_mesh(doc,buf,primitive,out_m,out_t)
                info.update({"source":name,"mesh_resource":101+i,"tex_resource":201+i})
                allparts.append(info)
    if [p["source"] for p in allparts] != ["soldier","pine","pine"]:
        raise ValueError(f"Unexpected mesh parts: {allparts}")
    rc = "// Generated from verified Kuningriigid GLB files; compiled inside EXE.\n"
    for i in range(len(allparts)):
        rc += f'{101+i} RCDATA "generated/mesh{i}.bin"\n'
        rc += f'{201+i} RCDATA "generated/tex{i}.bin"\n'
    bundle = work/"three-runtime.bundle.js"
    if not bundle.is_file() or bundle.stat().st_size < 256:
        raise ValueError("Missing official Three.js runtime core; run esbuild first")
    rc += '301 RCDATA "generated/three-runtime.bundle.js"' + chr(10)
    (work/"model_assets.rc").write_text(rc,encoding="utf-8")
    (work/"parts.json").write_text(json.dumps(allparts,indent=2),encoding="utf-8")
    print(json.dumps(allparts,indent=2))
    print("Packed mipmapped textures for the universal native renderer; model assets are instance-count independent.")

if __name__ == "__main__":
    main()
