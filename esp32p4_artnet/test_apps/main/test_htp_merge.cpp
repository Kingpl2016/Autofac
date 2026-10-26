//! E1.31 优先级 + HTP 合并测试。

#include <array>
#include <cstdint>

#include "artcore/htp_merge.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::htp_merge_priority;
using artcore::MergeSource;

TEST_CASE("无来源返回 0", "[htp]") {
    std::array<uint8_t, 512> out{};
    REQUIRE(htp_merge_priority(nullptr, 0, out.data()) == 0);
    MergeSource ms[1] = {};
    REQUIRE(htp_merge_priority(ms, 0, out.data()) == 0);
}

TEST_CASE("单源快路径：直接拷贝 + 尾部补零", "[htp]") {
    std::array<uint8_t, 4> d{10, 20, 30, 40};
    MergeSource ms[1];
    ms[0] = {d.data(), 4, 100};
    std::array<uint8_t, 512> out{};
    out.fill(0xFF);
    std::size_t n = htp_merge_priority(ms, 1, out.data());
    REQUIRE(n == 4);
    REQUIRE(out[0] == 10);
    REQUIRE(out[3] == 40);
}

TEST_CASE("同优先级多源 HTP 逐通道取高", "[htp]") {
    std::array<uint8_t, 3> a{10, 200, 5};
    std::array<uint8_t, 3> b{100, 20, 50};
    MergeSource ms[2];
    ms[0] = {a.data(), 3, 100};
    ms[1] = {b.data(), 3, 100};
    std::array<uint8_t, 512> out{};
    std::size_t n = htp_merge_priority(ms, 2, out.data());
    REQUIRE(n == 3);
    REQUIRE(out[0] == 100);  // max(10,100)
    REQUIRE(out[1] == 200);  // max(200,20)
    REQUIRE(out[2] == 50);   // max(5,50)
}

TEST_CASE("高优先级覆盖低优先级（低优先级不参与）", "[htp]") {
    std::array<uint8_t, 3> low{255, 255, 255};
    std::array<uint8_t, 3> high{1, 2, 3};
    MergeSource ms[2];
    ms[0] = {low.data(), 3, 100};
    ms[1] = {high.data(), 3, 200};  // 更高优先级
    std::array<uint8_t, 512> out{};
    std::size_t n = htp_merge_priority(ms, 2, out.data());
    REQUIRE(n == 3);
    // 只有 high 参与（单一最高优先级）→ 结果即 high，低优先级的 255 被忽略。
    REQUIRE(out[0] == 1);
    REQUIRE(out[1] == 2);
    REQUIRE(out[2] == 3);
}

TEST_CASE("不同长度取最大长度，短源尾部按 0 处理", "[htp]") {
    std::array<uint8_t, 2> a{5, 6};
    std::array<uint8_t, 4> b{1, 1, 9, 9};
    MergeSource ms[2];
    ms[0] = {a.data(), 2, 100};
    ms[1] = {b.data(), 4, 100};
    std::array<uint8_t, 512> out{};
    std::size_t n = htp_merge_priority(ms, 2, out.data());
    REQUIRE(n == 4);
    REQUIRE(out[0] == 5);  // max(5,1)
    REQUIRE(out[1] == 6);  // max(6,1)
    REQUIRE(out[2] == 9);  // a 无此通道（0）→ 9
    REQUIRE(out[3] == 9);
}
