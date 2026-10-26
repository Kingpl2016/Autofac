//! DMX 输出配置（由 settings 产生，dmx_out 消费）。放在 common 以免除彼此依赖。

#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace artcore {

/// 输出目标模式。
enum class TargetMode : uint8_t {
    /// 定向广播（发往子网广播地址）。
    Broadcast = 0,
    /// 单播到指定 IP。
    Unicast = 1,
};

/// 停止播放后的通道行为。
enum class StopBehavior : uint8_t {
    /// 保持最后一帧（不再发送）。
    Hold = 0,
    /// 发一帧全零熄灯。
    Blackout = 1,
};

/// DMX 输出配置。
struct OutputConfig {
    /// 启用 Art-Net 输出。
    bool artnet_enabled = true;
    /// 启用 sACN 输出。
    bool sacn_enabled = false;

    /// 目标模式。
    TargetMode target_mode = TargetMode::Broadcast;
    /// 单播目标 IPv4（主机序 u32）。
    uint32_t unicast_ip = 0;
    /// 当前网卡的定向广播地址（主机序 u32），由 net 组件填入。
    uint32_t broadcast_ip = 0;

    /// Art-Net UDP 端口（标准 6454）。
    uint16_t artnet_port = 6454;
    /// sACN UDP 端口（标准 5568）。
    uint16_t sacn_port = 5568;

    /// sACN 走组播（`239.255.hi.lo`）；否则按 target_mode 走单播 / 广播。
    bool sacn_multicast = true;
    /// sACN 优先级（0~200，默认 100）。
    uint8_t sacn_priority = 100;

    /// sACN 源名称（截断 / 补齐到 64 字节）。
    std::string source_name = "ArtNet Core";
    /// sACN 发送者 CID（16 字节，由 MAC 派生，重启后稳定）。
    std::array<uint8_t, 16> cid{};

    /// 停止行为。
    StopBehavior stop_behavior = StopBehavior::Hold;
    /// 静止段保活重发间隔（毫秒；0 表示不保活）。
    uint32_t keepalive_ms = 1000;
};

}  // namespace artcore
