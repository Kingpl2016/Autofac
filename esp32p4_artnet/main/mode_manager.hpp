//! 工作模式管理（ModeManager）：把工作模式映射为实时转发启停与回放门禁。

#pragma once

#include <cstdint>

#include "app_context.hpp"

namespace app {

/// 应用工作模式。
///
/// - 模式 1（Art-Net 转发）：停止并关闭回放，按 settings 的 forward_* 启动转发。
/// - 模式 0（自动）/ 4（节目）：停止转发，允许回放（模式 0 简化为等同模式 4）。
/// - 模式 2/3/5：停止转发并停止回放，不触发其它行为（仅存取模式号）。
///
/// # Arguments
///
/// * `c` - 组合根上下文（用到 player / forwarder / router / settings）。
/// * `mode` - 目标工作模式（0~5）。
void apply_mode(Context& c, uint8_t mode);

}  // namespace app
