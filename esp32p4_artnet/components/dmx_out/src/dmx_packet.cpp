//! Art-Net / sACN 报文构造实现（字节级对齐上位机）。

#include "artcore/dmx_packet.hpp"

#include <cstring>

#include "artcore/bytes.hpp"

namespace artcore::dmx {

namespace {

/// Art-Net 报文头 `"Art-Net\0"`。
constexpr uint8_t kArtnetHeader[8] = {'A', 'r', 't', '-', 'N', 'e', 't', 0};
/// ArtDmx OpCode（0x5000，报文内小端）。
constexpr uint16_t kOpDmx = 0x5000;
/// ArtPoll OpCode（0x2000）。
constexpr uint16_t kOpPoll = 0x2000;
/// ArtPollReply OpCode（0x2100）。
constexpr uint16_t kOpPollReply = 0x2100;
/// Art-Net 协议版本 14（ProtVerHi, ProtVerLo）。
constexpr uint8_t kProtVer[2] = {0x00, 0x0e};
/// 单帧最大通道数。
constexpr std::size_t kMaxDmx = 512;

/// ACN 包标识符 `"ASC-E1.17\0\0\0"`。
constexpr uint8_t kAcnPid[12] = {'A', 'S', 'C', '-', 'E', '1', '.', '1', '7', 0, 0, 0};

/// 写入 ACN flags+length 字段（高 4 位为 0x7）。
void write_flags_len(uint8_t* p, uint16_t len) noexcept {
    wr_be16(p, static_cast<uint16_t>(0x7000 | (len & 0x0FFF)));
}

}  // namespace

std::size_t build_artdmx_into(uint16_t port_address, uint8_t sequence,
                              std::span<const uint8_t> data, std::span<uint8_t> out) noexcept {
    if (port_address > kMaxPortAddress || data.empty() || out.size() < kArtDmxMax) {
        return 0;
    }
    const std::size_t n = (data.size() < kMaxDmx) ? data.size() : kMaxDmx;
    const std::size_t padded = n + (n & 1U);  // ArtDmx 要求偶数长度

    uint8_t* o = out.data();
    std::memcpy(o, kArtnetHeader, 8);
    wr_le16(o + 8, kOpDmx);
    o[10] = kProtVer[0];
    o[11] = kProtVer[1];
    o[12] = sequence;
    o[13] = 0;  // Physical
    wr_le16(o + 14, port_address);
    wr_be16(o + 16, static_cast<uint16_t>(padded));
    std::memcpy(o + 18, data.data(), n);
    if (padded > n) {
        o[18 + n] = 0;
    }
    return 18 + padded;
}

std::size_t build_sacn_into(uint16_t universe, std::span<const uint8_t> data, const uint8_t cid[16],
                            const char* source_name, uint8_t priority, uint8_t sequence,
                            uint8_t options, std::span<uint8_t> out) noexcept {
    if (out.size() < kSacnMax) {
        return 0;
    }
    const std::size_t n = (data.size() < kMaxDmx) ? data.size() : kMaxDmx;
    const std::size_t total = 126 + n;
    uint8_t* o = out.data();
    std::memset(o, 0, total);

    // ---- Root 层 ----
    wr_be16(o + 0, 0x0010);  // preamble size
    wr_be16(o + 2, 0x0000);  // postamble size
    std::memcpy(o + 4, kAcnPid, 12);
    write_flags_len(o + 16, static_cast<uint16_t>(total - 16));
    wr_be32(o + 18, 0x0000'0004);  // VECTOR_ROOT_E131_DATA
    std::memcpy(o + 22, cid, 16);

    // ---- Framing 层 ----
    write_flags_len(o + 38, static_cast<uint16_t>(total - 38));
    wr_be32(o + 40, 0x0000'0002);  // VECTOR_E131_DATA_PACKET
    // 源名称 64 字节（offset 44）
    if (source_name != nullptr) {
        std::size_t sn = std::strlen(source_name);
        if (sn > 63) {
            sn = 63;
        }
        std::memcpy(o + 44, source_name, sn);
    }
    o[108] = priority;
    wr_be16(o + 109, 0x0000);  // Sync Address
    o[111] = sequence;
    o[112] = options;  // Options
    wr_be16(o + 113, universe);

    // ---- DMP 层 ----
    write_flags_len(o + 115, static_cast<uint16_t>(total - 115));
    o[117] = 0x02;                                      // VECTOR_DMP_SET_PROPERTY
    o[118] = 0xa1;                                      // 地址与数据类型
    wr_be16(o + 119, 0x0000);                           // 首属性地址
    wr_be16(o + 121, 0x0001);                           // 地址增量
    wr_be16(o + 123, static_cast<uint16_t>(n + 1));     // 属性数（含 START Code）
    o[125] = 0x00;                                      // DMX START Code
    std::memcpy(o + 126, data.data(), n);

    return total;
}

bool is_artpoll(std::span<const uint8_t> buf) noexcept {
    if (buf.size() < 14) {
        return false;
    }
    if (std::memcmp(buf.data(), kArtnetHeader, 8) != 0) {
        return false;
    }
    return rd_le16(buf.data() + 8) == kOpPoll;
}

std::optional<ParsedDmx> parse_artdmx(std::span<const uint8_t> buf) noexcept {
    if (buf.size() < 18) {
        return std::nullopt;
    }
    if (std::memcmp(buf.data(), kArtnetHeader, 8) != 0) {
        return std::nullopt;
    }
    if (rd_le16(buf.data() + 8) != kOpDmx) {
        return std::nullopt;
    }
    ParsedDmx r;
    r.universe = rd_le16(buf.data() + 14);
    std::size_t length = rd_be16(buf.data() + 16);
    const std::size_t avail = buf.size() - 18;
    if (length > avail) {
        length = avail;
    }
    if (length > kMaxDmx) {
        length = kMaxDmx;
    }
    r.data = buf.data() + 18;
    r.len = static_cast<uint16_t>(length);
    r.priority = 0;
    return r;
}

bool is_sacn(std::span<const uint8_t> buf) noexcept {
    if (buf.size() < 16) {
        return false;
    }
    return std::memcmp(buf.data() + 4, kAcnPid, 12) == 0;
}

std::optional<ParsedDmx> parse_sacn_data(std::span<const uint8_t> buf) noexcept {
    if (buf.size() < 126 || !is_sacn(buf)) {
        return std::nullopt;
    }
    // Root 向量 VECTOR_ROOT_E131_DATA = 0x00000004。
    if (rd_be32(buf.data() + 18) != 0x0000'0004U) {
        return std::nullopt;
    }
    // Framing 向量 VECTOR_E131_DATA_PACKET = 0x00000002。
    if (rd_be32(buf.data() + 40) != 0x0000'0002U) {
        return std::nullopt;
    }
    // DMP 向量 VECTOR_DMP_SET_PROPERTY = 0x02。
    if (buf[117] != 0x02) {
        return std::nullopt;
    }
    // 起始码须为 0x00（DMX NULL Start Code），其它起始码不作为灯光数据转发。
    if (buf[125] != 0x00) {
        return std::nullopt;
    }
    ParsedDmx r;
    r.priority = buf[108];
    r.terminated = (buf[112] & kSacnOptTerminated) != 0;  // Options 的 Stream_Terminated 位
    r.universe = rd_be16(buf.data() + 113);
    const uint16_t propcount = rd_be16(buf.data() + 123);
    std::size_t n = (propcount > 0) ? static_cast<std::size_t>(propcount - 1U) : 0;  // 扣除起始码
    const std::size_t avail = buf.size() - 126;
    if (n > avail) {
        n = avail;
    }
    if (n > kMaxDmx) {
        n = kMaxDmx;
    }
    r.data = buf.data() + 126;
    r.len = static_cast<uint16_t>(n);
    return r;
}

std::size_t build_artpollreply_into(const PollReplyParams& p, std::span<uint8_t> out) noexcept {
    if (out.size() < kArtPollReplyLen) {
        return 0;
    }
    uint8_t* o = out.data();
    std::memset(o, 0, kArtPollReplyLen);

    std::memcpy(o + 0, kArtnetHeader, 8);
    wr_le16(o + 8, kOpPollReply);
    std::memcpy(o + 10, p.ip, 4);
    wr_le16(o + 14, kArtnetPort);  // Port 0x1936，小端
    o[16] = p.version_hi;
    o[17] = p.version_lo;

    // 取第一个 Universe 的高位作为 NetSwitch / SubSwitch（同一 bind 共享）。
    const std::size_t nports = (p.universes.size() < 4) ? p.universes.size() : 4;
    uint16_t first = p.universes.empty() ? 0 : p.universes[0];
    o[18] = static_cast<uint8_t>((first >> 8) & 0x7F);  // NetSwitch
    o[19] = static_cast<uint8_t>((first >> 4) & 0x0F);  // SubSwitch
    // OEM（18/19 之后为 20/21），置 0x00FF 通用值
    wr_be16(o + 20, 0x00FF);
    o[23] = 0xF0;  // Status1：indicators normal, booted from flash

    // 短名（offset 26，18 字节）/ 长名（offset 44，64 字节）
    if (p.short_name != nullptr) {
        std::size_t sl = std::strlen(p.short_name);
        if (sl > 17) sl = 17;
        std::memcpy(o + 26, p.short_name, sl);
    }
    if (p.long_name != nullptr) {
        std::size_t ll = std::strlen(p.long_name);
        if (ll > 63) ll = 63;
        std::memcpy(o + 44, p.long_name, ll);
    }

    // NumPorts（offset 172, 2B），PortTypes(174), GoodInput(178),
    // GoodOutput(182), SwIn(186), SwOut(190)
    wr_be16(o + 172, static_cast<uint16_t>(nports));
    for (std::size_t i = 0; i < nports; ++i) {
        uint16_t u = p.universes[i];
        o[174 + i] = 0x80;                                   // PortType：输出
        o[182 + i] = 0x80;                                   // GoodOutput：正在输出数据
        o[190 + i] = static_cast<uint8_t>(u & 0x0F);         // SwOut：Universe 低 4 位
    }

    o[200] = 0x00;                 // Style = StNode
    std::memcpy(o + 201, p.mac, 6);  // MAC（offset 201, 6B）
    std::memcpy(o + 207, p.ip, 4);   // BindIp（offset 207, 4B）
    o[211] = p.bind_index;           // BindIndex
    o[212] = 0x08;                   // Status2：支持 Art-Net 3/4、15bit

    return kArtPollReplyLen;
}

}  // namespace artcore::dmx
