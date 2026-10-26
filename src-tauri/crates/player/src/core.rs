//! 时间驱动的回放状态机。
//!
//! `Player` 与真实时钟解耦：所有时刻都以宿主层传入的**墙钟微秒**（单调、起点任意）表示，
//! 因此调度逻辑（倍速、暂停、循环、seek、保活）可以用虚拟时间做确定性测试。
//! 宿主层的职责只有两件事：按 [`Player::next_deadline`] 睡眠，醒来调用 [`Player::poll`]，
//! 并把返回的 [`Emission`] 交给转发 / 网络输出。
//!
//! # 输出语义
//!
//! - 帧到期（[`EmissionKind::Change`]）：只输出相对上次输出**发生变化**的 Universe。
//! - seek（[`EmissionKind::Seek`]）与循环回绕后的首帧：输出变化的 Universe；seek 输出全部。
//! - 保活（[`EmissionKind::Keepalive`]）：变更触发录制的静止段没有帧，按 `keepalive_us`
//!   重发当前全部 Universe，避免节点因长时间无数据而超时熄灯。暂停期间同样保活。
//! - 落后于时间轴（例如调度被阻塞）时，多个到期帧会合并，只输出最终状态。
//! - 帧损坏（CRC / 解压失败）时沿用上一帧数据继续（规范 §11 演出容错模式）。
//!
//! # 缓冲与拷贝
//!
//! 输出状态保存在内部的各路缓冲里，另有一份同形状的备用缓冲做双缓冲：推进 / seek 在备用缓冲上
//! 应用帧数据（失败时当前状态保持不变），成功后与当前缓冲交换，稳态下不分配。一次输出里的各路
//! 数据只拷贝一次，进同一块共享的 [`Bytes`]，每路是它的零拷贝切片。

use std::io::{Read, Seek};

use artrec_core::{ArtRecReader, UniDesc};
use bytes::Bytes;

/// 默认保活间隔：1 秒（低于常见节点 3~4 秒的无数据超时，且开销可忽略）。
pub const DEFAULT_KEEPALIVE_US: u64 = 1_000_000;
/// 最小 / 最大倍速（千分之一为单位）。
pub const MIN_SPEED_MILLI: u32 = 250;
/// 最大倍速（千分之一为单位）。
pub const MAX_SPEED_MILLI: u32 = 2000;
/// 倍速的基准值（1.0x）。
pub const NORMAL_SPEED_MILLI: u32 = 1000;

/// 回放状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayState {
    /// 已停止，无输出。
    Stopped,
    /// 播放中。
    Playing,
    /// 已暂停（位置冻结，仍保活）。
    Paused,
}

/// 输出原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmissionKind {
    /// 时间轴上的帧到期。
    Change,
    /// seek 后的状态补发。
    Seek,
    /// 静止段保活重发。
    Keepalive,
}

/// 单个 Universe 的输出数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniverseData {
    /// Universe 编号（来自 UniDesc）。
    pub universe: u16,
    /// 通道数据（`dmx_len` 字节，通常 512）。
    ///
    /// 同一次输出的各路数据共享一块引用计数缓冲（每路是其切片），克隆只增引用计数。
    pub data: Bytes,
}

/// 一次输出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emission {
    /// 输出原因。
    pub kind: EmissionKind,
    /// 需要发出的 Universe 数据。
    pub universes: Vec<UniverseData>,
}

/// 回放配置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlayerConfig {
    /// 保活间隔（微秒）；0 表示关闭保活。
    pub keepalive_us: u64,
    /// 是否循环播放。
    pub looping: bool,
    /// 倍速（千分之一为单位，1000 = 1.0x）。
    pub speed_milli: u32,
}

impl Default for PlayerConfig {
    fn default() -> Self {
        Self {
            keepalive_us: DEFAULT_KEEPALIVE_US,
            looping: false,
            speed_milli: NORMAL_SPEED_MILLI,
        }
    }
}

/// 面向 UI 的状态快照。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlayerStatus {
    /// 播放状态。
    pub state: PlayState,
    /// 当前位置（微秒，已钳制在节目时长内）。
    pub pos_us: u64,
    /// 节目总时长（微秒）。
    pub duration_us: u64,
    /// 倍速（千分之一）。
    pub speed_milli: u32,
    /// 是否循环。
    pub looping: bool,
    /// 帧总数。
    pub frames: usize,
    /// 已跳过的损坏帧数。
    pub corrupt_frames: u64,
}

/// 回放器。
pub struct Player<R: Read + Seek> {
    reader: ArtRecReader<R>,
    cfg: PlayerConfig,
    state: PlayState,
    /// 冻结位置（Stopped / Paused 时有效；Playing 时是锚点对应的位置）。
    pos_us: u64,
    /// Playing 时的锚点 `(墙钟微秒, 对应的节目位置)`。
    anchor: Option<(u64, u64)>,
    /// 下一个待输出的帧下标。
    next_index: usize,
    /// 当前输出状态；`None` 表示尚未输出过任何帧。
    buffers: Option<Vec<Vec<u8>>>,
    /// 备用缓冲（双缓冲的另一半）：推进 / seek 先在这里应用，成功后与 `buffers` 交换。
    spare: Vec<Vec<u8>>,
    /// 读块用的 Payload 缓冲（复用）。
    raw: Vec<u8>,
    /// 本次推进发生变化的 Universe 下标（复用）。
    changed: Vec<usize>,
    last_emit_wall: u64,
    corrupt: u64,
    /// 非循环播放刚到达结尾且尚未被 [`Player::take_ended`] 取走。
    ended: bool,
}

/// 把 `dst` 变成 `src` 的副本（逐路 `clear` + `extend_from_slice`，稳态下不分配）。
fn copy_buffers(dst: &mut Vec<Vec<u8>>, src: &[Vec<u8>]) {
    dst.resize_with(src.len(), Vec::new);
    for (d, s) in dst.iter_mut().zip(src) {
        d.clear();
        d.extend_from_slice(s);
    }
}

/// 把 `dst` 变成与 `unis` 一一对应的全零缓冲（与 [`ArtRecReader::zero_buffers`] 相同，但复用容量）。
fn zero_buffers_into(dst: &mut Vec<Vec<u8>>, unis: &[UniDesc]) {
    dst.resize_with(unis.len(), Vec::new);
    for (d, u) in dst.iter_mut().zip(unis) {
        d.clear();
        d.resize(usize::from(u.dmx_len), 0);
    }
}

/// 把选中的各路缓冲打包成输出：数据只拷贝一次，进同一块共享缓冲，每路取其切片。
///
/// # Arguments
///
/// * `unis` - Universe 描述（提供编号，与 `buffers` 一一对应）。
/// * `buffers` - 各路缓冲。
/// * `indices` - 要输出的下标（按此顺序）；越界的下标被忽略。
///
/// # Returns
///
/// 每个有效下标一条 [`UniverseData`]。
fn pack(
    unis: &[UniDesc],
    buffers: &[Vec<u8>],
    indices: impl Iterator<Item = usize> + Clone,
) -> Vec<UniverseData> {
    let picked = move || {
        indices
            .clone()
            .filter_map(|i| Some((unis.get(i)?.universe, buffers.get(i)?.as_slice())))
    };
    let (count, total) = picked().fold((0usize, 0usize), |(n, len), (_, d)| (n + 1, len + d.len()));
    if count == 0 {
        return Vec::new();
    }
    let mut flat = Vec::with_capacity(total);
    for (_, d) in picked() {
        flat.extend_from_slice(d);
    }
    let flat = Bytes::from(flat);
    let mut out = Vec::with_capacity(count);
    let mut at = 0;
    for (universe, d) in picked() {
        let end = at + d.len();
        out.push(UniverseData {
            universe,
            data: flat.slice(at..end),
        });
        at = end;
    }
    out
}

impl<R: Read + Seek> Player<R> {
    /// 以已打开的节目创建回放器（初始为停止状态）。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的 ArtRec 节目。
    /// * `cfg` - 回放配置；其中 `speed_milli` 会被钳制到 `[MIN_SPEED_MILLI, MAX_SPEED_MILLI]`。
    ///
    /// # Returns
    ///
    /// 处于 [`PlayState::Stopped`]、位置为 0 且尚无输出历史的 [`Player`]。
    #[must_use]
    pub fn new(reader: ArtRecReader<R>, cfg: PlayerConfig) -> Self {
        let mut cfg = cfg;
        cfg.speed_milli = cfg.speed_milli.clamp(MIN_SPEED_MILLI, MAX_SPEED_MILLI);
        Self {
            reader,
            cfg,
            state: PlayState::Stopped,
            pos_us: 0,
            anchor: None,
            next_index: 0,
            buffers: None,
            spare: Vec::new(),
            raw: Vec::new(),
            changed: Vec::new(),
            last_emit_wall: 0,
            corrupt: 0,
            ended: false,
        }
    }

    /// 回到"尚未输出"状态；缓冲移入备用缓冲以便复用。
    fn clear_output(&mut self) {
        if let Some(b) = self.buffers.take() {
            self.spare = b;
        }
    }

    /// 底层读取器（概览 / 曲线分析复用）。
    ///
    /// # Returns
    ///
    /// 回放器持有的 [`ArtRecReader`] 的只读引用。
    #[must_use]
    pub fn reader(&self) -> &ArtRecReader<R> {
        &self.reader
    }

    /// 节目总时长（微秒）。
    ///
    /// # Returns
    ///
    /// 文件头记录的节目总时长，单位微秒。
    #[must_use]
    pub fn duration_us(&self) -> u64 {
        self.reader.header().total_duration_us
    }

    /// 文件内各路 Universe 编号（与 UniDesc 顺序一致）。
    ///
    /// # Returns
    ///
    /// 按 UniDesc 顺序排列的 Universe 编号列表。
    #[must_use]
    pub fn universe_ids(&self) -> Vec<u16> {
        self.reader.unis().iter().map(|u| u.universe).collect()
    }

    /// 当前输出状态（尚未输出任何帧时为 `None`）。
    ///
    /// # Returns
    ///
    /// 已有输出历史时返回各路 Universe 的当前缓冲（顺序与 UniDesc 一致）；
    /// 尚未输出任何帧（新建、`stop` 之后或 seek 到首帧之前）时返回 `None`。
    #[must_use]
    pub fn buffers(&self) -> Option<&[Vec<u8>]> {
        self.buffers.as_deref()
    }

    /// 播放状态。
    ///
    /// # Returns
    ///
    /// 当前的 [`PlayState`]。
    #[must_use]
    pub fn state(&self) -> PlayState {
        self.state
    }

    /// 墙钟 `now` 对应的节目位置（未钳制）。
    fn raw_pos(&self, now: u64) -> u64 {
        match (self.state, self.anchor) {
            (PlayState::Playing, Some((wall, pos))) => {
                let dt = u128::from(now.saturating_sub(wall));
                pos.saturating_add((dt * u128::from(self.cfg.speed_milli) / 1000) as u64)
            }
            _ => self.pos_us,
        }
    }

    /// 墙钟 `now` 对应的节目位置（钳制在时长内）。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒，单调、起点任意）。
    ///
    /// # Returns
    ///
    /// 节目位置（微秒），不超过节目总时长；非播放状态下为冻结位置。
    #[must_use]
    pub fn position(&self, now: u64) -> u64 {
        self.raw_pos(now).min(self.duration_us())
    }

    /// 节目位置 `pos` 对应的墙钟时刻（向上取整）。仅 Playing 有意义。
    fn wall_for(&self, pos: u64) -> Option<u64> {
        let (wall, anchor_pos) = self.anchor?;
        let dpos = u128::from(pos.saturating_sub(anchor_pos));
        let speed = u128::from(self.cfg.speed_milli);
        Some(wall + ((dpos * 1000).div_ceil(speed)) as u64)
    }

    /// 状态快照。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒），用于计算 `pos_us`。
    ///
    /// # Returns
    ///
    /// 面向 UI 的 [`PlayerStatus`]，其中 `pos_us` 已钳制在节目时长内。
    #[must_use]
    pub fn status(&self, now: u64) -> PlayerStatus {
        PlayerStatus {
            state: self.state,
            pos_us: self.position(now),
            duration_us: self.duration_us(),
            speed_milli: self.cfg.speed_milli,
            looping: self.cfg.looping,
            frames: self.reader.index().len(),
            corrupt_frames: self.corrupt,
        }
    }

    /// 开始或继续播放。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒），作为播放锚点。
    pub fn play(&mut self, now: u64) {
        match self.state {
            PlayState::Playing => return,
            PlayState::Stopped => {
                self.pos_us = 0;
                self.next_index = 0;
                self.clear_output();
            }
            PlayState::Paused => {}
        }
        self.state = PlayState::Playing;
        self.anchor = Some((now, self.pos_us));
        self.last_emit_wall = now;
        self.ended = false;
    }

    /// 暂停（位置冻结，保活继续）。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒），用于冻结当前位置。
    pub fn pause(&mut self, now: u64) {
        if self.state == PlayState::Playing {
            self.pos_us = self.position(now);
            self.anchor = None;
            self.state = PlayState::Paused;
        }
    }

    /// 停止并回到开头；停止后不再有任何输出。
    pub fn stop(&mut self) {
        self.state = PlayState::Stopped;
        self.pos_us = 0;
        self.anchor = None;
        self.next_index = 0;
        self.clear_output();
        self.ended = false;
    }

    /// 取走"非循环播放刚到达结尾"的一次性信号。
    ///
    /// 宿主层在每次 [`Player::poll`] 之后调用，用于实现"连播"等结尾行为。
    ///
    /// # Returns
    ///
    /// 自上次调用（或 `play` / `stop` / `seek`）以来播放自然到达结尾且未循环时为 `true`，
    /// 并清除该信号；其余情况为 `false`。循环播放永远不会产生该信号。
    pub fn take_ended(&mut self) -> bool {
        std::mem::take(&mut self.ended)
    }

    /// 设置循环。
    ///
    /// # Arguments
    ///
    /// * `looping` - `true` 表示播放到结尾后回绕循环。
    pub fn set_loop(&mut self, looping: bool) {
        self.cfg.looping = looping;
    }

    /// 设置倍速（会钳制到 `[MIN_SPEED_MILLI, MAX_SPEED_MILLI]`）；播放中无缝切换。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒），用于在切换倍速时重设播放锚点。
    /// * `speed_milli` - 新倍速（千分之一为单位，`1000` 即 1.0x）。
    pub fn set_speed(&mut self, now: u64, speed_milli: u32) {
        let pos = self.position(now);
        self.cfg.speed_milli = speed_milli.clamp(MIN_SPEED_MILLI, MAX_SPEED_MILLI);
        if self.state == PlayState::Playing {
            self.pos_us = pos;
            self.anchor = Some((now, pos));
        }
    }

    /// 跳转到 `pos_us`。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒），播放中用于重设播放锚点。
    /// * `pos_us` - 目标节目位置（微秒）；超过节目时长时钳制到时长。
    ///
    /// # Returns
    ///
    /// 该位置应有的完整输出状态（全部 Universe）；位置早于首帧时没有输出。
    pub fn seek(&mut self, now: u64, pos_us: u64) -> Vec<Emission> {
        let pos = pos_us.min(self.duration_us());
        self.ended = false;
        self.pos_us = pos;
        if self.state == PlayState::Playing {
            self.anchor = Some((now, pos));
        }
        let Some(i) = self.reader.find_index(pos) else {
            // 早于首帧：没有已知状态，回到"尚未输出"
            self.next_index = 0;
            self.clear_output();
            return Vec::new();
        };
        self.resolve_tolerant(i);
        self.next_index = i + 1;
        self.last_emit_wall = now;
        vec![Emission {
            kind: EmissionKind::Seek,
            universes: self.full_state(),
        }]
    }

    /// 当前全部 Universe 的输出状态（与保活重发的内容相同）。
    ///
    /// 宿主层在输出被丢弃后可据此补发完整状态，让输出端重新与回放同步。
    ///
    /// # Returns
    ///
    /// 按 UniDesc 顺序的全部 Universe 数据（共享同一块缓冲）；尚未输出任何帧时为空。
    #[must_use]
    pub fn full_state(&self) -> Vec<UniverseData> {
        match &self.buffers {
            Some(b) => pack(self.reader.unis(), b, 0..b.len()),
            None => Vec::new(),
        }
    }

    /// 在 `work` 上从零解析第 `i` 帧的完整状态（回溯最近全量帧再前向应用）。
    ///
    /// 语义同 [`ArtRecReader::resolve_frame`]，但复用 `work` 与读块缓冲。
    fn resolve_into(&mut self, i: usize, work: &mut Vec<Vec<u8>>) -> artrec_core::Result<()> {
        let start = self.reader.keyframe_at_or_before(i)?;
        zero_buffers_into(work, self.reader.unis());
        for k in start..=i {
            let hdr = self.reader.read_chunk_into(k, &mut self.raw)?;
            self.reader.apply_chunk_into(work, &hdr, &self.raw)?;
        }
        Ok(())
    }

    /// 把第 `i` 帧的完整状态设为当前状态；损坏时向前回退最多 32 帧，仍失败则沿用当前状态
    /// （尚无状态时为全 0）。
    fn resolve_tolerant(&mut self, i: usize) {
        let mut work = std::mem::take(&mut self.spare);
        for k in (i.saturating_sub(32)..=i).rev() {
            if self.resolve_into(k, &mut work).is_ok() {
                self.corrupt += (i - k) as u64;
                self.spare = self.buffers.replace(work).unwrap_or_default();
                return;
            }
        }
        self.corrupt += 1;
        if self.buffers.is_none() {
            zero_buffers_into(&mut work, self.reader.unis());
            self.buffers = Some(work);
        } else {
            self.spare = work;
        }
    }

    /// 把第 `to` 帧作为"当前帧"应用，返回相对上次输出发生变化的 Universe。
    fn advance_to(&mut self, to: usize) -> Vec<UniverseData> {
        let kf = self.reader.keyframe_at_or_before(to);
        let start = match kf {
            // 关键帧晚于待输出位置 → 直接从关键帧起（跳过之间被合并的帧）
            Ok(k) if k >= self.next_index => k,
            _ => self.next_index.min(to),
        };
        // 在备用缓冲上以当前状态为基准应用（损坏帧不改变它），当前状态留作比较
        let mut work = std::mem::take(&mut self.spare);
        match &self.buffers {
            Some(prev) => copy_buffers(&mut work, prev),
            None => zero_buffers_into(&mut work, self.reader.unis()),
        }
        for k in start..=to {
            match self.reader.read_chunk_into(k, &mut self.raw) {
                Ok(hdr) => {
                    if self
                        .reader
                        .apply_chunk_into(&mut work, &hdr, &self.raw)
                        .is_err()
                    {
                        self.corrupt += 1;
                    }
                }
                Err(_) => self.corrupt += 1,
            }
        }
        self.changed.clear();
        let n = self.reader.unis().len();
        match &self.buffers {
            // 尚无输出历史：全部 Universe 都视为"已变化"
            None => self.changed.extend(0..n),
            Some(prev) => self
                .changed
                .extend((0..n).filter(|&idx| prev.get(idx) != work.get(idx))),
        }
        let changed = pack(self.reader.unis(), &work, self.changed.iter().copied());
        self.spare = self.buffers.replace(work).unwrap_or_default();
        self.next_index = to + 1;
        changed
    }

    /// 输出所有时间戳 `<= target` 且尚未输出的帧（合并为最终状态）。
    fn emit_due(&mut self, target: u64, now: u64, out: &mut Vec<Emission>) {
        let due_end = self.reader.index().partition_point(|f| f.time_us <= target);
        if due_end > self.next_index {
            let changed = self.advance_to(due_end - 1);
            if !changed.is_empty() {
                self.last_emit_wall = now;
                out.push(Emission {
                    kind: EmissionKind::Change,
                    universes: changed,
                });
            }
        }
    }

    /// 推进到墙钟 `now`：输出到期的帧，处理循环 / 结束，并在需要时发出保活。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒，须与其它调用使用同一时钟）。
    ///
    /// # Returns
    ///
    /// 本次需要发出的 [`Emission`] 列表（到期帧变更与保活）；没有任何输出时为空。
    pub fn poll(&mut self, now: u64) -> Vec<Emission> {
        let mut out = Vec::new();
        if self.state == PlayState::Playing {
            let dur = self.duration_us();
            let pos = self.raw_pos(now);
            self.emit_due(pos.min(dur), now, &mut out);
            if pos >= dur {
                if self.cfg.looping && dur > 0 {
                    // 直接跳到所在循环周期的起点，落后多个周期时无需逐圈补算
                    let cycles = pos / dur;
                    let wall_start = self.wall_for(cycles * dur).unwrap_or(now);
                    self.anchor = Some((wall_start, 0));
                    self.pos_us = 0;
                    self.next_index = 0;
                    let pos2 = self.raw_pos(now);
                    self.emit_due(pos2.min(dur), now, &mut out);
                } else {
                    self.state = PlayState::Stopped;
                    self.pos_us = dur;
                    self.anchor = None;
                    self.ended = true;
                }
            }
        }
        if matches!(self.state, PlayState::Playing | PlayState::Paused)
            && self.cfg.keepalive_us > 0
            && self.buffers.is_some()
            && now.saturating_sub(self.last_emit_wall) >= self.cfg.keepalive_us
        {
            out.push(Emission {
                kind: EmissionKind::Keepalive,
                universes: self.full_state(),
            });
            self.last_emit_wall = now;
        }
        out
    }

    /// 下次需要调用 [`Player::poll`] 的墙钟时刻；已停止返回 `None`。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前墙钟时刻（微秒），返回值不会早于它。
    ///
    /// # Returns
    ///
    /// 下一帧到期时刻与下次保活时刻中较早者（不早于 `now`）；已停止，
    /// 或暂停且无保活可发（保活关闭或尚无输出）时返回 `None`。
    #[must_use]
    pub fn next_deadline(&self, now: u64) -> Option<u64> {
        let keepalive = (self.cfg.keepalive_us > 0 && self.buffers.is_some())
            .then(|| self.last_emit_wall + self.cfg.keepalive_us);
        let frame = match self.state {
            PlayState::Stopped => return None,
            PlayState::Paused => None,
            PlayState::Playing => {
                let next_frame = self
                    .reader
                    .index()
                    .get(self.next_index)
                    .map(|f| f.time_us.min(self.duration_us()));
                let target = next_frame.unwrap_or_else(|| self.duration_us());
                self.wall_for(target)
            }
        };
        [frame, keepalive]
            .into_iter()
            .flatten()
            .min()
            .map(|t| t.max(now))
    }
}

#[cfg(test)]
mod tests {
    use artrec_core::CompressAlgo;

    use super::{EmissionKind, PlayState, Player, PlayerConfig, DEFAULT_KEEPALIVE_US};
    use crate::walker::testkit::{build_diff, build_full, open};

    /// 三个 Universe：0@0ms、1@100ms、0@250ms，总长 1s。
    fn sample() -> Player<std::io::Cursor<Vec<u8>>> {
        let bytes = build_full(
            2,
            &[
                (0, vec![(0, 0, 10)]),
                (100_000, vec![(1, 5, 50)]),
                (250_000, vec![(0, 0, 99)]),
            ],
            1_000_000,
            CompressAlgo::Zstd,
        );
        Player::new(open(bytes), PlayerConfig::default())
    }

    fn kinds(e: &[super::Emission]) -> Vec<EmissionKind> {
        e.iter().map(|x| x.kind).collect()
    }

    #[test]
    fn plays_frames_at_their_times_and_emits_only_changed_universes() {
        let mut p = sample();
        p.play(1_000);
        // 首帧：尚无输出历史 → 两路 Universe 都输出
        let e = p.poll(1_000);
        assert_eq!(kinds(&e), vec![EmissionKind::Change]);
        assert_eq!(e[0].universes.len(), 2);
        assert_eq!(e[0].universes[0].data[0], 10);

        assert!(p.poll(1_000 + 99_999).is_empty(), "未到 100ms 不应输出");
        let e = p.poll(1_000 + 100_000);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].universes.len(), 1, "只有 Universe 1 变化");
        assert_eq!(e[0].universes[0].universe, 1);
        assert_eq!(e[0].universes[0].data[5], 50);
    }

    #[test]
    fn behind_schedule_frames_are_coalesced() {
        let mut p = sample();
        p.play(0);
        p.poll(0);
        // 一次性落后到 300ms：100ms 与 250ms 两帧合并为一次输出
        let e = p.poll(300_000);
        assert_eq!(e.len(), 1);
        let by_u: Vec<(u16, u8, u8)> = e[0]
            .universes
            .iter()
            .map(|u| (u.universe, u.data[0], u.data[5]))
            .collect();
        assert_eq!(by_u, vec![(0, 99, 0), (1, 0, 50)]);
    }

    #[test]
    fn pause_freezes_position_and_resume_continues() {
        let mut p = sample();
        p.play(0);
        p.poll(0);
        p.pause(50_000);
        assert_eq!(p.state(), PlayState::Paused);
        assert_eq!(p.position(10_000_000), 50_000, "暂停后位置不应随时间前进");
        assert!(p.poll(200_000).is_empty());

        p.play(1_000_000); // 在墙钟 1s 处继续，位置仍是 50ms
        assert!(p.poll(1_000_000 + 49_999).is_empty());
        let e = p.poll(1_000_000 + 50_000);
        assert_eq!(
            e[0].universes[0].universe, 1,
            "100ms 的帧在继续后 50ms 到期"
        );
    }

    #[test]
    fn seek_emits_full_state_at_that_time() {
        let mut p = sample();
        p.play(0);
        let e = p.seek(0, 260_000);
        assert_eq!(kinds(&e), vec![EmissionKind::Seek]);
        let u = &e[0].universes;
        assert_eq!(u.len(), 2, "seek 输出全部 Universe");
        assert_eq!((u[0].data[0], u[1].data[5]), (99, 50));
        // seek 之后不会重复输出已过去的帧
        assert!(p.poll(0).is_empty());
        // 后退到 120ms：Universe 0 应回到 10
        let e = p.seek(0, 120_000);
        assert_eq!(
            (e[0].universes[0].data[0], e[0].universes[1].data[5]),
            (10, 50)
        );
    }

    #[test]
    fn seek_before_first_frame_outputs_nothing() {
        let bytes = build_full(
            1,
            &[(500_000, vec![(0, 0, 1)])],
            1_000_000,
            CompressAlgo::None,
        );
        let mut p = Player::new(open(bytes), PlayerConfig::default());
        p.play(0);
        assert!(p.seek(0, 100_000).is_empty());
        assert!(p.poll(100_000).is_empty());
        let e = p.poll(500_000);
        assert_eq!(e[0].universes[0].data[0], 1);
    }

    #[test]
    fn speed_scales_timeline() {
        let mut p = sample();
        p.set_speed(0, 2000);
        p.play(0);
        p.poll(0);
        assert!(p.poll(49_999).is_empty());
        let e = p.poll(50_000); // 2x：100ms 的帧在墙钟 50ms 到期
        assert_eq!(e[0].universes[0].universe, 1);
        assert_eq!(p.position(50_000), 100_000);
        // 播放中切换到 0.5x：位置连续
        p.set_speed(50_000, 500);
        assert_eq!(p.position(50_000), 100_000);
        assert_eq!(p.position(150_000), 150_000);
    }

    #[test]
    fn stops_at_end_without_loop() {
        let mut p = sample();
        p.play(0);
        p.poll(0);
        p.poll(250_000);
        let e = p.poll(2_000_000);
        assert!(e.is_empty());
        assert_eq!(p.state(), PlayState::Stopped);
        assert!(p.next_deadline(2_000_000).is_none());
    }

    #[test]
    fn reaching_the_end_signals_ended_exactly_once() {
        let mut p = sample();
        p.play(0);
        p.poll(0);
        assert!(!p.take_ended(), "未到结尾不应有信号");
        p.poll(1_000_000);
        assert_eq!(p.state(), PlayState::Stopped);
        assert!(p.take_ended(), "自然播完应给出信号");
        assert!(!p.take_ended(), "信号只取一次");
    }

    #[test]
    fn looping_never_signals_ended() {
        let mut p = sample();
        p.set_loop(true);
        p.play(0);
        p.poll(0);
        p.poll(1_000_000);
        p.poll(5_500_000);
        assert!(!p.take_ended());
    }

    #[test]
    fn seek_play_and_stop_clear_a_pending_ended_signal() {
        let mut p = sample();
        p.play(0);
        p.poll(1_000_000);
        p.seek(1_000_001, 0);
        assert!(!p.take_ended(), "seek 应清除未取走的结尾信号");

        p.play(2_000_000);
        p.poll(3_000_000);
        p.stop();
        assert!(!p.take_ended(), "stop 应清除未取走的结尾信号");

        p.play(4_000_000);
        p.poll(5_000_000);
        p.play(5_000_001); // 已停止状态下再次 play：从头开始并清除信号
        assert!(!p.take_ended());
    }

    #[test]
    fn loop_wraps_and_replays_first_frame() {
        let mut p = sample();
        p.set_loop(true);
        p.play(0);
        p.poll(0);
        p.poll(250_000);
        // 1s 时回绕，首帧（Universe0=10）应再次输出
        let e = p.poll(1_000_000);
        assert_eq!(p.state(), PlayState::Playing);
        let flat: Vec<(u16, u8)> = e
            .iter()
            .flat_map(|x| x.universes.iter().map(|u| (u.universe, u.data[0])))
            .collect();
        assert!(flat.contains(&(0, 10)), "{flat:?}");
        assert!(p.position(1_000_000) < 1_000);
    }

    #[test]
    fn loop_far_behind_does_not_spin() {
        let mut p = sample();
        p.set_loop(true);
        p.play(0);
        // 一次性落后 1000 个周期
        let _ = p.poll(1_000_000_000);
        assert_eq!(p.state(), PlayState::Playing);
        assert!(p.position(1_000_000_000) <= 1_000_000);
    }

    #[test]
    fn keepalive_resends_state_during_quiet_playback() {
        // 只有一帧、总长 10s：变更触发录制的典型静止段
        let bytes = build_full(1, &[(0, vec![(0, 0, 42)])], 10_000_000, CompressAlgo::None);
        let mut p = Player::new(open(bytes), PlayerConfig::default());
        p.play(0);
        assert_eq!(kinds(&p.poll(0)), vec![EmissionKind::Change]);
        assert!(p.poll(DEFAULT_KEEPALIVE_US - 1).is_empty());
        let e = p.poll(DEFAULT_KEEPALIVE_US);
        assert_eq!(kinds(&e), vec![EmissionKind::Keepalive]);
        assert_eq!(e[0].universes[0].data[0], 42);
        assert!(
            p.poll(DEFAULT_KEEPALIVE_US + 1).is_empty(),
            "保活后重新计时"
        );
        assert_eq!(
            kinds(&p.poll(2 * DEFAULT_KEEPALIVE_US)),
            vec![EmissionKind::Keepalive]
        );
    }

    #[test]
    fn keepalive_continues_while_paused() {
        let mut p = sample();
        p.set_loop(true);
        p.play(0);
        p.poll(0);
        p.pause(10_000);
        assert!(p.poll(500_000).is_empty());
        let e = p.poll(DEFAULT_KEEPALIVE_US);
        assert_eq!(kinds(&e), vec![EmissionKind::Keepalive]);
        assert_eq!(e[0].universes.len(), 2);
        // 保活后重新计时
        assert!(p.poll(DEFAULT_KEEPALIVE_US + 500_000).is_empty());
        assert_eq!(
            kinds(&p.poll(2 * DEFAULT_KEEPALIVE_US)),
            vec![EmissionKind::Keepalive]
        );
    }

    #[test]
    fn keepalive_disabled_when_zero() {
        let bytes = build_full(1, &[(0, vec![(0, 0, 1)])], 10_000_000, CompressAlgo::None);
        let mut p = Player::new(
            open(bytes),
            PlayerConfig {
                keepalive_us: 0,
                ..PlayerConfig::default()
            },
        );
        p.play(0);
        p.poll(0);
        assert!(p.poll(5_000_000).is_empty());
    }

    #[test]
    fn next_deadline_points_at_next_frame_or_keepalive() {
        let mut p = sample();
        assert_eq!(p.next_deadline(0), None);
        p.play(0);
        assert_eq!(p.next_deadline(0), Some(0)); // 首帧立即到期
        p.poll(0);
        assert_eq!(p.next_deadline(0), Some(100_000));
        p.poll(100_000);
        p.poll(250_000);
        // 帧已播完 → 下一个事件是结束（1s）或保活（250ms+1s），取较早者
        assert_eq!(p.next_deadline(250_000), Some(1_000_000));
        p.pause(300_000);
        assert_eq!(p.next_deadline(300_000), Some(1_250_000), "暂停时只剩保活");
    }

    #[test]
    fn diff_encoded_file_plays_identically() {
        let frames = vec![
            (0u64, vec![(0usize, 1usize, 1u8)]),
            (10_000, vec![(0, 2, 2)]),
            (20_000, vec![(0, 3, 3)]),
        ];
        let mut p = Player::new(
            open(build_diff(1, &frames, 20_000)),
            PlayerConfig::default(),
        );
        p.play(0);
        p.poll(0);
        p.poll(10_000);
        let e = p.poll(20_000);
        let d = &e[0].universes[0].data;
        assert_eq!((d[1], d[2], d[3]), (1, 2, 3));
        // seek 到中间也能由关键帧 + 差分正确重建
        let e = p.seek(20_000, 10_000);
        let d = &e[0].universes[0].data;
        assert_eq!((d[1], d[2], d[3]), (1, 2, 0));
    }

    #[test]
    fn corrupted_frame_keeps_previous_state_and_counts() {
        let bytes = build_full(
            1,
            &[
                (0, vec![(0, 0, 5)]),
                (10_000, vec![(0, 0, 6)]),
                (20_000, vec![(0, 0, 7)]),
            ],
            20_000,
            CompressAlgo::None,
        );
        let r = open(bytes.clone());
        let pool = r.header().chunk_pool_offset as usize;
        let second = pool + r.index()[1].chunk_pos as usize + artrec_core::CHUNKHDR_SIZE;
        let mut bad = bytes;
        bad[second] ^= 0xFF;
        let mut p = Player::new(open(bad), PlayerConfig::default());
        p.play(0);
        p.poll(0);
        let e = p.poll(10_000); // 第二帧损坏：状态不变 → 无输出
        assert!(e.is_empty());
        assert_eq!(p.status(10_000).corrupt_frames, 1);
        let e = p.poll(20_000);
        assert_eq!(e[0].universes[0].data[0], 7);
    }

    /// seek 到损坏帧：向前回退到最近可解析的帧，并计入损坏数；之后的推进不受影响。
    #[test]
    fn seek_onto_a_corrupted_frame_falls_back_to_an_earlier_one() {
        let bytes = build_full(
            1,
            &[
                (0, vec![(0, 0, 5)]),
                (10_000, vec![(0, 0, 6)]),
                (20_000, vec![(0, 0, 7)]),
            ],
            30_000,
            CompressAlgo::None,
        );
        let r = open(bytes.clone());
        let pool = r.header().chunk_pool_offset as usize;
        let second = pool + r.index()[1].chunk_pos as usize + artrec_core::CHUNKHDR_SIZE;
        let mut bad = bytes;
        bad[second] ^= 0xFF;
        let mut p = Player::new(open(bad), PlayerConfig::default());
        p.play(0);
        let e = p.seek(0, 15_000);
        assert_eq!(
            e[0].universes[0].data[0], 5,
            "第二帧损坏：回退到第一帧的状态"
        );
        assert_eq!(p.status(0).corrupt_frames, 1);
        let e = p.poll(20_000);
        assert_eq!(e[0].universes[0].data[0], 7);
    }

    /// 一次输出的各路数据共享同一块缓冲（每路是切片），`full_state` 与保活内容一致。
    #[test]
    fn emissions_share_one_buffer_and_full_state_matches_keepalive() {
        // 两路、只有一帧：首帧之后只剩保活
        let bytes = build_full(
            2,
            &[(0, vec![(0, 0, 10), (1, 5, 50)])],
            10_000_000,
            CompressAlgo::None,
        );
        let mut p = Player::new(open(bytes), PlayerConfig::default());
        assert!(p.full_state().is_empty(), "尚未输出时没有状态");
        p.play(0);
        let e = p.poll(0);
        let u = &e[0].universes;
        assert_eq!(u.len(), 2);
        assert_eq!(u[0].data.len(), 512);
        // 两路切片在同一块内存里首尾相接
        assert_eq!(u[0].data.as_ptr().wrapping_add(512), u[1].data.as_ptr());

        let state = p.full_state();
        assert_eq!(state, *u, "首帧之后的完整状态即首帧输出");
        let keep = p.poll(DEFAULT_KEEPALIVE_US);
        assert_eq!(kinds(&keep), vec![EmissionKind::Keepalive]);
        assert_eq!(keep[0].universes, state);

        p.stop();
        assert!(p.full_state().is_empty(), "停止后回到尚未输出");
        // 停止后从头播放：缓冲被复用，首帧照常输出全部 Universe
        p.play(5_000_000);
        assert_eq!(p.poll(5_000_000)[0].universes.len(), 2);
    }

    #[test]
    fn status_reports_clamped_position_and_flags() {
        let mut p = sample();
        p.set_loop(true);
        let s = p.status(0);
        assert_eq!(
            (s.state, s.pos_us, s.duration_us, s.frames),
            (PlayState::Stopped, 0, 1_000_000, 3)
        );
        assert!(s.looping);
        p.play(0);
        assert_eq!(p.status(5_000_000).pos_us, 1_000_000, "位置不超过时长");
    }
}
