//! 常量时间比较测试。

#include <array>
#include <cstdint>

#include "artcore/ct_compare.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::ct_equal;

TEST_CASE("定长字节比较", "[ct]") {
    std::array<uint8_t, 4> a{1, 2, 3, 4};
    std::array<uint8_t, 4> b{1, 2, 3, 4};
    std::array<uint8_t, 4> c{1, 2, 3, 5};
    REQUIRE(ct_equal(a.data(), b.data(), a.size()));
    REQUIRE_FALSE(ct_equal(a.data(), c.data(), a.size()));
    // 首字节即不同也要比到底（功能上等价于全比较）。
    std::array<uint8_t, 4> d{9, 2, 3, 4};
    REQUIRE_FALSE(ct_equal(a.data(), d.data(), a.size()));
}

TEST_CASE("字符串比较", "[ct]") {
    REQUIRE(ct_equal(std::string_view("secret"), std::string_view("secret")));
    REQUIRE_FALSE(ct_equal(std::string_view("secret"), std::string_view("secreT")));
    REQUIRE_FALSE(ct_equal(std::string_view("secret"), std::string_view("secret2")));
    REQUIRE(ct_equal(std::string_view(""), std::string_view("")));
}
