#pragma once
// GUI-only verified engine history. A successful VST3 sendMessage is NOT an
// accepted engine; only a matching worker result token can change history.
// Session-local file bytes; persistence/content SHA belongs to S4.
#include <cstdint>
#include <string>
#include <utility>
#include <vector>
namespace fw {
struct VerifiedPackage {
    std::vector<uint8_t> bytes;
    std::wstring path;
};
class VerifiedEngineHistory {
public:
    enum class Outcome { Ignored, Accepted, Rejected };
    bool begin(uint64_t request,VerifiedPackage package) {
        if(request==0||pending_||package.bytes.empty())return false;
        pendingId_=request;candidate_=std::move(package);pending_=true;
        return true;
    }
    Outcome complete(uint64_t request,bool accepted) {
        if(!pending_||request!=pendingId_)return Outcome::Ignored;
        pending_=false;pendingId_=0;
        if(!accepted){candidate_=VerifiedPackage{};return Outcome::Rejected;}
        previous_=std::move(current_);
        current_=std::move(candidate_);
        candidate_=VerifiedPackage{};
        return Outcome::Accepted;
    }
    void cancel() {pending_=false;pendingId_=0;candidate_=VerifiedPackage{};}
    bool awaiting() const noexcept {return pending_;}
    uint64_t pendingId() const noexcept {return pendingId_;}
    const VerifiedPackage& current() const noexcept {return current_;}
    const VerifiedPackage& previous() const noexcept {return previous_;}
private:
    VerifiedPackage current_{},previous_{},candidate_{};
    uint64_t pendingId_=0;
    bool pending_=false;
};
} // namespace fw
