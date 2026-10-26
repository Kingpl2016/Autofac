//! 推送式 OTA 固件升级（基于官方 `esp_ota_ops`）。
//!
//! 上位机把固件 `.bin` 通过 HTTP `POST /api/ota` 分块上传，[`OtaSession`] 写入
//! 非活动分区、校验、设为启动分区并重启。配合 `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`：
//! 新固件首启进入 PENDING_VERIFY，自检通过调 [`ota_mark_valid`]；否则下次启动回滚。

#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

#include "artcore/result.hpp"

namespace artcore {

/// OTA / 固件状态。
struct OtaStatus {
    /// 当前运行分区 label。
    std::string running_partition;
    /// 当前固件版本。
    std::string version;
    /// 编译时间。
    std::string compile_time;
    /// 是否处于首启待确认状态（PENDING_VERIFY）。
    bool pending_verify = false;
    /// 是否启用了回滚。
    bool rollback_enabled = false;
};

/// 一次推送式 OTA 写入会话（RAII：未 finish 的会话析构时 abort）。
class OtaSession {
public:
    OtaSession() = default;
    ~OtaSession();

    OtaSession(const OtaSession&) = delete;
    OtaSession& operator=(const OtaSession&) = delete;

    /// 开始写入非活动 OTA 分区。
    ///
    /// # Arguments
    ///
    /// * `total_size` - 预期固件字节数（未知可传 0，使用 `OTA_SIZE_UNKNOWN`）。
    ///
    /// # Errors
    ///
    /// 无可用 OTA 分区或 `esp_ota_begin` 失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> begin(std::size_t total_size) noexcept;

    /// 写入一段固件数据。
    ///
    /// # Arguments
    ///
    /// * `chunk` - 数据片段。
    ///
    /// # Errors
    ///
    /// 未开始或 `esp_ota_write` 失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> write(std::span<const uint8_t> chunk) noexcept;

    /// 结束写入：校验镜像、设为下次启动分区（不重启）。
    ///
    /// # Errors
    ///
    /// 镜像校验失败返回 [`Status::BadFile`]；设置启动分区失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> finish() noexcept;

    /// 放弃本次写入。
    void abort() noexcept;

    /// 已写入字节数。
    [[nodiscard]] std::size_t written() const noexcept { return written_; }

    /// 从已写入数据解析出的新固件版本（可能为空）。
    [[nodiscard]] const std::string& new_version() const noexcept { return new_version_; }

private:
    void capture_version(std::span<const uint8_t> chunk) noexcept;

    uint64_t handle_ = 0;  ///< esp_ota_handle_t
    const void* target_ = nullptr;
    bool active_ = false;
    std::size_t written_ = 0;
    std::string new_version_;
    /// 镜像头缓冲：须容纳 esp_image_header(24)+esp_image_segment_header(8)+esp_app_desc(256)
    /// = 288 字节，取 320 留余量，保证 capture_version 能解析出版本号（原 256 偏小恒失败）。
    static constexpr std::size_t kHeadCaptureLen = 320;
    uint8_t head_[kHeadCaptureLen] = {};
    std::size_t head_len_ = 0;
};

/// 读取当前 OTA / 固件状态。
[[nodiscard]] OtaStatus ota_status() noexcept;

/// 是否处于首启待确认状态。
[[nodiscard]] bool ota_pending_verify() noexcept;

/// 确认当前固件有效，取消回滚（自检通过后调用）。
void ota_mark_valid() noexcept;

/// 标记当前固件无效并重启回滚到旧固件（自检失败时调用）。
[[noreturn]] void ota_mark_invalid_and_reboot() noexcept;

}  // namespace artcore
