//! SD 卡挂载与文件原语实现。

#include "artcore/storage.hpp"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

#include "driver/sdmmc_host.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"

#if SOC_SDMMC_IO_POWER_EXTERNAL
#include "sd_pwr_ctrl_by_on_chip_ldo.h"
#endif

#include "sdkconfig.h"

namespace artcore {

namespace {
constexpr const char* kTag = "storage";
}

SdCard::~SdCard() { unmount(); }

Result<void> SdCard::mount(const char* mount_point) noexcept {
    if (card_ != nullptr) {
        return {};  // 已挂载
    }
    mount_point_ = mount_point;

    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.max_freq_khz = CONFIG_ART_SD_FREQ_KHZ;

#if SOC_SDMMC_IO_POWER_EXTERNAL
    sd_pwr_ctrl_ldo_config_t ldo_cfg = {};
    ldo_cfg.ldo_chan_id = CONFIG_ART_SD_LDO_CHAN;
    sd_pwr_ctrl_handle_t pwr = nullptr;
    if (sd_pwr_ctrl_new_on_chip_ldo(&ldo_cfg, &pwr) != ESP_OK) {
        return err(Status::IoError);
    }
    host.pwr_ctrl_handle = pwr;
    pwr_ = pwr;
#endif

    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = CONFIG_ART_SD_WIDTH;
#ifdef SOC_SDMMC_USE_GPIO_MATRIX
    slot.clk = static_cast<gpio_num_t>(CONFIG_ART_SD_CLK);
    slot.cmd = static_cast<gpio_num_t>(CONFIG_ART_SD_CMD);
    slot.d0 = static_cast<gpio_num_t>(CONFIG_ART_SD_D0);
#if CONFIG_ART_SD_WIDTH == 4
    slot.d1 = static_cast<gpio_num_t>(CONFIG_ART_SD_D1);
    slot.d2 = static_cast<gpio_num_t>(CONFIG_ART_SD_D2);
    slot.d3 = static_cast<gpio_num_t>(CONFIG_ART_SD_D3);
#endif
#endif
#if CONFIG_ART_SD_INTERNAL_PULLUP
    slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
#endif

    esp_vfs_fat_sdmmc_mount_config_t mcfg = {};
    mcfg.format_if_mount_failed = false;
    mcfg.max_files = 6;
    mcfg.allocation_unit_size = 32 * 1024;
    mcfg.disk_status_check_enable = true;

    sdmmc_card_t* card = nullptr;
    esp_err_t e = esp_vfs_fat_sdmmc_mount(mount_point, &host, &slot, &mcfg, &card);
    if (e != ESP_OK) {
#if SOC_SDMMC_IO_POWER_EXTERNAL
        if (pwr_ != nullptr) {
            sd_pwr_ctrl_del_on_chip_ldo(static_cast<sd_pwr_ctrl_handle_t>(pwr_));
            pwr_ = nullptr;
        }
#endif
        return err(Status::IoError);
    }
    card_ = card;
    return {};
}

void SdCard::unmount() noexcept {
    if (card_ != nullptr) {
        esp_vfs_fat_sdcard_unmount(mount_point_.c_str(), static_cast<sdmmc_card_t*>(card_));
        card_ = nullptr;
    }
#if SOC_SDMMC_IO_POWER_EXTERNAL
    if (pwr_ != nullptr) {
        sd_pwr_ctrl_del_on_chip_ldo(static_cast<sd_pwr_ctrl_handle_t>(pwr_));
        pwr_ = nullptr;
    }
#endif
}

namespace storage {

namespace {

/// 校验一段字节是否为合法 UTF-8。
bool is_valid_utf8(std::string_view s) noexcept {
    std::size_t i = 0;
    const std::size_t n = s.size();
    while (i < n) {
        uint8_t c = static_cast<uint8_t>(s[i]);
        std::size_t extra;
        if (c < 0x80) {
            extra = 0;
        } else if ((c & 0xE0) == 0xC0) {
            extra = 1;
            if (c < 0xC2) return false;  // 过长编码
        } else if ((c & 0xF0) == 0xE0) {
            extra = 2;
            // 3 字节过长（E0 80..9F）与 UTF-16 代理区（ED A0..BF）需看第二字节。
            if (i + 1 < n) {
                uint8_t c1 = static_cast<uint8_t>(s[i + 1]);
                if (c == 0xE0 && c1 < 0xA0) return false;  // 过长编码
                if (c == 0xED && c1 > 0x9F) return false;  // 代理区 U+D800..DFFF
            }
        } else if ((c & 0xF8) == 0xF0) {
            extra = 3;
            if (c > 0xF4) return false;
            // 4 字节过长（F0 80..8F）与超范围（F4 90..BF，> U+10FFFF）需看第二字节。
            if (i + 1 < n) {
                uint8_t c1 = static_cast<uint8_t>(s[i + 1]);
                if (c == 0xF0 && c1 < 0x90) return false;  // 过长编码
                if (c == 0xF4 && c1 > 0x8F) return false;  // > U+10FFFF
            }
        } else {
            return false;
        }
        if (i + extra >= n) {
            return false;
        }
        for (std::size_t k = 1; k <= extra; ++k) {
            if ((static_cast<uint8_t>(s[i + k]) & 0xC0) != 0x80) {
                return false;
            }
        }
        i += extra + 1;
    }
    return true;
}

}  // namespace

bool is_valid_program_filename(std::string_view name) noexcept {
    if (name.empty() || name.size() > 128) {
        return false;
    }
    if (name.front() == '.') {
        return false;
    }
    if (!is_valid_utf8(name)) {
        return false;
    }
    for (char ch : name) {
        uint8_t c = static_cast<uint8_t>(ch);
        if (c < 0x20) {
            return false;  // 控制字符
        }
        if (ch == '/' || ch == '\\') {
            return false;  // 路径分隔符
        }
    }
    if (name.find("..") != std::string_view::npos) {
        return false;
    }
    static constexpr std::string_view kExt = ".artrec";
    if (name.size() <= kExt.size()) {
        return false;
    }
    return name.substr(name.size() - kExt.size()) == kExt;
}

Result<DiskInfo> disk_info(const char* mount_point) noexcept {
    uint64_t total = 0;
    uint64_t free_b = 0;
    if (esp_vfs_fat_info(mount_point, &total, &free_b) != ESP_OK) {
        return err(Status::IoError);
    }
    return DiskInfo{total, free_b};
}

Result<void> atomic_replace(const char* tmp, const char* dst) noexcept {
    // 先尝试直接重命名；FATFS 对已存在目标的行为不确定，失败则先删后重命名。
    if (std::rename(tmp, dst) == 0) {
        return {};
    }
    ::unlink(dst);
    if (std::rename(tmp, dst) == 0) {
        return {};
    }
    return err(Status::IoError);
}

void cleanup_part_files(const char* dir) noexcept {
    DIR* d = ::opendir(dir);
    if (d == nullptr) {
        return;
    }
    struct dirent* ent;
    while ((ent = ::readdir(d)) != nullptr) {
        std::string_view nm(ent->d_name);
        if (nm.size() > 5 && nm.substr(nm.size() - 5) == ".part") {
            std::string full = std::string(dir) + "/" + ent->d_name;
            ::unlink(full.c_str());
        }
    }
    ::closedir(d);
}

Result<void> ensure_dir(const char* dir) noexcept {
    struct stat st;
    if (::stat(dir, &st) == 0) {
        return (st.st_mode & S_IFDIR) ? Result<void>{} : err(Status::IoError);
    }
    if (::mkdir(dir, 0777) == 0) {
        return {};
    }
    return err(Status::IoError);
}

}  // namespace storage

}  // namespace artcore
