//! 信号接收引擎：聚合多个 Universe 的状态、合并与统计快照。
//!
//! 合并结果在摄取时急切算好（单来源零合并、多来源写入定长缓冲），读取路径
//! [`SignalEngine::merged`] / [`SignalEngine::merged_bytes`] 零拷贝；冲突数只在
//! [`SignalEngine::snapshot`] 时惰性计算。引擎不含内部可变性，是 `Send + Sync` 的。

use std::collections::BTreeMap;
use std::net::IpAddr;

use artnet_net::{Bytes, DmxFrame, Protocol};
use serde::Serialize;

use crate::merge::MergeMode;
use crate::state::{unknown_source, SourceUpdate, UniverseState, DMX_CHANNELS};

/// Art-Net 默认优先级。
const ARTNET_DEFAULT_PRIORITY: u8 = 100;

/// 单个活跃 Universe 的快照（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct UniverseSnapshot {
    /// Universe 编号。
    pub universe: u16,
    /// 最近协议。
    pub protocol: Option<Protocol>,
    /// 源 IP 列表（字符串，按 [`IpAddr`] 数值升序）。
    pub source_ips: Vec<String>,
    /// 源数量。
    pub source_count: usize,
    /// 合并后非零通道数。
    pub active_channels: usize,
    /// 合并冲突通道数（被 ≥2 个源覆盖且取值不全相同的通道数）。
    pub conflict_channels: usize,
    /// 累计包数。
    pub total_packets: u64,
    /// 每秒包数（由 [`crate::RateTracker`] 在宿主层补齐，`snapshot()` 本身填 `0`）。
    pub packet_rate: u32,
    /// 该 Universe 上各来源的统计（按 [`IpAddr`] 数值升序，与 `source_ips` 一致；
    /// 例如 `10.0.0.9` 排在 `10.0.0.10` 之前，IPv4 排在 IPv6 之前）。
    pub sources: Vec<UniverseSource>,
}

/// 单个 Universe 内某个来源的统计（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct UniverseSource {
    /// 源 IP 字符串（未知来源为 `0.0.0.0`）。
    pub ip: String,
    /// 源 IP 的数值形式（与 `ip` 表示同一地址）。
    ///
    /// 不参与 JSON 序列化（前端载荷不变），供 [`crate::RateTracker`] 以 `Copy` 键索引
    /// 每源速率，避免逐周期克隆 / 解析 `ip` 字符串。手工构造时须与 `ip` 保持一致。
    #[serde(skip)]
    pub addr: IpAddr,
    /// 该源在此 Universe 上的累计包数。
    pub packets: u64,
    /// 该源在此 Universe 上的每秒包数（由 [`crate::RateTracker`] 补齐）。
    pub packet_rate: u32,
}

/// 单个来源（按源 IP 聚合）的统计（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
///
/// 每个 Universe 的合并结果在 [`ingest`](Self::ingest) / [`prune`](Self::prune) /
/// [`set_mode`](Self::set_mode) 时立即刷新；单个 Universe 的通道数上限为 512（DMX512），
/// 更宽的帧在摄取时截断（零拷贝切片）。
#[derive(Debug)]
pub struct SignalEngine {
    universes: BTreeMap<u16, UniverseState>,
    mode: MergeMode,
    timeout_ms: u64,
    order_counter: u64,
    total_packets: u64,
    /// 全局数据代号计数器：每次可能改变合并结果的操作取一个新值，
    /// 保证同一 Universe（含被移除后重建）的代号永不重复。
    gen_counter: u64,
}

// 编译期断言：引擎不含内部可变性，可放进 `RwLock` 供多读者并发访问。
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<SignalEngine>();
};

impl SignalEngine {
    /// 以给定合并模式与源超时创建引擎。
    ///
    /// # Arguments
    ///
    /// * `mode` - 合并模式。
    /// * `timeout_ms` - 源超时（毫秒）。
    ///
    /// # Returns
    ///
    /// 不含任何 Universe 的引擎。
    #[must_use]
    pub fn new(mode: MergeMode, timeout_ms: u64) -> Self {
        Self {
            universes: BTreeMap::new(),
            mode,
            timeout_ms,
            order_counter: 0,
            total_packets: 0,
            gen_counter: 0,
        }
    }

    /// 更新合并模式；模式确有变化时立即重算全部多来源 Universe 并更新其数据代号。
    ///
    /// # Arguments
    ///
    /// * `mode` - 新的合并模式。
    pub fn set_mode(&mut self, mode: MergeMode) {
        if self.mode == mode {
            return;
        }
        self.mode = mode;
        let data_gen = self.next_gen();
        for st in self.universes.values_mut() {
            st.apply_mode(mode, data_gen);
        }
    }

    /// 更新源超时（毫秒）。
    ///
    /// # Arguments
    ///
    /// * `timeout_ms` - 新的源超时（毫秒）。
    pub fn set_timeout(&mut self, timeout_ms: u64) {
        self.timeout_ms = timeout_ms;
    }

    /// 接收一帧 DMX 数据，并立即刷新该 Universe 的合并结果。
    ///
    /// 单来源 Universe 不做任何合并；多来源时按当前合并模式写入定长缓冲（不分配）。
    /// 超过 512 通道的帧截断到 512（零拷贝切片）。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收到的帧。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    pub fn ingest(&mut self, frame: &DmxFrame, now_ms: u64) {
        self.order_counter += 1;
        self.total_packets += 1;
        let data_gen = self.next_gen();
        let data = if frame.data.len() > DMX_CHANNELS {
            frame.data.slice(..DMX_CHANNELS)
        } else {
            frame.data.clone()
        };
        let update = SourceUpdate {
            ip: frame.source.unwrap_or_else(unknown_source),
            data,
            // Art-Net 与 sACN 目前统一按默认优先级处理（sACN 优先级在帧层暂未透传，后续可扩展）
            priority: ARTNET_DEFAULT_PRIORITY,
            now_ms,
            order: self.order_counter,
        };
        self.universes.entry(frame.universe).or_default().ingest(
            update,
            frame.protocol,
            self.mode,
            data_gen,
        );
    }

    /// 剔除所有 Universe 中超时的源，重算受影响的 Universe，并移除变空的 Universe。
    ///
    /// # Arguments
    ///
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    ///
    /// # Returns
    ///
    /// 被剔除的源总数。
    pub fn prune(&mut self, now_ms: u64) -> usize {
        // 本轮所有受影响的 Universe 共用一个新代号：它大于此前任何代号，足以表示“已变化”
        let data_gen = self.next_gen();
        let mut pruned = 0;
        for st in self.universes.values_mut() {
            pruned += st.prune(now_ms, self.timeout_ms, self.mode, data_gen);
        }
        if pruned > 0 {
            self.universes.retain(|_, st| !st.is_empty());
        }
        pruned
    }

    /// 借用某 Universe 的当前合并结果（零拷贝、零分配）。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    ///
    /// # Returns
    ///
    /// 该 Universe 有数据时返回 `Some`：单来源时直接借用该来源的数据，多来源时借用
    /// 合并缓冲；宽度为各来源最大宽度（不超过 512）。无该 Universe 时返回 `None`。
    #[must_use]
    pub fn merged(&self, universe: u16) -> Option<&[u8]> {
        self.universes.get(&universe).map(UniverseState::merged)
    }

    /// 取某 Universe 合并结果的共享所有权副本（供转发等需要跨任务持有数据的场合）。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    ///
    /// # Returns
    ///
    /// 该 Universe 有数据时返回 `Some`：单来源时为该来源 [`Bytes`] 的引用计数克隆
    /// （零拷贝零分配），多来源时为合并结果的一次拷贝（[`Bytes::copy_from_slice`]）。
    /// 无该 Universe 时返回 `None`。
    #[must_use]
    pub fn merged_bytes(&self, universe: u16) -> Option<Bytes> {
        self.universes
            .get(&universe)
            .map(UniverseState::merged_bytes)
    }

    /// 把某 Universe 的合并结果拷进调用方缓冲。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    /// * `out` - 目标缓冲；比合并结果短时只拷贝前 `out.len()` 个通道（512 字节缓冲总是够用）。
    ///
    /// # Returns
    ///
    /// 该 Universe 有数据时返回 `Some(n)`，`n` 为实际写入 `out` 的字节数
    /// （合并宽度与 `out.len()` 的较小者），`out[n..]` 保持不变；无该 Universe 时返回 `None`。
    #[must_use]
    pub fn merged_into(&self, universe: u16, out: &mut [u8]) -> Option<usize> {
        let data = self.merged(universe)?;
        let n = data.len().min(out.len());
        // n 不超过两者长度，切片必然在界内
        out[..n].copy_from_slice(&data[..n]);
        Some(n)
    }

    /// 某 Universe 的数据代号，供推送做变化检测。
    ///
    /// 合并结果可能变化时（`ingest`、`prune` 剔除了该 Universe 的来源、`set_mode`
    /// 切换影响了多来源 Universe、该 Universe 被移除后重建）代号就会更新为一个新值；
    /// 代号来自引擎级单调计数器，同一 Universe 不会出现重复值。代号未变则合并结果必然未变；
    /// 代号变化不保证数据一定不同。数值本身无意义，只用于比较。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    ///
    /// # Returns
    ///
    /// 该 Universe 有数据时返回 `Some(代号)`，否则返回 `None`。
    #[must_use]
    pub fn data_gen(&self, universe: u16) -> Option<u64> {
        self.universes.get(&universe).map(UniverseState::data_gen)
    }

    /// 计算某 Universe 的合并输出（分配一份 `Vec`；热路径请用 [`merged`](Self::merged)
    /// 或 [`merged_bytes`](Self::merged_bytes)）。
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
        self.merged(universe).map(<[u8]>::to_vec)
    }

    /// 移除最近一次更新来自指定协议的全部 Universe（如关闭 sACN 时清掉残留数据）。
    ///
    /// 来源按 IP 聚合、不区分协议，所以以 Universe 最近一次更新的协议为准。
    /// 若同一 Universe 编号同时有另一协议的来源，该 Universe 也会被移除，
    /// 但另一协议的后续帧会立即重建它。
    ///
    /// # Arguments
    ///
    /// * `protocol` - 要清除的协议。
    ///
    /// # Returns
    ///
    /// 被移除的 Universe 数。
    pub fn purge_protocol(&mut self, protocol: Protocol) -> usize {
        let before = self.universes.len();
        self.universes
            .retain(|_, st| st.last_protocol() != Some(protocol));
        before - self.universes.len()
    }

    /// 丢弃全部 Universe 状态（进入播放器模式时清空实时信号）。
    ///
    /// 累计包数 `total_packets` 保留不变，避免仪表盘的包速率计算出现负跳变。
    ///
    /// # Returns
    ///
    /// 被丢弃的 Universe 数。
    pub fn clear(&mut self) -> usize {
        let n = self.universes.len();
        self.universes.clear();
        n
    }

    /// 当前活跃 Universe 数量。
    ///
    /// # Returns
    ///
    /// 至少有一个来源的 Universe 数。
    #[must_use]
    pub fn active_universe_count(&self) -> usize {
        self.universes.len()
    }

    /// 累计接收包数。
    ///
    /// # Returns
    ///
    /// 引擎创建以来摄取的帧总数（`clear` 不会清零）。
    #[must_use]
    pub fn total_packets(&self) -> u64 {
        self.total_packets
    }

    /// 按源 IP 聚合当前所有活跃来源的统计（按 IP 数值升序）。
    ///
    /// # Returns
    ///
    /// 每个来源一条，含其活跃 Universe 与累计包数，供"选择要录制的设备"使用。
    #[must_use]
    pub fn source_stats(&self) -> Vec<SourceStat> {
        let mut agg: BTreeMap<IpAddr, SourceStat> = BTreeMap::new();
        for (&universe, st) in &self.universes {
            let protocol = st.last_protocol();
            for entry in st.sources() {
                let stat = agg.entry(entry.ip).or_insert_with(|| SourceStat {
                    ip: entry.ip.to_string(),
                    protocol,
                    universes: Vec::new(),
                    packets: 0,
                });
                stat.universes.push(universe);
                stat.packets += entry.packets;
                if protocol.is_some() {
                    stat.protocol = protocol;
                }
            }
        }
        agg.into_values().collect()
    }

    /// 生成全部活跃 Universe 的快照（按 Universe 升序）。
    ///
    /// 不克隆合并结果：`active_channels` 直接在借用的合并切片上统计，`conflict_channels`
    /// 只对多来源 Universe 惰性计算。`source_ips` 与 `sources` 均按 [`IpAddr`] 数值升序。
    ///
    /// # Returns
    ///
    /// 快照列表，供前端 Dashboard / Universe 视图渲染。
    #[must_use]
    pub fn snapshot(&self) -> Vec<UniverseSnapshot> {
        self.universes
            .iter()
            .map(|(&universe, st)| {
                let sources: Vec<UniverseSource> = st
                    .sources()
                    .iter()
                    .map(|e| UniverseSource {
                        ip: e.ip.to_string(),
                        addr: e.ip,
                        packets: e.packets,
                        packet_rate: 0,
                    })
                    .collect();
                UniverseSnapshot {
                    universe,
                    protocol: st.last_protocol(),
                    source_ips: sources.iter().map(|s| s.ip.clone()).collect(),
                    source_count: sources.len(),
                    active_channels: st.active_channels(),
                    conflict_channels: st.conflict_channels(),
                    total_packets: st.total_packets(),
                    packet_rate: 0,
                    sources,
                }
            })
            .collect()
    }

    /// 取一个新的数据代号。
    ///
    /// # Returns
    ///
    /// 严格大于此前任何代号的值。
    fn next_gen(&mut self) -> u64 {
        self.gen_counter += 1;
        self.gen_counter
    }
}
