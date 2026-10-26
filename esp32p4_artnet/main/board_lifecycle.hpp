//! 核心板生命周期：出厂初始化与「延迟重启」回调（给响应/应答留出发送时间）。

#pragma once

namespace app {

/// 出厂：清 NVS 与节目映射后立即重启。
void factory_reset();

/// 延迟软复位：约 300ms 后 esp_restart，先让 HTTP 响应 / 串口应答帧发出。
/// 作为 BoardControl 的 reboot 回调注入。
void defer_restart();

/// 延迟出厂：约 300ms 后执行 [`factory_reset`]。
/// 作为 BoardControl 的 factory_reset 回调注入。
void defer_factory();

}  // namespace app
