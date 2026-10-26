//! 核心板控制层实现（寄存器语义的唯一实现，供 HTTP 与串口两条通道复用）。

#include "artcore/control.hpp"

#include <unistd.h>

namespace artcore {

Result<void> BoardControl::board_op(int op) noexcept {
    switch (op) {
        case 0:  // 复位
            if (d_.reboot) d_.reboot();
            return {};
        case 1:  // 出厂
            if (d_.factory_reset) d_.factory_reset();
            return {};
        case 2:  // 测试
            return {};
        default:
            return err(Status::InvalidArg);
    }
}

Result<void> BoardControl::program_op(int no, int action) noexcept {
    if (no < 1 || no > 255) {
        return err(Status::InvalidArg);
    }
    const auto no16 = static_cast<uint16_t>(no);

    if (action == 5) {  // 录制：不支持
        return err(Status::NotSupported);
    }
    if (action == 4) {  // 删除
        auto file = d_.store->file_for(no16);
        if (!file) return err(Status::NotFound);
        // 若正在播放该节目，先停止并关闭。
        PlayerStatus ps = d_.player->status();
        if (ps.program_no == no && ps.state != static_cast<uint8_t>(PlayState::Idle)) {
            d_.player->cmd_stop();
            d_.player->cmd_close();
        }
        const std::string full = d_.programs_dir + "/" + *file;
        ::unlink(full.c_str());
        (void)d_.store->on_file_removed(*file);
        return {};
    }

    // 播放 / 暂停 / 停止：需工作模式允许（自动 0 / 节目 4）。
    const uint8_t wm = d_.settings->data().work_mode;
    if (wm != 0 && wm != 4) {
        return err(Status::WrongMode);
    }
    switch (action) {
        case 0:  // 停止
            d_.player->cmd_stop();
            break;
        case 1:  // 暂停
            d_.player->cmd_pause();
            break;
        case 2:  // 单次
        case 3:  // 循环
            if (!d_.store->file_for(no16)) {
                return err(Status::NotFound);
            }
            d_.player->cmd_open(no16);
            d_.player->cmd_set_repeat(action == 3 ? RepeatMode::Loop : RepeatMode::Off);
            d_.player->cmd_play();
            break;
        default:
            return err(Status::InvalidArg);
    }
    return {};
}

Result<void> BoardControl::set_work_mode(int mode) noexcept {
    if (mode < 0 || mode > 5) {
        return err(Status::InvalidArg);
    }
    d_.settings->data().work_mode = static_cast<uint8_t>(mode);
    (void)d_.settings->save();
    if (d_.apply_mode) {
        d_.apply_mode(static_cast<uint8_t>(mode));
    }
    return {};
}

uint8_t BoardControl::work_mode() const noexcept { return d_.settings->data().work_mode; }

Result<void> BoardControl::player_seek(uint32_t pos_ms) noexcept {
    d_.player->cmd_seek(pos_ms);
    return {};
}

Result<void> BoardControl::player_set_speed(int speed_x100) noexcept {
    d_.player->cmd_set_speed(static_cast<uint16_t>(speed_x100));
    return {};
}

}  // namespace artcore
