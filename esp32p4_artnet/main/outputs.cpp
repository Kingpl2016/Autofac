//! DMX 输出装配实现。

#include "outputs.hpp"

#include "artcore/status.hpp"
#include "esp_log.h"
#include "sdkconfig.h"

namespace app {

namespace {
constexpr const char* kTag = "outputs";
}  // namespace

std::vector<artcore::DmxUartPort> build_uart_ports() {
    const artcore::DmxUartPort all[4] = {
        {CONFIG_ART_DMX_P1_UART, CONFIG_ART_DMX_P1_TX,
         static_cast<uint16_t>(CONFIG_ART_DMX_P1_UNI)},
        {CONFIG_ART_DMX_P2_UART, CONFIG_ART_DMX_P2_TX,
         static_cast<uint16_t>(CONFIG_ART_DMX_P2_UNI)},
        {CONFIG_ART_DMX_P3_UART, CONFIG_ART_DMX_P3_TX,
         static_cast<uint16_t>(CONFIG_ART_DMX_P3_UNI)},
        {CONFIG_ART_DMX_P4_UART, CONFIG_ART_DMX_P4_TX,
         static_cast<uint16_t>(CONFIG_ART_DMX_P4_UNI)},
    };
    int n = CONFIG_ART_DMX_UART_PORTS;
    if (n < 1) {
        n = 1;
    }
    if (n > 4) {
        n = 4;
    }
    return std::vector<artcore::DmxUartPort>(all, all + n);
}

artcore::Result<void> apply_output(Context& c) {
    artcore::NetStatus ns = c.net.status();
    artcore::OutputConfig cfg = c.settings.output_config(ns.mac, ns.broadcast);
    cfg.unicast_ip = c.settings.data().unicast_ip;
    c.player.update_output_config(cfg);

    // UART DMX512：按总开关启停（关闭等效传入空端口列表）。
    if (c.settings.data().uart_output_enabled) {
        if (auto r = c.uart.configure(build_uart_ports(), CONFIG_ART_DMX_BREAK_BITS); !r) {
            ESP_LOGE(kTag, "DMX UART 配置失败：%s", artcore::status_name(r.error()));
        }
    } else {
        c.uart.shutdown();
    }

    // 网络 UDP 输出（artnet/sacn 开关已与 net_output_enabled 结合）。
    return c.output.configure(cfg);
}

}  // namespace app
