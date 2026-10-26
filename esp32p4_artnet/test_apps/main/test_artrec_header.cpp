//! .artrec 文件头解析测试（纯函数 parse_header）。

#include <array>
#include <cstring>

#include "artcore/artrec.hpp"
#include "artcore/bytes.hpp"
#include "catch2/catch_test_macros.hpp"

using namespace artcore;
using namespace artcore::artrec;

namespace {

/// 写大端 u64。
void wr_be64(uint8_t* p, uint64_t v) {
    for (int i = 0; i < 8; ++i) {
        p[i] = static_cast<uint8_t>(v >> (56 - 8 * i));
    }
}

/// 构造一个合法的 64 字节大端文件头。
std::array<uint8_t, kHeaderSize> make_header() {
    std::array<uint8_t, kHeaderSize> h{};
    std::memcpy(h.data(), kMagic, 4);
    wr_be16(h.data() + 4, kEndianBE);
    wr_be16(h.data() + 6, 1);      // ver_major
    wr_be16(h.data() + 8, 0);      // ver_minor
    wr_be32(h.data() + 10, 0);     // flags
    wr_be64(h.data() + 14, 0);     // rec_start_us
    wr_be64(h.data() + 22, 25000); // total_duration_us
    wr_be32(h.data() + 30, 1);     // universe_count
    wr_be32(h.data() + 34, 2);     // frame_count
    wr_be32(h.data() + 38, 64);    // universe_desc_offset
    wr_be32(h.data() + 42, 104);   // frame_index_offset
    wr_be32(h.data() + 46, 80);    // chunk_pool_offset
    h[50] = kCompressNone;
    h[51] = 0;
    return h;
}

}  // namespace

TEST_CASE("解析合法文件头", "[artrec]") {
    auto h = make_header();
    auto r = parse_header(std::span<const uint8_t>(h.data(), h.size()));
    REQUIRE(r.has_value());
    REQUIRE(r->ver_major == 1);
    REQUIRE(r->total_duration_us == 25000);
    REQUIRE(r->universe_count == 1);
    REQUIRE(r->frame_count == 2);
    REQUIRE(r->chunk_pool_offset == 80);
    REQUIRE(r->compress_algo == kCompressNone);
    REQUIRE_FALSE(r->little_endian);
}

TEST_CASE("魔数错误被拒绝", "[artrec]") {
    auto h = make_header();
    h[0] = 'X';
    REQUIRE_FALSE(parse_header(std::span<const uint8_t>(h.data(), h.size())).has_value());
}

TEST_CASE("小端标记被识别", "[artrec]") {
    auto h = make_header();
    // 改为小端标记并把关键字段重写为小端。
    h[4] = 0x55;
    h[5] = 0xAA;
    // universe_count 小端。
    h[30] = 1; h[31] = 0; h[32] = 0; h[33] = 0;
    h[34] = 2; h[35] = 0; h[36] = 0; h[37] = 0;
    auto r = parse_header(std::span<const uint8_t>(h.data(), h.size()));
    REQUIRE(r.has_value());
    REQUIRE(r->little_endian);
    REQUIRE(r->universe_count == 1);
}

TEST_CASE("差分帧标志被拒绝", "[artrec]") {
    auto h = make_header();
    wr_be32(h.data() + 10, kFlagDiffFrame);
    REQUIRE_FALSE(parse_header(std::span<const uint8_t>(h.data(), h.size())).has_value());
}

TEST_CASE("过高主版本被拒绝", "[artrec]") {
    auto h = make_header();
    wr_be16(h.data() + 6, kSupportedMajor + 1);
    REQUIRE_FALSE(parse_header(std::span<const uint8_t>(h.data(), h.size())).has_value());
}

TEST_CASE("未知压缩算法被拒绝", "[artrec]") {
    auto h = make_header();
    h[50] = 9;
    REQUIRE_FALSE(parse_header(std::span<const uint8_t>(h.data(), h.size())).has_value());
}

TEST_CASE("字节不足被拒绝", "[artrec]") {
    auto h = make_header();
    REQUIRE_FALSE(parse_header(std::span<const uint8_t>(h.data(), 10)).has_value());
}

TEST_CASE("超大帧数被 parse_header 拒绝", "[artrec]") {
    auto h = make_header();
    wr_be32(h.data() + 34, kMaxFrameCount + 1);  // frame_count 超上限
    REQUIRE_FALSE(parse_header(std::span<const uint8_t>(h.data(), h.size())).has_value());
}

TEST_CASE("分区边界校验：合法头在足够大的文件内通过", "[artrec]") {
    auto h = make_header();
    auto r = parse_header(std::span<const uint8_t>(h.data(), h.size()));
    REQUIRE(r.has_value());
    // Universe 表 [64,80)、帧索引表 [104,136)、chunk_pool 起点 80；文件 >=136 应通过。
    REQUIRE(header_regions_valid(*r, 200));
    REQUIRE(header_regions_valid(*r, 136));
    // 文件过小（索引表越过末尾）应拒绝。
    REQUIRE_FALSE(header_regions_valid(*r, 100));
}

TEST_CASE("分区边界校验：超大帧数用 64 位计算不回绕且被拒绝", "[artrec]") {
    FileHeader h{};
    h.universe_count = 1;
    h.frame_count = 0x1000'0001u;  // *16 在 32 位下会回绕成 16
    h.universe_desc_offset = 64;
    h.frame_index_offset = 128;
    h.chunk_pool_offset = 128;
    // 即便号称 1GB 文件，声明的 ~4GB 帧索引表也放不下 → 必须返回 false（证明用 64 位计算）。
    REQUIRE_FALSE(header_regions_valid(h, 1024ull * 1024 * 1024));
}

TEST_CASE("分区边界校验：偏移越过文件末尾被拒绝", "[artrec]") {
    auto h = make_header();
    auto r = parse_header(std::span<const uint8_t>(h.data(), h.size()));
    REQUIRE(r.has_value());
    FileHeader bad = *r;
    bad.chunk_pool_offset = 10000;  // 超过文件大小
    REQUIRE_FALSE(header_regions_valid(bad, 500));
}
