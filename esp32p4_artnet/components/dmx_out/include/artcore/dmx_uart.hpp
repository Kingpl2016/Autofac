//! UART DMX512 输出：自实现标准 DMX512 TX（一个 UART = 一个 universe）。
//!
//! 用官方 `driver/uart` 的 `uart_write_bytes_with_break` 以「帧尾 BREAK 作为下一帧前导」
//! 的方式连续刷新：每口一个后台线程，持续把 513 字节（起始码 0x00 + 512 通道）写出，
//! 波特率 250000、8 数据位、无校验、2 停止位，Etronet MCU 作 RS-485 线驱动。
//!
//! 与网络 Art-Net/sACN 输出并存、互不影响；是否输出某 universe 取决于是否有匹配口。
//!
//! 注意：本头文件不依赖 ESP-IDF，便于被 player / forwarder 等纯逻辑路径包含；
//! 实际驱动调用集中在 `dmx_uart.cpp`。

#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <thread>
#include <vector>

#include "artcore/result.hpp"

namespace artcore {

/// 一个 DMX 串口的配置（口 ↔ UART ↔ universe 映射）。
struct DmxUartPort {
    /// UART 控制器编号（如 1~4；0 通常留给控制台）。
    int uart_num = 1;
    /// TX GPIO（RS-485 线驱动输入）。
    int tx_gpio = 20;
    /// 该口输出的 universe 线性编号。
    uint16_t universe = 0;
};

// ===================== DMX512 时序常量（ANSI E1.11，250kbaud/8N2）=====================
//
// 无示波器核验时以此固化并单测：250kbaud 下 1 位 = 4us；8N2 每字节 11 位（1 起始 + 8 数据
// + 2 停止）。满帧 = 起始码 + 512 通道 = 513 字节。发送端 BREAK 下限 92us（=23 位），
// MAB 下限 12us；BREAK 采用「帧尾 BREAK 作下一帧前导」，MAB 由帧间空闲（> vTaskDelay(1)）
// 保证，远超下限。相邻两 BREAK 间隔 = 满帧时间 ≈ 22.6ms，远超 1204us 下限，刷新 ~42Hz。

/// 250kbaud 下单个位时间（微秒）。
inline constexpr unsigned kDmxBitUs = 4;
/// BREAK 合规下限（发送端 ≥ 92us → 23 位）。
inline constexpr int kDmxMinBreakBits = 23;
/// BREAK 上限（防误配过长，约 1ms）。
inline constexpr int kDmxMaxBreakBits = 250;
/// 满帧（513 字节 × 11 位/字节）发送时间（微秒）。
inline constexpr unsigned kDmxFrameUs = 513u * 11u * kDmxBitUs;
static_assert(kDmxFrameUs == 22572u, "DMX512 满帧发送时间应为 22.572ms");
static_assert(kDmxMinBreakBits * kDmxBitUs >= 92u, "BREAK 下限需 >= 92us（发送端规范）");

/// 将 BREAK 位数钳到 [`kDmxMinBreakBits`, `kDmxMaxBreakBits`]（纯函数，便于单测）。
///
/// # Arguments
///
/// * `bits` - 请求的 BREAK 位数。
///
/// # Returns
///
/// 钳位后的位数：低于下限提到 92us 合规值，高于上限截到约 1ms。
[[nodiscard]] constexpr int dmx512_clamp_break_bits(int bits) noexcept {
    if (bits < kDmxMinBreakBits) {
        return kDmxMinBreakBits;
    }
    if (bits > kDmxMaxBreakBits) {
        return kDmxMaxBreakBits;
    }
    return bits;
}

/// 把一个 Universe 的通道数据组装为 DMX512 发送缓冲（纯函数，不依赖 IDF）。
///
/// 布局：`out[0]` = START Code（0x00），`out[1..512]` = 通道数据（不足补零）。
///
/// # Arguments
///
/// * `data` - 通道数据（超过 512 截断）。
/// * `out` - 输出缓冲，容量须 >= 513。
///
/// # Returns
///
/// 写入字节数（固定 513）；缓冲不足返回 0。
[[nodiscard]] std::size_t build_dmx512_frame(std::span<const uint8_t> data,
                                             std::span<uint8_t> out) noexcept;

/// UART DMX512 多口输出器。
class DmxUart {
public:
    /// DMX512 发送缓冲长度（起始码 + 512 通道）。
    static constexpr std::size_t kFrameLen = 513;

    DmxUart() = default;
    ~DmxUart();

    DmxUart(const DmxUart&) = delete;
    DmxUart& operator=(const DmxUart&) = delete;

    /// 安装各 UART 驱动（TX-only、250000/8N2）并为每口启动刷新线程。
    ///
    /// 重复调用会先 [`shutdown`] 再按新配置重建。传入空列表等效于「关闭 UART 输出」。
    ///
    /// # Arguments
    ///
    /// * `ports` - 端口列表（口数通常 1~4）。
    /// * `break_bits` - BREAK 时长（位周期；250kbaud 下 1 位 = 4us，默认 44）。
    ///
    /// # Errors
    ///
    /// 任一 UART 驱动安装 / 参数 / 引脚设置失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> configure(std::span<const DmxUartPort> ports,
                                         int break_bits = 44) noexcept;

    /// 写入某 universe 匹配口的发送缓冲（起始码 0 + 数据补零到 512）。
    ///
    /// 无匹配口时静默忽略。线程安全。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 universe。
    /// * `data` - 通道数据（最多 512）。
    void send_universe(uint16_t universe, std::span<const uint8_t> data) noexcept;

    /// 停止全部刷新线程并卸载 UART 驱动。
    void shutdown() noexcept;

    /// 是否存在匹配该 universe 的输出口。线程安全。
    [[nodiscard]] bool has_universe(uint16_t universe) const noexcept;

    /// 当前输出口数量。线程安全。
    [[nodiscard]] std::size_t port_count() const noexcept {
        std::lock_guard<std::mutex> lock(ports_mutex_);
        return ports_.size();
    }

    /// 累计 TX 发送超时次数（`uart_wait_tx_done` 超时）。
    ///
    /// 正常运行恒为 0；非 0 意味着某帧未能在超时窗口内发完，是「帧中欠载 → 闪灯」
    /// 的间接信号，供 `/api/diag` 诊断观测。线程安全（原子）。
    [[nodiscard]] uint32_t tx_timeout_count() const noexcept {
        return tx_timeouts_.load(std::memory_order_relaxed);
    }

private:
    /// 单个输出口的运行态（互斥 / 线程不可移动，故装箱存放）。
    struct Port {
        int uart_num = -1;
        int tx_gpio = -1;
        uint16_t universe = 0;
        mutable std::mutex mutex;                        ///< 保护 frame
        std::array<uint8_t, kFrameLen> frame{};          ///< 当前待发送帧
        std::thread thread;                              ///< 刷新线程
    };

    void run(Port* p) noexcept;

    /// 保护 `ports_` 容器结构（配置重建 vs 发送 / 查询并发）。
    /// 锁序固定为 ports_mutex_ → Port::mutex，绝不反向，避免死锁。
    mutable std::mutex ports_mutex_;
    std::vector<std::unique_ptr<Port>> ports_;
    std::atomic<bool> running_{false};
    std::atomic<uint32_t> tx_timeouts_{0};  ///< TX 发送超时累计（欠载间接指标）
    int break_bits_ = 44;
};

}  // namespace artcore
