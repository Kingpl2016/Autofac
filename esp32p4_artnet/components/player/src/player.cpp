//! 回放引擎实现。

#include "artcore/player.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>

#include "esp_log.h"
#include "esp_pthread.h"
#include "esp_timer.h"

namespace artcore {

namespace {
constexpr const char* kTag = "player";
/// 空闲时等待命令的默认间隔（微秒）。
constexpr uint64_t kIdleWaitUs = 1'000'000;
/// 全零通道缓冲（熄灯 / 占位），最大 512。
constexpr uint8_t kZeros[512] = {};

/// 单调微秒时钟。
uint64_t now_us() noexcept { return static_cast<uint64_t>(esp_timer_get_time()); }
}  // namespace

Player::~Player() { stop_engine(); }

void Player::start(OutputRouter* output, ProgramStore* store, const OutputConfig& out_cfg) noexcept {
    if (running_.load()) {
        return;
    }
    out_ = output;
    store_ = store;
    out_cfg_ = out_cfg;
    running_.store(true);

    // 引擎线程：固定 core 1、较高优先级、较大栈。
    esp_pthread_cfg_t cfg = esp_pthread_get_default_config();
    cfg.thread_name = "player_engine";
    cfg.stack_size = 6144;
    cfg.prio = 10;
    cfg.pin_to_core = 1;
    esp_pthread_set_cfg(&cfg);

    thread_ = std::thread([this] { engine_loop(); });

    if constexpr (kPlayerPrefetch) {
        // 预读 / 解码线程：与引擎同核（core 1 专供回放），优先级略低于发送引擎，
        // 使解码在引擎等待下一帧的空档进行，引擎需发送时可抢占。
        esp_pthread_cfg_t pcfg = esp_pthread_get_default_config();
        pcfg.thread_name = "player_prefetch";
        pcfg.stack_size = 4096;
        pcfg.prio = 9;
        pcfg.pin_to_core = 1;
        esp_pthread_set_cfg(&pcfg);
        prefetch_thread_ = std::thread([this] { prefetch_loop(); });
    }
}

void Player::stop_engine() noexcept {
    if (!running_.load()) {
        return;
    }
    running_.store(false);
    cv_.notify_all();
    {
        std::lock_guard<std::mutex> lk(pf_mutex_);
        pf_active_ = false;
    }
    pf_cv_.notify_all();
    if (prefetch_thread_.joinable()) {
        prefetch_thread_.join();
    }
    if (thread_.joinable()) {
        thread_.join();
    }
}

void Player::update_output_config(const OutputConfig& out_cfg) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    out_cfg_.stop_behavior = out_cfg.stop_behavior;
    out_cfg_.keepalive_ms = out_cfg.keepalive_ms;
}

void Player::post(Cmd c) noexcept {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        cmds_.push_back(c);
    }
    cv_.notify_one();
}

void Player::cmd_open(uint16_t program_no) noexcept { post({CmdType::Open, program_no}); }
void Player::cmd_play() noexcept { post({CmdType::Play, 0}); }
void Player::cmd_pause() noexcept { post({CmdType::Pause, 0}); }
void Player::cmd_stop() noexcept { post({CmdType::Stop, 0}); }
void Player::cmd_close() noexcept { post({CmdType::Close, 0}); }
void Player::cmd_seek(uint32_t pos_ms) noexcept { post({CmdType::Seek, pos_ms}); }
void Player::cmd_set_speed(uint16_t x100) noexcept { post({CmdType::SetSpeed, x100}); }
void Player::cmd_set_repeat(RepeatMode mode) noexcept {
    post({CmdType::SetRepeat, static_cast<uint32_t>(mode)});
}

PlayerStatus Player::status() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
}

bool Player::has_program() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_.state != static_cast<uint8_t>(PlayState::Idle);
}

std::vector<uint16_t> Player::output_universes() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return pub_universes_;
}

// ---- 引擎线程 ----

void Player::engine_loop() noexcept {
    while (running_.load()) {
        // 1. 处理命令队列。
        for (;;) {
            Cmd c{};
            bool has = false;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!cmds_.empty()) {
                    c = cmds_.front();
                    cmds_.pop_front();
                    has = true;
                }
            }
            if (!has) {
                break;
            }
            switch (c.type) {
                case CmdType::Open: handle_open(static_cast<uint16_t>(c.arg)); break;
                case CmdType::Play: handle_play(); break;
                case CmdType::Pause:
                    if (state_ == PlayState::Playing) {
                        uint64_t n = now_us();
                        base_pos_us_ = base_pos_us_ + (n - base_mono_us_) * speed_x100_ / 100;
                        base_mono_us_ = n;
                        state_ = PlayState::Paused;
                    }
                    break;
                case CmdType::Stop: handle_stop(); break;
                case CmdType::Close: handle_close(); break;
                case CmdType::Seek: handle_seek(c.arg); break;
                case CmdType::SetSpeed: {
                    uint32_t sp = std::clamp<uint32_t>(c.arg, 25, 200);
                    uint64_t n = now_us();
                    if (state_ == PlayState::Playing) {
                        base_pos_us_ = base_pos_us_ + (n - base_mono_us_) * speed_x100_ / 100;
                        base_mono_us_ = n;
                    }
                    speed_x100_ = sp;
                    break;
                }
                case CmdType::SetRepeat: repeat_ = static_cast<RepeatMode>(c.arg); break;
            }
        }

        // 2. 根据状态推进一拍。
        uint64_t n = now_us();
        uint64_t deadline = n + kIdleWaitUs;
        if (state_ == PlayState::Playing && file_.is_open()) {
            do_tick(n, deadline);
        } else if (state_ == PlayState::Paused && file_.is_open()) {
            // 暂停保活。
            if (out_cfg_.keepalive_ms > 0 && have_frame_ &&
                n - last_send_mono_us_ >= static_cast<uint64_t>(out_cfg_.keepalive_ms) * 1000) {
                send_current();
                last_send_mono_us_ = n;
            }
            deadline = (out_cfg_.keepalive_ms > 0)
                           ? n + static_cast<uint64_t>(out_cfg_.keepalive_ms) * 1000
                           : n + kIdleWaitUs;
        }

        publish_status();

        // 3. 等待到截止时刻或新命令。
        std::unique_lock<std::mutex> lk(mutex_);
        if (cmds_.empty() && running_.load()) {
            uint64_t nx = now_us();
            if (deadline > nx) {
                cv_.wait_for(lk, std::chrono::microseconds(deadline - nx));
            }
        }
    }
}

void Player::handle_open(uint16_t no) noexcept {
    if (store_ == nullptr) {
        return;
    }
    auto path = store_->path_for(no);
    if (!path.has_value()) {
        ESP_LOGW(kTag, "打开节目 %u 失败：无映射", no);
        return;
    }
    // 先停用预读，再在 file_mutex_ 下切换文件，避免预读线程读到正在重开的 fd。
    reset_prefetch(0, 0, false);
    Result<void> r;
    {
        std::lock_guard<std::mutex> fl(file_mutex_);
        file_.close();
        r = file_.open(path->c_str());
    }
    if (!r) {
        ESP_LOGE(kTag, "打开 %s 失败：%s", path->c_str(), status_name(r.error()));
        state_ = PlayState::Idle;
        program_no_ = 0;
        have_frame_ = false;
        return;
    }
    program_no_ = no;
    state_ = PlayState::Stopped;
    base_pos_us_ = 0;
    base_mono_us_ = now_us();
    last_frame_ = SIZE_MAX;
    have_frame_ = false;
    bad_frames_ = 0;
    late_max_us_ = 0;
    late_sum_us_ = 0;
    late_count_ = 0;
    // 文件头自带循环标志，用户未显式选择前作为初始值。
    if (file_.loop_recommended() && repeat_ == RepeatMode::Off) {
        repeat_ = RepeatMode::Loop;
    }
    // 发布输出 Universe 列表快照（供设备发现应答）。
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pub_universes_.clear();
        pub_universes_.reserve(file_.universes().size());
        for (const auto& u : file_.universes()) {
            pub_universes_.push_back(u.universe);
        }
    }
    // 启动预读（从首帧开始，总帧数为快照）。
    reset_prefetch(0, file_.frame_count(), true);
    ESP_LOGI(kTag, "已打开节目 %u：%u 个 Universe，%u 帧，%llu ms", no,
             static_cast<unsigned>(file_.universes().size()),
             static_cast<unsigned>(file_.frame_count()),
             static_cast<unsigned long long>(file_.duration_us() / 1000));
}

void Player::handle_play() noexcept {
    if (!file_.is_open()) {
        return;
    }
    // 播完后再播从头开始。
    if (base_pos_us_ >= file_.duration_us()) {
        base_pos_us_ = 0;
    }
    base_mono_us_ = now_us();
    state_ = PlayState::Playing;
    last_frame_ = SIZE_MAX;  // 强制立即补发当前位置
}

void Player::handle_stop() noexcept {
    if (!file_.is_open()) {
        return;
    }
    state_ = PlayState::Stopped;
    base_pos_us_ = 0;
    base_mono_us_ = now_us();
    last_frame_ = SIZE_MAX;
    if (out_cfg_.stop_behavior == StopBehavior::Blackout) {
        send_blackout();
    }
    // sACN：通知停流。
    if (out_cfg_.sacn_enabled) {
        for (const auto& u : file_.universes()) {
            out_->terminate_universe(u.universe, std::span<const uint8_t>(kZeros, u.dmx_len));
        }
    }
}

void Player::handle_close() noexcept {
    reset_prefetch(0, 0, false);
    {
        std::lock_guard<std::mutex> fl(file_mutex_);
        file_.close();
    }
    state_ = PlayState::Idle;
    program_no_ = 0;
    have_frame_ = false;
    last_frame_ = SIZE_MAX;
    base_pos_us_ = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pub_universes_.clear();
    }
    if (late_count_ > 0) {
        ESP_LOGI(kTag, "回放迟到统计：avg=%lluus max=%lluus n=%u",
                 static_cast<unsigned long long>(late_sum_us_ / late_count_),
                 static_cast<unsigned long long>(late_max_us_), late_count_);
    }
}

void Player::handle_seek(uint32_t pos_ms) noexcept {
    if (!file_.is_open()) {
        return;
    }
    uint64_t pos = static_cast<uint64_t>(pos_ms) * 1000;
    if (pos > file_.duration_us()) {
        pos = file_.duration_us();
    }
    base_pos_us_ = pos;
    base_mono_us_ = now_us();
    last_frame_ = SIZE_MAX;
    // 立即补发该位置完整状态。
    auto f = file_.frame_at_or_before(pos);
    if (f.has_value()) {
        load_and_send(*f, now_us());
    }
}

void Player::do_tick(uint64_t now, uint64_t& next_deadline_us) noexcept {
    const uint64_t dur = file_.duration_us();
    uint64_t pos = base_pos_us_ + (now - base_mono_us_) * speed_x100_ / 100;

    // 到达 / 超过结尾。
    if (pos >= dur) {
        switch (repeat_) {
            case RepeatMode::Off:
                // 发最终帧并停在结尾。
                if (!file_.index().empty()) {
                    load_and_send(file_.frame_count() - 1, now);
                }
                state_ = PlayState::Stopped;
                base_pos_us_ = dur;
                base_mono_us_ = now;
                next_deadline_us = now + kIdleWaitUs;
                return;
            case RepeatMode::Loop:
                base_pos_us_ = 0;
                base_mono_us_ = now;
                last_frame_ = SIZE_MAX;
                pos = 0;
                break;
            case RepeatMode::Playlist:
                advance_playlist();
                if (state_ != PlayState::Playing) {
                    next_deadline_us = now + kIdleWaitUs;
                    return;
                }
                pos = 0;
                break;
        }
    }

    auto f = file_.frame_at_or_before(pos);
    if (!f.has_value()) {
        // 位置早于首帧：无输出，等到首帧。
        uint64_t first = file_.index().front().time_us;
        uint64_t delta = (first > pos) ? (first - pos) : 0;
        next_deadline_us = now + delta * 100 / speed_x100_;
        return;
    }

    if (*f != last_frame_) {
        // 落后合并：直接跳到最新到期帧，只发最终状态。
        load_and_send(*f, now);
    } else if (out_cfg_.keepalive_ms > 0 && have_frame_ &&
               now - last_send_mono_us_ >= static_cast<uint64_t>(out_cfg_.keepalive_ms) * 1000) {
        send_current();
        last_send_mono_us_ = now;
    }

    // 下一截止：下一帧时间 或 保活间隔，取近者。
    uint64_t next_time =
        (*f + 1 < file_.frame_count()) ? file_.index()[*f + 1].time_us : dur;
    uint64_t delta_pos = (next_time > pos) ? (next_time - pos) : 0;
    uint64_t dl = now + delta_pos * 100 / speed_x100_;
    if (out_cfg_.keepalive_ms > 0) {
        uint64_t ka = last_send_mono_us_ + static_cast<uint64_t>(out_cfg_.keepalive_ms) * 1000;
        dl = std::min(dl, ka);
    }
    if (dl <= now) {
        dl = now + 1000;  // 至少 1ms，避免忙转
    }
    next_deadline_us = dl;
}

void Player::load_and_send(std::size_t frame_idx, uint64_t now) noexcept {
    // 迟到统计：期望发送时刻对应该帧的时间戳。
    const uint64_t ft = file_.index()[frame_idx].time_us;
    uint64_t expected =
        (ft >= base_pos_us_) ? base_mono_us_ + (ft - base_pos_us_) * 100 / speed_x100_ : now;
    if (now > expected) {
        uint64_t late = now - expected;
        late_max_us_ = std::max(late_max_us_, late);
        late_sum_us_ += late;
        ++late_count_;
    }

    auto r = fetch_frame(frame_idx);
    if (r) {
        have_frame_ = true;
    } else {
        ++bad_frames_;  // 容错：保留上一帧 raw_（不被失败帧覆盖）
        ESP_LOGW(kTag, "帧 %u 获取失败：%s（沿用上一帧）",
                 static_cast<unsigned>(frame_idx), status_name(r.error()));
    }
    if (have_frame_) {
        send_current();
    }
    last_frame_ = frame_idx;
    last_send_mono_us_ = now;
}

Result<void> Player::read_frame_locked(std::size_t i, std::vector<uint8_t>& chunk,
                                       std::vector<uint8_t>& raw, ZstdDecoder& dec) noexcept {
    std::lock_guard<std::mutex> fl(file_mutex_);
    if (!file_.is_open()) {
        return err(Status::NotFound);
    }
    return file_.read_frame(i, chunk, raw, &dec);
}

Result<void> Player::fetch_frame(std::size_t i) noexcept {
    if constexpr (kPlayerPrefetch) {
        std::lock_guard<std::mutex> lk(pf_mutex_);
        // 丢弃过期（旧 gen）或已越过（idx < i，落后合并跳过的帧）的预读帧。
        while (!pf_ring_.empty()) {
            DecodedFrame& fr = pf_ring_.front();
            if (fr.gen != pf_gen_ || fr.idx < i) {
                pf_ring_.pop();
                continue;
            }
            break;
        }
        if (!pf_ring_.empty() && pf_ring_.front().gen == pf_gen_ && pf_ring_.front().idx == i) {
            DecodedFrame& fr = pf_ring_.front();
            Result<void> res;
            if (fr.ok) {
                raw_.swap(fr.raw);  // O(1) 取走解压数据；旧 raw_ 缓冲留在槽内供复用
                res = {};
            } else {
                res = err(Status::BadFile);  // 解码失败：保留上一帧 raw_
            }
            pf_ring_.pop();
            pf_cv_.notify_all();  // 腾出空位，唤醒预读线程
            return res;
        }
        // 未命中：把预读重定位到 i+1 并清环，随后同步读取本帧。
        ++pf_gen_;
        pf_next_ = i + 1;
        pf_ring_.clear();
        pf_cv_.notify_all();
    }
    // 同步回退读取（预读禁用或未命中）：读入临时缓冲，成功才换入 raw_，失败保留上一帧。
    Result<void> r = read_frame_locked(i, chunk_scratch_, raw_fallback_, decoder_);
    if (r) {
        raw_.swap(raw_fallback_);
    }
    return r;
}

void Player::reset_prefetch(std::size_t first_idx, std::size_t frame_count, bool active) noexcept {
    {
        std::lock_guard<std::mutex> lk(pf_mutex_);
        ++pf_gen_;
        pf_next_ = first_idx;
        pf_count_ = frame_count;
        pf_active_ = active;
        pf_ring_.clear();
    }
    pf_cv_.notify_all();
}

void Player::prefetch_loop() noexcept {
    while (running_.load()) {
        std::size_t idx = 0;
        uint32_t gen = 0;
        {
            std::unique_lock<std::mutex> lk(pf_mutex_);
            pf_cv_.wait(lk, [this] {
                return !running_.load() ||
                       (pf_active_ && !pf_ring_.full() && pf_next_ < pf_count_);
            });
            if (!running_.load()) {
                break;
            }
            idx = pf_next_;
            gen = pf_gen_;
        }
        // 解码：持 file_mutex_，绝不同时持 pf_mutex_（锁序固定，避免死锁）。
        Result<void> r = read_frame_locked(idx, pf_chunk_, pf_raw_, pf_decoder_);
        {
            std::unique_lock<std::mutex> lk(pf_mutex_);
            // 期间若发生 open/seek/未命中（gen 变）或预读停用，则丢弃本次结果。
            if (gen == pf_gen_ && pf_active_ && idx == pf_next_ && !pf_ring_.full()) {
                DecodedFrame& slot = pf_ring_.push_slot();
                slot.gen = gen;
                slot.idx = idx;
                slot.ok = r.has_value();
                slot.raw.swap(pf_raw_);  // 移入解压数据，换回槽内旧缓冲供下次复用
                pf_next_ = idx + 1;
            }
        }
    }
}

void Player::send_current() noexcept {
    if (out_ == nullptr || !have_frame_) {
        return;
    }
    std::size_t offset = 0;
    for (const auto& u : file_.universes()) {
        if (offset + u.dmx_len > raw_.size()) {
            break;
        }
        out_->send_universe(u.universe,
                            std::span<const uint8_t>(raw_.data() + offset, u.dmx_len));
        offset += u.dmx_len;
    }
}

void Player::send_blackout() noexcept {
    if (out_ == nullptr || !file_.is_open()) {
        return;
    }
    for (const auto& u : file_.universes()) {
        uint16_t len = std::min<uint16_t>(u.dmx_len, 512);
        out_->send_universe(u.universe, std::span<const uint8_t>(kZeros, len));
    }
}

void Player::advance_playlist() noexcept {
    if (store_ == nullptr) {
        state_ = PlayState::Stopped;
        return;
    }
    auto entries = store_->list();  // 已按编号升序
    uint16_t cur = program_no_;
    for (const auto& e : entries) {
        if (e.no > cur) {
            handle_open(e.no);
            if (state_ == PlayState::Stopped && file_.is_open()) {
                base_pos_us_ = 0;
                base_mono_us_ = now_us();
                state_ = PlayState::Playing;
                last_frame_ = SIZE_MAX;
                return;
            }
        }
    }
    // 到列表末尾：停在结尾。
    state_ = PlayState::Stopped;
    base_pos_us_ = file_.duration_us();
}

void Player::publish_status() noexcept {
    uint64_t n = now_us();
    uint64_t pos;
    if (state_ == PlayState::Playing) {
        pos = base_pos_us_ + (n - base_mono_us_) * speed_x100_ / 100;
        pos = std::min(pos, file_.is_open() ? file_.duration_us() : 0);
    } else {
        pos = base_pos_us_;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    status_.state = static_cast<uint8_t>(state_);
    status_.program_no = static_cast<uint8_t>(program_no_);
    status_.repeat = static_cast<uint8_t>(repeat_);
    status_.speed_x100 = static_cast<uint16_t>(speed_x100_);
    status_.pos_ms = static_cast<uint32_t>(pos / 1000);
    status_.dur_ms = file_.is_open() ? static_cast<uint32_t>(file_.duration_us() / 1000) : 0;
    status_.universes =
        file_.is_open() ? static_cast<uint16_t>(file_.universes().size()) : 0;
    status_.frames = file_.is_open() ? static_cast<uint32_t>(file_.frame_count()) : 0;
    status_.bad_frames = bad_frames_;
}

}  // namespace artcore
