# S2 Windows x64 native fixed shell (not distributable)

Issue: https://github.com/kinoko34077/frequency-warp-vst/issues/83

- Fixed class UIDs: Processor D51B3C205C574E31B40D7B64A2E8F719;
  Controller F8C2D41E84B9475BB5DC4E2FB948A0D3.
- Exactly 128 stable VST3 host ParamIDs: 0 Wet, 1 Bypass, 2 Lower,
  3 Upper, 4 Invert, 5 Curvature, 6 Shift, 7 Pivot, 8 Slope,
  9 Reflection Synthesis, 10 Ring Enable, 11 Crusher Enable, 12 FFT Quality;
  **13..33 distinct additional live DSP controls**, 34..63 reserved;
  64..127 generic engine slots **unbound** pending semantic mapping.
  See [complete host-visible binding table](PARAMETER_AUTOMATION.md).
- Supports exactly mono -> mono and stereo -> stereo; host f32/f64;
  variable blocks, in-place, zero-sample parameter events, state save/restore.
- Signal path deliberately delayed dry/identity by exactly 4095 samples
  for all modes, even bypass. Fixed-PDC Missing Engine fallback.
  Host parameter **automation and project-state values** are received but
  do NOT currently affect audio: no module engine is attached yet.
- Standalone native .fwengine interpreter and C++ staticlib ABI exist in
  `fwengine-runtime/`; they are NOT wired to the VST3 Processor yet.
  A tested RT pointer handoff and off-thread retirement primitive exists at
  `src/rt_swap_mailbox.h`, but no live module hot-swap or custom editor
  Browse/Drop/Reload is integrated. These remain S3 gates.
- Compile/Steinberg validator in Windows CI is not FL Studio validation,
  nor second DAW, physical listening or installer distribution.

Build using official Steinberg VST3 SDK 3.8.x recursively checked out,
Visual Studio 2022 and CMake 3.25+:

    cmake -S vst3 -B build/vst3 -G "Visual Studio 17 2022" -A x64 -DFW_VST3_SDK_DIR=C:/dev/vst3sdk -DSMTG_CREATE_PLUGIN_LINK=OFF -DSMTG_RUN_VST_VALIDATOR=ON
    cmake --build build/vst3 --config Release --target FrequencyWarpShell
    cmake --build build/vst3 --config Release --target fw_shell_delay_test
    cmake --build build/vst3 --config Release --target fw_shell_automation_test
    cmake --build build/vst3 --config Release --target fw_swap_mailbox_test
    ctest --test-dir build/vst3 -C Release --output-on-failure

This repository does not vendor the Steinberg SDK. SDK terms remain governed
by the upstream MIT license; no installer/binary has been published.
