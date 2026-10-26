//! 以太网接入、IP 配置、mDNS 与 Art-Net 设备发现应答。
//!
//! - 内部 EMAC + IP101 RMII PHY（REF_CLK 由 PHY 产生，EXT_IN，GPIO50）。
//! - DHCP 客户端 10 秒超时回退静态 IP。
//! - mDNS 广播主机名与 `_http._tcp` 服务。
//! - [`DiscoveryResponder`]：应答 ArtPoll → 回 ArtPollReply，使设备被上位机发现。

#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

#include "artcore/result.hpp"
#include "artcore/settings.hpp"

namespace artcore {

/// 网络状态快照。
struct NetStatus {
    /// 物理链路是否 up。
    bool link_up = false;
    /// 是否已取得 IP。
    bool got_ip = false;
    /// 是否为 DHCP 分配（否则为静态回退）。
    bool via_dhcp = false;
    /// 本机 IPv4（主机序）。
    uint32_t ip = 0;
    /// 子网掩码（主机序）。
    uint32_t netmask = 0;
    /// 网关（主机序）。
    uint32_t gateway = 0;
    /// 定向广播地址（主机序）。
    uint32_t broadcast = 0;
    /// 本机 MAC。
    uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
};

/// 以太网接入管理。
class Network {
public:
    /// 启动以太网并按配置取得 IP（DHCP 超时回退静态）。
    ///
    /// 调用前需已完成 `esp_netif_init`、默认事件循环与 NVS 初始化。
    ///
    /// # Arguments
    ///
    /// * `cfg` - 网络配置。
    /// * `dhcp_timeout_ms` - DHCP 等待超时（毫秒），超时后回退静态。
    ///
    /// # Errors
    ///
    /// 以太网驱动安装 / 启动失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> start(const NetConfig& cfg, uint32_t dhcp_timeout_ms) noexcept;

    /// 读取当前网络状态快照（线程安全）。
    [[nodiscard]] NetStatus status() const noexcept;

private:
    void* eth_handle_ = nullptr;
    void* netif_ = nullptr;
};

/// 启动 mDNS：广播主机名与 HTTP 服务。
///
/// # Arguments
///
/// * `hostname` - 主机名（`<hostname>.local`）。
/// * `instance` - 服务实例名。
/// * `http_port` - HTTP 服务端口。
///
/// # Errors
///
/// mDNS 初始化失败返回 [`Status::IoError`]。
[[nodiscard]] Result<void> start_mdns(const char* hostname, const char* instance,
                                      uint16_t http_port) noexcept;

/// Art-Net 设备发现应答：监听 6454 上的 ArtPoll，回 ArtPollReply。
class DiscoveryResponder {
public:
    /// 返回当前输出 Universe 列表的回调（由 app 绑定到当前节目）。
    using UniverseProvider = std::function<std::vector<uint16_t>()>;

    ~DiscoveryResponder();

    /// 启动应答任务。
    ///
    /// # Arguments
    ///
    /// * `net` - 网络管理器，用于获取本机 IP / MAC（生命周期须长于本对象）。
    /// * `provider` - 提供当前输出 Universe 的回调（可空，空则只报节点存在）。
    ///
    /// # Errors
    ///
    /// socket 创建失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> start(Network* net, UniverseProvider provider) noexcept;

    /// 停止应答任务。
    void stop() noexcept;

private:
    void run() noexcept;

    std::thread thread_;
    std::atomic<bool> running_{false};
    int sock_ = -1;
    Network* net_ = nullptr;
    UniverseProvider provider_;
};

}  // namespace artcore
