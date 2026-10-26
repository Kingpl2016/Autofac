//! 总线 MCU 串口桥接实现：解析帧 → 调 BoardControl → 回应答码。

#include "etronet_bridge.hpp"

#include <vector>

namespace app {

artcore::etronet::RegHandler make_etronet_handler(Context& c) {
    using artcore::Status;
    using artcore::etronet::Opcode;
    using artcore::etronet::Reg;
    artcore::BoardControl* ctrl = &c.control;
    return [ctrl](uint16_t reg, Opcode op,
                  std::span<const uint8_t> data) -> artcore::Result<std::vector<uint8_t>> {
        const bool is_get = (op == Opcode::Get);
        switch (static_cast<Reg>(reg)) {
            case Reg::BoardOp: {
                if (is_get || data.empty()) return artcore::err(Status::InvalidArg);
                if (auto r = ctrl->board_op(data[0]); !r) return artcore::err(r.error());
                return std::vector<uint8_t>{};
            }
            case Reg::Channel:
                return artcore::err(Status::NotSupported);  // 通道读写本期不支持
            case Reg::ProgramOp: {
                if (is_get || data.size() < 2) return artcore::err(Status::InvalidArg);
                if (auto r = ctrl->program_op(data[0], data[1]); !r) {
                    return artcore::err(r.error());
                }
                return std::vector<uint8_t>{};
            }
            case Reg::WorkMode: {
                if (is_get) return std::vector<uint8_t>{ctrl->work_mode()};
                if (data.empty()) return artcore::err(Status::InvalidArg);
                if (auto r = ctrl->set_work_mode(data[0]); !r) return artcore::err(r.error());
                return std::vector<uint8_t>{};
            }
            default:
                return artcore::err(Status::NotSupported);
        }
    };
}

}  // namespace app
