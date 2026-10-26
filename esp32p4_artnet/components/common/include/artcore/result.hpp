//! `Result<T>`：承载成功值或 [`Status`] 的轻量返回类型。
//!
//! 基于 C++23 `std::expected`，统一替代 `esp_err_t` 的裸返回与 out 参数风格，
//! 全程不依赖 C++ 异常（IDF 默认关闭异常）。

#pragma once

#include <expected>
#include <utility>
#include <variant>

#include "artcore/status.hpp"

namespace artcore {

/// 成功时携带类型 `T`，失败时携带 [`Status`] 的返回类型。
template <class T>
using Result = std::expected<T, Status>;

/// 构造一个失败结果。
///
/// # Arguments
///
/// * `s` - 错误状态码。
///
/// # Returns
///
/// `std::unexpected<Status>`，可隐式转换为任意 `Result<T>` 的失败分支。
[[nodiscard]] constexpr std::unexpected<Status> err(Status s) noexcept {
    return std::unexpected<Status>(s);
}

/// 表示无返回值的成功 / 失败（等价于 `Result<std::monostate>` 的简化）。
using Unit = Result<std::monostate>;

/// 返回一个成功的 [`Unit`]。
[[nodiscard]] inline Unit ok() noexcept { return Unit{std::monostate{}}; }

}  // namespace artcore
