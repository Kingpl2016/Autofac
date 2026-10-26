//! 总线 MCU（Etronet）串口协议（《总线 MCU 与核心板通信协议 D261022 v1.0》）纯逻辑层。
//!
//! 本头文件实现帧的编解码、流式解析与操作码派发，**不依赖 ESP-IDF**，
//! 便于在 `test_apps` 用 Catch2 做主机侧单测；UART 驱动调用集中在 `etronet_link.cpp`。
//!
//! 帧格式：
//! ```
//! [帧头 0x35][通信定义 1B][数据长度 n(2B)][数据载荷 n*B][校验和 1B]
//! 数据载荷 = [寄存器 2B][交互数据 (n-2)*B]
//! ```
//! - 帧头固定 0x35：bit7-6 版本号(00)，bit5-0 固定 110101b。
//! - 通信定义：bit7 传输模式(0 单帧 / 1 分组，暂不支持)，bit6-4 操作码，bit3-0 预留(0000)。
//! - 数据长度 n、寄存器均为 2 字节；字节序见 [`rd_u16`] / [`wr_u16`]（当前小端，便于一处切换）。
//! - 校验和见 [`checksum`]（当前为「帧头至数据载荷」字节和取低 8 位，便于一处替换）。
//!
//! ESP32 为**纯从机**：仅被动解析 MCU 下发的帧并按操作码回应答帧，不主动发起。

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <vector>

#include "artcore/result.hpp"
#include "artcore/status.hpp"

namespace artcore::etronet {

// ===================== 协议常量 =====================

/// 帧头固定值（版本 0.0 + 固定位域 110101b）。
inline constexpr uint8_t kFrameHeader = 0x35;

/// 帧头低 6 位固定值（bit5-0）。
inline constexpr uint8_t kHeaderFixedBits = 0x35 & 0x3F;

/// 帧的固定开销字节数：帧头(1) + 通信定义(1) + 数据长度(2) + 校验和(1)。
inline constexpr std::size_t kFrameOverhead = 5;

/// 数据载荷至少含 2 字节寄存器。
inline constexpr std::size_t kRegisterBytes = 2;

/// 最小合法帧长（开销 + 寄存器，交互数据可为空）。
inline constexpr std::size_t kMinFrameLen = kFrameOverhead + kRegisterBytes;  // 7

/// 数据载荷长度上限（防伪造超长 n 灌爆内存；可按实际需求调整）。
inline constexpr std::size_t kMaxPayloadLen = 1024;

// ===================== 操作码 / 通信定义 =====================

/// 操作码（通信定义 bit6-4，见协议 2.4）。
enum class Opcode : uint8_t {
    SetAck = 0,       ///< set 确认，应答指令
    SetNeedAck = 1,   ///< set 操作，需确认
    SetNoAck = 2,     ///< set 操作，无需确认
    Get = 3,          ///< get 操作
    GetResp = 4,      ///< get 操作的响应应答
    PushNeedAck = 5,  ///< push 操作，需确认
    PushNoAck = 6,    ///< push 操作，无需确认
    PushAck = 7,      ///< push 确认，应答指令
};

/// 寄存器地址（协议 2.5：ETRONET MCU 写 DMX 核心板）。
enum class Reg : uint16_t {
    BoardOp = 0x0000,    ///< DMX 核心板操作（0 复位 / 1 出厂初始化 / 2 测试）。
    Channel = 0x0001,    ///< 通道读写（本期不支持）。
    ProgramOp = 0x0002,  ///< 节目文件操作。
    WorkMode = 0x0003,   ///< 工作模式设置。
};

/// 组装通信定义字节。
///
/// # Arguments
///
/// * `op` - 操作码（bit6-4）。
/// * `group` - 是否分组传输（bit7；本实现恒为单帧，一般传 false）。
///
/// # Returns
///
/// 通信定义字节（预留位 bit3-0 置 0）。
[[nodiscard]] constexpr uint8_t make_comm_def(Opcode op, bool group = false) noexcept {
    return static_cast<uint8_t>((group ? 0x80 : 0x00) |
                                ((static_cast<uint8_t>(op) & 0x07) << 4));
}

/// 取通信定义中的操作码（bit6-4）。
[[nodiscard]] constexpr Opcode comm_def_opcode(uint8_t comm_def) noexcept {
    return static_cast<Opcode>((comm_def >> 4) & 0x07);
}

/// 是否为分组传输（bit7）。
[[nodiscard]] constexpr bool comm_def_is_group(uint8_t comm_def) noexcept {
    return (comm_def & 0x80) != 0;
}

// ===================== 字节序 / 校验和（集中封装，便于按真实 MCU 一处切换）=====================

/// 读 2 字节无符号整数（当前实现：小端）。
[[nodiscard]] constexpr uint16_t rd_u16(uint8_t lo, uint8_t hi) noexcept {
    return static_cast<uint16_t>(lo | (static_cast<uint16_t>(hi) << 8));
}

/// 把 16 位值写入 2 字节缓冲（当前实现：小端）。
///
/// # Arguments
///
/// * `v` - 待写入值。
/// * `out` - 输出缓冲，容量须 >= 2。
constexpr void wr_u16(uint16_t v, std::span<uint8_t> out) noexcept {
    out[0] = static_cast<uint8_t>(v & 0xFF);
    out[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}

/// 计算校验和（当前实现：入参全部字节之和取低 8 位）。
///
/// 覆盖范围由调用方给定，组帧时取「帧头至数据载荷」全部字节（不含校验和自身）。
///
/// # Arguments
///
/// * `bytes` - 参与校验的字节序列。
///
/// # Returns
///
/// 8 位校验和。
[[nodiscard]] constexpr uint8_t checksum(std::span<const uint8_t> bytes) noexcept {
    uint8_t sum = 0;
    for (uint8_t b : bytes) {
        sum = static_cast<uint8_t>(sum + b);
    }
    return sum;
}

// ===================== 组帧 / 拆帧 =====================

/// 解析出的一帧。
struct Frame {
    uint8_t comm_def = 0;      ///< 原始通信定义字节。
    Opcode opcode = Opcode::SetAck;  ///< 操作码。
    bool group = false;        ///< 是否分组传输。
    uint16_t reg = 0;          ///< 寄存器地址。
    std::vector<uint8_t> data; ///< 交互数据（数据载荷去掉寄存器后的部分，可为空）。
};

/// 组装一帧（含帧头、通信定义、长度、寄存器、交互数据、校验和）。
///
/// # Arguments
///
/// * `op` - 操作码。
/// * `reg` - 寄存器地址。
/// * `data` - 交互数据（可为空）。
///
/// # Returns
///
/// 完整帧字节序列。
[[nodiscard]] std::vector<uint8_t> build_frame(Opcode op, uint16_t reg,
                                               std::span<const uint8_t> data);

/// 便捷重载：以 [`Reg`] 组帧。
[[nodiscard]] inline std::vector<uint8_t> build_frame(Opcode op, Reg reg,
                                                      std::span<const uint8_t> data) {
    return build_frame(op, static_cast<uint16_t>(reg), data);
}

/// 一次性解析单帧（要求 `bytes` 恰好是一整帧）。
///
/// # Arguments
///
/// * `bytes` - 候选帧字节。
///
/// # Returns
///
/// 成功返回 [`Frame`]；帧头错误 / 长度不符 / 校验和错误返回对应 [`Status`]，
/// 分组传输返回 [`Status::NotSupported`]。
[[nodiscard]] Result<Frame> parse_frame(std::span<const uint8_t> bytes);

// ===================== 流式解析状态机 =====================

/// 逐字节喂入的帧解析器：从 UART 字节流中切分出完整合法帧。
///
/// 具备坏帧头重同步、长度上限保护、校验和失败丢弃与计数能力；不依赖 IDF。
class FrameParser {
public:
    /// 创建解析器。
    ///
    /// # Arguments
    ///
    /// * `max_payload` - 数据载荷长度上限（超限的帧丢弃，防内存灌爆）。
    explicit FrameParser(std::size_t max_payload = kMaxPayloadLen) noexcept
        : max_payload_(max_payload) {}

    /// 喂入一段字节，返回本次新切分出的完整帧（可能 0~多帧）。
    ///
    /// # Arguments
    ///
    /// * `bytes` - 新到达的字节。
    ///
    /// # Returns
    ///
    /// 本次解析出的帧列表（按到达顺序）。
    [[nodiscard]] std::vector<Frame> feed(std::span<const uint8_t> bytes);

    /// 清空内部缓冲与状态（不清计数器）。
    void reset() noexcept { buf_.clear(); }

    /// 校验和错误而丢弃的帧数。
    [[nodiscard]] uint32_t checksum_errors() const noexcept { return checksum_errors_; }
    /// 分组传输（暂不支持）而丢弃的帧数。
    [[nodiscard]] uint32_t group_dropped() const noexcept { return group_dropped_; }
    /// 超长度上限而丢弃的帧数。
    [[nodiscard]] uint32_t oversize_dropped() const noexcept { return oversize_dropped_; }

private:
    std::vector<uint8_t> buf_;  ///< 累积缓冲（从一个候选帧头开始）。
    std::size_t max_payload_;
    uint32_t checksum_errors_ = 0;
    uint32_t group_dropped_ = 0;
    uint32_t oversize_dropped_ = 0;
};

// ===================== 操作码派发 =====================

/// 寄存器处理回调：执行一次寄存器操作并返回结果。
///
/// 对 get：成功时返回要回给 MCU 的交互数据（可为空）。
/// 对 set/push：通常返回空数据，失败返回对应 [`Status`]。
///
/// # Arguments
///
/// * `reg` - 寄存器地址。
/// * `op` - 操作码。
/// * `data` - 入帧携带的交互数据。
using RegHandler =
    std::function<Result<std::vector<uint8_t>>(uint16_t reg, Opcode op, std::span<const uint8_t>)>;

/// 按操作码语义处理一帧并生成应答帧（纯函数，业务由 `handler` 注入）。
///
/// 应答规则：
/// - set 需确认(1) → 执行后回 set-ack(0)，交互数据首字节为应答码(0~7)。
/// - set 无需确认(2) → 执行，不回帧。
/// - get(3) → 读取后回 get-响应(4)，携带 handler 返回的数据（失败时首字节为应答码）。
/// - push 需确认(5) → 执行后回 push-ack(7)；push 无需确认(6) → 执行不回帧。
/// - 应答类操作码(0/4/7) 作为入帧收到时忽略，不回帧。
///
/// # Arguments
///
/// * `frame` - 已解析的入帧。
/// * `handler` - 寄存器业务回调。
///
/// # Returns
///
/// 需回发的应答帧字节；无需应答时返回 `std::nullopt`。
[[nodiscard]] std::optional<std::vector<uint8_t>> dispatch(const Frame& frame,
                                                           const RegHandler& handler);

}  // namespace artcore::etronet
