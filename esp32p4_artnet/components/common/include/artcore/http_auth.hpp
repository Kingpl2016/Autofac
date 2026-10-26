//! HTTP 鉴权策略（纯逻辑，便于单测）。
//!
//! 把"是否放行"从 HTTP 具体实现中剥离出来，集中表达默认安全策略：
//! - 配置了 token：所有端点都必须携带有效 Bearer 才放行。
//! - 未配置 token 且要求鉴权（默认）：**高危（变更类）端点拒绝**，只读端点放行
//!   （可信内网下的取用便利，同时杜绝默认状态下被未授权刷机 / 改配 / 删文件）。
//! - 未配置 token 且显式关闭鉴权：全部放行（仅供开发，生产勿用）。

#pragma once

#include <cstdint>

namespace artcore {

/// 鉴权决策结果。
enum class AuthResult : uint8_t {
    /// 放行。
    Allow,
    /// 拒绝（调用方应回 401）。
    Deny,
};

/// 鉴权策略纯函数。
///
/// # Arguments
///
/// * `token_configured` - 是否已配置非空 token。
/// * `bearer_valid` - 本次请求是否携带与 token 匹配的有效 Bearer（仅在已配置时有意义）。
/// * `sensitive` - 本端点是否为高危 / 变更类（非 GET 请求、OTA、出厂等）。
/// * `require_auth` - 是否强制鉴权（对应 `CONFIG_ART_REQUIRE_AUTH`）。
///
/// # Returns
///
/// [`AuthResult::Allow`] 表示放行，[`AuthResult::Deny`] 表示拒绝。
[[nodiscard]] constexpr AuthResult auth_policy(bool token_configured, bool bearer_valid,
                                               bool sensitive, bool require_auth) noexcept {
    if (token_configured) {
        return bearer_valid ? AuthResult::Allow : AuthResult::Deny;
    }
    if (!require_auth) {
        return AuthResult::Allow;  // 显式关闭鉴权（开发用）
    }
    // 要求鉴权但未配置 token：高危端点拒绝，只读端点放行。
    return sensitive ? AuthResult::Deny : AuthResult::Allow;
}

}  // namespace artcore
