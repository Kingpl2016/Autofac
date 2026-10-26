//! Art-Net 设备发现应答（监听 6454 上的 ArtPoll，回 ArtPollReply）。

#include <algorithm>
#include <cstring>
#include <utility>
#include <vector>

#include "artcore/dmx_packet.hpp"
#include "artcore/net.hpp"
#include "esp_log.h"
#include "esp_pthread.h"
#include "lwip/sockets.h"

namespace artcore {

namespace {
constexpr const char* kTag = "discovery";
}

DiscoveryResponder::~DiscoveryResponder() { stop(); }

Result<void> DiscoveryResponder::start(Network* net, UniverseProvider provider) noexcept {
    if (running_.load()) {
        return {};
    }
    net_ = net;
    provider_ = std::move(provider);

    sock_ = ::lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock_ < 0) {
        return err(Status::IoError);
    }
    int one = 1;
    ::lwip_setsockopt(sock_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    ::lwip_setsockopt(sock_, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = lwip_htons(dmx::kArtnetPort);
    addr.sin_addr.s_addr = INADDR_ANY;
    if (::lwip_bind(sock_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::lwip_close(sock_);
        sock_ = -1;
        return err(Status::IoError);
    }

    running_.store(true);
    esp_pthread_cfg_t cfg = esp_pthread_get_default_config();
    cfg.thread_name = "artpoll";
    cfg.stack_size = 4096;
    cfg.prio = 4;
    cfg.pin_to_core = 0;
    esp_pthread_set_cfg(&cfg);
    thread_ = std::thread([this] { run(); });
    return {};
}

void DiscoveryResponder::stop() noexcept {
    if (!running_.load()) {
        return;
    }
    running_.store(false);
    if (sock_ >= 0) {
        ::lwip_shutdown(sock_, SHUT_RDWR);
        ::lwip_close(sock_);
        sock_ = -1;
    }
    if (thread_.joinable()) {
        thread_.join();
    }
}

void DiscoveryResponder::run() noexcept {
    uint8_t rx[64];
    uint8_t tx[dmx::kArtPollReplyLen];

    while (running_.load()) {
        sockaddr_in src{};
        socklen_t slen = sizeof(src);
        int n = ::lwip_recvfrom(sock_, rx, sizeof(rx), 0,
                                reinterpret_cast<sockaddr*>(&src), &slen);
        if (n <= 0) {
            if (!running_.load()) {
                break;
            }
            continue;
        }
        if (!dmx::is_artpoll(std::span<const uint8_t>(rx, static_cast<std::size_t>(n)))) {
            continue;
        }

        NetStatus st = net_ ? net_->status() : NetStatus{};
        std::vector<uint16_t> unis = provider_ ? provider_() : std::vector<uint16_t>{};

        dmx::PollReplyParams p{};
        p.ip[0] = static_cast<uint8_t>((st.ip >> 24) & 0xFF);
        p.ip[1] = static_cast<uint8_t>((st.ip >> 16) & 0xFF);
        p.ip[2] = static_cast<uint8_t>((st.ip >> 8) & 0xFF);
        p.ip[3] = static_cast<uint8_t>(st.ip & 0xFF);
        std::memcpy(p.mac, st.mac, 6);
        p.short_name = "ArtNetCore";
        p.long_name = "ArtNet Core Playback Node";

        // 按 4 个 Universe 一组分 bind 回复（上位机会合并）。
        std::size_t idx = 0;
        uint8_t bind = 1;
        do {
            std::size_t take = std::min<std::size_t>(4, unis.size() - idx);
            p.universes = std::span<const uint16_t>(unis.data() + idx, take);
            p.bind_index = bind;
            std::size_t len = dmx::build_artpollreply_into(p, std::span<uint8_t>(tx));
            if (len > 0) {
                ::lwip_sendto(sock_, tx, len, 0, reinterpret_cast<sockaddr*>(&src),
                              sizeof(src));
            }
            idx += take;
            ++bind;
        } while (idx < unis.size());
    }
}

}  // namespace artcore
