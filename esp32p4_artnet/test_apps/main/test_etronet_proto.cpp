//! 总线 MCU（Etronet）串口协议纯逻辑测试（组帧 / 拆帧 / 流式解析 / 操作码派发）。

#include <array>
#include <initializer_list>
#include <span>
#include <vector>

#include "artcore/etronet_proto.hpp"
#include "catch2/catch_test_macros.hpp"

using namespace artcore;
using namespace artcore::etronet;

namespace {
/// 把若干字节拼成 vector，便于构造输入流。
std::vector<uint8_t> bytes(std::initializer_list<uint8_t> v) { return std::vector<uint8_t>(v); }
}  // namespace

// ===================== 位域 / 校验和 =====================

TEST_CASE("帧头常量与固定位域", "[etronet]") {
    REQUIRE(kFrameHeader == 0x35);
    // bit7-6 版本=00，bit5-0=110101b。
    REQUIRE((kFrameHeader >> 6) == 0);
    REQUIRE(kHeaderFixedBits == 0x35);
}

TEST_CASE("通信定义打包与解包", "[etronet]") {
    uint8_t cd = make_comm_def(Opcode::Get);
    REQUIRE(comm_def_opcode(cd) == Opcode::Get);
    REQUIRE_FALSE(comm_def_is_group(cd));
    REQUIRE((cd & 0x0F) == 0);  // 预留位为 0

    uint8_t g = make_comm_def(Opcode::SetNeedAck, true);
    REQUIRE(comm_def_is_group(g));
    REQUIRE(comm_def_opcode(g) == Opcode::SetNeedAck);
}

TEST_CASE("校验和为字节和低 8 位", "[etronet]") {
    std::array<uint8_t, 4> b{0x35, 0x10, 0xFF, 0x02};
    REQUIRE(checksum(b) == static_cast<uint8_t>(0x35 + 0x10 + 0xFF + 0x02));
    REQUIRE(checksum(std::span<const uint8_t>{}) == 0);
}

TEST_CASE("u16 小端读写互逆", "[etronet]") {
    uint8_t out[2];
    wr_u16(0xBEEF, out);
    REQUIRE(out[0] == 0xEF);
    REQUIRE(out[1] == 0xBE);
    REQUIRE(rd_u16(out[0], out[1]) == 0xBEEF);
}

// ===================== 组帧 / 拆帧 =====================

TEST_CASE("build_frame 字节布局", "[etronet]") {
    std::array<uint8_t, 1> data{0x01};
    auto f = build_frame(Opcode::SetNeedAck, Reg::WorkMode, data);
    // 帧头 + 通信定义 + 长度(2) + 载荷(reg2+data1=3) + 校验和 = 8
    REQUIRE(f.size() == 8);
    REQUIRE(f[0] == 0x35);
    REQUIRE(comm_def_opcode(f[1]) == Opcode::SetNeedAck);
    REQUIRE(rd_u16(f[2], f[3]) == 3);        // 数据长度 = 寄存器2 + 数据1
    REQUIRE(rd_u16(f[4], f[5]) == 0x0003);   // 寄存器 WorkMode
    REQUIRE(f[6] == 0x01);                   // 交互数据
    REQUIRE(f[7] == checksum(std::span<const uint8_t>(f.data(), 7)));
}

TEST_CASE("parse_frame 回解 build_frame", "[etronet]") {
    std::array<uint8_t, 3> data{0x0A, 0x0B, 0x0C};
    auto f = build_frame(Opcode::Get, 0x1234, data);
    auto r = parse_frame(f);
    REQUIRE(r.has_value());
    REQUIRE(r->opcode == Opcode::Get);
    REQUIRE_FALSE(r->group);
    REQUIRE(r->reg == 0x1234);
    REQUIRE(r->data.size() == 3);
    REQUIRE(r->data[0] == 0x0A);
    REQUIRE(r->data[2] == 0x0C);
}

TEST_CASE("parse_frame 空交互数据", "[etronet]") {
    auto f = build_frame(Opcode::Get, Reg::WorkMode, std::span<const uint8_t>{});
    REQUIRE(f.size() == kMinFrameLen);
    auto r = parse_frame(f);
    REQUIRE(r.has_value());
    REQUIRE(r->data.empty());
    REQUIRE(r->reg == 0x0003);
}

TEST_CASE("parse_frame 拒绝坏帧头 / 坏校验 / 短帧 / 分组", "[etronet]") {
    std::array<uint8_t, 1> data{0x01};
    auto good = build_frame(Opcode::SetNeedAck, Reg::WorkMode, data);

    // 坏帧头
    auto bad_hdr = good;
    bad_hdr[0] = 0x34;
    REQUIRE(parse_frame(bad_hdr).error() == Status::BadFile);

    // 坏校验
    auto bad_sum = good;
    bad_sum.back() ^= 0xFF;
    REQUIRE(parse_frame(bad_sum).error() == Status::BadFile);

    // 短帧
    REQUIRE(parse_frame(std::span<const uint8_t>(good.data(), 4)).error() == Status::InvalidArg);

    // 分组传输位
    auto grp = build_frame(Opcode::SetNeedAck, Reg::WorkMode, data);
    grp[1] |= 0x80;
    grp.back() = checksum(std::span<const uint8_t>(grp.data(), grp.size() - 1));
    REQUIRE(parse_frame(grp).error() == Status::NotSupported);
}

// ===================== 流式解析 =====================

TEST_CASE("FrameParser 分段喂入拼出整帧", "[etronet][parser]") {
    std::array<uint8_t, 2> data{0xAA, 0xBB};
    auto f = build_frame(Opcode::SetNoAck, Reg::ProgramOp, data);

    FrameParser p;
    // 先喂前半截，不应产出帧。
    auto a = p.feed(std::span<const uint8_t>(f.data(), 3));
    REQUIRE(a.empty());
    // 补齐剩余，产出一帧。
    auto b = p.feed(std::span<const uint8_t>(f.data() + 3, f.size() - 3));
    REQUIRE(b.size() == 1);
    REQUIRE(b[0].opcode == Opcode::SetNoAck);
    REQUIRE(b[0].reg == 0x0002);
    REQUIRE(b[0].data.size() == 2);
}

TEST_CASE("FrameParser 前导垃圾字节后重同步", "[etronet][parser]") {
    std::array<uint8_t, 1> data{0x02};
    auto f = build_frame(Opcode::SetNeedAck, Reg::WorkMode, data);

    std::vector<uint8_t> stream = bytes({0x00, 0xFF, 0x12});  // 垃圾
    stream.insert(stream.end(), f.begin(), f.end());

    FrameParser p;
    auto got = p.feed(stream);
    REQUIRE(got.size() == 1);
    REQUIRE(got[0].reg == 0x0003);
}

TEST_CASE("FrameParser 粘包拆出多帧", "[etronet][parser]") {
    std::array<uint8_t, 1> d1{0x01};
    std::array<uint8_t, 1> d2{0x04};
    auto f1 = build_frame(Opcode::SetNeedAck, Reg::WorkMode, d1);
    auto f2 = build_frame(Opcode::Get, Reg::ProgramOp, d2);

    std::vector<uint8_t> stream(f1);
    stream.insert(stream.end(), f2.begin(), f2.end());

    FrameParser p;
    auto got = p.feed(stream);
    REQUIRE(got.size() == 2);
    REQUIRE(got[0].reg == 0x0003);
    REQUIRE(got[1].reg == 0x0002);
    REQUIRE(got[1].opcode == Opcode::Get);
}

TEST_CASE("FrameParser 校验和错误计数并丢弃", "[etronet][parser]") {
    std::array<uint8_t, 1> data{0x01};
    auto f = build_frame(Opcode::SetNeedAck, Reg::WorkMode, data);
    f.back() ^= 0xFF;  // 破坏校验

    FrameParser p;
    auto got = p.feed(f);
    REQUIRE(got.empty());
    REQUIRE(p.checksum_errors() >= 1);
}

TEST_CASE("FrameParser 超长度上限丢弃", "[etronet][parser]") {
    FrameParser p(8);  // 载荷上限仅 8
    // 构造一个声明长度 n=100（> 8）的帧头部。
    std::vector<uint8_t> hdr = bytes({0x35, make_comm_def(Opcode::SetNoAck), 100, 0});
    auto got = p.feed(hdr);
    REQUIRE(got.empty());
    REQUIRE(p.oversize_dropped() >= 1);
}

// ===================== 操作码派发 =====================

namespace {
/// 固定成功、回带输入数据的桩 handler（用于 get 验证数据透传）。
RegHandler echo_ok() {
    return [](uint16_t, Opcode, std::span<const uint8_t> in) -> Result<std::vector<uint8_t>> {
        return std::vector<uint8_t>(in.begin(), in.end());
    };
}
/// 固定失败的桩 handler。
RegHandler always(Status s) {
    return [s](uint16_t, Opcode, std::span<const uint8_t>) -> Result<std::vector<uint8_t>> {
        return err(s);
    };
}
}  // namespace

TEST_CASE("dispatch set 需确认回 set-ack 带应答码", "[etronet][dispatch]") {
    std::array<uint8_t, 1> data{0x01};
    Frame fr = *parse_frame(build_frame(Opcode::SetNeedAck, Reg::WorkMode, data));

    auto reply = dispatch(fr, echo_ok());
    REQUIRE(reply.has_value());
    auto pr = parse_frame(*reply);
    REQUIRE(pr.has_value());
    REQUIRE(pr->opcode == Opcode::SetAck);
    REQUIRE(pr->reg == 0x0003);
    REQUIRE(pr->data.size() == 1);
    REQUIRE(pr->data[0] == static_cast<uint8_t>(Status::Ok));
}

TEST_CASE("dispatch set 失败回非 0 应答码", "[etronet][dispatch]") {
    std::array<uint8_t, 1> data{0x09};
    Frame fr = *parse_frame(build_frame(Opcode::SetNeedAck, Reg::ProgramOp, data));

    auto reply = dispatch(fr, always(Status::NotFound));
    REQUIRE(reply.has_value());
    auto pr = parse_frame(*reply);
    REQUIRE(pr->opcode == Opcode::SetAck);
    REQUIRE(pr->data[0] == static_cast<uint8_t>(Status::NotFound));
}

TEST_CASE("dispatch set 无需确认不回帧", "[etronet][dispatch]") {
    std::array<uint8_t, 1> data{0x01};
    Frame fr = *parse_frame(build_frame(Opcode::SetNoAck, Reg::WorkMode, data));
    REQUIRE_FALSE(dispatch(fr, echo_ok()).has_value());
}

TEST_CASE("dispatch get 回 get-响应透传数据", "[etronet][dispatch]") {
    // handler 回 2 字节数据，验证 get-响应携带。
    RegHandler h = [](uint16_t, Opcode, std::span<const uint8_t>) -> Result<std::vector<uint8_t>> {
        return std::vector<uint8_t>{0x04, 0x02};
    };
    Frame fr = *parse_frame(build_frame(Opcode::Get, Reg::WorkMode, std::span<const uint8_t>{}));

    auto reply = dispatch(fr, h);
    REQUIRE(reply.has_value());
    auto pr = parse_frame(*reply);
    REQUIRE(pr->opcode == Opcode::GetResp);
    REQUIRE(pr->data.size() == 2);
    REQUIRE(pr->data[0] == 0x04);
}

TEST_CASE("dispatch push 需确认回 push-ack；无需确认不回", "[etronet][dispatch]") {
    std::array<uint8_t, 1> data{0x01};
    Frame need = *parse_frame(build_frame(Opcode::PushNeedAck, Reg::WorkMode, data));
    auto r1 = dispatch(need, echo_ok());
    REQUIRE(r1.has_value());
    REQUIRE(parse_frame(*r1)->opcode == Opcode::PushAck);

    Frame noack = *parse_frame(build_frame(Opcode::PushNoAck, Reg::WorkMode, data));
    REQUIRE_FALSE(dispatch(noack, echo_ok()).has_value());
}

TEST_CASE("dispatch 应答类入帧被忽略", "[etronet][dispatch]") {
    std::array<uint8_t, 1> data{0x00};
    Frame ack = *parse_frame(build_frame(Opcode::SetAck, Reg::WorkMode, data));
    REQUIRE_FALSE(dispatch(ack, echo_ok()).has_value());
}
