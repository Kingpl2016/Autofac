//! 全工程统一的状态码与到协议 / HTTP 的映射。
//!
//! `Status` 同时承载两种对外语义：
//! - 控制语义沿用《核心板控制软件要求》的应答码 0~7；
//! - HTTP 接口把它映射为对应状态码（见 [`status_to_http`]）。
//!
//! 内部另加了 `NoSpace` / `Again` 等扩展值，仅用于固件内部流转，
//! 对外时按就近语义映射。

#pragma once

#include <cstdint>

namespace artcore {

/// 统一状态码。数值 0~7 与上位机应答码一一对应，便于可追溯。
enum class Status : uint8_t {
    /// 成功。
    Ok = 0,
    /// 参数非法。
    InvalidArg = 1,
    /// 目标未找到（节目号 / 文件不存在）。
    NotFound = 2,
    /// 设备忙（升级中、切换中、已有播放事务）。
    Busy = 3,
    /// 不支持的操作（录制、通道读写、差分帧等本期未实现项）。
    NotSupported = 4,
    /// 底层 IO 错误（SD 读写、socket 等）。
    IoError = 5,
    /// 文件非法（.artrec 头校验失败、格式不符）。
    BadFile = 6,
    /// 当前工作模式不允许该操作。
    WrongMode = 7,
    /// 存储空间不足。
    NoSpace = 8,
    /// 暂不可用 / 请稍后重试（资源未就绪）。
    Again = 9,
};

/// 返回状态码对应的短名（英文，用于日志）。
///
/// # Arguments
///
/// * `s` - 状态码。
///
/// # Returns
///
/// 以 `\0` 结尾的静态字符串，调用方不得释放。
constexpr const char* status_name(Status s) noexcept {
    switch (s) {
        case Status::Ok:           return "ok";
        case Status::InvalidArg:   return "invalid_arg";
        case Status::NotFound:     return "not_found";
        case Status::Busy:         return "busy";
        case Status::NotSupported: return "not_supported";
        case Status::IoError:      return "io_error";
        case Status::BadFile:      return "bad_file";
        case Status::WrongMode:    return "wrong_mode";
        case Status::NoSpace:      return "no_space";
        case Status::Again:        return "again";
    }
    return "unknown";
}

/// 把状态码映射为 HTTP 状态码。
///
/// # Arguments
///
/// * `s` - 状态码。
///
/// # Returns
///
/// 对应的 HTTP 数字状态码；`Ok` 返回 200。
constexpr int status_to_http(Status s) noexcept {
    switch (s) {
        case Status::Ok:           return 200;
        case Status::InvalidArg:   return 400;
        case Status::NotFound:     return 404;
        case Status::Busy:         return 409;
        case Status::NotSupported: return 501;
        case Status::IoError:      return 500;
        case Status::BadFile:      return 422;
        case Status::WrongMode:    return 409;
        case Status::NoSpace:      return 507;
        case Status::Again:        return 503;
    }
    return 500;
}

/// 把状态码压缩为 0~7 的协议应答字节（扩展值按就近语义归并）。
///
/// # Arguments
///
/// * `s` - 状态码。
///
/// # Returns
///
/// 0~7 的应答码：`NoSpace` 归入 `IoError`，`Again` 归入 `Busy`。
constexpr uint8_t status_to_reply_code(Status s) noexcept {
    switch (s) {
        case Status::NoSpace: return static_cast<uint8_t>(Status::IoError);
        case Status::Again:   return static_cast<uint8_t>(Status::Busy);
        default:              return static_cast<uint8_t>(s);
    }
}

}  // namespace artcore
