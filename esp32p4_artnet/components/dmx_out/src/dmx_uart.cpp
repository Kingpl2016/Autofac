//! UART DMX512 输出实现（官方 driver/uart，连续刷新 + 帧尾 BREAK）。

#include "artcore/dmx_uart.hpp"

#include <cstring>

#include "driver/uart.h"
#include "esp_log.h"
#include "esp_pthread.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace artcore {

namespace {
constexpr const char* kTag = "dmx_uart";
/// DMX512 波特率。
constexpr int kDmxBaud = 250000;
/// 每口 RX 环形缓冲（TX-only 场景给最小值）。
constexpr int kRxBufSize = 256;
/// 每口 TX 环形缓冲：须 >= 一整帧（513 字节），取 1024 留余量。
///
/// 关键：此值 > 0 时，`uart_write_bytes_with_break` 把整帧一次压入软件环形缓冲即返回，
/// 由驱动 ISR 自主从环缓冲喂硬件 FIFO，使「帧内 513 字节」的字节流连续性与任务调度
/// **解耦**。设为 0（旧实现）则要靠线程被持续调度来分批续填 128 字节 FIFO，一旦在共享
/// 核（core 0：lwIP / forwarder / 多口 UART）上被抢占且未及时回填，FIFO 欠载 → DMX 帧
/// 中途出现空闲电平 → 灯具判为错帧 → 偶发闪灯。
constexpr int kTxBufSize = 1024;
/// 单帧发送超时（覆盖 513 字节 @250kbaud ≈ 23ms，留足余量）。
constexpr int kTxDoneTimeoutMs = 100;
}  // namespace

std::size_t build_dmx512_frame(std::span<const uint8_t> data, std::span<uint8_t> out) noexcept {
    if (out.size() < DmxUart::kFrameLen) {
        return 0;
    }
    out[0] = 0x00;  // DMX NULL START Code
    std::size_t n = data.size();
    if (n > 512) {
        n = 512;
    }
    if (n > 0) {
        std::memcpy(out.data() + 1, data.data(), n);
    }
    if (n < 512) {
        std::memset(out.data() + 1 + n, 0, 512 - n);
    }
    return DmxUart::kFrameLen;
}

DmxUart::~DmxUart() { shutdown(); }

Result<void> DmxUart::configure(std::span<const DmxUartPort> ports, int break_bits) noexcept {
    shutdown();
    // 钳位到 DMX512 合规区间：防止误配出过短 BREAK（< 92us）导致接收端不识别。
    break_bits_ = dmx512_clamp_break_bits(break_bits);

    if (ports.empty()) {
        return {};  // 关闭 UART 输出
    }

    uart_config_t uc = {};
    uc.baud_rate = kDmxBaud;
    uc.data_bits = UART_DATA_8_BITS;
    uc.parity = UART_PARITY_DISABLE;
    uc.stop_bits = UART_STOP_BITS_2;
    uc.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uc.source_clk = UART_SCLK_DEFAULT;

    // 先在本地构建（含驱动安装），全部成功后再整体换入 ports_，
    // 使发送 / 查询路径要么看到旧容器、要么看到完整新容器，绝不观察到半成品。
    std::vector<std::unique_ptr<Port>> local;
    auto cleanup_local = [&local]() noexcept {
        for (auto& up : local) {
            if (up->uart_num >= 0 &&
                uart_is_driver_installed(static_cast<uart_port_t>(up->uart_num))) {
                uart_driver_delete(static_cast<uart_port_t>(up->uart_num));
            }
        }
        local.clear();
    };

    for (const auto& cfg : ports) {
        const uart_port_t port = static_cast<uart_port_t>(cfg.uart_num);
        // TX 环形缓冲 kTxBufSize(>一整帧)：整帧一次入队，ISR 自主喂 FIFO，帧内字节流
        // 不受任务调度抖动影响（根除帧中欠载 → 闪灯）。详见 kTxBufSize 注释。
        if (uart_driver_install(port, kRxBufSize, kTxBufSize, 0, nullptr, 0) != ESP_OK) {
            ESP_LOGE(kTag, "UART%d 驱动安装失败", cfg.uart_num);
            cleanup_local();
            return err(Status::IoError);
        }
        // 装入已安装驱动的口（失败时由 cleanup_local 统一卸载，避免驱动泄漏）。
        auto p = std::make_unique<Port>();
        p->uart_num = cfg.uart_num;
        p->tx_gpio = cfg.tx_gpio;
        p->universe = cfg.universe;
        (void)build_dmx512_frame({}, std::span<uint8_t>(p->frame));  // 初始化为全零帧
        local.push_back(std::move(p));

        if (uart_param_config(port, &uc) != ESP_OK) {
            ESP_LOGE(kTag, "UART%d 参数配置失败", cfg.uart_num);
            cleanup_local();
            return err(Status::IoError);
        }
        if (uart_set_pin(port, cfg.tx_gpio, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE,
                         UART_PIN_NO_CHANGE) != ESP_OK) {
            ESP_LOGE(kTag, "UART%d 引脚设置失败（TX=%d）", cfg.uart_num, cfg.tx_gpio);
            cleanup_local();
            return err(Status::IoError);
        }
    }

    // 整体换入（短临界区）。unique_ptr 保证 Port 地址稳定，后续线程可安全持有其裸指针。
    {
        std::lock_guard<std::mutex> lock(ports_mutex_);
        ports_ = std::move(local);
    }

    running_.store(true);
    // 每口一个刷新线程：core 0、适中优先级、小栈。
    for (auto& up : ports_) {
        Port* p = up.get();
        esp_pthread_cfg_t tcfg = esp_pthread_get_default_config();
        tcfg.thread_name = "dmx_uart_tx";
        tcfg.stack_size = 3072;
        tcfg.prio = 6;
        tcfg.pin_to_core = 0;
        esp_pthread_set_cfg(&tcfg);
        p->thread = std::thread([this, p] { run(p); });
    }

    ESP_LOGI(kTag, "DMX UART 输出已启动：%u 口，BREAK %d 位",
             static_cast<unsigned>(ports_.size()), break_bits_);
    return {};
}

void DmxUart::run(Port* p) noexcept {
    const uart_port_t port = static_cast<uart_port_t>(p->uart_num);
    std::array<uint8_t, kFrameLen> buf{};
    while (running_.load()) {
        {
            std::lock_guard<std::mutex> lock(p->mutex);
            std::memcpy(buf.data(), p->frame.data(), kFrameLen);
        }
        // 连续刷新：帧尾 BREAK 充当下一帧的前导 BREAK。整帧一次压入 TX 环形缓冲，
        // 由 ISR 自主喂 FIFO（见 kTxBufSize），帧内字节流不随任务调度抖动。
        uart_write_bytes_with_break(port, buf.data(), kFrameLen, break_bits_);
        // 等待整帧 + BREAK 发完（约 22.6ms）。超时计入欠载指标供 /api/diag 观测。
        if (uart_wait_tx_done(port, pdMS_TO_TICKS(kTxDoneTimeoutMs)) == ESP_ERR_TIMEOUT) {
            tx_timeouts_.fetch_add(1, std::memory_order_relaxed);
        }
        // 让出 CPU 给同核其它任务（含看门狗喂狗）。
        vTaskDelay(1);
    }
}

void DmxUart::send_universe(uint16_t universe, std::span<const uint8_t> data) noexcept {
    std::lock_guard<std::mutex> lock(ports_mutex_);
    for (auto& up : ports_) {
        if (up->universe == universe) {
            std::lock_guard<std::mutex> plock(up->mutex);
            (void)build_dmx512_frame(data, std::span<uint8_t>(up->frame));
        }
    }
}

void DmxUart::shutdown() noexcept {
    // 1. 通知线程停止并 join——不持 ports_mutex_，避免阻塞发送路径（单帧写出约 23ms）。
    //    线程只访问各自的 Port，不触碰容器结构，故与并发的 send_universe（只读）互不破坏。
    if (running_.exchange(false)) {
        for (auto& up : ports_) {
            if (up->thread.joinable()) {
                up->thread.join();
            }
        }
    }
    // 2. 卸载驱动并清空容器——短临界区，与发送 / 查询路径互斥。
    std::lock_guard<std::mutex> lock(ports_mutex_);
    for (auto& up : ports_) {
        if (up->uart_num >= 0 && uart_is_driver_installed(static_cast<uart_port_t>(up->uart_num))) {
            uart_driver_delete(static_cast<uart_port_t>(up->uart_num));
        }
    }
    ports_.clear();
}

bool DmxUart::has_universe(uint16_t universe) const noexcept {
    std::lock_guard<std::mutex> lock(ports_mutex_);
    for (const auto& up : ports_) {
        if (up->universe == universe) {
            return true;
        }
    }
    return false;
}

}  // namespace artcore
