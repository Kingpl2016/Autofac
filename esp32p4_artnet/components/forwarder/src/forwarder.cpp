//! 实时转发实现：收 Art-Net/sACN → 跨来源 HTP 合并 → OutputRouter。

#include "artcore/forwarder.hpp"

#include <sys/time.h>

#include <algorithm>
#include <cstring>

#include "artcore/dmx_packet.hpp"
#include "artcore/htp_merge.hpp"
#include "esp_log.h"
#include "esp_pthread.h"
#include "esp_timer.h"
#include "lwip/sockets.h"

namespace artcore {

namespace {
constexpr const char* kTag = "forward";
/// 来源超时（无更新则剔除）。
constexpr uint64_t kSourceTimeoutUs = 3'000'000;
/// select 轮询超时（便于检查 running 标志并喂看门狗）。
constexpr int kSelectTimeoutMs = 200;
/// 接收缓冲（足以容纳 ArtDmx/sACN 整包）。
constexpr std::size_t kRxBuf = 1024;
/// 每 universe 最大来源数（防伪造源 IP 灌爆内存）。
constexpr std::size_t kMaxSourcesPerUniverse = 8;

/// 单调微秒时钟。
uint64_t now_us() noexcept { return static_cast<uint64_t>(esp_timer_get_time()); }

/// 创建并绑定一个 UDP socket 到指定端口（主机序）。失败返回 -1。
int bind_udp(uint16_t port) noexcept {
    int s = ::lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s < 0) {
        return -1;
    }
    int one = 1;
    ::lwip_setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    ::lwip_setsockopt(s, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = lwip_htons(port);
    addr.sin_addr.s_addr = INADDR_ANY;
    if (::lwip_bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::lwip_close(s);
        return -1;
    }
    return s;
}
}  // namespace

Forwarder::~Forwarder() { stop(); }

Result<void> Forwarder::start(OutputRouter* out, uint16_t uni_start, uint16_t uni_count,
                              bool enable_sacn) noexcept {
    stop();
    out_ = out;
    uni_start_ = uni_start;
    uni_count_ = uni_count;
    sacn_ = enable_sacn;
    universes_.clear();

    // 每次进入模式 1 从零统计，给出本次会话的干净视图。
    rx_datagrams_.store(0, std::memory_order_relaxed);
    artnet_parsed_.store(0, std::memory_order_relaxed);
    sacn_parsed_.store(0, std::memory_order_relaxed);
    dropped_range_.store(0, std::memory_order_relaxed);
    last_src_ip_.store(0, std::memory_order_relaxed);
    last_universe_.store(0, std::memory_order_relaxed);
    sources_.store(0, std::memory_order_relaxed);

    if (out_ == nullptr || uni_count_ == 0) {
        ESP_LOGW(kTag, "转发未启用（out 为空或订阅范围为 0）");
        return {};
    }

    artnet_sock_ = bind_udp(dmx::kArtnetPort);
    if (artnet_sock_ < 0) {
        return err(Status::IoError);
    }

    if (sacn_) {
        sacn_sock_ = bind_udp(dmx::kSacnPort);
        if (sacn_sock_ < 0) {
            ::lwip_close(artnet_sock_);
            artnet_sock_ = -1;
            return err(Status::IoError);
        }
        // 按订阅范围 join 组播 239.255.hi.lo。
        for (uint32_t u = uni_start_; u < static_cast<uint32_t>(uni_start_) + uni_count_; ++u) {
            ip_mreq mreq{};
            mreq.imr_multiaddr.s_addr = lwip_htonl(dmx::sacn_multicast_v4(static_cast<uint16_t>(u)));
            mreq.imr_interface.s_addr = INADDR_ANY;
            ::lwip_setsockopt(sacn_sock_, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq));
        }
    }

    running_.store(true);
    esp_pthread_cfg_t cfg = esp_pthread_get_default_config();
    cfg.thread_name = "forwarder";
    cfg.stack_size = 5120;
    cfg.prio = 8;
    cfg.pin_to_core = 0;
    esp_pthread_set_cfg(&cfg);
    thread_ = std::thread([this] { run(); });

    ESP_LOGI(kTag, "转发已启动：universe [%u,%u) sACN=%d", uni_start_,
             static_cast<unsigned>(uni_start_) + uni_count_, sacn_ ? 1 : 0);
    return {};
}

void Forwarder::stop() noexcept {
    if (!running_.exchange(false)) {
        // 可能从未启动，但仍清理残留 socket。
        if (artnet_sock_ >= 0) {
            ::lwip_close(artnet_sock_);
            artnet_sock_ = -1;
        }
        if (sacn_sock_ >= 0) {
            ::lwip_close(sacn_sock_);
            sacn_sock_ = -1;
        }
        if (thread_.joinable()) {
            thread_.join();
        }
        return;
    }
    if (artnet_sock_ >= 0) {
        ::lwip_shutdown(artnet_sock_, SHUT_RDWR);
    }
    if (sacn_sock_ >= 0) {
        ::lwip_shutdown(sacn_sock_, SHUT_RDWR);
    }
    if (thread_.joinable()) {
        thread_.join();
    }
    if (artnet_sock_ >= 0) {
        ::lwip_close(artnet_sock_);
        artnet_sock_ = -1;
    }
    if (sacn_sock_ >= 0) {
        ::lwip_close(sacn_sock_);
        sacn_sock_ = -1;
    }
    universes_.clear();
    sources_.store(0, std::memory_order_relaxed);
}

bool Forwarder::in_range(uint16_t universe) const noexcept {
    return universe_in_range(universe, uni_start_, uni_count_);
}

ForwarderStats Forwarder::stats() const noexcept {
    ForwarderStats s;
    s.running = running_.load();
    s.uni_start = uni_start_;
    s.uni_count = uni_count_;
    s.sacn = sacn_;
    s.rx_datagrams = rx_datagrams_.load(std::memory_order_relaxed);
    s.artnet_parsed = artnet_parsed_.load(std::memory_order_relaxed);
    s.sacn_parsed = sacn_parsed_.load(std::memory_order_relaxed);
    s.dropped_range = dropped_range_.load(std::memory_order_relaxed);
    s.last_src_ip = last_src_ip_.load(std::memory_order_relaxed);
    s.last_universe = static_cast<uint16_t>(last_universe_.load(std::memory_order_relaxed));
    s.sources = sources_.load(std::memory_order_relaxed);
    return s;
}

void Forwarder::run() noexcept {
    std::vector<uint8_t> rx(kRxBuf);
    uint64_t last_prune = now_us();

    while (running_.load()) {
        fd_set rfds;
        FD_ZERO(&rfds);
        int maxfd = -1;
        if (artnet_sock_ >= 0) {
            FD_SET(artnet_sock_, &rfds);
            maxfd = std::max(maxfd, artnet_sock_);
        }
        if (sacn_sock_ >= 0) {
            FD_SET(sacn_sock_, &rfds);
            maxfd = std::max(maxfd, sacn_sock_);
        }
        if (maxfd < 0) {
            break;
        }

        timeval tv{};
        tv.tv_sec = kSelectTimeoutMs / 1000;
        tv.tv_usec = (kSelectTimeoutMs % 1000) * 1000;
        int sel = ::lwip_select(maxfd + 1, &rfds, nullptr, nullptr, &tv);

        const uint64_t n = now_us();
        if (sel > 0) {
            // Art-Net（6454）。
            if (artnet_sock_ >= 0 && FD_ISSET(artnet_sock_, &rfds)) {
                sockaddr_in src{};
                socklen_t sl = sizeof(src);
                int got = ::lwip_recvfrom(artnet_sock_, rx.data(), rx.size(), 0,
                                          reinterpret_cast<sockaddr*>(&src), &sl);
                if (got > 0) {
                    rx_datagrams_.fetch_add(1, std::memory_order_relaxed);
                    auto p = dmx::parse_artdmx(
                        std::span<const uint8_t>(rx.data(), static_cast<std::size_t>(got)));
                    if (p.has_value()) {
                        artnet_parsed_.fetch_add(1, std::memory_order_relaxed);
                        ingest(p->universe, p->data, p->len, p->priority, p->terminated,
                               lwip_ntohl(src.sin_addr.s_addr), n);
                    }
                }
            }
            // sACN（5568）。
            if (sacn_sock_ >= 0 && FD_ISSET(sacn_sock_, &rfds)) {
                sockaddr_in src{};
                socklen_t sl = sizeof(src);
                int got = ::lwip_recvfrom(sacn_sock_, rx.data(), rx.size(), 0,
                                          reinterpret_cast<sockaddr*>(&src), &sl);
                if (got > 0) {
                    rx_datagrams_.fetch_add(1, std::memory_order_relaxed);
                    auto p = dmx::parse_sacn_data(
                        std::span<const uint8_t>(rx.data(), static_cast<std::size_t>(got)));
                    if (p.has_value()) {
                        sacn_parsed_.fetch_add(1, std::memory_order_relaxed);
                        ingest(p->universe, p->data, p->len, p->priority, p->terminated,
                               lwip_ntohl(src.sin_addr.s_addr), n);
                    }
                }
            }
        }

        // 周期性剔除超时来源。
        if (n - last_prune >= kSourceTimeoutUs) {
            prune(n);
            last_prune = n;
        }
    }
}

void Forwarder::ingest(uint16_t universe, const uint8_t* data, uint16_t len, uint8_t priority,
                       bool terminated, uint32_t src_ip, uint64_t now) noexcept {
    // 记录最近一包（无论是否在范围内），便于诊断"收没收到 / 来自哪个来源 / 哪个 universe"。
    last_src_ip_.store(src_ip, std::memory_order_relaxed);
    last_universe_.store(universe, std::memory_order_relaxed);

    if (data == nullptr) {
        return;
    }
    if (!in_range(universe)) {
        const uint32_t d = dropped_range_.fetch_add(1, std::memory_order_relaxed) + 1;
        if (d == 1 || (d % 500) == 0) {
            ESP_LOGW(kTag, "收到范围外 universe=%u（订阅 [%u,%u)），累计丢弃 %u 帧",
                     static_cast<unsigned>(universe), static_cast<unsigned>(uni_start_),
                     static_cast<unsigned>(uni_start_) + uni_count_, static_cast<unsigned>(d));
        }
        return;
    }
    if (len > 512) {
        len = 512;
    }
    UniverseState& st = universes_[universe];

    // Stream_Terminated：剔除该来源并重算（若存在）。
    if (terminated) {
        const std::size_t before = st.sources.size();
        st.sources.erase(std::remove_if(st.sources.begin(), st.sources.end(),
                                        [src_ip](const Source& s) { return s.ip == src_ip; }),
                         st.sources.end());
        const std::size_t removed = before - st.sources.size();
        if (removed != 0) {
            sources_.fetch_sub(static_cast<uint32_t>(removed), std::memory_order_relaxed);
            if (st.sources.empty()) {
                universes_.erase(universe);
            } else {
                merge_and_send(universe, st);
            }
        }
        return;
    }

    Source* src = nullptr;
    for (auto& s : st.sources) {
        if (s.ip == src_ip) {
            src = &s;
            break;
        }
    }
    if (src == nullptr) {
        // 源数上限：防伪造源 IP 灌爆内存；满则丢弃新源。
        if (st.sources.size() >= kMaxSourcesPerUniverse) {
            return;
        }
        st.sources.emplace_back();
        src = &st.sources.back();
        src->ip = src_ip;
        sources_.fetch_add(1, std::memory_order_relaxed);
    }
    src->last_us = now;
    // 归一化优先级：Art-Net（priority=0）按 E1.31 默认 100 参与合并。
    src->priority = (priority == 0) ? 100 : priority;
    // 只清尾部（维持 [len,512) 恒为 0 的不变式），避免每包整块 512B 清零。
    const uint16_t prev = src->len;
    if (len > 0) {
        std::memcpy(src->data.data(), data, len);
    }
    if (len < prev) {
        std::memset(src->data.data() + len, 0, static_cast<std::size_t>(prev) - len);
    }
    src->len = len;
    merge_and_send(universe, st);
}

void Forwarder::merge_and_send(uint16_t universe, UniverseState& st) noexcept {
    if (st.sources.empty() || out_ == nullptr) {
        return;
    }
    // 组装来源视图，交给纯函数做优先级 + HTP 合并（单源走快路径）。
    MergeSource ms[kMaxSourcesPerUniverse];
    std::size_t n = 0;
    for (const auto& s : st.sources) {
        if (n >= kMaxSourcesPerUniverse) {
            break;
        }
        ms[n].data = s.data.data();
        ms[n].len = s.len;
        ms[n].priority = s.priority;
        ++n;
    }
    std::array<uint8_t, 512> merged{};
    std::size_t out_len = htp_merge_priority(ms, n, merged.data());
    out_->send_universe(universe, std::span<const uint8_t>(merged.data(), out_len));
}

void Forwarder::prune(uint64_t now) noexcept {
    for (auto it = universes_.begin(); it != universes_.end();) {
        auto& sources = it->second.sources;
        const std::size_t before = sources.size();
        sources.erase(std::remove_if(sources.begin(), sources.end(),
                                     [&](const Source& s) {
                                         return now - s.last_us > kSourceTimeoutUs;
                                     }),
                      sources.end());
        const std::size_t removed = before - sources.size();
        if (removed != 0) {
            sources_.fetch_sub(static_cast<uint32_t>(removed), std::memory_order_relaxed);
        }
        if (removed != 0 && !sources.empty()) {
            merge_and_send(it->first, it->second);  // 来源减少，重算下发
        }
        if (sources.empty()) {
            it = universes_.erase(it);  // 全部来源超时：停止该 universe（保留最后输出）
        } else {
            ++it;
        }
    }
}

}  // namespace artcore
