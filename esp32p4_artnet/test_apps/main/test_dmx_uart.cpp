//! UART DMX512 发送缓冲构造测试（纯函数 build_dmx512_frame）。

#include <array>
#include <cstdint>

#include "artcore/dmx_uart.hpp"
#include "catch2/catch_test_macros.hpp"

using namespace artcore;

TEST_CASE("DMX512 帧：起始码 0 + 数据 + 补零", "[dmxuart]") {
    std::array<uint8_t, DmxUart::kFrameLen> out{};
    std::array<uint8_t, 3> data{10, 20, 30};

    std::size_t n = build_dmx512_frame(data, out);

    REQUIRE(n == 513);
    REQUIRE(out[0] == 0x00);  // START Code
    REQUIRE(out[1] == 10);
    REQUIRE(out[2] == 20);
    REQUIRE(out[3] == 30);
    // 其余通道补零。
    REQUIRE(out[4] == 0);
    REQUIRE(out[512] == 0);
}

TEST_CASE("DMX512 帧：满 512 通道", "[dmxuart]") {
    std::array<uint8_t, DmxUart::kFrameLen> out{};
    std::array<uint8_t, 512> data{};
    data.fill(0xFF);
    data[0] = 1;
    data[511] = 7;

    std::size_t n = build_dmx512_frame(data, out);

    REQUIRE(n == 513);
    REQUIRE(out[0] == 0x00);
    REQUIRE(out[1] == 1);
    REQUIRE(out[512] == 7);
}

TEST_CASE("DMX512 帧：超 512 截断", "[dmxuart]") {
    std::array<uint8_t, DmxUart::kFrameLen> out{};
    std::array<uint8_t, 600> data{};
    data.fill(0xAB);

    std::size_t n = build_dmx512_frame(data, out);

    REQUIRE(n == 513);  // 仍为 1 + 512
    REQUIRE(out[512] == 0xAB);
}

TEST_CASE("DMX512 帧：缓冲不足返回 0", "[dmxuart]") {
    std::array<uint8_t, 100> small{};
    std::array<uint8_t, 3> data{1, 2, 3};
    REQUIRE(build_dmx512_frame(data, small) == 0);
}

TEST_CASE("DMX512 帧：空数据全零", "[dmxuart]") {
    std::array<uint8_t, DmxUart::kFrameLen> out{};
    out.fill(0x55);  // 预置非零，验证被清零
    std::array<uint8_t, 0> empty{};

    std::size_t n = build_dmx512_frame(empty, out);

    REQUIRE(n == 513);
    REQUIRE(out[0] == 0x00);
    REQUIRE(out[1] == 0);
    REQUIRE(out[256] == 0);
    REQUIRE(out[512] == 0);
}

TEST_CASE("BREAK 位数钳位到 DMX512 合规区间", "[dmxuart]") {
    // 过短（含 0 / 负）被提到下限 23 位（92us）。
    REQUIRE(dmx512_clamp_break_bits(0) == kDmxMinBreakBits);
    REQUIRE(dmx512_clamp_break_bits(-5) == kDmxMinBreakBits);
    REQUIRE(dmx512_clamp_break_bits(1) == kDmxMinBreakBits);
    REQUIRE(dmx512_clamp_break_bits(22) == kDmxMinBreakBits);
    // 区间内原样返回。
    REQUIRE(dmx512_clamp_break_bits(23) == 23);
    REQUIRE(dmx512_clamp_break_bits(44) == 44);  // 默认值
    // 过大截到上限。
    REQUIRE(dmx512_clamp_break_bits(10000) == kDmxMaxBreakBits);
}

TEST_CASE("DMX512 时序常量自洽", "[dmxuart]") {
    REQUIRE(kDmxBitUs == 4);
    REQUIRE(kDmxFrameUs == 22572u);                     // 513 * 11 * 4us
    REQUIRE(kDmxMinBreakBits * kDmxBitUs >= 92u);       // 发送端 BREAK 下限
}
