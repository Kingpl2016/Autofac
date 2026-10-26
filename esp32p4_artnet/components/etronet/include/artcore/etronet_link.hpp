//! 总线 MCU（Etronet）串口链路：566400/8N1 UART 传输，收帧→派发→回应答帧。
//!
//! ESP32 为纯从机：后台 RX 线程持续读 UART 字节，喂入 [`etronet::FrameParser`]，
//! 对每个完整合法帧调用 [`etronet::dispatch`]（业务经注入的 [`etronet::RegHandler`] 执行），
//! 并把生成的应答帧写回 UART。
//!
//! 本头文件不依赖 ESP-IDF；驱动调用集中在 `etronet_link.cpp`。生命周期（configure/
//! shutdown、重复 configure 先关再建）与线程安全参照 `dmx_out` 的 `DmxUart`。

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <thread>

#include "artcore/etronet_proto.hpp"
#include "artcore/result.hpp"

namespace artcore {

/// 串口链路配置（口 / 引脚 / 波特率）。
struct EtronetLinkConfig {
    /// UART 控制器编号（串口分配表：UART1 外部高速通信；避开控制台 UART0 与 DMX UART2）。
    int uart_num = 1;
    /// TX GPIO（串口分配表：UART1 TX=GPIO4，上板前核对）。
    int tx_gpio = 4;
    /// RX GPIO（串口分配表：UART1 RX=GPIO5，上板前核对）。
    int rx_gpio = 5;
    /// 波特率（协议规定 566400）。
    int baud = 566400;
    /// 数据载荷长度上限（超限帧丢弃，防内存灌爆）。
    std::size_t max_payload = etronet::kMaxPayloadLen;
};

/// 总线 MCU（Etronet）串口链路。
class EtronetLink {
public:
    EtronetLink() = default;
    ~EtronetLink();

    EtronetLink(const EtronetLink&) = delete;
    EtronetLink& operator=(const EtronetLink&) = delete;

    /// 安装 UART（8 数据位 / 无校验 / 1 停止位 / 无流控）并启动 RX 线程。
    ///
    /// 重复调用会先 [`shutdown`] 再按新配置重建。
    ///
    /// # Arguments
    ///
    /// * `cfg` - 串口配置。
    /// * `handler` - 寄存器业务回调（由 app 层注入，复用既有动作）。
    ///
    /// # Errors
    ///
    /// UART 驱动安装 / 参数 / 引脚设置失败返回 [`Status::IoError`]；
    /// `handler` 为空返回 [`Status::InvalidArg`]。
    [[nodiscard]] Result<void> configure(const EtronetLinkConfig& cfg,
                                         etronet::RegHandler handler) noexcept;

    /// 停止 RX 线程并卸载 UART 驱动。
    void shutdown() noexcept;

    /// 是否正在运行。线程安全。
    [[nodiscard]] bool running() const noexcept { return running_.load(); }

private:
    void run() noexcept;

    mutable std::mutex mutex_;  ///< 保护配置重建与 shutdown 的互斥。
    std::atomic<bool> running_{false};
    std::thread thread_;
    int uart_num_ = -1;
    EtronetLinkConfig cfg_{};
    etronet::RegHandler handler_;
    etronet::FrameParser parser_;
};

}  // namespace artcore
