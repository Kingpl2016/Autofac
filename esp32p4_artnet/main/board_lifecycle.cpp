//! 核心板生命周期实现。

#include "board_lifecycle.hpp"

#include <unistd.h>

#include <thread>

#include "app_context.hpp"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"

namespace app {

namespace {
constexpr const char* kTag = "lifecycle";
}  // namespace

void factory_reset() {
    ESP_LOGW(kTag, "执行出厂初始化：清除 NVS 与节目映射");
    nvs_flash_erase();
    ::unlink(kProgramsJson);
    esp_restart();
}

void defer_restart() {
    std::thread([] {
        ::usleep(300 * 1000);  // 300ms：足以把 HTTP 响应 / 串口应答帧发完
        esp_restart();
    }).detach();
}

void defer_factory() {
    std::thread([] {
        ::usleep(300 * 1000);
        factory_reset();
    }).detach();
}

}  // namespace app
