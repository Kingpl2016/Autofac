//! CRC16-CCITT（CCITT-FALSE / IBM-3740）：多项式 0x1021，初值 0xFFFF，
//! 输入输出均不反转，无异或输出。与上位机 `artrec-core` 的实现逐位一致，
//! 对 "123456789" 的校验值为 0x29B1。
//!
//! header-only，编译期生成查表。

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace artcore {

namespace detail {

/// 编译期生成 CRC16-CCITT 查表（256 项）。
constexpr std::array<uint16_t, 256> make_crc16_table() noexcept {
    std::array<uint16_t, 256> t{};
    for (int i = 0; i < 256; ++i) {
        uint16_t crc = static_cast<uint16_t>(i << 8);
        for (int b = 0; b < 8; ++b) {
            crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021)
                                 : static_cast<uint16_t>(crc << 1);
        }
        t[static_cast<std::size_t>(i)] = crc;
    }
    return t;
}

inline constexpr std::array<uint16_t, 256> kCrc16Table = make_crc16_table();

}  // namespace detail

/// 计算一段数据的 CRC16-CCITT 校验值。
///
/// # Arguments
///
/// * `data` - 数据指针。
/// * `len` - 字节数。
///
/// # Returns
///
/// 16 位校验值；空输入返回初值 0xFFFF。
[[nodiscard]] inline uint16_t crc16_ccitt(const uint8_t* data, std::size_t len) noexcept {
    uint16_t crc = 0xFFFF;
    for (std::size_t i = 0; i < len; ++i) {
        uint8_t idx = static_cast<uint8_t>((crc >> 8) ^ data[i]);
        crc = static_cast<uint16_t>((crc << 8) ^ detail::kCrc16Table[idx]);
    }
    return crc;
}

}  // namespace artcore
