//! 以太网接入、IP 配置与 mDNS 实现。

#include "artcore/net.hpp"

#include <cstring>
#include <mutex>

#include "esp_eth.h"
#include "esp_eth_mac.h"
#include "esp_eth_mac_esp.h"
#include "esp_eth_phy.h"
#include "esp_eth_phy_ip101.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "lwip/inet.h"
#include "mdns.h"
#include "sdkconfig.h"

namespace artcore {

namespace {
constexpr const char* kTag = "net";
constexpr int kBitGotIp = BIT0;

std::mutex g_mutex;
NetStatus g_status;
EventGroupHandle_t g_events = nullptr;

/// 网络序 esp_ip4 → 主机序 u32（首八位组为最高位）。
uint32_t from_esp_ip4(esp_ip4_addr_t a) { return lwip_ntohl(a.addr); }
/// 主机序 u32 → 网络序 esp_ip4。
esp_ip4_addr_t to_esp_ip4(uint32_t host) {
    esp_ip4_addr_t a;
    a.addr = lwip_htonl(host);
    return a;
}

void on_eth_event(void*, esp_event_base_t, int32_t id, void*) {
    std::lock_guard<std::mutex> lock(g_mutex);
    switch (id) {
        case ETHERNET_EVENT_CONNECTED:
            g_status.link_up = true;
            ESP_LOGI(kTag, "以太网链路 up");
            break;
        case ETHERNET_EVENT_DISCONNECTED:
            g_status.link_up = false;
            g_status.got_ip = false;
            ESP_LOGW(kTag, "以太网链路 down");
            break;
        default:
            break;
    }
}

void on_got_ip(void*, esp_event_base_t, int32_t, void* data) {
    auto* ev = static_cast<ip_event_got_ip_t*>(data);
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_status.got_ip = true;
        g_status.via_dhcp = true;
        g_status.ip = from_esp_ip4(ev->ip_info.ip);
        g_status.netmask = from_esp_ip4(ev->ip_info.netmask);
        g_status.gateway = from_esp_ip4(ev->ip_info.gw);
        g_status.broadcast = g_status.ip | ~g_status.netmask;
    }
    if (g_events != nullptr) {
        xEventGroupSetBits(g_events, kBitGotIp);
    }
    ESP_LOGI(kTag, "取得 IP：" IPSTR, IP2STR(&ev->ip_info.ip));
}

}  // namespace

Result<void> Network::start(const NetConfig& cfg, uint32_t dhcp_timeout_ms) noexcept {
    g_events = xEventGroupCreate();

    // 1. 以太网 MAC + IP101 PHY（RMII，REF_CLK 由 PHY 产生 EXT_IN）。
    eth_esp32_emac_config_t emac_cfg = ETH_ESP32_EMAC_DEFAULT_CONFIG();
    emac_cfg.smi_gpio.mdc_num = CONFIG_ART_ETH_MDC;
    emac_cfg.smi_gpio.mdio_num = CONFIG_ART_ETH_MDIO;
    emac_cfg.clock_config.rmii.clock_mode = EMAC_CLK_EXT_IN;
    // IDF 6.1：clock_gpio 为普通 int（旧 emac_rmii_clock_gpio_t 枚举已移除）。
    emac_cfg.clock_config.rmii.clock_gpio = CONFIG_ART_ETH_REF_CLK;

    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    esp_eth_mac_t* mac = esp_eth_mac_new_esp32(&emac_cfg, &mac_cfg);

    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.phy_addr = CONFIG_ART_ETH_PHY_ADDR;
    phy_cfg.reset_gpio_num = CONFIG_ART_ETH_PHY_RST;
    esp_eth_phy_t* phy = esp_eth_phy_new_ip101(&phy_cfg);

    if (mac == nullptr || phy == nullptr) {
        return err(Status::IoError);
    }

    esp_eth_config_t eth_cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t handle = nullptr;
    if (esp_eth_driver_install(&eth_cfg, &handle) != ESP_OK) {
        return err(Status::IoError);
    }
    eth_handle_ = handle;

    // 2. netif。
    esp_netif_config_t netif_cfg = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t* netif = esp_netif_new(&netif_cfg);
    netif_ = netif;
    if (netif == nullptr) {
        return err(Status::IoError);
    }
    // 主机名。
    esp_netif_set_hostname(netif, cfg.hostname.c_str());

    if (esp_netif_attach(netif, esp_eth_new_netif_glue(handle)) != ESP_OK) {
        return err(Status::IoError);
    }

    // 3. 事件。
    esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, &on_eth_event, nullptr);
    esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, &on_got_ip, nullptr);

    // MAC 地址。
    uint8_t mac_addr[6] = {};
    esp_eth_ioctl(handle, ETH_CMD_G_MAC_ADDR, mac_addr);
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        std::memcpy(g_status.mac, mac_addr, 6);
    }

    if (esp_eth_start(handle) != ESP_OK) {
        return err(Status::IoError);
    }

    // 4. 静态 or DHCP。
    if (!cfg.dhcp) {
        esp_netif_dhcpc_stop(netif);
        esp_netif_ip_info_t ip_info = {};
        ip_info.ip = to_esp_ip4(cfg.ip);
        ip_info.netmask = to_esp_ip4(cfg.netmask);
        ip_info.gw = to_esp_ip4(cfg.gateway);
        esp_netif_set_ip_info(netif, &ip_info);
        std::lock_guard<std::mutex> lock(g_mutex);
        g_status.got_ip = true;
        g_status.via_dhcp = false;
        g_status.ip = cfg.ip;
        g_status.netmask = cfg.netmask;
        g_status.gateway = cfg.gateway;
        g_status.broadcast = cfg.ip | ~cfg.netmask;
        ESP_LOGI(kTag, "使用静态 IP");
    } else {
        // 等待 DHCP；超时回退静态。
        EventBits_t bits = xEventGroupWaitBits(g_events, kBitGotIp, pdFALSE, pdTRUE,
                                               pdMS_TO_TICKS(dhcp_timeout_ms));
        if ((bits & kBitGotIp) == 0) {
            ESP_LOGW(kTag, "DHCP 超时，回退静态 IP");
            esp_netif_dhcpc_stop(netif);
            esp_netif_ip_info_t ip_info = {};
            esp_ip4_addr_t fip, fmask, fgw;
            esp_netif_str_to_ip4(CONFIG_ART_NET_FALLBACK_IP, &fip);
            esp_netif_str_to_ip4(CONFIG_ART_NET_FALLBACK_MASK, &fmask);
            esp_netif_str_to_ip4(CONFIG_ART_NET_FALLBACK_GW, &fgw);
            ip_info.ip = fip;
            ip_info.netmask = fmask;
            ip_info.gw = fgw;
            esp_netif_set_ip_info(netif, &ip_info);
            std::lock_guard<std::mutex> lock(g_mutex);
            g_status.got_ip = true;
            g_status.via_dhcp = false;
            g_status.ip = from_esp_ip4(fip);
            g_status.netmask = from_esp_ip4(fmask);
            g_status.gateway = from_esp_ip4(fgw);
            g_status.broadcast = g_status.ip | ~g_status.netmask;
        }
    }

    return {};
}

NetStatus Network::status() const noexcept {
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_status;
}

Result<void> start_mdns(const char* hostname, const char* instance, uint16_t http_port) noexcept {
    if (mdns_init() != ESP_OK) {
        return err(Status::IoError);
    }
    mdns_hostname_set(hostname);
    mdns_instance_name_set(instance);
    mdns_service_add(nullptr, "_http", "_tcp", http_port, nullptr, 0);
    ESP_LOGI(kTag, "mDNS 已启动：%s.local:%u", hostname, http_port);
    return {};
}

}  // namespace artcore
