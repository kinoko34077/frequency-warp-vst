#pragma once
// UI-3: strict, bounded parsing of WebView2's WebMessageAsJson on GUI thread.
// Not a generic JSON parser, deliberately accepts only the finite browser
// bridge v1 event grammar. Browser origin and semantic slot policy are checked
// by the native caller before performing any DAW edit.
#include <cstdint>
#include <cmath>
#include <cwchar>
#include <optional>
#include <string>
#include <string_view>

namespace fw {
enum class UiWireKind { Hello, Begin, Perform, End };
struct UiWireMessage {
    UiWireKind kind;
    uint32_t id=0;
    double normalized=0.0;
};
inline std::optional<UiWireMessage> parseUiWireMessage(std::wstring_view json) {
    constexpr std::wstring_view prefix=
        L"{\"protocol\":\"frequency-warp.host-ui.v1\",\"kind\":\"";
    if(json.size()>512 || json.substr(0,prefix.size())!=prefix)
        return std::nullopt;
    const auto start=prefix.size();
    const auto end=json.find(L'"',start);
    if(end==std::wstring_view::npos)return std::nullopt;
    const auto kind=json.substr(start,end-start);
    auto tail=json.substr(end+1);
    if(kind==L"hello") {
        // Native sends initial snapshot only after a versioned local UI hello.
        if(tail.substr(0,32)!=L",\"version\":1,\"visibleBindings\":[")
            return std::nullopt;
        if(tail.back()!=L'}'||tail.size()<33)return std::nullopt;
        return UiWireMessage{UiWireKind::Hello,0,0.0};
    }
    UiWireKind type;
    if(kind==L"edit-begin")type=UiWireKind::Begin;
    else if(kind==L"edit-perform")type=UiWireKind::Perform;
    else if(kind==L"edit-end")type=UiWireKind::End;
    else return std::nullopt;
    constexpr std::wstring_view idPrefix=L",\"id\":";
    if(tail.substr(0,idPrefix.size())!=idPrefix)return std::nullopt;
    tail.remove_prefix(idPrefix.size());
    if(tail.empty()||tail.front()<L'0'||tail.front()>L'9')return std::nullopt;
    if(tail.front()==L'0' && tail.size()>1 && tail[1]>=L'0' && tail[1]<=L'9')
        return std::nullopt;
    uint32_t id=0;
    size_t pos=0;
    for(;pos<tail.size()&&tail[pos]>=L'0'&&tail[pos]<=L'9';pos++){
        id=id*10u+static_cast<uint32_t>(tail[pos]-L'0');
        if(id>=128)return std::nullopt;
    }
    tail.remove_prefix(pos);
    if(type!=UiWireKind::Perform) {
        if(tail!=L"}")return std::nullopt;
        return UiWireMessage{type,id,0.0};
    }
    constexpr std::wstring_view valuePrefix=L",\"value\":";
    if(tail.substr(0,valuePrefix.size())!=valuePrefix ||
       tail.size()<=valuePrefix.size()+1 || tail.back()!=L'}')return std::nullopt;
    tail.remove_prefix(valuePrefix.size());
    tail.remove_suffix(1);
    // Exact JSON numeric alphabet: no whitespace, strings, NaN/Inf or metadata.
    if(tail.empty()||tail.size()>64)return std::nullopt;
    for(wchar_t c:tail){
        if((c<L'0'||c>L'9') && c!=L'-' && c!=L'+' &&
           c!=L'.' && c!=L'e' && c!=L'E')return std::nullopt;
    }
    const std::wstring number(tail);
    wchar_t* after=nullptr;
    const double normalized=std::wcstod(number.c_str(),&after);
    if(after!=number.c_str()+number.size()||!std::isfinite(normalized)||
       normalized<0.0||normalized>1.0)return std::nullopt;
    return UiWireMessage{type,id,normalized};
}
} // namespace fw
