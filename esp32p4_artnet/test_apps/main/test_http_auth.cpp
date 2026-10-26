//! HTTP 鉴权策略纯函数测试。

#include "artcore/http_auth.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::auth_policy;
using artcore::AuthResult;

TEST_CASE("已配置 token：有效 Bearer 放行、无效拒绝", "[auth]") {
    // token_configured=true
    REQUIRE(auth_policy(true, true, false, true) == AuthResult::Allow);   // 只读 + 有效
    REQUIRE(auth_policy(true, true, true, true) == AuthResult::Allow);    // 高危 + 有效
    REQUIRE(auth_policy(true, false, false, true) == AuthResult::Deny);   // 只读 + 无效
    REQUIRE(auth_policy(true, false, true, true) == AuthResult::Deny);    // 高危 + 无效
}

TEST_CASE("未配置 token + 强制鉴权：高危拒绝、只读放行", "[auth]") {
    // token_configured=false, require_auth=true, bearer_valid 无意义
    REQUIRE(auth_policy(false, false, true, true) == AuthResult::Deny);   // 高危（如 OTA/删文件）
    REQUIRE(auth_policy(false, false, false, true) == AuthResult::Allow); // 只读（如 GET 状态）
}

TEST_CASE("未配置 token + 关闭强制鉴权：全部放行（开发用）", "[auth]") {
    REQUIRE(auth_policy(false, false, true, false) == AuthResult::Allow);
    REQUIRE(auth_policy(false, false, false, false) == AuthResult::Allow);
}
