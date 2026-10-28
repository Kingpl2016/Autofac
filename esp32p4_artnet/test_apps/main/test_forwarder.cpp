//! 实时转发订阅范围判定测试（universe_in_range 纯函数）。
//!
//! 这是转发"范围外丢弃"的唯一分支：命中才会进入 HTP 合并并下发，
//! 否则计入 dropped_range 并丢弃。重点验证边界与 16 位不回绕。

#include <cstdint>

#include "artcore/forwarder.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::universe_in_range;

TEST_CASE("范围内/外基本判定", "[forward]") {
    // 订阅 [0,4) → 命中 0,1,2,3；4 落在范围外。
    REQUIRE(universe_in_range(0, 0, 4));
    REQUIRE(universe_in_range(1, 0, 4));
    REQUIRE(universe_in_range(3, 0, 4));
    REQUIRE_FALSE(universe_in_range(4, 0, 4));
}

TEST_CASE("count=0 恒不命中", "[forward]") {
    REQUIRE_FALSE(universe_in_range(0, 0, 0));
    REQUIRE_FALSE(universe_in_range(5, 5, 0));
}

TEST_CASE("非零起点的闭开区间", "[forward]") {
    // 订阅 [10,3) → 命中 10,11,12。
    REQUIRE_FALSE(universe_in_range(9, 10, 3));
    REQUIRE(universe_in_range(10, 10, 3));
    REQUIRE(universe_in_range(12, 10, 3));
    REQUIRE_FALSE(universe_in_range(13, 10, 3));
}

TEST_CASE("接近 16 位上界不回绕", "[forward]") {
    // start+count 超过 65535 时用 32 位累加，若按 16 位回绕会误判。
    REQUIRE(universe_in_range(65534, 65534, 4));
    REQUIRE(universe_in_range(65535, 65534, 4));
    // 下列若发生 (65534+4)&0xFFFF=2 的回绕会被误判为命中，必须为 false。
    REQUIRE_FALSE(universe_in_range(65533, 65534, 4));
    REQUIRE_FALSE(universe_in_range(1, 65534, 4));
}
