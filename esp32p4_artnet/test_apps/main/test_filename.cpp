//! 节目文件名校验测试。

#include "artcore/storage.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::storage::is_valid_program_filename;

TEST_CASE("合法文件名", "[filename]") {
    REQUIRE(is_valid_program_filename("show.artrec"));
    REQUIRE(is_valid_program_filename("20261026-120000_开场.artrec"));  // 中文 UTF-8
    REQUIRE(is_valid_program_filename("001_cue.artrec"));
}

TEST_CASE("非法文件名被拒绝", "[filename]") {
    REQUIRE_FALSE(is_valid_program_filename(""));
    REQUIRE_FALSE(is_valid_program_filename(".artrec"));         // 仅扩展名
    REQUIRE_FALSE(is_valid_program_filename(".hidden.artrec"));  // 以点开头
    REQUIRE_FALSE(is_valid_program_filename("a/b.artrec"));      // 路径分隔符
    REQUIRE_FALSE(is_valid_program_filename("a\\b.artrec"));     // 反斜杠
    REQUIRE_FALSE(is_valid_program_filename("../evil.artrec"));  // 穿越
    REQUIRE_FALSE(is_valid_program_filename("show.txt"));        // 扩展名不符
    REQUIRE_FALSE(is_valid_program_filename("show.artrec.txt")); // 扩展名不符
    REQUIRE_FALSE(is_valid_program_filename("bad\x01.artrec"));  // 控制字符
}

TEST_CASE("超长文件名被拒绝", "[filename]") {
    std::string long_name(130, 'a');
    long_name += ".artrec";
    REQUIRE_FALSE(is_valid_program_filename(long_name));
}

TEST_CASE("非法 UTF-8 文件名被拒绝", "[filename]") {
    // UTF-16 代理区 ED A0 80（U+D800）非法。
    REQUIRE_FALSE(is_valid_program_filename(std::string("\xED\xA0\x80", 3) + "x.artrec"));
    // 3 字节过长 E0 80 80。
    REQUIRE_FALSE(is_valid_program_filename(std::string("\xE0\x80\x80", 3) + "x.artrec"));
    // 4 字节过长 F0 80 80 80。
    REQUIRE_FALSE(is_valid_program_filename(std::string("\xF0\x80\x80\x80", 4) + "x.artrec"));
    // 超范围 F4 90 80 80（> U+10FFFF）。
    REQUIRE_FALSE(is_valid_program_filename(std::string("\xF4\x90\x80\x80", 4) + "x.artrec"));
    // 合法 3 字节中文 U+4E2D（E4 B8 AD）应通过。
    REQUIRE(is_valid_program_filename(std::string("\xE4\xB8\xAD", 3) + ".artrec"));
}
