//! DMX 输出装配：Kconfig → 串口端口映射，依 settings + 网络重建网络/UART 输出。

#pragma once

#include <vector>

#include "app_context.hpp"
#include "artcore/dmx_uart.hpp"
#include "artcore/result.hpp"

namespace app {

/// 从 Kconfig 组装前 N 个 DMX 串口的端口映射（口数 1~4，夹取）。
[[nodiscard]] std::vector<artcore::DmxUartPort> build_uart_ports();

/// 依当前 settings + 网络信息重建 DMX 输出：网络 UDP（Art-Net/sACN）与 UART DMX512。
///
/// # Arguments
///
/// * `c` - 组合根上下文（用到 net / settings / player / uart / output）。
[[nodiscard]] artcore::Result<void> apply_output(Context& c);

}  // namespace app
