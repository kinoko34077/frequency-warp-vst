#pragma once
// R3C2D0: non-RT, existing-project-only Controller -> Processor authorization.
// The editable GUI descriptor is NEVER the authority. The Worker independently
// re-attests its still-active WASM module and exact saved FWS3 ledger.
// A new ledger is NOT created or silently rewritten by this transport.
#include "project_binding_association.h"
#include <cstdint>
#include <limits>
#include <vector>

namespace fw {
constexpr std::size_t kGenericUiDescriptorLimit=65536;
constexpr std::uint64_t kGenericUiMaxRequest =
    static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());

inline bool validGenericUiRequest(std::uint64_t request,
                                  const std::uint8_t* bytes,
                                  std::size_t length) noexcept {
    if(request==0 || request>kGenericUiMaxRequest || !bytes ||
       length==0 || length>kGenericUiDescriptorLimit)return false;
    // This transport intentionally only carries JSON text, not a filesystem
    // name, script URI or arbitrary native bytes. Full syntax and semantic
    // validation remain the non-RT Rust/native worker's responsibility.
    for(std::size_t i=0;i<length;++i)
        if(bytes[i]==0)return false;
    return true;
}

// Caller must hold the Processor project-state mutex. Prepare a complete
// *copy* of the current worker-confirmed package + previously saved ledger;
// never accept a package, hash or "active" flag supplied by the UI.
// Failures leave 'out' untouched and do not revoke already-active audio.
inline bool prepareSavedGenericUiAuthorization(
    const VerifiedProjectEngine& verified,
    const std::vector<std::uint8_t>& savedLedger,
    const std::uint8_t* descriptor,std::size_t descriptorSize,
    std::uint64_t requestId,
    EngineProjectState& out) {
    if(!validGenericUiRequest(requestId,descriptor,descriptorSize) ||
       savedLedger.empty() || !verified.active ||
       verified.acceptedGeneration==0 || verified.package.empty())
        return false;
    EngineProjectState image{};
    image.package=verified.package;
    image.bindingLedger=savedLedger;
    if(!matchSavedBindingToVerifiedEngine(image,verified))
        return false;
    out=std::move(image);
    return true;
}
} // namespace fw
