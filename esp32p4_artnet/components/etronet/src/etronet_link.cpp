//! 总线 MCU（Etronet）串口链路实现（官方 driver/uart，RX 线程收帧并回应答）。

#include "artcore/etronet_link.hpp"

#include <vector>

#include "driver/uart.h"
#include "esp_log.h"
#include "esp_pthread.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace artcore {

namespace {
constexpr const char* kTag = "etronet";
/// RX 环形缓冲大小（容纳突发多帧）。
constexpr int kRxBufSize = 2048;
/// TX 环形缓冲大小（应答帧很短，给最小值即可）。
constexpr int kTxBufSize = 512;
/// 单次读取超时（ms）：无数据时让出 CPU。
constexpr int kReadTimeoutMs = 20;
/// 单次读取的字节上限。
constexpr std::size_t kReadChunk = 512;
}  // namespace

EtronetLink::~EtronetLink() { shutdown(); }

Result<void> EtronetLink::configure(const EtronetLinkConfig& cfg,
                                    etronet::RegHandler handler) noexcept {
    if (!handler) {
        return err(Status::InvalidArg);
    }
    shutdown();

    std::lock_guard<std::mutex> lock(mutex_);

    const uart_port_t port = static_cast<uart_port_t>(cfg.uart_num);
    uart_config_t uc = {};
    uc.baud_rate = cfg.baud;
    uc.data_bits = UART_DATA_8_BITS;
    uc.parity = UART_PARITY_DISABLE;
    uc.stop_bits = UART_STOP_BITS_1;
    uc.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uc.source_clk = UART_SCLK_DEFAULT;

    if (uart_driver_install(port, kRxBufSize, kTxBufSize, 0, nullptr, 0) != ESP_OK) {
        ESP_LOGE(kTag, "UART%d 驱动安装失败", cfg.uart_num);
        return err(Status::IoError);
    }
    if (uart_param_config(port, &uc) != ESP_OK) {
        ESP_LOGE(kTag, "UART%d 参数配置失败", cfg.uart_num);
        uart_driver_delete(port);
        return err(Status::IoError);
    }
    if (uart_set_pin(port, cfg.tx_gpio, cfg.rx_gpio, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) !=
        ESP_OK) {
        ESP_LOGE(kTag, "UART%d 引脚设置失败（TX=%d RX=%d）", cfg.uart_num, cfg.tx_gpio, cfg.rx_gpio);
        uart_driver_delete(port);
        return err(Status::IoError);
    }

    cfg_ = cfg;
    uart_num_ = cfg.uart_num;
    handler_ = std::move(handler);
    parser_ = etronet::FrameParser(cfg.max_payload);

    running_.store(true);
    esp_pthread_cfg_t tcfg = esp_pthread_get_default_config();
    tcfg.thread_name = "etronet_rx";
    tcfg.stack_size = 4096;
    tcfg.prio = 6;
    tcfg.pin_to_core = 0;
    esp_pthread_set_cfg(&tcfg);
    thread_ = std::thread([this] { run(); });

    ESP_LOGI(kTag, "总线 MCU 串口已启动：UART%d %d 8N1（TX=%d RX=%d）", cfg.uart_num, cfg.baud,
             cfg.tx_gpio, cfg.rx_gpio);
    return {};
}

void EtronetLink::run() noexcept {
    const uart_port_t port = static_cast<uart_port_t>(uart_num_);
    std::vector<uint8_t> chunk(kReadChunk);
    while (running_.load()) {
        int got = uart_read_bytes(port, chunk.data(), chunk.size(), pdMS_TO_TICKS(kReadTimeoutMs));
        if (got <= 0) {
            continue;  // 超时无数据
        }
        auto frames =
            parser_.feed(std::span<const uint8_t>(chunk.data(), static_cast<size_t>(got)));
        for (const auto& fr : frames) {
            auto reply = etronet::dispatch(fr, handler_);
            if (reply && !reply->empty()) {
                uart_write_bytes(port, reply->data(), reply->size());
            }
        }
    }
}

void EtronetLink::shutdown() noexcept {
    // 1. 通知线程停止并 join（不持 mutex_，RX 线程不触碰需互斥的结构）。
    if (running_.exchange(false)) {
        if (thread_.joinable()) {
            thread_.join();
        }
    }
    // 2. 卸载驱动。
    std::lock_guard<std::mutex> lock(mutex_);
    if (uart_num_ >= 0 && uart_is_driver_installed(static_cast<uart_port_t>(uart_num_))) {
        uart_driver_delete(static_cast<uart_port_t>(uart_num_));
    }
    uart_num_ = -1;
}

}  // namespace artcore
