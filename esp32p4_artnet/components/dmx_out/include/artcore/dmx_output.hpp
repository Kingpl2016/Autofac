//! DMX UDP 发送器：按 [`OutputConfig`] 将一个 Universe 的 DMX 数据
//! 以 Art-Net 和 / 或 sACN 发出。
//!
//! 发送在播放调度线程调用；配置变更在控制线程调用，内部用互斥保护 socket 切换。

#pragma once

#include <cstdint>
#include <mutex>
#include <span>
#include <unordered_map>

#include "artcore/dmx_packet.hpp"
#include "artcore/output_config.hpp"
#include "artcore/result.hpp"

namespace artcore {

/// DMX UDP 发送器。
class DmxOutput {
public:
    DmxOutput() = default;
    ~DmxOutput();

    DmxOutput(const DmxOutput&) = delete;
    DmxOutput& operator=(const DmxOutput&) = delete;

    /// 应用配置并（重新）创建发送 socket。
    ///
    /// # Arguments
    ///
    /// * `cfg` - 输出配置。
    ///
    /// # Errors
    ///
    /// socket 创建或选项设置失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> configure(const OutputConfig& cfg) noexcept;

    /// 发送一个 Universe 的 DMX 数据（按配置发 Art-Net 与 / 或 sACN）。
    ///
    /// Universe 越界（Art-Net > 0x7FFF，或 sACN 不在 1~63999）时跳过对应协议并计数。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 线性编号。
    /// * `data` - 通道数据（最多 512）。
    void send_universe(uint16_t universe, std::span<const uint8_t> data) noexcept;

    /// 发送 sACN Stream_Terminated（通知接收端该 Universe 停流）；Art-Net 无此概念。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    /// * `data` - 最后一帧数据（随终止包一并发出）。
    void terminate_universe(uint16_t universe, std::span<const uint8_t> data) noexcept;

    /// 关闭 socket。
    void shutdown() noexcept;

    /// 累计因越界被跳过的 Universe 次数。
    [[nodiscard]] uint32_t skipped_count() const noexcept { return skipped_; }

private:
    /// 实际 UDP 发送（在锁外调用，fd 由调用方在锁内快照得到）。
    void send_to(int sock, uint32_t host_ip, uint16_t port, const uint8_t* buf,
                 std::size_t len) noexcept;

    std::mutex mutex_;
    int sock_ = -1;
    OutputConfig cfg_{};
    uint32_t skipped_ = 0;
    std::unordered_map<uint16_t, uint8_t> seq_artnet_;
    std::unordered_map<uint16_t, uint8_t> seq_sacn_;
};

}  // namespace artcore
