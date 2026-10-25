//! 单个 Universe 的多源状态跟踪。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};

use artnet_net::Protocol;

use crate::merge::{merge, MergeMode, MergeResult, SourceView};

/// 源主键：以源 IP 区分（未知来源回落 0.0.0.0）。
pub type SourceKey = IpAddr;

/// 某个源在一个 Universe 上的最新状态。
#[derive(Debug, Clone)]
pub struct SourceEntry {
    /// 最新通道数据。
    pub data: Vec<u8>,
    /// 优先级（Art-Net 默认 100）。
    pub priority: u8,
    /// 最后更新逻辑时间（毫秒）。
    pub last_seen_ms: u64,
    /// 到达序（同毫秒稳定排序用）。
    pub order: u64,
    /// 累计包数。
    pub packets: u64,
}

/// 一个 Universe 的全部源与派生状态。
#[derive(Debug, Clone, Default)]
pub struct UniverseState {
    /// 各源最新状态。
    pub sources: HashMap<SourceKey, SourceEntry>,
    /// 最近一次更新的协议。
    pub last_protocol: Option<Protocol>,
    /// 该 Universe 累计包数。
    pub total_packets: u64,
}

impl UniverseState {
    /// 接收一帧更新某源状态。
    ///
    /// # Arguments
    ///
    /// * `src` - 源 IP。
    /// * `protocol` - 来源协议。
    /// * `data` - 通道数据。
    /// * `priority` - 优先级。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    /// * `order` - 全局单调到达序。
    pub fn ingest(
        &mut self,
        src: SourceKey,
        protocol: Protocol,
        data: Vec<u8>,
        priority: u8,
        now_ms: u64,
        order: u64,
    ) {
        self.last_protocol = Some(protocol);
        self.total_packets += 1;
        let entry = self.sources.entry(src).or_insert(SourceEntry {
            data: Vec::new(),
            priority,
            last_seen_ms: now_ms,
            order,
            packets: 0,
        });
        entry.data = data;
        entry.priority = priority;
        entry.last_seen_ms = now_ms;
        entry.order = order;
        entry.packets += 1;
    }

    /// 剔除超时未更新的源。
    ///
    /// # Arguments
    ///
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    /// * `timeout_ms` - 超时阈值（毫秒）。
    ///
    /// # Returns
    ///
    /// 被剔除的源数量。
    pub fn prune(&mut self, now_ms: u64, timeout_ms: u64) -> usize {
        let before = self.sources.len();
        self.sources
            .retain(|_, e| now_ms.saturating_sub(e.last_seen_ms) <= timeout_ms);
        before - self.sources.len()
    }

    /// 按合并模式计算当前输出。
    ///
    /// # Arguments
    ///
    /// * `mode` - 合并模式。
    ///
    /// # Returns
    ///
    /// 合并结果（无源时为空输出）。
    #[must_use]
    pub fn merged(&self, mode: MergeMode) -> MergeResult {
        let views: Vec<SourceView<'_>> = self
            .sources
            .values()
            .map(|e| SourceView {
                data: &e.data,
                priority: e.priority,
                last_seen_ms: e.last_seen_ms,
                order: e.order,
            })
            .collect();
        merge(&views, mode)
    }

    /// 返回参与的源 IP 列表（升序）。
    #[must_use]
    pub fn source_ips(&self) -> Vec<IpAddr> {
        let mut v: Vec<IpAddr> = self.sources.keys().copied().collect();
        v.sort_unstable();
        v
    }
}

/// 未知来源的占位 IP。
#[must_use]
pub fn unknown_source() -> IpAddr {
    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
}
