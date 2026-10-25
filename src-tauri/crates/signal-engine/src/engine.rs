//! 信号接收引擎：聚合多个 Universe 的状态、合并与统计快照。

use std::collections::BTreeMap;

use artnet_net::{DmxFrame, Protocol};
use serde::Serialize;

use crate::merge::MergeMode;
use crate::state::{unknown_source, UniverseState};

/// Art-Net 默认优先级。
const ARTNET_DEFAULT_PRIORITY: u8 = 100;

/// 单个活跃 Universe 的快照（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseSnapshot {
    /// Universe 编号。
    pub universe: u16,
    /// 最近协议。
    pub protocol: Option<Protocol>,
    /// 源 IP 列表（字符串）。
    pub source_ips: Vec<String>,
    /// 源数量。
    pub source_count: usize,
    /// 合并后非零通道数。
    pub active_channels: usize,
    /// 合并冲突通道数。
    pub conflict_channels: usize,
    /// 累计包数。
    pub total_packets: u64,
}

/// 单个来源（按源 IP 聚合）的统计（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStat {
    /// 源 IP 字符串（未知来源为 `0.0.0.0`）。
    pub ip: String,
    /// 该源最近使用的协议。
    pub protocol: Option<Protocol>,
    /// 该源当前活跃的 Universe（升序）。
    pub universes: Vec<u16>,
    /// 该源在所有 Universe 上的累计包数。
    pub packets: u64,
}

/// 信号接收引擎。
#[derive(Debug)]
pub struct SignalEngine {
    universes: BTreeMap<u16, UniverseState>,
    mode: MergeMode,
    timeout_ms: u64,
    order_counter: u64,
    total_packets: u64,
}

impl SignalEngine {
    /// 以给定合并模式与源超时创建引擎。
    ///
    /// # Arguments
    ///
    /// * `mode` - 合并模式。
    /// * `timeout_ms` - 源超时（毫秒）。
    #[must_use]
    pub fn new(mode: MergeMode, timeout_ms: u64) -> Self {
        Self {
            universes: BTreeMap::new(),
            mode,
            timeout_ms,
            order_counter: 0,
            total_packets: 0,
        }
    }

    /// 更新合并模式。
    pub fn set_mode(&mut self, mode: MergeMode) {
        self.mode = mode;
    }

    /// 更新源超时（毫秒）。
    pub fn set_timeout(&mut self, timeout_ms: u64) {
        self.timeout_ms = timeout_ms;
    }

    /// 接收一帧 DMX 数据。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收到的帧。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    pub fn ingest(&mut self, frame: &DmxFrame, now_ms: u64) {
        self.order_counter += 1;
        self.total_packets += 1;
        let src = frame.source.unwrap_or_else(unknown_source);
        let priority = match frame.protocol {
            Protocol::ArtNet => ARTNET_DEFAULT_PRIORITY,
            // sACN 优先级在帧层暂未透传，统一按默认处理（后续可扩展）
            Protocol::Sacn => ARTNET_DEFAULT_PRIORITY,
        };
        self.universes
            .entry(frame.universe)
            .or_default()
            .ingest(
                src,
                frame.protocol,
                frame.data.clone(),
                priority,
                now_ms,
                self.order_counter,
            );
    }

    /// 剔除所有 Universe 中超时的源，并移除变空的 Universe。
    ///
    /// # Arguments
    ///
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    ///
    /// # Returns
    ///
    /// 被剔除的源总数。
    pub fn prune(&mut self, now_ms: u64) -> usize {
        let mut pruned = 0;
        for st in self.universes.values_mut() {
            pruned += st.prune(now_ms, self.timeout_ms);
        }
        self.universes.retain(|_, st| !st.sources.is_empty());
        pruned
    }

    /// 计算某 Universe 的合并输出。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    ///
    /// # Returns
    ///
    /// 合并后的通道数据；该 Universe 无数据时返回 `None`。
    #[must_use]
    pub fn merged_output(&self, universe: u16) -> Option<Vec<u8>> {
        self.universes.get(&universe).map(|st| st.merged(self.mode).data)
    }

    /// 当前活跃 Universe 数量。
    #[must_use]
    pub fn active_universe_count(&self) -> usize {
        self.universes.len()
    }

    /// 累计接收包数。
    #[must_use]
    pub fn total_packets(&self) -> u64 {
        self.total_packets
    }

    /// 按源 IP 聚合当前所有活跃来源的统计（按 IP 升序）。
    ///
    /// # Returns
    ///
    /// 每个来源一条，含其活跃 Universe 与累计包数，供"选择要录制的设备"使用。
    #[must_use]
    pub fn source_stats(&self) -> Vec<SourceStat> {
        let mut agg: BTreeMap<std::net::IpAddr, SourceStat> = BTreeMap::new();
        for (&universe, st) in &self.universes {
            for (&ip, entry) in &st.sources {
                let stat = agg.entry(ip).or_insert_with(|| SourceStat {
                    ip: ip.to_string(),
                    protocol: st.last_protocol,
                    universes: Vec::new(),
                    packets: 0,
                });
                stat.universes.push(universe);
                stat.packets += entry.packets;
                if st.last_protocol.is_some() {
                    stat.protocol = st.last_protocol;
                }
            }
        }
        agg.into_values().collect()
    }

    /// 生成全部活跃 Universe 的快照（按 Universe 升序）。
    ///
    /// # Returns
    ///
    /// 快照列表，供前端 Dashboard / Universe 视图渲染。
    #[must_use]
    pub fn snapshot(&self) -> Vec<UniverseSnapshot> {
        self.universes
            .iter()
            .map(|(&universe, st)| {
                let m = st.merged(self.mode);
                let active_channels = m.data.iter().filter(|&&v| v > 0).count();
                UniverseSnapshot {
                    universe,
                    protocol: st.last_protocol,
                    source_ips: st.source_ips().iter().map(ToString::to_string).collect(),
                    source_count: m.source_count,
                    active_channels,
                    conflict_channels: m.conflict_channels,
                    total_packets: st.total_packets,
                }
            })
            .collect()
    }
}
