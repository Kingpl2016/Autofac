//! 固件组合根的共享上下文：集中持有所有子系统实例与若干全局常量。
//!
//! 取代原先散落在 `app_main.cpp` 的文件级全局 `g_*`，让拆分出去的各装配 / 业务单元
//! （mode_manager / outputs / etronet_bridge 等）通过显式传入 [`Context&`] 获取依赖，
//! 而非隐式捕获全局，依赖关系一目了然。

#pragma once

#include "artcore/api_server.hpp"
#include "artcore/control.hpp"
#include "artcore/dmx_output.hpp"
#include "artcore/dmx_uart.hpp"
#include "artcore/etronet_link.hpp"
#include "artcore/forwarder.hpp"
#include "artcore/net.hpp"
#include "artcore/output_router.hpp"
#include "artcore/player.hpp"
#include "artcore/program_store.hpp"
#include "artcore/settings.hpp"
#include "artcore/storage.hpp"

namespace app {

/// SD 卡挂载点。
inline constexpr const char* kMount = "/sdcard";
/// 节目目录（文件接口根）。
inline constexpr const char* kProgramsDir = "/sdcard/programs";
/// 节目映射持久化文件。
inline constexpr const char* kProgramsJson = "/sdcard/programs.json";

/// 固件所有子系统实例的集中持有（静态存储，生命周期即整个运行期）。
struct Context {
    artcore::Settings settings;
    artcore::SdCard sd;
    artcore::ProgramStore store;
    artcore::DmxOutput output;
    artcore::DmxUart uart;
    artcore::OutputRouter router;
    artcore::Network net;
    artcore::Player player;
    artcore::Forwarder forwarder;
    artcore::DiscoveryResponder discovery;
    artcore::ApiServer api;
    artcore::EtronetLink etronet;
    artcore::BoardControl control;
};

}  // namespace app
