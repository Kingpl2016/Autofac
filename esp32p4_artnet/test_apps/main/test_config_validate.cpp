//! 运行时配置字段校验测试。

#include <string>
#include <string_view>

#include "artcore/config_validate.hpp"
#include "catch2/catch_test_macros.hpp"

using namespace artcore;

TEST_CASE("数值范围校验", "[cfgvalid]") {
    REQUIRE(valid_sacn_priority(0));
    REQUIRE(valid_sacn_priority(200));
    REQUIRE_FALSE(valid_sacn_priority(-1));
    REQUIRE_FALSE(valid_sacn_priority(201));
    REQUIRE_FALSE(valid_sacn_priority(300));  // 原始越界（窄化成 uint8 会被掩盖）

    REQUIRE(valid_target_mode(0));
    REQUIRE(valid_target_mode(1));
    REQUIRE_FALSE(valid_target_mode(2));

    REQUIRE(valid_stop_behavior(1));
    REQUIRE_FALSE(valid_stop_behavior(5));

    REQUIRE(valid_keepalive_ms(0));
    REQUIRE(valid_keepalive_ms(600000));
    REQUIRE_FALSE(valid_keepalive_ms(600001));

    REQUIRE(valid_forward_uni_start(0));
    REQUIRE(valid_forward_uni_start(32767));
    REQUIRE_FALSE(valid_forward_uni_start(32768));

    REQUIRE(valid_forward_uni_count(1));
    REQUIRE(valid_forward_uni_count(512));
    REQUIRE_FALSE(valid_forward_uni_count(0));
    REQUIRE_FALSE(valid_forward_uni_count(513));
}

TEST_CASE("主机名校验", "[cfgvalid]") {
    REQUIRE(valid_hostname("artnet-core"));
    REQUIRE(valid_hostname("node1"));
    REQUIRE_FALSE(valid_hostname(""));
    REQUIRE_FALSE(valid_hostname("-bad"));
    REQUIRE_FALSE(valid_hostname("bad-"));
    REQUIRE_FALSE(valid_hostname("has space"));
    REQUIRE_FALSE(valid_hostname("under_score"));
    REQUIRE_FALSE(valid_hostname(std::string_view(std::string(64, 'a'))));
}

TEST_CASE("源名校验", "[cfgvalid]") {
    REQUIRE(valid_source_name("ArtNet Core"));
    REQUIRE_FALSE(valid_source_name(""));
    REQUIRE_FALSE(valid_source_name(std::string_view("bad\x01name", 8)));
    REQUIRE_FALSE(valid_source_name(std::string_view(std::string(64, 'x'))));
}

TEST_CASE("token 校验", "[cfgvalid]") {
    REQUIRE(valid_http_token(""));           // 清除
    REQUIRE(valid_http_token("s3cretToken"));
    REQUIRE_FALSE(valid_http_token("short"));          // < 8
    REQUIRE_FALSE(valid_http_token(std::string_view(std::string(65, 'a'))));  // > 64
    REQUIRE_FALSE(valid_http_token("has space tok"));  // 含空格
}

TEST_CASE("IPv4 解析", "[cfgvalid]") {
    REQUIRE(parse_ipv4("192.168.1.200") == 0xC0A801C8u);
    REQUIRE(parse_ipv4("0.0.0.0") == 0x00000000u);
    REQUIRE(parse_ipv4("255.255.255.255") == 0xFFFFFFFFu);
    REQUIRE(parse_ipv4("10.0.0.1") == 0x0A000001u);

    // 非法：越界 / 段数不对 / 空段 / 多余字符 / 超长段。
    REQUIRE_FALSE(parse_ipv4("256.1.1.1").has_value());
    REQUIRE_FALSE(parse_ipv4("1.2.3").has_value());
    REQUIRE_FALSE(parse_ipv4("1.2.3.4.5").has_value());
    REQUIRE_FALSE(parse_ipv4("1.2.3.").has_value());
    REQUIRE_FALSE(parse_ipv4(".1.2.3").has_value());
    REQUIRE_FALSE(parse_ipv4("1.2.3.4 ").has_value());
    REQUIRE_FALSE(parse_ipv4("1.2..4").has_value());
    REQUIRE_FALSE(parse_ipv4("1.2.3.4444").has_value());
    REQUIRE_FALSE(parse_ipv4("a.b.c.d").has_value());
    REQUIRE_FALSE(parse_ipv4("").has_value());
}

TEST_CASE("IPv4 校验", "[cfgvalid]") {
    REQUIRE(valid_ipv4("192.168.1.1"));
    REQUIRE_FALSE(valid_ipv4("999.0.0.1"));
    REQUIRE_FALSE(valid_ipv4("not-an-ip"));
}
