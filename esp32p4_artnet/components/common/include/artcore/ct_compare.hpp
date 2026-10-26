//! 常量时间比较（避免 token / 哈希校验的时序侧信道）。

#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace artcore {

/// 定长字节序列的常量时间相等比较（不随首个差异位置提前返回）。
///
/// # Arguments
///
/// * `a` / `b` - 两段等长字节。
/// * `n` - 字节数。
///
/// # Returns
///
/// 完全相等返回 `true`。用于定长哈希比较时不泄漏任何长度信息。
[[nodiscard]] inline bool ct_equal(const uint8_t* a, const uint8_t* b, std::size_t n) noexcept {
    uint8_t diff = 0;
    for (std::size_t i = 0; i < n; ++i) {
        diff |= static_cast<uint8_t>(a[i] ^ b[i]);
    }
    return diff == 0;
}

/// 字符串的常量时间相等比较。
///
/// 注意：长度不同会立即返回 `false`，因而会泄漏长度差异；仅在无法定长化时使用。
/// token 校验应改为比较定长哈希（见 Settings::verify_token）。
[[nodiscard]] inline bool ct_equal(std::string_view a, std::string_view b) noexcept {
    if (a.size() != b.size()) {
        return false;
    }
    return ct_equal(reinterpret_cast<const uint8_t*>(a.data()),
                    reinterpret_cast<const uint8_t*>(b.data()), a.size());
}

}  // namespace artcore
