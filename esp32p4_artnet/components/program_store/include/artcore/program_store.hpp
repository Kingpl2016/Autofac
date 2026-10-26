//! 节目编号 ↔ 文件映射表。
//!
//! - 内存索引：编号(1~255) → 文件名，O(1) 解析，供"按编号播放 / 查询 / 下载"。
//! - 持久化：`programs.json`（原子写），启动时与目录对账自愈：
//!   文件消失则移除映射，新文件分配最小空闲编号，JSON 损坏 / 缺失则从目录重建。
//!
//! 线程安全：内部互斥，控制线程与播放线程可并发访问。

#pragma once

#include <array>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "artcore/result.hpp"

namespace artcore {

/// 一条节目映射。
struct ProgramEntry {
    /// 节目号（1~255）。
    uint16_t no = 0;
    /// 文件名（不含目录）。
    std::string file;
    /// 文件字节大小。
    uint64_t size = 0;
};

/// 节目编号映射表。
class ProgramStore {
public:
    /// 可用节目号上限（1~255）。
    static constexpr uint16_t kMaxNo = 255;

    /// 初始化：加载 `programs.json` 并与节目目录对账。
    ///
    /// # Arguments
    ///
    /// * `programs_dir` - 节目目录绝对路径（如 `/sdcard/programs`）。
    /// * `json_path` - 映射表文件绝对路径（如 `/sdcard/programs.json`）。
    ///
    /// # Errors
    ///
    /// 目录不可访问返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> init(const char* programs_dir, const char* json_path) noexcept;

    /// 按编号解析文件名。
    ///
    /// # Arguments
    ///
    /// * `no` - 节目号。
    ///
    /// # Returns
    ///
    /// 命中返回文件名；无映射返回 `std::nullopt`。
    [[nodiscard]] std::optional<std::string> file_for(uint16_t no) const noexcept;

    /// 按编号解析文件绝对路径。
    [[nodiscard]] std::optional<std::string> path_for(uint16_t no) const noexcept;

    /// 查某编号的字节大小。
    [[nodiscard]] std::optional<uint64_t> size_for(uint16_t no) const noexcept;

    /// 反查文件名对应的编号。
    [[nodiscard]] std::optional<uint16_t> number_for(std::string_view file) const noexcept;

    /// 列出全部映射（按编号升序）。
    [[nodiscard]] std::vector<ProgramEntry> list() const noexcept;

    /// 把编号指向某文件。
    ///
    /// # Arguments
    ///
    /// * `no` - 节目号（1~255）。
    /// * `file` - 目标文件名（须已存在于节目目录）。
    /// * `force` - 编号已占用时是否覆盖。
    ///
    /// # Errors
    ///
    /// - 编号非法返回 [`Status::InvalidArg`]。
    /// - 文件不存在返回 [`Status::NotFound`]。
    /// - 编号已占用且未强制返回 [`Status::Busy`]。
    [[nodiscard]] Result<void> assign(uint16_t no, std::string_view file, bool force) noexcept;

    /// 解除某编号的映射（不删文件）。
    [[nodiscard]] Result<void> unassign(uint16_t no) noexcept;

    /// 新文件加入：若未映射则分配最小空闲编号。
    ///
    /// # Arguments
    ///
    /// * `file` - 文件名。
    /// * `size` - 文件字节大小。
    ///
    /// # Returns
    ///
    /// 该文件对应的编号（已存在映射则返回原编号）。
    ///
    /// # Errors
    ///
    /// 编号耗尽返回 [`Status::NoSpace`]。
    [[nodiscard]] Result<uint16_t> on_file_added(std::string_view file, uint64_t size) noexcept;

    /// 文件删除：移除其映射。
    [[nodiscard]] Result<void> on_file_removed(std::string_view file) noexcept;

    /// 文件重命名：映射跟随。
    [[nodiscard]] Result<void> on_file_renamed(std::string_view from, std::string_view to) noexcept;

private:
    struct Slot {
        std::string file;
        uint64_t size = 0;
    };

    [[nodiscard]] Result<void> persist_locked() noexcept;
    void reconcile_locked() noexcept;
    [[nodiscard]] uint16_t smallest_free_locked() const noexcept;

    mutable std::mutex mutex_;
    std::array<std::optional<Slot>, 256> slots_{};
    std::string dir_;
    std::string json_;
};

}  // namespace artcore
