//! 日志环形缓冲：把 ESP-IDF 日志同时留存在一段 RAM 环形缓冲里，
//! 供 HTTP `GET /api/logs` 远程取回，便于现场无串口排障。
//!
//! 安装后仍保留原有串口输出（tee 转发），不改变既有日志行为。

#pragma once

#include <cstddef>
#include <string>

namespace artcore::log_ring {

/// 安装日志钩子：把后续日志 tee 到环形缓冲，同时转发到原 vprintf。
///
/// 线程安全；重复调用只安装一次。缓冲区固定大小（见实现），满则覆盖最旧内容。
void install();

/// 读取当前环形缓冲中的全部日志文本（按时间顺序）。
///
/// # Returns
///
/// 缓冲内的日志快照（新分配的 `std::string`）；未安装或为空时返回空串。
std::string snapshot();

/// 清空环形缓冲。
void clear();

}  // namespace artcore::log_ring
