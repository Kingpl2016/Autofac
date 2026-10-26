//! 总线 MCU 串口桥接：构造把寄存器帧转发到 [`artcore::BoardControl`] 的处理回调。
//!
//! 业务与 HTTP 侧同源（统一走 BoardControl）；本单元只做「帧 → 控制层 → 应答码」的映射。

#pragma once

#include "app_context.hpp"
#include "artcore/etronet_proto.hpp"

namespace app {

/// 构造总线 MCU 串口的寄存器处理回调（捕获 `c.control`）。
///
/// 寄存器映射（协议 2.5）：0x0000 核心板操作 / 0x0001 通道读写(不支持) /
/// 0x0002 节目操作 / 0x0003 工作模式。
[[nodiscard]] artcore::etronet::RegHandler make_etronet_handler(Context& c);

}  // namespace app
