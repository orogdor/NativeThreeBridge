# NativeThreeBridge

An experimental native Windows DirectX 12 renderer, independent of Kuningriigid.

## v0.5.0: 10 original Stone Age houses and 10 original pines

- Native DirectX 12 renderer, depth buffer, textured 3D models, GPU instancing.
- Exactly 10 houses from Kuningriigid/models-stone-lod-v244/house_far.glb.
- Exactly 10 trees from Kuningriigid/assets/sapling-trees/pine_01/mid.glb.
- House JPEG and pine PNG alpha-mask textures embedded in the EXE.
- No Chromium, Electron, WebView, Deno, Node, Python or web browser at Windows runtime.
- Windows EXE includes models. GitHub Actions downloads pinned original GLBs, verifies checksums and packs them as Windows resources.
- Orbit camera via left mouse drag, wheel zoom, pause with Space, exit with Esc, FPS in window title.
- SHA-256 verified GitHub Releases updater is retained.

**Current limitations:** This is a static render benchmark and is NOT yet a full Three.js JavaScript game runtime. Real runtime output and FPS need verification on a Windows PC; GitHub CI validates building and model packaging but cannot test the 3D window.

## Downloads

[Get Windows v0.5.0 from Releases](https://github.com/orogdor/NativeThreeBridge/releases/latest). Download NativeThreeBridge-Windows-x64.zip, extract and run NativeThree-Launcher.exe for automatic updates. Or open NativeThree-DX12.exe directly without an update check. For compatibility with the existing launcher, NativeThree-Diagnostics.exe now contains the new DX12 renderer rather than GDI.

## Windows development build

Run BUILD-WINDOWS.bat inside a Visual Studio x64 Native Tools Command Prompt with Python installed. The script uses Pillow at build time for embedded GLB textures, Microsoft C++ compiler and Windows SDK resource compiler.

The JavaScript Three.js data adapter remains in js/ as experimental conversion code, but it does NOT run inside this EXE.

Original models and provenance:
- [Kuningriigid Stone Age house](https://github.com/orogdor/Kuningriigid/blob/main/models-stone-lod-v244/house_far.glb)
- [Kuningriigid Sapling pine](https://github.com/orogdor/Kuningriigid/blob/main/assets/sapling-trees/pine_01/mid.glb)

The Kuningriigid repository is not modified by the experiment.
