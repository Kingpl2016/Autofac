//! Art-Net / sACN 打包测试（字节级对齐上位机）。

#include <array>
#include <cstring>

#include "artcore/dmx_packet.hpp"
#include "catch2/catch_test_macros.hpp"

using namespace artcore::dmx;

TEST_CASE("ArtDmx 头部字节布局", "[artnet]") {
    std::array<uint8_t, kArtDmxMax> out{};
    std::array<uint8_t, 3> data{10, 20, 30};
    std::size_t n = build_artdmx_into(0x0001, 7, data, out);

    // 3 通道补齐为偶数 4 → 18 + 4 = 22 字节。
    REQUIRE(n == 22);
    REQUIRE(std::memcmp(out.data(), "Art-Net\0", 8) == 0);
    // OpCode 0x5000 小端。
    REQUIRE(out[8] == 0x00);
    REQUIRE(out[9] == 0x50);
    // ProtVer 14（0x00,0x0e）。
    REQUIRE(out[10] == 0x00);
    REQUIRE(out[11] == 0x0e);
    REQUIRE(out[12] == 7);   // sequence
    REQUIRE(out[13] == 0);   // physical
    // Port-Address 小端。
    REQUIRE(out[14] == 0x01);
    REQUIRE(out[15] == 0x00);
    // Length 大端，补齐偶数 4。
    REQUIRE(out[16] == 0x00);
    REQUIRE(out[17] == 0x04);
    REQUIRE(out[18] == 10);
    REQUIRE(out[19] == 20);
    REQUIRE(out[20] == 30);
    REQUIRE(out[21] == 0);  // 补 0
}

TEST_CASE("ArtDmx 拒绝越界与空数据", "[artnet]") {
    std::array<uint8_t, kArtDmxMax> out{};
    std::array<uint8_t, 2> data{1, 2};
    REQUIRE(build_artdmx_into(0x8000, 0, data, out) == 0);  // Port-Address 越界
    std::array<uint8_t, 0> empty{};
    REQUIRE(build_artdmx_into(1, 0, empty, out) == 0);  // 空数据
}

TEST_CASE("sACN E1.31 关键字段", "[sacn]") {
    std::array<uint8_t, kSacnMax> out{};
    std::array<uint8_t, 4> data{1, 2, 3, 4};
    uint8_t cid[16] = {0xAA, 0xBB};
    std::size_t n = build_sacn_into(1, data, cid, "Src", 100, 5, 0x00, out);

    REQUIRE(n == 126 + 4);
    // Root preamble size。
    REQUIRE(out[0] == 0x00);
    REQUIRE(out[1] == 0x10);
    // ACN PID。
    REQUIRE(std::memcmp(out.data() + 4, "ASC-E1.17\0\0\0", 12) == 0);
    // Root 向量 0x00000004。
    REQUIRE(out[21] == 0x04);
    // CID。
    REQUIRE(out[22] == 0xAA);
    REQUIRE(out[23] == 0xBB);
    // 优先级。
    REQUIRE(out[108] == 100);
    // 序列号。
    REQUIRE(out[111] == 5);
    // Universe 大端。
    REQUIRE(out[113] == 0x00);
    REQUIRE(out[114] == 0x01);
    // DMP 向量 0x02。
    REQUIRE(out[117] == 0x02);
    // 属性数 = 通道数 + 1。
    REQUIRE(out[123] == 0x00);
    REQUIRE(out[124] == 0x05);
    // START Code。
    REQUIRE(out[125] == 0x00);
    // 通道数据。
    REQUIRE(out[126] == 1);
    REQUIRE(out[129] == 4);
}

TEST_CASE("sACN 组播地址映射", "[sacn]") {
    REQUIRE(sacn_multicast_v4(1) == ((239u << 24) | (255u << 16) | 1u));
    REQUIRE(sacn_multicast_v4(0x0102) == ((239u << 24) | (255u << 16) | (1u << 8) | 2u));
}

TEST_CASE("sACN 终止包置 Options 位", "[sacn]") {
    std::array<uint8_t, kSacnMax> out{};
    std::array<uint8_t, 2> data{9, 9};
    uint8_t cid[16] = {};
    (void)build_sacn_into(1, data, cid, "x", 100, 1, kSacnOptTerminated, out);
    REQUIRE(out[112] == kSacnOptTerminated);
}

// ===================== 解析（接收侧）=====================

TEST_CASE("parse_artdmx 回解 build_artdmx", "[artnet][parse]") {
    std::array<uint8_t, kArtDmxMax> out{};
    std::array<uint8_t, 4> data{11, 22, 33, 44};
    std::size_t n = build_artdmx_into(0x1234, 3, data, out);
    REQUIRE(n > 0);

    auto p = parse_artdmx(std::span<const uint8_t>(out.data(), n));
    REQUIRE(p.has_value());
    REQUIRE(p->universe == 0x1234);
    REQUIRE(p->len == 4);
    REQUIRE(p->priority == 0);
    REQUIRE(p->data[0] == 11);
    REQUIRE(p->data[1] == 22);
    REQUIRE(p->data[2] == 33);
    REQUIRE(p->data[3] == 44);
}

TEST_CASE("parse_artdmx 拒绝非 ArtDmx", "[artnet][parse]") {
    std::array<uint8_t, 32> buf{};
    // sACN 报文不应被识别为 ArtDmx。
    std::array<uint8_t, kSacnMax> sacn{};
    std::array<uint8_t, 2> data{1, 2};
    uint8_t cid[16] = {};
    std::size_t sn = build_sacn_into(1, data, cid, "x", 100, 1, 0x00, sacn);
    REQUIRE_FALSE(parse_artdmx(std::span<const uint8_t>(sacn.data(), sn)).has_value());
    // 太短的缓冲。
    REQUIRE_FALSE(parse_artdmx(std::span<const uint8_t>(buf.data(), 4)).has_value());
}

TEST_CASE("is_sacn 识别 ACN PID", "[sacn][parse]") {
    std::array<uint8_t, kSacnMax> out{};
    std::array<uint8_t, 3> data{1, 2, 3};
    uint8_t cid[16] = {};
    std::size_t n = build_sacn_into(1, data, cid, "x", 100, 1, 0x00, out);
    REQUIRE(is_sacn(std::span<const uint8_t>(out.data(), n)));

    std::array<uint8_t, kArtDmxMax> art{};
    std::size_t an = build_artdmx_into(1, 0, data, art);
    REQUIRE_FALSE(is_sacn(std::span<const uint8_t>(art.data(), an)));
}

TEST_CASE("parse_sacn_data 回解 build_sacn", "[sacn][parse]") {
    std::array<uint8_t, kSacnMax> out{};
    std::array<uint8_t, 5> data{1, 2, 3, 4, 5};
    uint8_t cid[16] = {0x01};
    std::size_t n = build_sacn_into(1000, data, cid, "Src", 120, 9, 0x00, out);
    REQUIRE(n == 126 + 5);

    auto p = parse_sacn_data(std::span<const uint8_t>(out.data(), n));
    REQUIRE(p.has_value());
    REQUIRE(p->universe == 1000);
    REQUIRE(p->len == 5);
    REQUIRE(p->priority == 120);
    REQUIRE(p->data[0] == 1);
    REQUIRE(p->data[4] == 5);
}

TEST_CASE("parse_sacn_data 拒绝 Art-Net 与短包", "[sacn][parse]") {
    std::array<uint8_t, kArtDmxMax> art{};
    std::array<uint8_t, 3> data{7, 8, 9};
    std::size_t an = build_artdmx_into(1, 0, data, art);
    REQUIRE_FALSE(parse_sacn_data(std::span<const uint8_t>(art.data(), an)).has_value());

    std::array<uint8_t, 64> tooshort{};
    REQUIRE_FALSE(parse_sacn_data(std::span<const uint8_t>(tooshort.data(), 64)).has_value());
}
