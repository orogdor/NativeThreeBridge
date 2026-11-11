# NativeThreeBridge DX12 safety and crash diagnostics (experimental)

This document describes the **experimental** `experiments/k73-glsl-instancing-20261110` branch. Do not merge into `main` or deploy to the user’s stable installation until a separate validation and hardware-risk review.

## Why these guards were added

On 10 November 2026, a K73 DX12 session on an RTX 2080 Super coincided with a Windows kernel bugcheck `0x1C7` (`STORE_DATA_STRUCTURE_CORRUPTION`). WinDbg showed `MemCompression` and `nt!ST_STORE<SM_TRAITS>::StDmPageRecordUnprotect` with an inconsistent memory hash. The dump **did not attribute the corruption to NativeThreeBridge, NVIDIA, or faulty RAM**. Older `LiveKernelEvent 0x193/0x141` records and four 8 GB 3200 MHz DIMMs from two different RAM kits are additional investigative leads, not proof. GPU stress tests on that PC are suspended.

## Safety controls

- **GPU-free unit tests**: `test/dx12-safety-guards.cpp` runs without a graphics adapter, DX12 device, or user PC. CI verifies invalid packets, NaNs, resource IDs, allocation bounds, overflow, and out-of-range draws.
- **Input validation**: explicit float32 packet shape, finite integer counts, maximum 128 passes/16 MiB of pending packet payload, 16,384 draws/pass, 2,000,000 vertices/geometry, 6,000,000 indices, 65,536 instances, 8,192-pixel texture dimensions, 256 MiB per buffer/texture copy, **1 GiB live texture upload footprint**, and **50 million index/vertex × instance operations per frame**. Invalid commands are logged and rejected before submission to DX12.
- **Bounded waits**: CPU fence waits time out after 5 seconds rather than waiting indefinitely. An expired wait logs the stage and DRED information and exits the process. This **cannot guarantee prevention of a kernel bugcheck**.
- **Device removal**: `Present`, fence signaling and completed-frame checks inspect failing HRESULTs / `GetDeviceRemovedReason`. DRED auto-breadcrumb and GPU page-fault collection is configured before device creation and logged if the graphics driver reports a lost device. DRED information may be absent when a system crashes abruptly.
- **Opt-in diagnostic mode**: `NATIVETHREE_DX12_DEBUG=1` enables the D3D12 debug layer if installed. This can be slow; do not enable it automatically in production.
- **Opt-in flight recorder**: `NATIVETHREE_DX12_FLIGHTLOG=1` flushes one `before-submit` and one `submitted` record per DX12 frame with draw counts, GPU-work budget, live texture usage and fence values. This records **CPU submission progress**, not proof a specific command finished executing on the GPU. Logging every frame incurs I/O overhead and cannot necessarily flush through a hard BSOD.
- **Software adapter**: `NATIVETHREE_DX12_WARP=1` selects the Microsoft WARP software adapter, bypassing the discrete NVIDIA GPU for rendering. This only works with an EXE built **after** the safety implementation. WARP still uses CPU/RAM, so it does not guarantee that a machine with unstable RAM cannot crash.

## Safe validation order

1. Compile and execute the portable C++ guard test in a disposable GitHub-hosted runner, without touching the user’s graphics driver.
2. Compile the complete native EXE in CI and inspect compiler warnings, static checks, and WebGL2 regression tests.
3. Validate the software-only WARP path on an **isolated CI or disposable machine**, never the user’s primary PC without separate permission.
4. Review the original PC’s RAM stability (especially mixed DIMM kits / memory overclock) and prior graphics-kernel events. Hardware or firmware changes require explicit user approval.
5. Only after the user expressly approves, perform small, time-bounded GPU tests on a safe environment, recording DX12 debug output, DRED breadcrumbs and a reproducible test case.

## Local experimental K73 launcher

The earlier test file `E:\KuningriigidTest\experiments\K73-web-vs-native-20261110\Start-K73-DX12-safe.ps1` has been replaced with a **fail-closed interlock**. It will not run the old experimental hardware DX12 engine that preceded the BSOD. The user's stable `E:\KuningriigidTest` installation, original K73 source, and stored save data are unchanged.

**Limits of the safety changes:** They cannot fix corrupt RAM, a kernel-mode display-driver defect, or an OS memory manager bug. No BSOD-free guarantee is made. A watchdog can stop a user-mode process that is still responsive; it cannot stop a kernel-mode crash already in progress.
