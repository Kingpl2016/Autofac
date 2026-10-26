//! 传输无关的核心板控制层：把《核心板控制软件要求》的寄存器语义集中实现一处。
//!
//! HTTP（`api_server`）与总线 MCU 串口（`etronet` 的处理回调）都把各自的「解析 +
//! 应答编码」做成薄适配器，业务动作统一走本层，避免两条通道各写一遍、行为漂移。
//!
//! 本层不涉及任何传输细节；复位 / 出厂 / 应用工作模式等副作用经回调注入，
//! 回调是否「延迟执行」由调用方（app 层）决定（串口侧需先把应答帧发出再重启）。

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <utility>

#include "artcore/player.hpp"
#include "artcore/program_store.hpp"
#include "artcore/result.hpp"
#include "artcore/settings.hpp"

namespace artcore {

/// 核心板控制（寄存器语义的唯一实现）。
class BoardControl {
public:
    /// 依赖与副作用回调。指针生命周期须长于 [`BoardControl`]。
    struct Deps {
        Player* player = nullptr;       ///< 回放引擎。
        ProgramStore* store = nullptr;  ///< 节目映射表。
        Settings* settings = nullptr;   ///< 配置。
        std::string programs_dir;       ///< 节目目录（删除时拼绝对路径）。
        std::function<void()> reboot;          ///< 复位（调用方可自行延迟）。
        std::function<void()> factory_reset;   ///< 出厂（调用方可自行延迟）。
        std::function<void(uint8_t)> apply_mode;  ///< 应用工作模式（ModeManager）。
    };

    BoardControl() = default;

    /// 绑定依赖（在各子系统就绪后调用）。
    void bind(Deps deps) noexcept { d_ = std::move(deps); }

    /// 0x0000 核心板操作：0 复位 / 1 出厂 / 2 测试。
    ///
    /// 复位 / 出厂仅触发注入的回调（是否延迟由回调自身决定），本函数立即返回成功，
    /// 以便调用方先把响应 / 应答发出。
    [[nodiscard]] Result<void> board_op(int op) noexcept;

    /// 0x0002 节目操作：节目号 1~255；动作 0 停 / 1 暂停 / 2 单次 / 3 循环 / 4 删除 / 5 录制。
    ///
    /// 录制不支持（[`Status::NotSupported`]）；播放类需工作模式允许（自动 0 / 节目 4），
    /// 否则 [`Status::WrongMode`]。
    [[nodiscard]] Result<void> program_op(int no, int action) noexcept;

    /// 0x0003 写工作模式（0~5）：存配置并应用（启停转发 / 回放门禁）。
    [[nodiscard]] Result<void> set_work_mode(int mode) noexcept;

    /// 0x0003 读工作模式。
    [[nodiscard]] uint8_t work_mode() const noexcept;

    /// 0x0011 跳转到指定毫秒位置。
    [[nodiscard]] Result<void> player_seek(uint32_t pos_ms) noexcept;

    /// 0x0012 设置倍速 ×100（引擎内夹取 25~200）。
    [[nodiscard]] Result<void> player_set_speed(int speed_x100) noexcept;

private:
    Deps d_;
};

}  // namespace artcore
