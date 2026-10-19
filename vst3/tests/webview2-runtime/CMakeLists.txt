cmake_minimum_required(VERSION 3.25)
project(FrequencyWarpWebView2RuntimeSmoke LANGUAGES CXX)
if(NOT WIN32)
  message(FATAL_ERROR "UI-5B3 real WebView2 runtime smoke is Windows-only")
endif()
if(NOT FW_WEBVIEW2_SDK_DIR OR
   NOT EXISTS "${FW_WEBVIEW2_SDK_DIR}/build/native/include/WebView2.h" OR
   NOT EXISTS "${FW_WEBVIEW2_SDK_DIR}/build/native/x64/WebView2LoaderStatic.lib")
  message(FATAL_ERROR "Set FW_WEBVIEW2_SDK_DIR to verified official WebView2 NuGet SDK")
endif()
add_executable(fw_webview2_runtime_smoke smoke.cpp)
target_compile_features(fw_webview2_runtime_smoke PRIVATE cxx_std_17)
target_include_directories(fw_webview2_runtime_smoke PRIVATE
  "${FW_WEBVIEW2_SDK_DIR}/build/native/include")
target_link_libraries(fw_webview2_runtime_smoke PRIVATE
  "${FW_WEBVIEW2_SDK_DIR}/build/native/x64/WebView2LoaderStatic.lib"
  ole32 user32)
enable_testing()
add_test(NAME fw_webview2_runtime_smoke COMMAND fw_webview2_runtime_smoke)
set_tests_properties(fw_webview2_runtime_smoke PROPERTIES TIMEOUT 55)
