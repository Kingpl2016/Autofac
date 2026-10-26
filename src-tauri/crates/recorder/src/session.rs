//! 录制会话：过滤 → 录制专用合并引擎 → 变更检测 → ArtRec 写入。
//!
//! 会话是纯逻辑、与时钟解耦：所有时间戳由调用方以"相对录制起点的微秒"传入，
//! 便于确定性测试；宿主层负责在 socket 接收点取单调时间并周期性调用 [`RecorderSession::tick`]。

use std::collections::{BTreeSet, HashSet};
use std::io::{Seek, Write};
use std::net::IpAddr;

use artnet_net::{DmxFrame, Protocol};
use artrec_core::{ArtRecWriter, Result, UniDesc, MAX_FULL_PAYLOAD, MAX_UNIVERSE};
use serde::Serialize;
use signal_engine::{MergeMode, SignalEngine};

use crate::encoder::{Encoded, EncoderConfig, FrameEncoder};
use crate::filter::RecordFilter;

/// 每路 Universe 在文件中的 DMX 通道数（标准 512，短帧补零）。
pub const DMX_LEN: u16 = 512;

/// 单文件最多容纳的 Universe 数（受单帧全量 Payload ≤ [`MAX_FULL_PAYLOAD`] 限制）。
pub const MAX_UNIVERSES_PER_FILE: usize = MAX_FULL_PAYLOAD / DMX_LEN as usize;

/// Universe 集合规划结果。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniversePlan {
    /// 将被录制的 Universe（升序，与文件内 UniDesc 顺序一致）。
    pub accepted: Vec<u16>,
    /// 超出 ArtRec 可表示范围（> 2047）而被拒绝的 Universe。
    pub rejected_out_of_range: Vec<u16>,
    /// 超出单文件容量（> 127 路）而被拒绝的 Universe。
    pub rejected_over_capacity: Vec<u16>,
}

/// 把候选 Universe 规划为可录制集合：去重、升序、剔除越界并按容量截断。
///
/// # Arguments
///
/// * `candidates` - 候选 Universe（可重复、无序）。
///
/// # Returns
///
/// 规划结果，调用方应把被拒绝的 Universe 提示给用户。
#[must_use]
pub fn plan_universes(candidates: impl IntoIterator<Item = u16>) -> UniversePlan {
    let set: BTreeSet<u16> = candidates.into_iter().collect();
    let mut plan = UniversePlan::default();
    for u in set {
        if u > MAX_UNIVERSE {
            plan.rejected_out_of_range.push(u);
        } else if plan.accepted.len() >= MAX_UNIVERSES_PER_FILE {
            plan.rejected_over_capacity.push(u);
        } else {
            plan.accepted.push(u);
        }
    }
    plan
}

/// 会话配置。
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// 过滤条件。
    pub filter: RecordFilter,
    /// 录制的 Universe 集合（应来自 [`plan_universes`]，升序）。
    pub universes: Vec<u16>,
    /// 同一 Universe 多源合并模式。
    pub merge_mode: MergeMode,
    /// 帧编码配置。
    pub encoder: EncoderConfig,
    /// 录制开始的 Unix 时间戳（微秒，写入文件头仅作日志）。
    pub rec_start_unix_us: u64,
}

/// 会话实时统计。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// 已写帧数。
    pub frames: u64,
    /// 其中全量帧数。
    pub full_frames: u64,
    /// 其中差分帧数。
    pub diff_frames: u64,
    /// 当前文件占用字节（不含收尾时才写出的索引表）。
    pub bytes: u64,
    /// 最后一帧时间戳（微秒）。
    pub duration_us: u64,
    /// 通过过滤并进入录制的包数。
    pub accepted_packets: u64,
    /// 被过滤条件拒绝的包数。
    pub filtered_packets: u64,
    /// 通过过滤但 Universe 不在固定集合内而被忽略的包数。
    pub ignored_packets: u64,
    /// 被忽略的不同 Universe 个数。
    pub ignored_universes: usize,
    /// 观测到的最长关键帧链（seek 最坏回溯帧数）。
    pub max_chain: u32,
}

/// 录制会话。
pub struct RecorderSession<W: Write + Seek> {
    w: ArtRecWriter<W>,
    enc: FrameEncoder,
    engine: SignalEngine,
    filter: RecordFilter,
    universes: Vec<u16>,
    /// 复用的各路快照缓冲（与 `universes` 等长、每路 [`DMX_LEN`] 字节），`tick` 时原地覆盖。
    snap: Vec<Vec<u8>>,
    member: HashSet<u16>,
    dirty: bool,
    last_change_us: u64,
    accepted: u64,
    filtered: u64,
    ignored: u64,
    ignored_set: BTreeSet<u16>,
    sources_seen: BTreeSet<IpAddr>,
    seen_artnet: bool,
    seen_sacn: bool,
}

impl<W: Write + Seek> RecorderSession<W> {
    /// 创建会话并写出文件头与 Universe 描述表。
    ///
    /// # Arguments
    ///
    /// * `sink` - 目标写入流（文件或内存 `Cursor`）。
    /// * `cfg` - 会话配置。
    /// * `source_timeout_ms` - 合并引擎的源超时（毫秒，录制端不主动 prune，仅透传构造）。
    ///
    /// # Returns
    ///
    /// 已写出文件头与 Universe 描述表、尚未写任何帧的新会话。
    ///
    /// # Errors
    ///
    /// Universe 越界、重复或总量过大时返回对应 [`artrec_core::ArtRecError`]。
    pub fn new(sink: W, cfg: SessionConfig, source_timeout_ms: u64) -> Result<Self> {
        let unis = cfg
            .universes
            .iter()
            .map(|&u| UniDesc::from_universe(u, DMX_LEN))
            .collect::<Result<Vec<_>>>()?;
        let w = ArtRecWriter::new(
            sink,
            unis,
            cfg.encoder.algo,
            cfg.encoder.level,
            cfg.encoder.file_flags(),
            cfg.rec_start_unix_us,
        )?;
        Ok(Self {
            w,
            enc: FrameEncoder::new(cfg.encoder),
            engine: SignalEngine::new(cfg.merge_mode, source_timeout_ms),
            filter: cfg.filter,
            member: cfg.universes.iter().copied().collect(),
            snap: vec![vec![0u8; DMX_LEN as usize]; cfg.universes.len()],
            universes: cfg.universes,
            dirty: false,
            last_change_us: 0,
            accepted: 0,
            filtered: 0,
            ignored: 0,
            ignored_set: BTreeSet::new(),
            sources_seen: BTreeSet::new(),
            seen_artnet: false,
            seen_sacn: false,
        })
    }

    /// 摄入一帧：不通过过滤的计入 `filtered`，集合外 Universe 计入 `ignored`。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收到的帧。
    /// * `t_us` - 该帧到达时刻（相对录制起点，微秒）。
    pub fn ingest(&mut self, frame: &DmxFrame, t_us: u64) {
        if !self.filter.matches(frame) {
            self.filtered += 1;
            return;
        }
        if !self.member.contains(&frame.universe) {
            self.ignored += 1;
            self.ignored_set.insert(frame.universe);
            return;
        }
        self.engine.ingest(frame, t_us / 1000);
        self.sources_seen
            .insert(frame.source.unwrap_or_else(signal_engine::unknown_source));
        match frame.protocol {
            Protocol::ArtNet => self.seen_artnet = true,
            Protocol::Sacn => self.seen_sacn = true,
        }
        self.accepted += 1;
        self.dirty = true;
        self.last_change_us = self.last_change_us.max(t_us);
    }

    /// 把当前各路合并输出按 UniDesc 顺序写入复用的快照缓冲，补零/截断到 [`DMX_LEN`]（零分配）。
    ///
    /// 结果与"`merged_output(u).unwrap_or_default()` 后 `resize(DMX_LEN, 0)`"逐字节一致：
    /// 合并宽度之外的通道清零，Universe 不存在时整路清零。
    fn refresh_snapshot(&mut self) {
        for (&u, buf) in self.universes.iter().zip(self.snap.iter_mut()) {
            let n = self.engine.merged_into(u, buf).unwrap_or(0);
            buf[n..].fill(0);
        }
    }

    /// 周期性调用：若自上次以来有新数据，则做变更检测并按需写帧。
    ///
    /// # Returns
    ///
    /// 写入了帧则返回 [`Encoded`]（宿主层可据此追加崩溃恢复日志），否则 `None`。
    ///
    /// # Errors
    ///
    /// 写入失败返回对应 [`artrec_core::ArtRecError`]。
    pub fn tick(&mut self) -> Result<Option<Encoded>> {
        if !self.dirty {
            return Ok(None);
        }
        self.dirty = false;
        self.refresh_snapshot();
        let t = self
            .w
            .last_time_us()
            .map_or(self.last_change_us, |l| l.max(self.last_change_us));
        self.enc.encode(&mut self.w, t, &self.snap)
    }

    /// 刷新底层缓冲，使已写 Chunk 落到操作系统。
    ///
    /// # Errors
    ///
    /// 刷新失败返回 [`artrec_core::ArtRecError::Io`]。
    pub fn flush(&mut self) -> Result<()> {
        self.w.flush()
    }

    /// 底层写入流的只读引用（宿主层据此对文件做 `sync_data`）。
    ///
    /// # Returns
    ///
    /// 会话持有的底层写入流 `W` 的只读引用。
    #[must_use]
    pub fn sink(&self) -> &W {
        self.w.get_ref()
    }

    /// 放弃会话并取回底层流，不补写索引与头部（取消录制 / 崩溃模拟用）。
    ///
    /// # Returns
    ///
    /// 会话持有的底层写入流 `W`，其内容停留在放弃时刻的状态。
    #[must_use]
    pub fn abandon(self) -> W {
        self.w.into_inner()
    }

    /// 已被接受进入录制的来源 IP 集合（升序）。
    ///
    /// # Returns
    ///
    /// 升序排列的来源 IP 列表；未知来源以 `0.0.0.0` 计入。
    #[must_use]
    pub fn sources_seen(&self) -> Vec<IpAddr> {
        self.sources_seen.iter().copied().collect()
    }

    /// 已被接受进入录制的协议集合。
    ///
    /// # Returns
    ///
    /// 已见过的协议列表，顺序固定为 Art-Net 在前、sACN 在后；尚无数据时为空。
    #[must_use]
    pub fn protocols_seen(&self) -> Vec<Protocol> {
        let mut v = Vec::new();
        if self.seen_artnet {
            v.push(Protocol::ArtNet);
        }
        if self.seen_sacn {
            v.push(Protocol::Sacn);
        }
        v
    }

    /// 实时统计快照。
    ///
    /// # Returns
    ///
    /// 当前时刻的 [`SessionStats`]（帧数、字节数、包计数等）。
    #[must_use]
    pub fn stats(&self) -> SessionStats {
        SessionStats {
            frames: self.w.frame_count() as u64,
            full_frames: self.enc.full_frames(),
            diff_frames: self.enc.diff_frames(),
            bytes: self.w.bytes_written(),
            duration_us: self.w.last_time_us().unwrap_or(0),
            accepted_packets: self.accepted,
            filtered_packets: self.filtered,
            ignored_packets: self.ignored,
            ignored_universes: self.ignored_set.len(),
            max_chain: self.enc.max_chain(),
        }
    }

    /// 被忽略的 Universe 集合（升序）。
    ///
    /// # Returns
    ///
    /// 通过过滤但不在固定集合内、因此被忽略的 Universe 列表（升序、去重）。
    #[must_use]
    pub fn ignored_universes(&self) -> Vec<u16> {
        self.ignored_set.iter().copied().collect()
    }

    /// 结束录制：冲刷待写变更、补收尾帧、写索引并回填头部。
    ///
    /// # Arguments
    ///
    /// * `total_us` - 录制总时长（相对起点，微秒）；不会小于最后一帧时间戳。
    ///
    /// # Returns
    ///
    /// `(底层流, 最终统计)`。
    ///
    /// # Errors
    ///
    /// 写入失败返回对应 [`artrec_core::ArtRecError`]。
    pub fn finish(mut self, total_us: u64) -> Result<(W, SessionStats)> {
        self.tick()?;
        let total = total_us.max(self.w.last_time_us().unwrap_or(0));
        self.enc.encode_tail(&mut self.w, total)?;
        let mut stats = self.stats();
        stats.duration_us = total;
        let sink = self.w.finish(total)?;
        Ok((sink, stats))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::net::{IpAddr, Ipv4Addr};

    use artnet_net::{Bytes, DmxFrame, Protocol};
    use artrec_core::ArtRecReader;
    use signal_engine::MergeMode;

    use super::{plan_universes, RecorderSession, SessionConfig, MAX_UNIVERSES_PER_FILE};
    use crate::encoder::EncoderConfig;
    use crate::filter::RecordFilter;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, last))
    }

    fn frame(universe: u16, src: u8, data: &[u8]) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: Bytes::copy_from_slice(data),
            source: Some(ip(src)),
            sequence: 0,
            received_at: std::time::Instant::now(),
        }
    }

    fn session(filter: RecordFilter, universes: Vec<u16>) -> RecorderSession<Cursor<Vec<u8>>> {
        session_with(filter, universes, EncoderConfig::default())
    }

    fn session_with(
        filter: RecordFilter,
        universes: Vec<u16>,
        encoder: EncoderConfig,
    ) -> RecorderSession<Cursor<Vec<u8>>> {
        RecorderSession::new(
            Cursor::new(Vec::new()),
            SessionConfig {
                filter,
                universes,
                merge_mode: MergeMode::Htp,
                encoder,
                rec_start_unix_us: 0,
            },
            2500,
        )
        .unwrap()
    }

    #[test]
    fn plan_dedups_sorts_and_limits() {
        let p = plan_universes([5, 1, 5, 3000, 2]);
        assert_eq!(p.accepted, vec![1, 2, 5]);
        assert_eq!(p.rejected_out_of_range, vec![3000]);
        assert!(p.rejected_over_capacity.is_empty());

        let many = plan_universes(0..200u16);
        assert_eq!(many.accepted.len(), MAX_UNIVERSES_PER_FILE);
        assert_eq!(
            many.rejected_over_capacity.len(),
            200 - MAX_UNIVERSES_PER_FILE
        );
    }

    #[test]
    fn static_signal_writes_single_frame_plus_tail() {
        let mut s = session(RecordFilter::default(), vec![1]);
        for i in 0..50u64 {
            s.ingest(&frame(1, 1, &[10, 20, 30]), i * 23_000);
            s.tick().unwrap();
        }
        let (cur, stats) = s.finish(2_000_000).unwrap();
        // 首帧 + 收尾帧
        assert_eq!(stats.frames, 2);
        assert_eq!(stats.duration_us, 2_000_000);
        let r = ArtRecReader::open(cur.into_inner()).unwrap();
        assert_eq!(r.header().total_duration_us, 2_000_000);
        assert_eq!(r.index().last().unwrap().time_us, 2_000_000);
        let f = r.frame_at(1_000_000).unwrap().unwrap();
        assert_eq!(&f[0][..4], &[10, 20, 30, 0]);
        assert_eq!(f[0].len(), 512);
    }

    #[test]
    fn source_filter_excludes_other_devices() {
        let filter = RecordFilter {
            sources: vec![ip(1)],
            ..RecordFilter::default()
        };
        let mut s = session(filter, vec![1]);
        s.ingest(&frame(1, 1, &[100]), 1000);
        s.ingest(&frame(1, 2, &[200]), 2000); // 被过滤
        s.tick().unwrap();
        let (cur, stats) = s.finish(10_000).unwrap();
        assert_eq!(stats.accepted_packets, 1);
        assert_eq!(stats.filtered_packets, 1);
        let r = ArtRecReader::open(cur.into_inner()).unwrap();
        assert_eq!(r.frame_at(5000).unwrap().unwrap()[0][0], 100);
    }

    #[test]
    fn two_selected_sources_merge_htp() {
        let mut s = session(RecordFilter::default(), vec![1]);
        s.ingest(&frame(1, 1, &[10, 200, 0]), 1000);
        s.ingest(&frame(1, 2, &[50, 100, 5]), 1500);
        s.tick().unwrap();
        let (cur, _) = s.finish(5000).unwrap();
        let r = ArtRecReader::open(cur.into_inner()).unwrap();
        assert_eq!(&r.frame_at(2000).unwrap().unwrap()[0][..3], &[50, 200, 5]);
    }

    #[test]
    fn universes_outside_fixed_set_are_ignored_and_counted() {
        let mut s = session(RecordFilter::default(), vec![1]);
        s.ingest(&frame(1, 1, &[1]), 0);
        s.ingest(&frame(7, 1, &[1]), 10);
        s.ingest(&frame(7, 1, &[2]), 20);
        s.ingest(&frame(9, 1, &[1]), 30);
        s.tick().unwrap();
        let st = s.stats();
        assert_eq!(st.ignored_packets, 3);
        assert_eq!(st.ignored_universes, 2);
        assert_eq!(s.ignored_universes(), vec![7, 9]);
    }

    #[test]
    fn changing_signal_roundtrips_each_change() {
        let diff = EncoderConfig {
            allow_diff: true,
            ..EncoderConfig::default()
        };
        let mut s = session_with(RecordFilter::default(), vec![0, 1], diff);
        let mut expect = Vec::new();
        for i in 0..100u64 {
            let t = i * 22_000;
            s.ingest(&frame(0, 1, &[(i % 256) as u8, 0, 5]), t);
            s.ingest(&frame(1, 1, &[0, (i / 2) as u8]), t);
            if let Some(e) = s.tick().unwrap() {
                expect.push((e.index.time_us, i));
            }
        }
        let (cur, stats) = s.finish(2_300_000).unwrap();
        assert!(stats.diff_frames > 0, "应出现差分帧");
        assert!(stats.max_chain <= 50, "关键帧间隔 1s / 22ms ≈ 46");
        let r = ArtRecReader::open(cur.into_inner()).unwrap();
        for (t, i) in expect {
            let f = r.frame_at(t).unwrap().unwrap();
            assert_eq!(f[0][0], (i % 256) as u8);
            assert_eq!(f[1][1], (i / 2) as u8);
        }
    }

    #[test]
    fn default_encoder_records_full_frames_only_and_roundtrips() {
        let mut s = session(RecordFilter::default(), vec![0]);
        let mut expect = Vec::new();
        for i in 0..60u64 {
            s.ingest(&frame(0, 1, &[(i % 5) as u8 * 40, i as u8]), i * 22_000);
            if let Some(e) = s.tick().unwrap() {
                expect.push((e.index.time_us, i));
            }
        }
        let (cur, stats) = s.finish(1_400_000).unwrap();
        assert_eq!(stats.diff_frames, 0);
        assert_eq!(stats.max_chain, 1);
        let r = ArtRecReader::open(cur.into_inner()).unwrap();
        assert_eq!(
            r.header().flags,
            0,
            "默认不置 ALLOW_DIFF_FRAME，保证固件兼容"
        );
        for (t, i) in expect {
            let f = r.frame_at(t).unwrap().unwrap();
            assert_eq!(f[0][0], (i % 5) as u8 * 40);
            assert_eq!(f[0][1], i as u8);
        }
    }

    #[test]
    fn finish_with_no_data_yields_empty_valid_file() {
        let s = session(RecordFilter::default(), vec![1]);
        let (cur, stats) = s.finish(1000).unwrap();
        assert_eq!(stats.frames, 0);
        let r = ArtRecReader::open(cur.into_inner()).unwrap();
        assert_eq!(r.header().frame_count, 0);
    }

    // ---- 与改动前实现的逐字节对照 ----

    use artrec_core::{ArtRecWriter, UniDesc};
    use signal_engine::SignalEngine;

    use super::DMX_LEN;
    use crate::encoder::legacy::{LegacyEncoder, Rng};
    use crate::encoder::Encoded;

    /// 改动前的会话 tick 路径：`merged_output` 分配快照 + 旧编码器。
    struct LegacySession {
        w: ArtRecWriter<Cursor<Vec<u8>>>,
        enc: LegacyEncoder,
        engine: SignalEngine,
        filter: RecordFilter,
        universes: Vec<u16>,
        dirty: bool,
        last_change_us: u64,
    }

    impl LegacySession {
        fn new(cfg: &SessionConfig, source_timeout_ms: u64) -> Self {
            let unis = cfg
                .universes
                .iter()
                .map(|&u| UniDesc::from_universe(u, DMX_LEN).unwrap())
                .collect();
            let w = ArtRecWriter::new(
                Cursor::new(Vec::new()),
                unis,
                cfg.encoder.algo,
                cfg.encoder.level,
                cfg.encoder.file_flags(),
                cfg.rec_start_unix_us,
            )
            .unwrap();
            Self {
                w,
                enc: LegacyEncoder::new(cfg.encoder),
                engine: SignalEngine::new(cfg.merge_mode, source_timeout_ms),
                filter: cfg.filter.clone(),
                universes: cfg.universes.clone(),
                dirty: false,
                last_change_us: 0,
            }
        }

        fn ingest(&mut self, frame: &DmxFrame, t_us: u64) {
            if !self.filter.matches(frame) || !self.universes.contains(&frame.universe) {
                return;
            }
            self.engine.ingest(frame, t_us / 1000);
            self.dirty = true;
            self.last_change_us = self.last_change_us.max(t_us);
        }

        fn snapshot(&self) -> Vec<Vec<u8>> {
            self.universes
                .iter()
                .map(|&u| {
                    let mut v = self.engine.merged_output(u).unwrap_or_default();
                    v.resize(DMX_LEN as usize, 0);
                    v
                })
                .collect()
        }

        fn tick(&mut self) -> Option<Encoded> {
            if !self.dirty {
                return None;
            }
            self.dirty = false;
            let snap = self.snapshot();
            let t = self
                .w
                .last_time_us()
                .map_or(self.last_change_us, |l| l.max(self.last_change_us));
            self.enc.encode(&mut self.w, t, &snap).unwrap()
        }

        fn finish(mut self, total_us: u64) -> Vec<u8> {
            self.tick();
            let total = total_us.max(self.w.last_time_us().unwrap_or(0));
            self.enc.encode_tail(&mut self.w, total).unwrap();
            self.w.finish(total).unwrap().into_inner()
        }
    }

    /// 伪随机帧：随机 Universe（含集合外的 12）、来源、宽度（含短帧与超长帧）与内容。
    fn random_frame(rng: &mut Rng) -> DmxFrame {
        const UNIS: [u16; 4] = [0, 3, 7, 12];
        const WIDTHS: [usize; 7] = [1, 3, 24, 100, 511, 512, 600];
        let universe = UNIS[rng.below(UNIS.len() as u64) as usize];
        let src = 1 + rng.below(3) as u8;
        let width = WIDTHS[rng.below(WIDTHS.len() as u64) as usize];
        let fill = rng.below(256) as u8;
        let mut data = vec![fill; width];
        for _ in 0..rng.below(8) {
            let ch = rng.below(width as u64) as usize;
            data[ch] = rng.below(256) as u8;
        }
        frame(universe, src, &data)
    }

    /// 复用缓冲的快照与旧实现（`merged_output` + `resize`）逐字节一致，
    /// 覆盖宽度收缩、多来源合并与从未收到数据的 Universe。
    #[test]
    fn snapshot_matches_legacy_merged_output() {
        for mode in [MergeMode::Htp, MergeMode::Ltp, MergeMode::Priority] {
            let mut s = RecorderSession::new(
                Cursor::new(Vec::new()),
                SessionConfig {
                    filter: RecordFilter::default(),
                    universes: vec![0, 3, 7, 9],
                    merge_mode: mode,
                    encoder: EncoderConfig::default(),
                    rec_start_unix_us: 0,
                },
                2500,
            )
            .unwrap();
            let mut rng = Rng(0x1234_5678_9ABC_DEF1);
            // 先灌满 512 字节，再发短帧：合并宽度收缩后，旧数据必须被清零
            s.ingest(&frame(0, 1, &[0xAA; 512]), 0);
            s.refresh_snapshot();
            s.engine.prune(1_000_000);
            s.ingest(&frame(0, 1, &[1, 2, 3]), 1_000_000_000);
            for step in 0..600u64 {
                if step > 0 {
                    s.ingest(&random_frame(&mut rng), 1_000_000_000 + step * 1000);
                }
                s.refresh_snapshot();
                let expect: Vec<Vec<u8>> = s
                    .universes
                    .iter()
                    .map(|&u| {
                        let mut v = s.engine.merged_output(u).unwrap_or_default();
                        v.resize(DMX_LEN as usize, 0);
                        v
                    })
                    .collect();
                assert!(s.snap == expect, "{mode:?} step={step}");
            }
            assert!(
                s.snap[3].iter().all(|&b| b == 0),
                "从未收到数据的 Universe 整路为 0"
            );
        }
    }

    /// 同一输入序列下，新会话与改动前实现写出的文件逐字节一致（默认配置与差分配置）。
    #[test]
    fn session_file_matches_legacy_byte_for_byte() {
        let diff = EncoderConfig {
            allow_diff: true,
            keyframe_interval_us: 200_000,
            ..EncoderConfig::default()
        };
        for (mode, encoder) in [
            (MergeMode::Htp, EncoderConfig::default()),
            (MergeMode::Ltp, EncoderConfig::default()),
            (MergeMode::Htp, diff),
            (MergeMode::Priority, diff),
        ] {
            let cfg = SessionConfig {
                filter: RecordFilter::default(),
                universes: vec![0, 3, 7, 9],
                merge_mode: mode,
                encoder,
                rec_start_unix_us: 42,
            };
            let mut s = RecorderSession::new(Cursor::new(Vec::new()), cfg.clone(), 2500).unwrap();
            let mut old = LegacySession::new(&cfg, 2500);
            let mut rng = Rng(0x0F0F_1234_ABCD_0001);
            let mut t = 0u64;
            for step in 0..800 {
                for _ in 0..rng.below(4) {
                    let f = random_frame(&mut rng);
                    s.ingest(&f, t);
                    old.ingest(&f, t);
                    t += rng.below(3000);
                }
                assert_eq!(
                    s.tick().unwrap(),
                    old.tick(),
                    "{mode:?}/{encoder:?} step={step}"
                );
                t += rng.below(30_000);
            }
            let (cur, stats) = s.finish(t + 5_000).unwrap();
            assert!(
                stats.frames > 100,
                "{mode:?}/{encoder:?}: frames={}",
                stats.frames
            );
            if encoder.allow_diff {
                assert!(stats.diff_frames > 0, "{mode:?}/{encoder:?}");
            }
            assert!(
                cur.into_inner() == old.finish(t + 5_000),
                "{mode:?}/{encoder:?}: 文件字节不一致"
            );
        }
    }
}
