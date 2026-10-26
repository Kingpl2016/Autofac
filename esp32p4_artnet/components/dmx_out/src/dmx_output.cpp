//! DMX UDP 发送器实现（lwIP BSD socket）。

#include "artcore/dmx_output.hpp"

#include <cstring>

#include "lwip/sockets.h"

namespace artcore {

namespace {
/// sACN Universe 合法范围上限（0 保留，>63999 保留）。
constexpr uint16_t kSacnUniverseMax = 63999;
}  // namespace

DmxOutput::~DmxOutput() { shutdown(); }

Result<void> DmxOutput::configure(const OutputConfig& cfg) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (sock_ >= 0) {
        ::lwip_close(sock_);
        sock_ = -1;
    }
    cfg_ = cfg;

    sock_ = ::lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock_ < 0) {
        return err(Status::IoError);
    }

    int one = 1;
    // 广播（Art-Net 定向广播、可选 sACN 广播）。
    ::lwip_setsockopt(sock_, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));

    // sACN 组播出口：绑定到当前网卡的本机地址，TTL 适中。
    if (cfg_.sacn_enabled && cfg_.sacn_multicast && cfg_.broadcast_ip != 0) {
        // 以广播地址推不出本机 IP，这里由 net 组件通过 unicast_ip 之外的途径设置出口；
        // 简化处理：设置组播 TTL，出口交由路由表 / 默认网卡决定。
        uint8_t ttl = 16;
        ::lwip_setsockopt(sock_, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
    }

    seq_artnet_.clear();
    seq_sacn_.clear();
    return {};
}

void DmxOutput::send_to(int sock, uint32_t host_ip, uint16_t port, const uint8_t* buf,
                        std::size_t len) noexcept {
    if (sock < 0 || len == 0) {
        return;
    }
    sockaddr_in dst{};
    dst.sin_family = AF_INET;
    dst.sin_port = lwip_htons(port);
    dst.sin_addr.s_addr = lwip_htonl(host_ip);
    ::lwip_sendto(sock, buf, len, 0, reinterpret_cast<sockaddr*>(&dst), sizeof(dst));
}

void DmxOutput::send_universe(uint16_t universe, std::span<const uint8_t> data) noexcept {
    // 临界区内只做序列号自增与打包到本地缓冲 + 快照 fd / 目标；网络 I/O 移到锁外，
    // 缩短锁持有时间，避免发送阻塞时串行化（回放 / 转发两路共用本锁）。
    uint8_t art_buf[dmx::kArtDmxMax];
    uint8_t sacn_buf[dmx::kSacnMax];
    std::size_t art_len = 0;
    std::size_t sacn_len = 0;
    uint32_t art_ip = 0;
    uint32_t sacn_ip = 0;
    uint16_t art_port = 0;
    uint16_t sacn_port = 0;
    int sock = -1;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        sock = sock_;
        if (sock < 0) {
            return;
        }
        // Art-Net。
        if (cfg_.artnet_enabled) {
            if (universe > dmx::kMaxPortAddress) {
                ++skipped_;
            } else {
                uint8_t seq = ++seq_artnet_[universe];
                std::size_t n =
                    dmx::build_artdmx_into(universe, seq, data, std::span<uint8_t>(art_buf));
                if (n > 0) {
                    art_len = n;
                    art_ip = (cfg_.target_mode == TargetMode::Unicast) ? cfg_.unicast_ip
                                                                       : cfg_.broadcast_ip;
                    art_port = cfg_.artnet_port;
                }
            }
        }
        // sACN。
        if (cfg_.sacn_enabled) {
            if (universe == 0 || universe > kSacnUniverseMax) {
                ++skipped_;
            } else {
                uint8_t seq = ++seq_sacn_[universe];
                std::size_t n =
                    dmx::build_sacn_into(universe, data, cfg_.cid.data(), cfg_.source_name.c_str(),
                                         cfg_.sacn_priority, seq, 0x00, std::span<uint8_t>(sacn_buf));
                if (n > 0) {
                    sacn_len = n;
                    sacn_ip = cfg_.sacn_multicast
                                  ? dmx::sacn_multicast_v4(universe)
                                  : ((cfg_.target_mode == TargetMode::Unicast) ? cfg_.unicast_ip
                                                                               : cfg_.broadcast_ip);
                    sacn_port = cfg_.sacn_port;
                }
            }
        }
    }
    // 锁外发送。
    if (art_len > 0) {
        send_to(sock, art_ip, art_port, art_buf, art_len);
    }
    if (sacn_len > 0) {
        send_to(sock, sacn_ip, sacn_port, sacn_buf, sacn_len);
    }
}

void DmxOutput::terminate_universe(uint16_t universe, std::span<const uint8_t> data) noexcept {
    uint8_t buf[dmx::kSacnMax];
    std::size_t len = 0;
    uint32_t ip = 0;
    uint16_t port = 0;
    int sock = -1;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        sock = sock_;
        if (sock < 0 || !cfg_.sacn_enabled) {
            return;
        }
        if (universe == 0 || universe > kSacnUniverseMax) {
            return;
        }
        uint8_t seq = ++seq_sacn_[universe];
        std::size_t n = dmx::build_sacn_into(universe, data, cfg_.cid.data(),
                                             cfg_.source_name.c_str(), cfg_.sacn_priority, seq,
                                             dmx::kSacnOptTerminated, std::span<uint8_t>(buf));
        if (n > 0) {
            len = n;
            ip = cfg_.sacn_multicast
                     ? dmx::sacn_multicast_v4(universe)
                     : ((cfg_.target_mode == TargetMode::Unicast) ? cfg_.unicast_ip
                                                                  : cfg_.broadcast_ip);
            port = cfg_.sacn_port;
        }
    }
    if (len > 0) {
        send_to(sock, ip, port, buf, len);
    }
}

void DmxOutput::shutdown() noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (sock_ >= 0) {
        ::lwip_close(sock_);
        sock_ = -1;
    }
}

}  // namespace artcore
