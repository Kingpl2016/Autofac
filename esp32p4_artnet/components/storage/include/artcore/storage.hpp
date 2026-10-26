//! SD 卡挂载与安全文件原语。
//!
//! - [`SdCard`]：RAII 封装片上 LDO 供电 + SDMMC 4-bit 挂载 / 卸载。
//! - [`storage`] 命名空间：节目文件名校验、剩余空间、原子替换、`.part` 清理。
//!
//! 引脚、总线宽度、频率、LDO 通道取自工程 Kconfig（见 main/Kconfig.projbuild）。

#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include "artcore/result.hpp"

namespace artcore {

/// 磁盘容量信息（字节）。
struct DiskInfo {
    /// 总字节数。
    uint64_t total_bytes = 0;
    /// 剩余字节数。
    uint64_t free_bytes = 0;
};

/// SD 卡（SDMMC）RAII 句柄。
class SdCard {
public:
    SdCard() = default;
    ~SdCard();

    SdCard(const SdCard&) = delete;
    SdCard& operator=(const SdCard&) = delete;

    /// 初始化 LDO 供电并挂载 FAT 文件系统。
    ///
    /// # Arguments
    ///
    /// * `mount_point` - 挂载点（如 `/sdcard`）。
    ///
    /// # Errors
    ///
    /// LDO / SDMMC / 挂载失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> mount(const char* mount_point) noexcept;

    /// 卸载并释放 LDO（析构亦会调用）。
    void unmount() noexcept;

    /// 是否已挂载。
    [[nodiscard]] bool mounted() const noexcept { return card_ != nullptr; }

private:
    void* card_ = nullptr;  ///< sdmmc_card_t*
    void* pwr_ = nullptr;   ///< sd_pwr_ctrl_handle_t
    std::string mount_point_;
};

namespace storage {

/// 节目文件名合法性校验。
///
/// 规则：非空、UTF-8 合法、长度 <= 128 字节、不含路径分隔符 / `..` / 控制字符、
/// 不以 `.` 开头、以 `.artrec`（小写）结尾。
///
/// # Arguments
///
/// * `name` - 待校验的文件名（不含目录）。
///
/// # Returns
///
/// 合法返回 `true`。
[[nodiscard]] bool is_valid_program_filename(std::string_view name) noexcept;

/// 查询挂载卷的容量信息。
///
/// # Arguments
///
/// * `mount_point` - 挂载点。
///
/// # Errors
///
/// 查询失败返回 [`Status::IoError`]。
[[nodiscard]] Result<DiskInfo> disk_info(const char* mount_point) noexcept;

/// 原子替换：把 `tmp` 重命名为 `dst`（必要时先删除已存在的 `dst`）。
///
/// # Arguments
///
/// * `tmp` - 源临时文件绝对路径。
/// * `dst` - 目标绝对路径。
///
/// # Errors
///
/// 重命名失败返回 [`Status::IoError`]。
[[nodiscard]] Result<void> atomic_replace(const char* tmp, const char* dst) noexcept;

/// 清理目录下遗留的 `.part` 临时文件（上传中断残留）。
///
/// # Arguments
///
/// * `dir` - 目录绝对路径。
void cleanup_part_files(const char* dir) noexcept;

/// 确保目录存在（不存在则创建）。
///
/// # Arguments
///
/// * `dir` - 目录绝对路径。
///
/// # Errors
///
/// 创建失败返回 [`Status::IoError`]。
[[nodiscard]] Result<void> ensure_dir(const char* dir) noexcept;

}  // namespace storage

}  // namespace artcore
