//! 输出路由：把一帧 Universe 同时下发到网络（Art-Net/sACN UDP）与 UART DMX512 两路。
//!
//! 回放引擎 [`Player`] 与实时转发 [`Forwarder`] 都只面向本类，不直接依赖具体输出器。
//! 每一路各自判断是否启用 / 是否有匹配口：
//! - [`DmxOutput`]：按 [`OutputConfig`] 的 artnet/sacn 开关决定是否真正发包。
//! - [`DmxUart`]：按是否存在匹配该 universe 的物理口决定是否输出。
//!
//! header-only：只做转发，无状态，不引入 IDF 依赖。

#pragma once

#include <cstdint>
#include <span>

#include "artcore/dmx_output.hpp"
#include "artcore/dmx_uart.hpp"

namespace artcore {

/// 双路输出路由器（网络 + UART）。
class OutputRouter {
public:
    OutputRouter() = default;

    /// 构造并绑定两路输出器（任一可为空）。
    OutputRouter(DmxOutput* net, DmxUart* uart) noexcept : net_(net), uart_(uart) {}

    /// 绑定 / 重绑两路输出器。指针生命周期须长于本路由器。
    ///
    /// # Arguments
    ///
    /// * `net` - 网络 UDP 发送器（可空）。
    /// * `uart` - UART DMX512 输出器（可空）。
    void bind(DmxOutput* net, DmxUart* uart) noexcept {
        net_ = net;
        uart_ = uart;
    }

    /// 下发一个 Universe 的 DMX 数据到两路。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 线性编号。
    /// * `data` - 通道数据（最多 512）。
    void send_universe(uint16_t universe, std::span<const uint8_t> data) noexcept {
        if (net_ != nullptr) {
            net_->send_universe(universe, data);
        }
        if (uart_ != nullptr) {
            uart_->send_universe(universe, data);
        }
    }

    /// 停流：仅对网络侧有意义（sACN Stream_Terminated）；UART 侧由上层清零处理。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 线性编号。
    /// * `data` - 最后一帧数据。
    void terminate_universe(uint16_t universe, std::span<const uint8_t> data) noexcept {
        if (net_ != nullptr) {
            net_->terminate_universe(universe, data);
        }
    }

private:
    DmxOutput* net_ = nullptr;
    DmxUart* uart_ = nullptr;
};

}  // namespace artcore
