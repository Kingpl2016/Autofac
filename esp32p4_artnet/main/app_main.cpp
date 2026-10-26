//! 固件装配入口（组合根）：按序初始化各子系统并接线。
//!
//! 仅保留「装配 + 启动时序」；具体业务已拆分到同目录的职责单元：
//! - `mode_manager`   工作模式 → 转发/回放门禁
//! - `outputs`        Kconfig → 串口端口映射，重建网络/UART 输出
//! - `board_lifecycle` 出厂 / 延迟重启
//! - `etronet_bridge` 串口帧 → BoardControl
//! 所有子系统实例集中在 `app::Context`（见 `app_context.hpp`）。
//!
//! 启动顺序：基础初始化 → 配置 → SD / 节目目录 → 网络 → mDNS → DMX 输出 →
//! 回放引擎 → 设备发现 → 控制层 → HTTP 服务 → 工作模式 → 串口 → OTA 首启自检。

#include <cstring>

#include "app_context.hpp"
#include "board_lifecycle.hpp"
#include "etronet_bridge.hpp"
#include "mode_manager.hpp"
#include "outputs.hpp"

#include "artcore/log_ring.hpp"
#include "artcore/ota.hpp"
#include "artcore/status.hpp"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace {

constexpr const char* kTag = "app";

/// 所有子系统实例（静态存储，生命周期即整个运行期）。
app::Context g;

}  // namespace

extern "C" void app_main(void) {
    // 1. 基础初始化。
    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    artcore::log_ring::install();

    artcore::OtaStatus boot_ota = artcore::ota_status();
    ESP_LOGI(kTag, "ArtNet Core 启动：固件 %s，运行分区 %s，IDF %s",
             boot_ota.version.c_str(), boot_ota.running_partition.c_str(), esp_get_idf_version());

    // 2. 配置。
    if (auto r = g.settings.load(); !r) {
        ESP_LOGE(kTag, "配置加载失败，使用默认值");
    }
    // 出厂默认 token：NVS 未设置且配置了默认值时预置，避免「无 token + 强制鉴权」
    // 导致新设备连 PUT /api/config 都被拒、无法远程设置 token 的自锁。
    if (std::strlen(CONFIG_ART_DEFAULT_HTTP_TOKEN) > 0 && !g.settings.has_token()) {
        if (auto r = g.settings.set_token(CONFIG_ART_DEFAULT_HTTP_TOKEN); !r) {
            ESP_LOGE(kTag, "预置默认 token 失败");
        }
    }

    // 3. SD 卡 + 目录 + 节目映射。
    bool sd_ok = false;
    if (auto r = g.sd.mount(app::kMount); r) {
        sd_ok = true;
        (void)artcore::storage::ensure_dir(app::kProgramsDir);
        artcore::storage::cleanup_part_files(app::kProgramsDir);
        (void)g.store.init(app::kProgramsDir, app::kProgramsJson);
        ESP_LOGI(kTag, "SD 卡已挂载，节目目录 %s", app::kProgramsDir);
    } else {
        ESP_LOGE(kTag, "SD 卡挂载失败：%s（文件接口将返回 503）",
                 artcore::status_name(r.error()));
    }

    // 4. 网络。
    if (auto r = g.net.start(g.settings.data().net, CONFIG_ART_DHCP_TIMEOUT_MS); !r) {
        ESP_LOGE(kTag, "以太网启动失败：%s", artcore::status_name(r.error()));
    }
    (void)artcore::start_mdns(CONFIG_ART_MDNS_HOSTNAME, "ArtNet Core", CONFIG_ART_HTTP_PORT);

    // 5. DMX 输出。
    if (auto r = app::apply_output(g); !r) {
        ESP_LOGE(kTag, "DMX 输出初始化失败：%s", artcore::status_name(r.error()));
    }

    // 6. 回放引擎（经输出路由器下发到网络 + UART 两路）。
    g.router.bind(&g.output, &g.uart);
    {
        artcore::NetStatus ns = g.net.status();
        artcore::OutputConfig outcfg = g.settings.output_config(ns.mac, ns.broadcast);
        g.player.start(&g.router, &g.store, outcfg);
    }

    // 7. 设备发现应答（上报当前节目的输出 Universe）。
    (void)g.discovery.start(&g.net, [] { return g.player.output_universes(); });

    // 7.5 核心板控制层（寄存器语义唯一实现，HTTP 与串口共用）。
    g.control.bind({
        .player = &g.player,
        .store = &g.store,
        .settings = &g.settings,
        .programs_dir = app::kProgramsDir,
        .reboot = app::defer_restart,
        .factory_reset = app::defer_factory,
        .apply_mode = [](uint8_t m) { app::apply_mode(g, m); },
    });

    // 8. HTTP 服务。
    artcore::ApiDeps deps;
    deps.settings = &g.settings;
    deps.player = &g.player;
    deps.store = &g.store;
    deps.control = &g.control;
    deps.output = &g.output;
    deps.uart = &g.uart;
    deps.net = &g.net;
    deps.sd = &g.sd;
    deps.programs_dir = app::kProgramsDir;
    deps.mount_point = app::kMount;
    deps.reboot = [] { esp_restart(); };
    deps.factory_reset = app::factory_reset;
    deps.apply_output = [] { return app::apply_output(g); };
    deps.apply_mode = [](uint8_t m) { app::apply_mode(g, m); };
    if (auto r = g.api.start(deps, CONFIG_ART_HTTP_PORT); !r) {
        ESP_LOGE(kTag, "HTTP 服务启动失败：%s", artcore::status_name(r.error()));
    }

    // 8.5 按当前工作模式应用一次（模式 1 会启动实时转发）。
    app::apply_mode(g, g.settings.data().work_mode);

    // 8.6 总线 MCU 串口（Etronet）：按 Kconfig 使能，ESP32 作纯从机收帧并回应答。
#if CONFIG_ART_ETRONET_ENABLE
    {
        artcore::EtronetLinkConfig ecfg;
        ecfg.uart_num = CONFIG_ART_ETRONET_UART;
        ecfg.tx_gpio = CONFIG_ART_ETRONET_TX;
        ecfg.rx_gpio = CONFIG_ART_ETRONET_RX;
        ecfg.baud = CONFIG_ART_ETRONET_BAUD;
        ecfg.max_payload = CONFIG_ART_ETRONET_MAX_FRAME;
        if (auto r = g.etronet.configure(ecfg, app::make_etronet_handler(g)); !r) {
            ESP_LOGE(kTag, "总线 MCU 串口启动失败：%s", artcore::status_name(r.error()));
        }
    }
#endif

    // 9. OTA 首启自检：网络就绪 + SD 挂载视为成功，确认有效；否则回滚。
    if (artcore::ota_pending_verify()) {
        bool healthy = g.net.status().got_ip && sd_ok;
        if (healthy) {
            artcore::ota_mark_valid();
        } else {
            ESP_LOGE(kTag, "OTA 首启自检失败（net=%d sd=%d），回滚",
                     g.net.status().got_ip, sd_ok);
            artcore::ota_mark_invalid_and_reboot();
        }
    }

    ESP_LOGI(kTag, "初始化完成，空闲堆 %u 字节",
             static_cast<unsigned>(esp_get_free_heap_size()));
}
