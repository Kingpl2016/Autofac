//! E1.31 优先级 + HTP 合并（纯函数，便于单测）。
//!
//! 语义：接收端只采用**最高优先级**的来源集合；在同一最高优先级内逐通道取高（HTP）。
//! 单一最高优先级来源时走快路径直接拷贝，省去清零与逐通道比较。

#pragma once

#include <cstddef>
#include <cstdint>

namespace artcore {

/// 参与合并的一个来源。
struct MergeSource {
    /// 通道数据（长度 `len`，其余视为 0）。
    const uint8_t* data = nullptr;
    /// 通道数（<= 512）。
    uint16_t len = 0;
    /// 优先级（Art-Net 无此概念，调用方可归一化为默认值）。
    uint8_t priority = 0;
};

/// 按 E1.31 优先级 + HTP 合并多个来源到 `out`（容量须 >= 512）。
///
/// # Arguments
///
/// * `sources` - 来源数组。
/// * `n` - 来源数。
/// * `out` - 输出缓冲（容量 >= 512）。
///
/// # Returns
///
/// 输出通道数（参与合并来源 `len` 的最大值，上限 512）；无来源返回 0。
[[nodiscard]] inline std::size_t htp_merge_priority(const MergeSource* sources, std::size_t n,
                                                    uint8_t* out) noexcept {
    if (sources == nullptr || n == 0 || out == nullptr) {
        return 0;
    }
    // 1. 最高优先级。
    uint8_t maxp = 0;
    for (std::size_t i = 0; i < n; ++i) {
        if (sources[i].priority > maxp) {
            maxp = sources[i].priority;
        }
    }
    // 2. 统计最高优先级来源与输出长度。
    std::size_t hi_count = 0;
    const MergeSource* only = nullptr;
    std::size_t out_len = 0;
    for (std::size_t i = 0; i < n; ++i) {
        if (sources[i].priority != maxp) {
            continue;
        }
        ++hi_count;
        only = &sources[i];
        std::size_t cl = sources[i].len;
        if (cl > 512) {
            cl = 512;
        }
        if (cl > out_len) {
            out_len = cl;
        }
    }
    // 3. 单源快路径：直接拷贝 + 尾部补零。
    if (hi_count == 1) {
        std::size_t cl = only->len;
        if (cl > 512) {
            cl = 512;
        }
        for (std::size_t i = 0; i < cl; ++i) {
            out[i] = only->data[i];
        }
        for (std::size_t i = cl; i < out_len; ++i) {
            out[i] = 0;
        }
        return out_len;
    }
    // 4. 多源 HTP（逐通道取高）。
    for (std::size_t i = 0; i < out_len; ++i) {
        out[i] = 0;
    }
    for (std::size_t s = 0; s < n; ++s) {
        if (sources[s].priority != maxp) {
            continue;
        }
        std::size_t cl = sources[s].len;
        if (cl > 512) {
            cl = 512;
        }
        for (std::size_t i = 0; i < cl; ++i) {
            if (sources[s].data[i] > out[i]) {
                out[i] = sources[s].data[i];
            }
        }
    }
    return out_len;
}

}  // namespace artcore
