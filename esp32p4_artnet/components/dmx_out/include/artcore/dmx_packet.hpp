//! Art-Net（ArtDmx / ArtPollReply）与 sACN（E1.31）数据包构造（纯函数）。
//!
//! 字节布局与上位机 `artnet-net` 的 `build_dmx_into` / `sacn::build_into` **逐字节对齐**，
//! 以保证固件回放输出与上位机实时输出完全一致。不依赖 IDF，便于 host 单测。

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace artcore::dmx {

/// Art-Net UDP 标准端口。
inline constexpr uint16_t kArtnetPort = 6454;
/// sACN UDP 标准端口。
inline constexpr uint16_t kSacnPort = 5568;

/// ArtDmx 报文最大长度（18 头 + 512 通道）。
inline constexpr std::size_t kArtDmxMax = 18 + 512;
/// E1.31 报文最大长度（126 头 + 512 通道）。
inline constexpr std::size_t kSacnMax = 126 + 512;
/// ArtPollReply 固定长度。
inline constexpr std::size_t kArtPollReplyLen = 239;
/// Art-Net Port-Address 上限（15 位）。
inline constexpr uint16_t kMaxPortAddress = 0x7FFF;

/// sACN Options 字节的 Stream_Terminated 位。
inline constexpr uint8_t kSacnOptTerminated = 0x40;

/// 构造一个 ArtDmx（Output）报文，写入 `out`。
///
/// 规则与 `artnet-net::build_dmx_into` 一致：`Port-Address` 小端、`Length` 大端且补齐
/// 为偶数、`ProtVer`=14、`Physical`=0。
///
/// # Arguments
///
/// * `port_address` - 15 位 Port-Address（即 Universe 线性编号）。
/// * `sequence` - 序列号（0 表示不启用序列）。
/// * `data` - 通道数据（最多 512，超出截断；奇数长度末尾补 0）。
/// * `out` - 输出缓冲，容量须 >= [`kArtDmxMax`]。
///
/// # Returns
///
/// 写入字节数（18 + 补齐后的数据长度）；`port_address` 越界或 `data` 为空时返回 0。
[[nodiscard]] std::size_t build_artdmx_into(uint16_t port_address, uint8_t sequence,
                                            std::span<const uint8_t> data,
                                            std::span<uint8_t> out) noexcept;

/// 构造一个 E1.31（sACN）数据报文，写入 `out`。
///
/// 字节布局与 `sacn::build_into` 一致。
///
/// # Arguments
///
/// * `universe` - sACN Universe（1~63999）。
/// * `data` - 通道数据（不含 START Code，最多 512）。
/// * `cid` - 发送者 CID（16 字节）。
/// * `source_name` - 源名称（截断 / 补齐到 64 字节）。
/// * `priority` - 优先级（0~200）。
/// * `sequence` - 序列号。
/// * `options` - Options 字节（0 或 [`kSacnOptTerminated`]）。
/// * `out` - 输出缓冲，容量须 >= [`kSacnMax`]。
///
/// # Returns
///
/// 写入字节数（126 + 通道数）；参数非法时返回 0。
[[nodiscard]] std::size_t build_sacn_into(uint16_t universe, std::span<const uint8_t> data,
                                          const uint8_t cid[16], const char* source_name,
                                          uint8_t priority, uint8_t sequence, uint8_t options,
                                          std::span<uint8_t> out) noexcept;

/// 计算某 Universe 的 sACN 组播 IPv4（主机序 u32）：`239.255.hi.lo`。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
///
/// # Returns
///
/// 主机序的 IPv4（`239<<24 | 255<<16 | hi<<8 | lo`）。
[[nodiscard]] constexpr uint32_t sacn_multicast_v4(uint16_t universe) noexcept {
    return (239u << 24) | (255u << 16) |
           (static_cast<uint32_t>((universe >> 8) & 0xFF) << 8) |
           static_cast<uint32_t>(universe & 0xFF);
}

// ===================== 解析（接收侧，供实时转发）=====================

/// 从接收缓冲解析出的一帧 DMX 数据。
///
/// `data` 直接指向传入缓冲内部，调用方须保证缓冲在使用 `data` 期间保持有效。
struct ParsedDmx {
    /// Universe 线性编号（Art-Net Port-Address / sACN Universe）。
    uint16_t universe = 0;
    /// 指向通道数据起始（不含起始码），长度为 `len`。
    const uint8_t* data = nullptr;
    /// 通道数（<= 512）。
    uint16_t len = 0;
    /// 优先级（仅 sACN 有意义；Art-Net 恒为 0）。
    uint8_t priority = 0;
    /// sACN Stream_Terminated 位（仅 sACN 有意义；Art-Net 恒为 false）。
    bool terminated = false;
};

/// 解析一个 ArtDmx（Output，OpCode 0x5000）报文。
///
/// 与 [`build_artdmx_into`] 对称：校验 `"Art-Net\0"` 头与 OpCode，取 `Port-Address`
/// （小端，偏移 14）、`Length`（大端，偏移 16）、数据（偏移 18）。
///
/// # Arguments
///
/// * `buf` - 收到的 UDP 负载。
///
/// # Returns
///
/// 成功返回 [`ParsedDmx`]（`len` 已按实际缓冲与 512 夹取）；非 ArtDmx 返回 `std::nullopt`。
[[nodiscard]] std::optional<ParsedDmx> parse_artdmx(std::span<const uint8_t> buf) noexcept;

/// 判定缓冲是否为 sACN（E1.31）：Root 层 ACN 包标识符 `"ASC-E1.17\0\0\0"`（偏移 4）。
///
/// # Arguments
///
/// * `buf` - 收到的 UDP 负载。
///
/// # Returns
///
/// 匹配返回 `true`。
[[nodiscard]] bool is_sacn(std::span<const uint8_t> buf) noexcept;

/// 解析一个 sACN E1.31 数据报（VECTOR_E131_DATA_PACKET）。
///
/// 与 [`build_sacn_into`] 对称：校验 Root / Framing / DMP 向量与 NULL 起始码，取
/// `Universe`（大端，偏移 113）、优先级（偏移 108）与起始码后的通道数据
/// （DMP 属性数 - 1，偏移 126）。
///
/// # Arguments
///
/// * `buf` - 收到的 UDP 负载。
///
/// # Returns
///
/// 成功返回 [`ParsedDmx`]（含 `priority`）；非数据包 / 非 NULL 起始码返回 `std::nullopt`。
[[nodiscard]] std::optional<ParsedDmx> parse_sacn_data(std::span<const uint8_t> buf) noexcept;

/// ArtPollReply 构造参数。
struct PollReplyParams {
    /// 本机 IPv4（4 字节，网络顺序：ip[0] 为最高位八位组）。
    uint8_t ip[4] = {0, 0, 0, 0};
    /// 本机 MAC（6 字节）。
    uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
    /// 短名（最多 17 字节 + NUL）。
    const char* short_name = "ArtNetCore";
    /// 长名（最多 63 字节 + NUL）。
    const char* long_name = "ArtNet Core Playback Node";
    /// 本回复包含的输出 Universe（最多 4 个）。
    std::span<const uint16_t> universes{};
    /// 固件版本高 / 低字节。
    uint8_t version_hi = 0;
    uint8_t version_lo = 1;
    /// BindIndex（从 1 起；>4 个 Universe 时分多个回复，依次 1,2,...）。
    uint8_t bind_index = 1;
};

/// 构造一个 ArtPollReply 报文（239 字节），用于被上位机设备发现。
///
/// 一个回复最多承载 4 个输出 Universe；超过时由调用方分组多次构造（递增
/// `bind_index`），上位机会按 bind 合并。
///
/// # Arguments
///
/// * `p` - 回复参数。
/// * `out` - 输出缓冲，容量须 >= [`kArtPollReplyLen`]。
///
/// # Returns
///
/// 写入字节数（固定 [`kArtPollReplyLen`]）；缓冲不足返回 0。
[[nodiscard]] std::size_t build_artpollreply_into(const PollReplyParams& p,
                                                  std::span<uint8_t> out) noexcept;

/// 判定缓冲是否为 ArtPoll 报文（`"Art-Net\0"` + OpCode 0x2000）。
[[nodiscard]] bool is_artpoll(std::span<const uint8_t> buf) noexcept;

}  // namespace artcore::dmx
