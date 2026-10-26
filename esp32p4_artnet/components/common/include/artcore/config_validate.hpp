//! 运行时配置字段校验（纯函数，便于单测）。
//!
//! 数值范围用原始值校验，避免在写入窄类型（如 uint8_t）时被静默截断而掩盖越界。

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

namespace artcore {

/// 解析点分十进制 IPv4 字符串为主机序 u32（首八位组在最高位，与 NetConfig 一致）。
///
/// 要求恰好 4 段、每段 1~3 位纯数字且 0~255、无空段、无多余字符。
///
/// # Returns
///
/// 合法返回主机序 u32（如 `"192.168.1.200"` → `0xC0A801C8`）；非法返回 `std::nullopt`。
[[nodiscard]] inline std::optional<uint32_t> parse_ipv4(std::string_view s) noexcept {
    uint32_t result = 0;
    int octets = 0;
    std::size_t i = 0;
    while (octets < 4) {
        std::size_t start = i;
        unsigned value = 0;
        std::size_t digits = 0;
        while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
            value = value * 10 + static_cast<unsigned>(s[i] - '0');
            ++digits;
            ++i;
            if (digits > 3) {
                return std::nullopt;
            }
        }
        if (digits == 0 || i == start || value > 255) {
            return std::nullopt;
        }
        result = (result << 8) | value;
        ++octets;
        if (octets < 4) {
            if (i >= s.size() || s[i] != '.') {
                return std::nullopt;
            }
            ++i;  // 跳过 '.'
        }
    }
    if (i != s.size()) {
        return std::nullopt;  // 尾部有多余字符
    }
    return result;
}

/// IPv4 点分十进制字符串是否合法（见 [`parse_ipv4`]）。
[[nodiscard]] inline bool valid_ipv4(std::string_view s) noexcept {
    return parse_ipv4(s).has_value();
}

/// sACN 优先级 0~200（E1.31）。
constexpr bool valid_sacn_priority(long v) noexcept { return v >= 0 && v <= 200; }
/// 目标模式 0（广播）/ 1（单播）。
constexpr bool valid_target_mode(long v) noexcept { return v == 0 || v == 1; }
/// 停止行为 0（保持）/ 1（熄灯）。
constexpr bool valid_stop_behavior(long v) noexcept { return v == 0 || v == 1; }
/// 保活间隔 0~600000ms（0 表示不保活）。
constexpr bool valid_keepalive_ms(long v) noexcept { return v >= 0 && v <= 600000; }
/// 转发订阅起始 universe 0~32767（Art-Net 15 位 Port-Address）。
constexpr bool valid_forward_uni_start(long v) noexcept { return v >= 0 && v <= 32767; }
/// 转发订阅 universe 数 1~512。
constexpr bool valid_forward_uni_count(long v) noexcept { return v >= 1 && v <= 512; }

/// 主机名：长度 1~63，仅 `[A-Za-z0-9-]`，不以 `-` 开头 / 结尾（RFC 1123 子集，供 mDNS/DHCP）。
[[nodiscard]] inline bool valid_hostname(std::string_view s) noexcept {
    if (s.empty() || s.size() > 63) {
        return false;
    }
    if (s.front() == '-' || s.back() == '-') {
        return false;
    }
    for (char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        (c >= '0' && c <= '9') || c == '-';
        if (!ok) {
            return false;
        }
    }
    return true;
}

/// sACN 源名称：长度 1~63 字节，无控制字符（< 0x20）。
[[nodiscard]] inline bool valid_source_name(std::string_view s) noexcept {
    if (s.empty() || s.size() > 63) {
        return false;
    }
    for (char c : s) {
        if (static_cast<unsigned char>(c) < 0x20) {
            return false;
        }
    }
    return true;
}

/// HTTP token：空串（表示清除）或 8~64 个可见 ASCII 字符（0x21~0x7E）。
[[nodiscard]] inline bool valid_http_token(std::string_view s) noexcept {
    if (s.empty()) {
        return true;  // 清除鉴权
    }
    if (s.size() < 8 || s.size() > 64) {
        return false;
    }
    for (char c : s) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u <= 0x20 || u >= 0x7F) {
            return false;
        }
    }
    return true;
}

}  // namespace artcore
