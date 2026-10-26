//! 推送式 OTA 实现。

#include "artcore/ota.hpp"

#include <algorithm>
#include <cstring>

#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "sdkconfig.h"

namespace artcore {

namespace {
constexpr const char* kTag = "ota";
}

OtaSession::~OtaSession() { abort(); }

Result<void> OtaSession::begin(std::size_t total_size) noexcept {
    if (active_) {
        return err(Status::Busy);
    }
    const esp_partition_t* target = esp_ota_get_next_update_partition(nullptr);
    if (target == nullptr) {
        return err(Status::IoError);
    }
    esp_ota_handle_t h = 0;
    esp_err_t e =
        esp_ota_begin(target, total_size == 0 ? OTA_SIZE_UNKNOWN : total_size, &h);
    if (e != ESP_OK) {
        ESP_LOGE(kTag, "esp_ota_begin 失败：%s", esp_err_to_name(e));
        return err(Status::IoError);
    }
    target_ = target;
    handle_ = h;
    active_ = true;
    written_ = 0;
    head_len_ = 0;
    new_version_.clear();
    ESP_LOGI(kTag, "OTA 开始写入分区 %s", target->label);
    return {};
}

void OtaSession::capture_version(std::span<const uint8_t> chunk) noexcept {
    // 累积前 256 字节，解析镜像头后的 esp_app_desc_t 取版本。
    if (head_len_ >= sizeof(head_)) {
        return;
    }
    std::size_t take = std::min(sizeof(head_) - head_len_, chunk.size());
    std::memcpy(head_ + head_len_, chunk.data(), take);
    head_len_ += take;

    constexpr std::size_t kDescOff = sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t);
    if (head_len_ >= kDescOff + sizeof(esp_app_desc_t) && new_version_.empty()) {
        esp_app_desc_t desc;
        std::memcpy(&desc, head_ + kDescOff, sizeof(desc));
        if (desc.magic_word == ESP_APP_DESC_MAGIC_WORD) {
            char ver[33];
            std::memcpy(ver, desc.version, sizeof(desc.version));
            ver[32] = '\0';
            new_version_ = ver;
            ESP_LOGI(kTag, "新固件版本：%s", new_version_.c_str());
        }
    }
}

Result<void> OtaSession::write(std::span<const uint8_t> chunk) noexcept {
    if (!active_) {
        return err(Status::IoError);
    }
    capture_version(chunk);
    esp_err_t e = esp_ota_write(static_cast<esp_ota_handle_t>(handle_), chunk.data(), chunk.size());
    if (e != ESP_OK) {
        ESP_LOGE(kTag, "esp_ota_write 失败：%s", esp_err_to_name(e));
        abort();
        return err(Status::IoError);
    }
    written_ += chunk.size();
    return {};
}

Result<void> OtaSession::finish() noexcept {
    if (!active_) {
        return err(Status::IoError);
    }
    esp_err_t e = esp_ota_end(static_cast<esp_ota_handle_t>(handle_));
    active_ = false;
    if (e != ESP_OK) {
        // 校验失败（含签名，如启用）。
        ESP_LOGE(kTag, "esp_ota_end 校验失败：%s", esp_err_to_name(e));
        return err(Status::BadFile);
    }
    e = esp_ota_set_boot_partition(static_cast<const esp_partition_t*>(target_));
    if (e != ESP_OK) {
        ESP_LOGE(kTag, "设置启动分区失败：%s", esp_err_to_name(e));
        return err(Status::IoError);
    }
    ESP_LOGI(kTag, "OTA 完成，共 %u 字节，重启后生效", static_cast<unsigned>(written_));
    return {};
}

void OtaSession::abort() noexcept {
    if (active_) {
        esp_ota_abort(static_cast<esp_ota_handle_t>(handle_));
        active_ = false;
    }
}

OtaStatus ota_status() noexcept {
    OtaStatus s;
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running != nullptr) {
        s.running_partition = running->label;
        esp_ota_img_states_t st;
        if (esp_ota_get_state_partition(running, &st) == ESP_OK) {
            s.pending_verify = (st == ESP_OTA_IMG_PENDING_VERIFY);
        }
    }
    const esp_app_desc_t* desc = esp_app_get_description();
    if (desc != nullptr) {
        s.version = desc->version;
        s.compile_time = std::string(desc->date) + " " + desc->time;
    }
#if CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
    s.rollback_enabled = true;
#endif
    return s;
}

bool ota_pending_verify() noexcept {
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running == nullptr) {
        return false;
    }
    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(running, &st) != ESP_OK) {
        return false;
    }
    return st == ESP_OTA_IMG_PENDING_VERIFY;
}

void ota_mark_valid() noexcept {
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(kTag, "固件自检通过，已确认有效");
}

void ota_mark_invalid_and_reboot() noexcept {
    ESP_LOGE(kTag, "固件自检失败，回滚到旧固件");
    esp_ota_mark_app_invalid_rollback_and_reboot();
    // 正常不会返回。
    for (;;) {
    }
}

}  // namespace artcore
