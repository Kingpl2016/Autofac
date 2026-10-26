//! 总线 MCU（Etronet）串口协议纯逻辑实现（组帧 / 拆帧 / 流式解析 / 操作码派发）。

#include "artcore/etronet_proto.hpp"

#include <cstring>

namespace artcore::etronet {

std::vector<uint8_t> build_frame(Opcode op, uint16_t reg, std::span<const uint8_t> data) {
    const uint16_t n = static_cast<uint16_t>(kRegisterBytes + data.size());  // 载荷长度（含寄存器）
    std::vector<uint8_t> f;
    f.reserve(kFrameOverhead + n);

    f.push_back(kFrameHeader);
    f.push_back(make_comm_def(op));
    // 数据长度（2 字节，字节序由 wr_u16 决定）。
    uint8_t len[2];
    wr_u16(n, len);
    f.push_back(len[0]);
    f.push_back(len[1]);
    // 数据载荷：寄存器(2) + 交互数据。
    uint8_t regb[2];
    wr_u16(reg, regb);
    f.push_back(regb[0]);
    f.push_back(regb[1]);
    f.insert(f.end(), data.begin(), data.end());
    // 校验和：覆盖帧头至数据载荷。
    f.push_back(checksum(std::span<const uint8_t>(f.data(), f.size())));
    return f;
}

Result<Frame> parse_frame(std::span<const uint8_t> bytes) {
    if (bytes.size() < kMinFrameLen) {
        return err(Status::InvalidArg);
    }
    if (bytes[0] != kFrameHeader) {
        return err(Status::BadFile);
    }
    const uint8_t comm_def = bytes[1];
    if (comm_def_is_group(comm_def)) {
        return err(Status::NotSupported);  // 分组传输暂不支持
    }
    const uint16_t n = rd_u16(bytes[2], bytes[3]);
    if (n < kRegisterBytes || n > kMaxPayloadLen) {
        return err(Status::InvalidArg);
    }
    const std::size_t expect = kFrameOverhead + n;
    if (bytes.size() != expect) {
        return err(Status::InvalidArg);
    }
    // 校验和覆盖帧头至数据载荷（即除最后 1 字节外的全部）。
    const uint8_t want = checksum(bytes.subspan(0, expect - 1));
    if (want != bytes[expect - 1]) {
        return err(Status::BadFile);
    }

    Frame fr;
    fr.comm_def = comm_def;
    fr.opcode = comm_def_opcode(comm_def);
    fr.group = false;
    fr.reg = rd_u16(bytes[4], bytes[5]);
    const std::size_t data_len = n - kRegisterBytes;
    if (data_len > 0) {
        fr.data.assign(bytes.begin() + 6, bytes.begin() + 6 + data_len);
    }
    return fr;
}

std::vector<Frame> FrameParser::feed(std::span<const uint8_t> bytes) {
    std::vector<Frame> out;
    buf_.insert(buf_.end(), bytes.begin(), bytes.end());

    std::size_t pos = 0;  // 已消费到的位置
    while (true) {
        // 1. 定位帧头：丢弃帧头前的垃圾字节（重同步）。
        while (pos < buf_.size() && buf_[pos] != kFrameHeader) {
            ++pos;
        }
        if (pos >= buf_.size()) {
            break;  // 无帧头，全部丢弃
        }
        // 2. 头部至少要能读出通信定义 + 长度。
        if (buf_.size() - pos < 4) {
            break;  // 等更多字节
        }
        const uint8_t comm_def = buf_[pos + 1];
        const uint16_t n = rd_u16(buf_[pos + 2], buf_[pos + 3]);

        // 3. 载荷长度非法（过短 / 超限）：判定此帧头为误同步，跳过 1 字节重找。
        if (n < kRegisterBytes || n > max_payload_) {
            if (n > max_payload_) {
                ++oversize_dropped_;
            }
            ++pos;
            continue;
        }
        const std::size_t total = kFrameOverhead + n;
        // 4. 整帧尚未到齐：等更多字节。
        if (buf_.size() - pos < total) {
            break;
        }
        // 5. 分组传输：暂不支持，丢弃本帧并前移。
        if (comm_def_is_group(comm_def)) {
            ++group_dropped_;
            pos += total;
            continue;
        }
        // 6. 校验和。
        auto frame_span = std::span<const uint8_t>(buf_.data() + pos, total);
        const uint8_t want = checksum(frame_span.subspan(0, total - 1));
        if (want != buf_[pos + total - 1]) {
            ++checksum_errors_;
            ++pos;  // 可能是误同步的假帧头，跳 1 字节重找
            continue;
        }
        // 7. 合法整帧。
        Frame fr;
        fr.comm_def = comm_def;
        fr.opcode = comm_def_opcode(comm_def);
        fr.group = false;
        fr.reg = rd_u16(buf_[pos + 4], buf_[pos + 5]);
        const std::size_t data_len = n - kRegisterBytes;
        if (data_len > 0) {
            fr.data.assign(buf_.begin() + pos + 6, buf_.begin() + pos + 6 + data_len);
        }
        out.push_back(std::move(fr));
        pos += total;
    }

    // 丢弃已消费 / 已跳过的前缀，保留未处理尾部，避免缓冲无限增长。
    if (pos > 0) {
        buf_.erase(buf_.begin(), buf_.begin() + pos);
    }
    return out;
}

std::optional<std::vector<uint8_t>> dispatch(const Frame& frame, const RegHandler& handler) {
    switch (frame.opcode) {
        case Opcode::SetNeedAck: {
            auto r = handler(frame.reg, frame.opcode, frame.data);
            const uint8_t code =
                r ? static_cast<uint8_t>(Status::Ok) : status_to_reply_code(r.error());
            uint8_t payload[1] = {code};
            return build_frame(Opcode::SetAck, frame.reg, payload);
        }
        case Opcode::SetNoAck: {
            (void)handler(frame.reg, frame.opcode, frame.data);  // 执行，不回帧
            return std::nullopt;
        }
        case Opcode::Get: {
            auto r = handler(frame.reg, frame.opcode, frame.data);
            if (r) {
                return build_frame(Opcode::GetResp, frame.reg, *r);
            }
            // 读取失败：回响应帧，交互数据首字节为应答码。
            uint8_t payload[1] = {status_to_reply_code(r.error())};
            return build_frame(Opcode::GetResp, frame.reg, payload);
        }
        case Opcode::PushNeedAck: {
            auto r = handler(frame.reg, frame.opcode, frame.data);
            const uint8_t code =
                r ? static_cast<uint8_t>(Status::Ok) : status_to_reply_code(r.error());
            uint8_t payload[1] = {code};
            return build_frame(Opcode::PushAck, frame.reg, payload);
        }
        case Opcode::PushNoAck: {
            (void)handler(frame.reg, frame.opcode, frame.data);  // 执行，不回帧
            return std::nullopt;
        }
        // 应答类操作码作为入帧收到时忽略（ESP32 为纯从机，不应收到这些）。
        case Opcode::SetAck:
        case Opcode::GetResp:
        case Opcode::PushAck:
        default:
            return std::nullopt;
    }
}

}  // namespace artcore::etronet
