//! 固件配置（NVS 持久化，带 schema 版本便于平滑迁移）。
//!
//! 字段分三类：网络、DMX 输出、运行态（工作模式、HTTP token）。
//! CID 不持久化，运行时由 MAC 派生（重启稳定）。

#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

#include "artcore/output_config.hpp"
#include "artcore/result.hpp"

namespace artcore {

/// 当前配置 schema 版本。字段结构变更时 +1 并在 [`Settings::load`] 内迁移。
///
/// v2：新增 UART/网络输出开关与实时转发订阅字段（缺失时按默认值补齐）。
/// v3：HTTP token 不再明文存储，改存加盐 SHA-256（旧明文 token 在迁移时转存并抹除）。
inline constexpr uint16_t kSettingsSchemaVersion = 3;

/// token 盐字节数。
inline constexpr std::size_t kTokenSaltLen = 16;
/// token 哈希字节数（SHA-256）。
inline constexpr std::size_t kTokenHashLen = 32;

/// 网络配置。
struct NetConfig {
    /// 使用 DHCP（超时回退静态）。
    bool dhcp = true;
    /// 静态 IPv4（主机序，dhcp=false 时生效）。
    uint32_t ip = 0;
    /// 子网掩码（主机序）。
    uint32_t netmask = 0;
    /// 网关（主机序）。
    uint32_t gateway = 0;
    /// 主机名（mDNS / DHCP 用）。
    std::string hostname = "artnet-core";
};

/// 全部可持久化配置。
struct AppSettings {
    /// schema 版本。
    uint16_t schema_version = kSettingsSchemaVersion;
    /// 网络。
    NetConfig net{};

    // ---- DMX 输出（持久化部分）----
    bool artnet_enabled = true;
    bool sacn_enabled = false;
    TargetMode target_mode = TargetMode::Broadcast;
    uint32_t unicast_ip = 0;
    uint16_t artnet_port = 6454;
    uint16_t sacn_port = 5568;
    bool sacn_multicast = true;
    uint8_t sacn_priority = 100;
    std::string source_name = "ArtNet Core";
    StopBehavior stop_behavior = StopBehavior::Hold;
    uint32_t keepalive_ms = 1000;

    // ---- 输出通路开关（v2）----
    /// 启用 UART DMX512 输出（口 ↔ universe 映射见 Kconfig）。
    bool uart_output_enabled = true;
    /// 启用网络（Art-Net / sACN UDP）输出；与 artnet_enabled / sacn_enabled 结合生效。
    bool net_output_enabled = false;

    // ---- 实时转发订阅（v2，工作模式 1 用）----
    /// 转发订阅起始 universe。
    uint16_t forward_uni_start = 0;
    /// 转发订阅 universe 数量。
    uint16_t forward_uni_count = 4;
    /// 转发时是否同时接收并合并 sACN（否则只收 Art-Net）。
    bool forward_sacn = false;

    // ---- 运行态 ----
    /// 工作模式（0 自动 / 1 Art-Net 转发 / 2 回路 / 3 场景 / 4 节目 / 5 效果）。
    uint8_t work_mode = 0;

    // ---- HTTP token（加盐哈希，不存明文）----
    /// 是否已设置 token。
    bool token_set = false;
    /// 随机盐。
    std::array<uint8_t, kTokenSaltLen> token_salt{};
    /// SHA-256(salt || token)。
    std::array<uint8_t, kTokenHashLen> token_hash{};
};

/// 配置管理：从 NVS 加载 / 保存，并生成运行时 [`OutputConfig`]。
class Settings {
public:
    /// 从 NVS 加载；命名空间不存在时写入默认值（schema=当前版本）。
    ///
    /// # Errors
    ///
    /// NVS 打开 / 读取 / 提交失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> load() noexcept;

    /// 将当前配置写回 NVS 并提交。
    ///
    /// # Errors
    ///
    /// NVS 写入 / 提交失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> save() noexcept;

    /// 可变配置引用。
    [[nodiscard]] AppSettings& data() noexcept { return s_; }
    /// 只读配置引用。
    [[nodiscard]] const AppSettings& data() const noexcept { return s_; }

    /// 由持久化字段 + 运行态信息生成 [`OutputConfig`]。
    ///
    /// # Arguments
    ///
    /// * `mac` - 本机 6 字节 MAC，用于派生稳定 CID。
    /// * `broadcast_ip` - 当前网卡定向广播地址（主机序）。
    ///
    /// # Returns
    ///
    /// 可直接交给 [`DmxOutput::configure`] 的配置。
    [[nodiscard]] OutputConfig output_config(const uint8_t mac[6],
                                             uint32_t broadcast_ip) const noexcept;

    /// 是否已配置 HTTP token。
    [[nodiscard]] bool has_token() const noexcept { return s_.token_set; }

    /// 常量时间校验呈现的 token 是否匹配已存哈希。
    ///
    /// # Arguments
    ///
    /// * `presented` - 请求携带的明文 token。
    ///
    /// # Returns
    ///
    /// 未设置 token 或不匹配返回 `false`。
    [[nodiscard]] bool verify_token(std::string_view presented) const noexcept;

    /// 设置（或以空串清除）HTTP token，生成随机盐并存加盐哈希后持久化。
    ///
    /// # Arguments
    ///
    /// * `token` - 新 token；空串表示清除鉴权。
    ///
    /// # Errors
    ///
    /// NVS 写入失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> set_token(std::string_view token) noexcept;

private:
    AppSettings s_{};
};

}  // namespace artcore
