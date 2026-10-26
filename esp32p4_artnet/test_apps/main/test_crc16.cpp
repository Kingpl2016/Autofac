//! CRC16-CCITT 测试（与上位机 artrec-core 逐位一致）。

#include "artcore/crc16.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::crc16_ccitt;

TEST_CASE("CRC16-CCITT 标准校验值", "[crc16]") {
    // IBM-3740 / CCITT-FALSE 对 "123456789" 的标准校验值为 0x29B1。
    const char* s = "123456789";
    REQUIRE(crc16_ccitt(reinterpret_cast<const uint8_t*>(s), 9) == 0x29B1);
}

TEST_CASE("CRC16 空输入为初值", "[crc16]") {
    REQUIRE(crc16_ccitt(nullptr, 0) == 0xFFFF);
}

TEST_CASE("CRC16 单字节", "[crc16]") {
    uint8_t b = 0x00;
    // 已知：init 0xFFFF 经单个 0x00 字节后为 0xE1F0。
    REQUIRE(crc16_ccitt(&b, 1) == 0xE1F0);
}
