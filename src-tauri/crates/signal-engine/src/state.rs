//! 单个 Universe 的多源状态跟踪与急切合并。
//!
//! 来源以 `Vec` 存储并始终按 [`IpAddr`] 数值升序排列（通常只有 1~2 个来源，线性查找
//! 比哈希更快；有序存储让快照 / 统计无需再排序）。合并结果在数据变化时立即算好：
//!
//! - 单来源：不做任何合并，合并结果就是该来源的数据本身（零拷贝借用）；
//! - 多来源：按当前合并模式写入定长缓冲 `merged[..merged_len]`，不分配。

use std::net::{IpAddr, Ipv4Addr};

use artnet_net::{Bytes, Protocol};

use crate::merge::{count_conflicts, merge_into, MergeInput, MergeMode};

/// 单个 Universe 的最大通道数（DMX512）；更宽的帧在摄取时截断到该宽度。
pub(crate) const DMX_CHANNELS: usize = 512;

/// 某个源在一个 Universe 上的最新状态。
#[derive(Debug, Clone)]
pub(crate) struct SourceEntry {
    /// 源 IP（未知来源回落 `0.0.0.0`），也是来源主键。
    pub(crate) ip: IpAddr,
    /// 最新通道数据（共享引用计数缓冲，避免每帧深拷贝；长度不超过 [`DMX_CHANNELS`]）。
    pub(crate) data: Bytes,
    /// 优先级（Art-Net 默认 100）。
    pub(crate) priority: u8,
    /// 最后更新逻辑时间（毫秒）。
    pub(crate) last_seen_ms: u64,
    /// 全局单调到达序（LTP 同毫秒稳定排序用）。
    pub(crate) order: u64,
    /// 累计包数。
    pub(crate) packets: u64,
}

impl MergeInput for SourceEntry {
    fn data(&self) -> &[u8] {
        &self.data
    }

    fn priority(&self) -> u8 {
        self.priority
    }

    fn ltp_key(&self) -> (u64, u64) {
        (self.last_seen_ms, self.order)
    }
}

/// 一次来源更新（一帧）携带的数据，避免 [`UniverseState::ingest`] 参数过多。
#[derive(Debug, Clone)]
pub(crate) struct SourceUpdate {
    /// 源 IP。
    pub(crate) ip: IpAddr,
    /// 通道数据（调用方已截断到 [`DMX_CHANNELS`]）。
    pub(crate) data: Bytes,
    /// 优先级。
    pub(crate) priority: u8,
    /// 当前逻辑时间（毫秒）。
    pub(crate) now_ms: u64,
    /// 全局单调到达序。
    pub(crate) order: u64,
}

/// 一个 Universe 的全部源与派生状态。
#[derive(Debug, Clone)]
pub(crate) struct UniverseState {
    /// 各源最新状态，按 `ip` 数值升序。
    sources: Vec<SourceEntry>,
    /// 最近一次更新的协议。
    last_protocol: Option<Protocol>,
    /// 该 Universe 累计包数。
    total_packets: u64,
    /// 多来源时的合并结果缓冲（只有 `[..merged_len]` 有效）；单来源时不使用。
    merged: [u8; DMX_CHANNELS],
    /// `merged` 的有效宽度。
    merged_len: usize,
    /// 数据代号：合并结果可能变化时由引擎赋予一个全局递增的新值。
    data_gen: u64,
}

impl Default for UniverseState {
    fn default() -> Self {
        Self {
            sources: Vec::new(),
            last_protocol: None,
            total_packets: 0,
            merged: [0; DMX_CHANNELS],
            merged_len: 0,
            data_gen: 0,
        }
    }
}

impl UniverseState {
    /// 接收一帧更新某源状态，并立即刷新合并结果。
    ///
    /// # Arguments
    ///
    /// * `update` - 来源更新（IP、数据、优先级、时间与到达序）。
    /// * `protocol` - 来源协议。
    /// * `mode` - 当前合并模式。
    /// * `data_gen` - 赋给该 Universe 的新数据代号。
    pub(crate) fn ingest(
        &mut self,
        update: SourceUpdate,
        protocol: Protocol,
        mode: MergeMode,
        data_gen: u64,
    ) {
        let SourceUpdate {
            ip,
            data,
            priority,
            now_ms,
            order,
        } = update;
        self.last_protocol = Some(protocol);
        self.total_packets += 1;
        if let Some(entry) = self.sources.iter_mut().find(|e| e.ip == ip) {
            entry.data = data;
            entry.priority = priority;
            entry.last_seen_ms = now_ms;
            entry.order = order;
            entry.packets += 1;
        } else {
            // 新来源插入到有序位置，保持按 IP 数值升序
            let at = self.sources.partition_point(|e| e.ip < ip);
            self.sources.insert(
                at,
                SourceEntry {
                    ip,
                    data,
                    priority,
                    last_seen_ms: now_ms,
                    order,
                    packets: 1,
                },
            );
        }
        self.data_gen = data_gen;
        self.remerge(mode);
    }

    /// 剔除超时未更新的源；有源被剔除时刷新合并结果与数据代号。
    ///
    /// # Arguments
    ///
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    /// * `timeout_ms` - 超时阈值（毫秒）。
    /// * `mode` - 当前合并模式。
    /// * `data_gen` - 有源被剔除时赋给该 Universe 的新数据代号。
    ///
    /// # Returns
    ///
    /// 被剔除的源数量。
    pub(crate) fn prune(
        &mut self,
        now_ms: u64,
        timeout_ms: u64,
        mode: MergeMode,
        data_gen: u64,
    ) -> usize {
        let before = self.sources.len();
        self.sources
            .retain(|e| now_ms.saturating_sub(e.last_seen_ms) <= timeout_ms);
        let removed = before - self.sources.len();
        if removed > 0 {
            self.data_gen = data_gen;
            self.remerge(mode);
        }
        removed
    }

    /// 合并模式切换后重算（仅多来源 Universe 受影响）。
    ///
    /// # Arguments
    ///
    /// * `mode` - 新的合并模式。
    /// * `data_gen` - 受影响时赋给该 Universe 的新数据代号。
    pub(crate) fn apply_mode(&mut self, mode: MergeMode, data_gen: u64) {
        if self.sources.len() >= 2 {
            self.data_gen = data_gen;
            self.remerge(mode);
        }
    }

    /// 按当前来源集合重算合并缓冲；单来源 / 无来源时不做任何合并。
    ///
    /// # Arguments
    ///
    /// * `mode` - 合并模式。
    fn remerge(&mut self, mode: MergeMode) {
        self.merged_len = if self.sources.len() >= 2 {
            merge_into(&self.sources, mode, &mut self.merged)
        } else {
            0
        };
    }

    /// 借用当前合并结果。
    ///
    /// # Returns
    ///
    /// 单来源时为该来源数据本身，多来源时为合并缓冲的有效部分，无来源时为空切片。
    #[must_use]
    pub(crate) fn merged(&self) -> &[u8] {
        match self.sources.as_slice() {
            [only] => &only.data,
            _ => self.merged.get(..self.merged_len).unwrap_or_default(),
        }
    }

    /// 取当前合并结果的共享所有权副本。
    ///
    /// # Returns
    ///
    /// 单来源时为该来源 [`Bytes`] 的引用计数克隆（零拷贝零分配）；多来源时拷贝合并缓冲。
    #[must_use]
    pub(crate) fn merged_bytes(&self) -> Bytes {
        match self.sources.as_slice() {
            [only] => only.data.clone(),
            _ => Bytes::copy_from_slice(self.merged()),
        }
    }

    /// 惰性计算冲突通道数（仅快照使用）。
    ///
    /// # Returns
    ///
    /// 被 ≥2 个来源覆盖且取值不全相同的通道数；单来源时为 `0`。
    #[must_use]
    pub(crate) fn conflict_channels(&self) -> usize {
        count_conflicts(&self.sources)
    }

    /// 合并结果中的非零通道数。
    ///
    /// # Returns
    ///
    /// 非零通道个数。
    #[must_use]
    pub(crate) fn active_channels(&self) -> usize {
        self.merged().iter().filter(|&&v| v > 0).count()
    }

    /// 各源最新状态（按 IP 数值升序）。
    ///
    /// # Returns
    ///
    /// 来源条目切片。
    #[must_use]
    pub(crate) fn sources(&self) -> &[SourceEntry] {
        &self.sources
    }

    /// 是否已无任何来源（引擎据此移除该 Universe）。
    ///
    /// # Returns
    ///
    /// 无来源时为 `true`。
    #[must_use]
    pub(crate) fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    /// 最近一次更新的协议。
    ///
    /// # Returns
    ///
    /// 尚未收到任何帧时为 `None`。
    #[must_use]
    pub(crate) fn last_protocol(&self) -> Option<Protocol> {
        self.last_protocol
    }

    /// 该 Universe 累计包数。
    ///
    /// # Returns
    ///
    /// 累计包数。
    #[must_use]
    pub(crate) fn total_packets(&self) -> u64 {
        self.total_packets
    }

    /// 当前数据代号。
    ///
    /// # Returns
    ///
    /// 最近一次合并结果可能变化时赋予的代号。
    #[must_use]
    pub(crate) fn data_gen(&self) -> u64 {
        self.data_gen
    }
}

/// 未知来源的占位 IP。
///
/// # Returns
///
/// `0.0.0.0`。
#[must_use]
pub fn unknown_source() -> IpAddr {
    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
}
