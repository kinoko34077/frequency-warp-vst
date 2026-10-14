#include "../src/engine_bridge_abi.h"
#include <cstdint>
#include <cstddef>
#include <type_traits>
static_assert(std::is_standard_layout<FWNativeParamEvent>::value,
    "WASM host events must have C standard layout");
static_assert(sizeof(FWNativeParamEvent)==16,"WASM event ABI must be stable");
static_assert(offsetof(FWNativeParamEvent,canonical_value)==8,
    "WASM event f64 canonical value offset must equal 8");
static_assert(sizeof(uint32_t)==4);
int main(){
    FWNativeParamEvent v{64,128,.25};
    return (v.id==64&&v.sample_offset==128&&v.canonical_value==.25) ? 0 : 1;
}
