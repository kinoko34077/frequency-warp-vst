#pragma once
// R3C2D0: non-RT data construction for a candidate Controller descriptor.
// Only previously saved FWS3 bindings and exact worker-verified package bytes
// may reach postAuthorization. This builder does NOT grant a GUI edit.
#include "generic_authorization_plan.h"
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>
namespace fw {
struct GenericDescriptorAuthorizationRequest {
    EngineProjectState project{};
    std::vector<std::uint8_t> descriptor{};
};
inline bool buildGenericDescriptorAuthorizationRequest(
    const VerifiedProjectEngine& worker,
    const std::vector<std::uint8_t>& savedLedger,
    const std::uint8_t* json,std::size_t size,
    GenericDescriptorAuthorizationRequest& output) {
    if(!worker.active||!worker.acceptedGeneration||worker.package.empty()||
       worker.engineId.empty()||savedLedger.empty()||!json||!size||
       size>65536)return false;
    try {
        GenericDescriptorAuthorizationRequest candidate{};
        candidate.project.package=worker.package;
        candidate.project.bindingLedger=savedLedger;
        if(!matchSavedBindingToVerifiedEngine(candidate.project,worker))
            return false;
        candidate.descriptor.assign(json,json+size);
        output=std::move(candidate);
        return true;
    }catch(...) {return false;}
}
} // namespace fw
