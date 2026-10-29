//! 回放引擎：状态机 + 绝对时间调度，向网络输出 DMX。
//!
//! 单引擎线程模型：线程持有打开的 [`artrec::ArtRecFile`]、[`ZstdDecoder`] 与
//! [`OutputRouter`] 引用（网络 + UART 两路），按命令队列驱动状态，按帧索引时间调度发送。
//!
//! 实现要点与上位机播放器对齐：
//! - 保活：静止段 / 暂停时按 `keepalive_ms` 重发当前全部 Universe。
//! - 落后合并：多个到期帧只发最终状态。
//! - 容错：帧 CRC / 解压失败时沿用上一帧并累计损坏帧数。
//! - seek：立即补发该位置完整状态；倍速：重设时间基准，无跳变。
//!
//! 注：读取与发送在同一引擎线程完成（帧边界处读盘）。读取 / 调度分线程 +
//! 无锁 SPSC 环形队列的优化留待压测后，不改变本类对外契约。

#pragma once

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include "artcore/artrec.hpp"
#include "artcore/output_config.hpp"
#include "artcore/output_router.hpp"
#include "artcore/program_store.hpp"
#include "artcore/result.hpp"
#include "artcore/ring_buffer.hpp"
#include "artcore/zstd_dec.hpp"
#include "sdkconfig.h"

namespace artcore {

#ifdef CONFIG_ART_PLAYER_PREFETCH
/// 是否启用回放预读 / 解码分线程（Kconfig）。
inline constexpr bool kPlayerPrefetch = true;
/// 预读环形缓冲深度（已解压帧数）。
inline constexpr std::size_t kPlayerPrefetchDepth = CONFIG_ART_PLAYER_PREFETCH_DEPTH;
#else
/// 未启用预读：走单线程回退路径。
inline constexpr bool kPlayerPrefetch = false;
/// 占位深度（禁用时环仍存在但不使用）。
inline constexpr std::size_t kPlayerPrefetchDepth = 4;
#endif

/// 播放状态。
enum class PlayState : uint8_t {
    /// 空闲（未打开节目）。
    Idle = 0,
    /// 已打开但未播放。
    Stopped = 1,
    /// 播放中。
    Playing = 2,
    /// 暂停。
    Paused = 3,
};

/// 重复模式。
enum class RepeatMode : uint8_t {
    /// 播完停在结尾。
    Off = 0,
    /// 循环当前节目。
    Loop = 1,
    /// 连播（播完按编号升序开下一个）。
    Playlist = 2,
};

/// 打开节目时的重复模式决策（纯函数，便于推理与测试）。
///
/// - 用户主动打开（`user_initiated=true`）：重置为 `Off`，再按文件 loop 推荐标志决定，
///   使切换节目时行为可预期（新节目的循环性只由其文件头决定）。
/// - 连播内部切歌（`user_initiated=false`）：保留当前模式，避免把 `Playlist` 打断成单曲。
///
/// # Arguments
///
/// * `user_initiated` - 是否用户主动打开（否则为连播推进内部打开）。
/// * `loop_recommended` - 文件头是否建议循环。
/// * `current` - 当前重复模式。
[[nodiscard]] constexpr RepeatMode repeat_on_open(bool user_initiated, bool loop_recommended,
                                                  RepeatMode current) noexcept {
    if (!user_initiated) {
        return current;
    }
    return loop_recommended ? RepeatMode::Loop : RepeatMode::Off;
}

/// 播放状态快照（供寄存器 0x0010 / HTTP `GET /api/player`）。
struct PlayerStatus {
    /// 状态（见 [`PlayState`]）。
    uint8_t state = 0;
    /// 当前节目号（未打开为 0）。
    uint8_t program_no = 0;
    /// 重复模式（见 [`RepeatMode`]）。
    uint8_t repeat = 0;
    /// 倍速 ×100（25~200）。
    uint16_t speed_x100 = 100;
    /// 当前播放位置（毫秒）。
    uint32_t pos_ms = 0;
    /// 节目总时长（毫秒）。
    uint32_t dur_ms = 0;
    /// Universe 数。
    uint16_t universes = 0;
    /// 帧数。
    uint32_t frames = 0;
    /// 损坏帧累计。
    uint32_t bad_frames = 0;
};

/// 回放引擎。
class Player {
public:
    Player() = default;
    ~Player();

    Player(const Player&) = delete;
    Player& operator=(const Player&) = delete;

    /// 启动引擎线程。
    ///
    /// # Arguments
    ///
    /// * `output` - 输出路由器（网络 + UART，生命周期须长于本 Player）。
    /// * `store` - 节目映射表（连播查找下一个用）。
    /// * `out_cfg` - 输出配置（提供 Universe 顺序之外的停止行为 / 保活间隔）。
    void start(OutputRouter* output, ProgramStore* store, const OutputConfig& out_cfg) noexcept;

    /// 停止并 join 引擎线程。
    void stop_engine() noexcept;

    /// 更新输出相关参数（停止行为 / 保活间隔）。线程安全。
    void update_output_config(const OutputConfig& out_cfg) noexcept;

    // ---- 命令（异步投递到引擎线程，按顺序处理）----

    /// 打开指定编号的节目（解析路径 + 打开文件）。
    void cmd_open(uint16_t program_no) noexcept;
    /// 开始 / 恢复播放。
    void cmd_play() noexcept;
    /// 暂停。
    void cmd_pause() noexcept;
    /// 停止（回到起点，按停止行为处理输出）。
    void cmd_stop() noexcept;
    /// 关闭节目（卸载文件，回到 Idle）。
    void cmd_close() noexcept;
    /// 跳转到指定毫秒位置。
    void cmd_seek(uint32_t pos_ms) noexcept;
    /// 设置倍速 ×100（25~200，越界夹取）。
    void cmd_set_speed(uint16_t speed_x100) noexcept;
    /// 设置重复模式。
    void cmd_set_repeat(RepeatMode mode) noexcept;

    /// 读取当前状态快照。线程安全。
    [[nodiscard]] PlayerStatus status() const noexcept;

    /// 当前是否有节目打开（非 Idle）。线程安全。
    [[nodiscard]] bool has_program() const noexcept;

    /// 当前已打开节目的输出 Universe 列表快照（供设备发现应答）。线程安全。
    [[nodiscard]] std::vector<uint16_t> output_universes() const noexcept;

private:
    /// 命令类型。
    enum class CmdType : uint8_t {
        Open,
        Play,
        Pause,
        Stop,
        Close,
        Seek,
        SetSpeed,
        SetRepeat,
    };
    struct Cmd {
        CmdType type;
        uint32_t arg = 0;  ///< Open: 节目号；Seek: 毫秒；SetSpeed: x100；SetRepeat: mode
    };

    void engine_loop() noexcept;
    void post(Cmd c) noexcept;

    // 以下均在引擎线程内调用（无需额外加锁，除状态快照字段外）。
    void handle_open(uint16_t no, bool user_initiated) noexcept;
    void handle_play() noexcept;
    void handle_stop() noexcept;
    void handle_close() noexcept;
    void handle_seek(uint32_t pos_ms) noexcept;
    void do_tick(uint64_t now_us, uint64_t& next_deadline_us) noexcept;
    void load_and_send(std::size_t frame_idx, uint64_t now_us) noexcept;
    void send_current() noexcept;
    void send_blackout() noexcept;
    void advance_playlist() noexcept;
    void publish_status() noexcept;

    // 取第 i 帧解压数据到 raw_：预读命中则直接取，未命中走 file_mutex_ 下同步读（回退路径）。
    [[nodiscard]] Result<void> fetch_frame(std::size_t i) noexcept;
    // 在 file_mutex_ 保护下同步读取一帧（回退读与预读线程共用 fd / 解码器时的唯一入口）。
    [[nodiscard]] Result<void> read_frame_locked(std::size_t i, std::vector<uint8_t>& chunk,
                                                 std::vector<uint8_t>& raw,
                                                 ZstdDecoder& dec) noexcept;
    // 预读 / 解码线程主循环。
    void prefetch_loop() noexcept;
    // 重置预读：设定起始帧 / 总帧数 / 是否激活，递增生成号并清空环、唤醒预读线程。
    void reset_prefetch(std::size_t first_idx, std::size_t frame_count, bool active) noexcept;

    // 引擎 / 外部共享。
    std::thread thread_;
    std::atomic<bool> running_{false};
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<Cmd> cmds_;

    // 状态快照（mutex 保护）。
    PlayerStatus status_{};
    // 当前节目输出 Universe 列表快照（mutex 保护）。
    std::vector<uint16_t> pub_universes_{};

    // 引擎线程私有。
    OutputRouter* out_ = nullptr;
    ProgramStore* store_ = nullptr;
    // 运行期可变的输出字段改用原子：引擎线程无锁读取，控制线程经 update_output_config
    // 写入，消除此前对 out_cfg_ 的数据竞争。其余 OutputConfig 字段由 DmxOutput 持有。
    std::atomic<uint32_t> keepalive_ms_{1000};
    std::atomic<StopBehavior> stop_behavior_{StopBehavior::Hold};
    std::atomic<bool> sacn_enabled_{false};
    artrec::ArtRecFile file_;
    ZstdDecoder decoder_;
    std::vector<uint8_t> chunk_scratch_;
    std::vector<uint8_t> raw_;           ///< 当前帧解压后的原始 Payload（keepalive 复用）
    std::vector<uint8_t> raw_fallback_;  ///< 同步回退读取的临时输出（成功才换入 raw_）
    bool have_frame_ = false;            ///< raw_ 是否已有有效数据

    // ---- 预读 / 解码分线程（kPlayerPrefetch 为 true 时启用）----
    /// 一帧预读结果。
    struct DecodedFrame {
        uint32_t gen = 0;            ///< 生成号（open/seek/loop/未命中时递增使旧帧失效）
        std::size_t idx = SIZE_MAX;  ///< 帧下标
        bool ok = false;             ///< 解压是否成功
        std::vector<uint8_t> raw;    ///< 解压后 Payload
    };
    std::thread prefetch_thread_;
    /// 保护 fd 生命周期（open/close）与 read_frame/decoder，使预读线程与回退读互斥。
    std::mutex file_mutex_;
    /// 保护下列预读控制态与环。锁序固定，绝不与 file_mutex_ 嵌套持有，避免死锁。
    std::mutex pf_mutex_;
    std::condition_variable pf_cv_;
    RingBuffer<DecodedFrame, kPlayerPrefetchDepth> pf_ring_;
    uint32_t pf_gen_ = 0;       ///< 当前生成号
    std::size_t pf_next_ = 0;   ///< 预读线程下一个要解码的帧
    std::size_t pf_count_ = 0;  ///< 当前节目帧数快照
    bool pf_active_ = false;    ///< 预读是否激活（节目已打开）
    // 预读线程私有解码缓冲。
    ZstdDecoder pf_decoder_;
    std::vector<uint8_t> pf_chunk_;
    std::vector<uint8_t> pf_raw_;

    PlayState state_ = PlayState::Idle;
    RepeatMode repeat_ = RepeatMode::Off;
    uint16_t program_no_ = 0;
    uint32_t speed_x100_ = 100;

    // 时间基准：pos_us = base_pos_us_ + (now - base_mono_us_) * speed / 100。
    uint64_t base_mono_us_ = 0;
    uint64_t base_pos_us_ = 0;

    std::size_t last_frame_ = SIZE_MAX;  ///< 最近已发送的帧下标
    uint64_t last_send_mono_us_ = 0;     ///< 最近一次发送的单调时刻（保活用）
    uint32_t bad_frames_ = 0;

    // 调度迟到统计（微秒）。
    uint64_t late_max_us_ = 0;
    uint64_t late_sum_us_ = 0;
    uint32_t late_count_ = 0;
};

}  // namespace artcore
