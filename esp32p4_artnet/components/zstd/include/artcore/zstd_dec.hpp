//! Zstd 解压封装（仅解压）。
//!
//! 对上游 `libzstd` 的解压 API 做薄封装，向工程其余部分只暴露 [`Result`] 风格接口，
//! 公开头文件不引入 `zstd.h`。上游源码由 `fetch_zstd` 脚本按固定版本拉到
//! `components/zstd/upstream/`（见组件 README）。

#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "artcore/result.hpp"

namespace artcore {

/// 一次性解压（内部每次新建上下文；非热路径用）。
///
/// # Arguments
///
/// * `dst` - 输出缓冲；容量须 >= 解压后原始长度。
/// * `src` - 压缩数据。
///
/// # Returns
///
/// 成功返回解压出的字节数。
///
/// # Errors
///
/// - 解压失败或 `dst` 容量不足返回 [`Status::BadFile`]。
[[nodiscard]] Result<std::size_t> zstd_decompress(std::span<uint8_t> dst,
                                                  std::span<const uint8_t> src) noexcept;

/// 可复用的解压上下文（回放热路径用，避免每帧重建）。
///
/// 持有一个 `ZSTD_DCtx`，跨帧复用。非线程安全：每个解码线程各持一个实例。
class ZstdDecoder {
public:
    /// 创建上下文；失败时 [`valid`] 为 `false`。
    ZstdDecoder() noexcept;
    ~ZstdDecoder();

    ZstdDecoder(const ZstdDecoder&) = delete;
    ZstdDecoder& operator=(const ZstdDecoder&) = delete;
    ZstdDecoder(ZstdDecoder&& other) noexcept;
    ZstdDecoder& operator=(ZstdDecoder&& other) noexcept;

    /// 复用内部上下文解压一帧。
    ///
    /// # Arguments
    ///
    /// * `dst` - 输出缓冲；容量须 >= 解压后原始长度。
    /// * `src` - 压缩数据。
    ///
    /// # Returns
    ///
    /// 成功返回解压出的字节数。
    ///
    /// # Errors
    ///
    /// - 上下文无效、解压失败或容量不足返回 [`Status::BadFile`]。
    [[nodiscard]] Result<std::size_t> decompress(std::span<uint8_t> dst,
                                                 std::span<const uint8_t> src) noexcept;

    /// 上下文是否创建成功。
    [[nodiscard]] bool valid() const noexcept { return ctx_ != nullptr; }

private:
    /// `ZSTD_DCtx*`，以 `void*` 隐藏上游类型。
    void* ctx_ = nullptr;
};

}  // namespace artcore
