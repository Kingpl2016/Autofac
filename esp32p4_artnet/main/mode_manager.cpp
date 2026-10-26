//! 工作模式管理实现。

#include "mode_manager.hpp"

#include "artcore/status.hpp"
#include "esp_log.h"

namespace app {

namespace {
constexpr const char* kTag = "mode";
}  // namespace

void apply_mode(Context& c, uint8_t mode) {
    // 离开节目 / 自动模式时停止播放（保持原门禁语义）。
    if (mode != 0 && mode != 4) {
        c.player.cmd_stop();
    }
    if (mode == 1) {
        c.player.cmd_close();
        c.forwarder.stop();
        const auto& s = c.settings.data();
        if (auto r = c.forwarder.start(&c.router, s.forward_uni_start, s.forward_uni_count,
                                       s.forward_sacn);
            !r) {
            ESP_LOGE(kTag, "实时转发启动失败：%s", artcore::status_name(r.error()));
        }
    } else {
        c.forwarder.stop();
    }
}

}  // namespace app
