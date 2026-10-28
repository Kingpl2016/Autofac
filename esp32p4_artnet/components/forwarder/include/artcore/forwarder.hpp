//! 实时转发：接收网络 Art-Net / sACN，按 universe 跨来源 HTP 合并后下发到输出路由。
//!
//! 工作模式 1（Art-Net 转发）启用本模块。接收线程：
//! - 绑定 UDP 6454（Art-Net）与 5568（sACN，按订阅范围 join 组播 `239.255.hi.lo`）。
//! - 维护每 (universe, source_ip) 的影子缓冲；同一 universe 多来源按 **HTP**（逐通道取
//!   高）合并，结果交给 [`OutputRouter`]（网络 + UART 两路）。
//! - 来源超时（默认 3s 无更新）剔除并重算合并。
//!
//! 仅处理订阅范围 `[uni_start, uni_start+uni_count)` 内的 universe，以界定内存与组播。

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <thread>
#include <unordered_map>
#include <vector>

#include "artcore/output_router.hpp"
#include "artcore/result.hpp"

namespace artcore {

/// universe 是否落在订阅范围 `[start, start+count)` 内。
///
/// 用 32 位累加避免 `start+count` 在 16 位上回绕；`count==0` 时恒为 false。
/// 抽成纯函数便于单测——这是转发"范围外丢弃"判定的唯一分支。
[[nodiscard]] constexpr bool universe_in_range(uint16_t universe, uint16_t start,
                                               uint16_t count) noexcept {
    return universe >= start &&
           static_cast<uint32_t>(universe) < static_cast<uint32_t>(start) + count;
}

/// 转发器接收统计快照（供 `GET /api/diag` 定位"收不到包"卡在哪一环）。
struct ForwarderStats {
    bool running = false;        ///< 转发线程是否在跑（仅工作模式 1）
    uint16_t uni_start = 0;      ///< 订阅起始 universe
    uint16_t uni_count = 0;      ///< 订阅 universe 数
    bool sacn = false;           ///< 是否同时接收 sACN
    uint32_t rx_datagrams = 0;   ///< 6454/5568 上成功收到的 UDP 包数
    uint32_t artnet_parsed = 0;  ///< 解析成功的 ArtDmx 帧数
    uint32_t sacn_parsed = 0;    ///< 解析成功的 sACN 数据帧数
    uint32_t dropped_range = 0;  ///< 解析成功但 universe 不在订阅范围被丢弃数
    uint32_t last_src_ip = 0;    ///< 最近一包来源 IP（主机序）
    uint16_t last_universe = 0;  ///< 最近一包的 universe
    uint32_t sources = 0;        ///< 当前活跃来源总数（跨 universe）
};

/// Art-Net / sACN 实时转发器。
class Forwarder {
public:
    Forwarder() = default;
    ~Forwarder();

    Forwarder(const Forwarder&) = delete;
    Forwarder& operator=(const Forwarder&) = delete;

    /// 启动接收线程并（可选）join sACN 组播。
    ///
    /// 重复调用先 [`stop`] 再按新参数重启。
    ///
    /// # Arguments
    ///
    /// * `out` - 输出路由器（生命周期须长于本对象）。
    /// * `uni_start` - 订阅起始 universe。
    /// * `uni_count` - 订阅 universe 数量（0 表示不转发）。
    /// * `enable_sacn` - 是否同时接收并合并 sACN（否则只收 Art-Net）。
    ///
    /// # Errors
    ///
    /// socket 创建 / 绑定失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> start(OutputRouter* out, uint16_t uni_start, uint16_t uni_count,
                                     bool enable_sacn) noexcept;

    /// 停止接收线程并关闭 socket。
    void stop() noexcept;

    /// 是否正在转发。
    [[nodiscard]] bool running() const noexcept { return running_.load(); }

    /// 读取接收统计快照（线程安全，用于诊断）。
    [[nodiscard]] ForwarderStats stats() const noexcept;

private:
    /// 单个来源的影子缓冲。
    struct Source {
        uint32_t ip = 0;          ///< 来源 IP（主机序）
        uint64_t last_us = 0;     ///< 最近更新单调时刻
        uint16_t len = 0;         ///< 该来源通道数
        uint8_t priority = 100;   ///< 归一化优先级（Art-Net→默认 100，sACN 用包内值）
        std::array<uint8_t, 512> data{};  ///< [len,512) 恒为 0 的 512 通道
    };
    /// 单个 universe 的多来源状态。
    struct UniverseState {
        std::vector<Source> sources;
    };

    void run() noexcept;
    /// 处理一帧解析结果（更新来源并重算 + 下发合并结果）。
    ///
    /// * `priority` - 来源优先级（0 视为 Art-Net，归一化为默认 100）。
    /// * `terminated` - sACN Stream_Terminated：剔除该来源并重算。
    void ingest(uint16_t universe, const uint8_t* data, uint16_t len, uint8_t priority,
                bool terminated, uint32_t src_ip, uint64_t now_us) noexcept;
    /// 对某 universe 做 HTP 合并并下发。
    void merge_and_send(uint16_t universe, UniverseState& st) noexcept;
    /// 剔除超时来源；对受影响 universe 重算下发。
    void prune(uint64_t now_us) noexcept;
    /// universe 是否在订阅范围内。
    [[nodiscard]] bool in_range(uint16_t universe) const noexcept;

    std::thread thread_;
    std::atomic<bool> running_{false};
    int artnet_sock_ = -1;
    int sacn_sock_ = -1;
    OutputRouter* out_ = nullptr;
    uint16_t uni_start_ = 0;
    uint16_t uni_count_ = 0;
    bool sacn_ = false;

    std::unordered_map<uint16_t, UniverseState> universes_;

    // ---- 接收统计（原子：转发线程写，HTTP 诊断线程只读快照）----
    std::atomic<uint32_t> rx_datagrams_{0};
    std::atomic<uint32_t> artnet_parsed_{0};
    std::atomic<uint32_t> sacn_parsed_{0};
    std::atomic<uint32_t> dropped_range_{0};
    std::atomic<uint32_t> last_src_ip_{0};
    std::atomic<uint32_t> last_universe_{0};
    std::atomic<uint32_t> sources_{0};
};

}  // namespace artcore
