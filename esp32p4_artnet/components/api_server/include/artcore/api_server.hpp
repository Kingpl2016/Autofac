//! 统一 HTTP 服务：控制、文件、节目、配置、日志、OTA。
//!
//! 取代原 TCP 1227 指令通道，全部走 HTTP REST（端口默认 80）。寄存器语义映射见
//! `docs/protocol.md`。可选 Bearer token 作用于全部 `/api` 与写类文件接口。
//!
//! 大文件（节目上传 / 下载、固件上传）分块收发，避免饿死回放调度线程。

#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "artcore/control.hpp"
#include "artcore/dmx_output.hpp"
#include "artcore/dmx_uart.hpp"
#include "artcore/net.hpp"
#include "artcore/player.hpp"
#include "artcore/program_store.hpp"
#include "artcore/result.hpp"
#include "artcore/settings.hpp"
#include "artcore/storage.hpp"

namespace artcore {

/// HTTP 服务依赖与回调。指针生命周期须长于 [`ApiServer`]。
struct ApiDeps {
    /// 配置。
    Settings* settings = nullptr;
    /// 回放引擎。
    Player* player = nullptr;
    /// 节目映射表。
    ProgramStore* store = nullptr;
    /// 核心板控制层（寄存器语义：board/program/workmode/seek/speed）。
    BoardControl* control = nullptr;
    /// DMX 发送器（配置变更时重建）。
    DmxOutput* output = nullptr;
    /// UART DMX512 输出器（诊断：口数 / TX 超时计数）。可为空。
    DmxUart* uart = nullptr;
    /// 网络状态。
    Network* net = nullptr;
    /// SD 卡（挂载状态）。
    SdCard* sd = nullptr;

    /// 节目目录（文件接口根）。
    std::string programs_dir;
    /// 挂载点（剩余空间查询）。
    std::string mount_point;

    /// 复位回调（board op 0）。
    std::function<void()> reboot;
    /// 出厂回调（board op 1：清 NVS + 映射后重启）。
    std::function<void()> factory_reset;
    /// 依据当前 settings 重建 DMX 输出（UDP + UART，配置变更后调用）。
    std::function<Result<void>()> apply_output;
    /// 应用工作模式（启停实时转发 / 回放门禁，见 app 的 ModeManager）。
    std::function<void(uint8_t)> apply_mode;
};

/// HTTP 服务。
class ApiServer {
public:
    ApiServer() = default;
    ~ApiServer();

    ApiServer(const ApiServer&) = delete;
    ApiServer& operator=(const ApiServer&) = delete;

    /// 启动 HTTP 服务并注册全部路由。
    ///
    /// # Arguments
    ///
    /// * `deps` - 依赖与回调。
    /// * `port` - 监听端口（通常 80）。
    ///
    /// # Errors
    ///
    /// 启动或注册失败返回 [`Status::IoError`]。
    [[nodiscard]] Result<void> start(const ApiDeps& deps, uint16_t port) noexcept;

    /// 停止服务。
    void stop() noexcept;

    /// 依赖（供静态处理函数访问）。
    [[nodiscard]] ApiDeps& deps() noexcept { return deps_; }

private:
    void* server_ = nullptr;  ///< httpd_handle_t
    ApiDeps deps_;
};

}  // namespace artcore
