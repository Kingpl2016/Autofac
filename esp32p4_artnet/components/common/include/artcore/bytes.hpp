//! 大端 / 小端整数读写辅助（header-only）。
//!
//! `.artrec` 文件内多字节字段为大端；Art-Net 的 `Port-Address` 为小端、
//! `Length` 为大端。集中在此避免各处手写移位出错。

#pragma once

#include <cstddef>
#include <cstdint>

namespace artcore {

/// 从 `p` 读取大端 `uint16`。
[[nodiscard]] constexpr uint16_t rd_be16(const uint8_t* p) noexcept {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

/// 从 `p` 读取大端 `uint32`。
[[nodiscard]] constexpr uint32_t rd_be32(const uint8_t* p) noexcept {
    return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

/// 从 `p` 读取大端 `uint64`。
[[nodiscard]] constexpr uint64_t rd_be64(const uint8_t* p) noexcept {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) {
        v = (v << 8) | p[i];
    }
    return v;
}

/// 从 `p` 读取小端 `uint16`。
[[nodiscard]] constexpr uint16_t rd_le16(const uint8_t* p) noexcept {
    return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8));
}

/// 把 `v` 以大端写入 `p`。
constexpr void wr_be16(uint8_t* p, uint16_t v) noexcept {
    p[0] = static_cast<uint8_t>(v >> 8);
    p[1] = static_cast<uint8_t>(v);
}

/// 把 `v` 以小端写入 `p`。
constexpr void wr_le16(uint8_t* p, uint16_t v) noexcept {
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
}

/// 把 `v` 以大端写入 `p`。
constexpr void wr_be32(uint8_t* p, uint32_t v) noexcept {
    p[0] = static_cast<uint8_t>(v >> 24);
    p[1] = static_cast<uint8_t>(v >> 16);
    p[2] = static_cast<uint8_t>(v >> 8);
    p[3] = static_cast<uint8_t>(v);
}

}  // namespace artcore
