//! 信号输出分发：把某个 Universe 的一帧数据按转发表（或指定目标）解析成发送任务并发出。
//!
//! 实时接收链路与录制回放共用本模块，保证两者的路由、偏移、延迟与发送行为一致。
//!
//! 热路径（256 Universe × 44Hz × 多目的地）设计要点：
//!
//! - 转发表归分发器所有（唯一真相），每次修改（[`Dispatcher::set_table`]、
//!   [`Dispatcher::set_sacn_enabled`]）都在同一把写锁内重新编译成 [`CompiledRoutes`] 并放进
//!   `ArcSwap`；解析路由只做一次无锁读取，无路由的 Universe 查位图即返回；
//! - 发送任务携带共享的预解析 [`Endpoint`]（地址 + 计数器句柄）与共享负载 [`Bytes`]，
//!   生成任务不克隆字符串、不解析 IP；
//! - 44Hz 限速表以 `(目的地序号, 目标 Universe)` 为键，每次解析最多加一次锁；
//! - 发送器放在 [`SenderSlot`]（`ArcSwapOption`）里，发送不加锁；
//! - 延迟任务交给常驻的延迟队列 worker，不再每包 `spawn`。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use arc_swap::{ArcSwap, ArcSwapOption};
use artnet_net::socket::DmxSender;
use artnet_net::Bytes;
use forwarding::{ForwardProtocol, ForwardingTable};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

use crate::delay::{DelayQueue, Delayed};
use crate::output_stats::{OutputStats, DIRECT_PREFIX};
use crate::routes::{CompiledRoutes, Endpoint};
use crate::sender::{SenderHealth, SenderSlot};
use crate::util::lock;

/// 一次待发送任务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardJob {
    /// 发送端点：预解析的目标地址、目的地 id、协议与统计计数器（多个任务共享）。
    ///
    /// 直发目标（[`DispatchTarget::Direct`]）的 id 为 `direct:ip:port`、没有计数器，只计入全局统计。
    pub endpoint: Arc<Endpoint>,
    /// 目标 Universe。
    pub target_universe: u16,
    /// 延迟（毫秒），0 为立即发送。
    pub delay_ms: u16,
    /// 通道数据（多目标共享引用计数缓冲，避免每目标深拷贝整帧）。
    pub data: Bytes,
}

/// 输出目标。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DispatchTarget {
    /// 走转发表（与实时信号相同的路由、偏移与延迟）。
    #[default]
    Forwarding,
    /// 直接发往指定地址，Universe 编号保持不变。
    #[serde(rename_all = "camelCase")]
    Direct {
        /// 目标 IP。
        ip: String,
        /// 输出协议。
        protocol: ForwardProtocol,
        /// 目标端口。
        port: u16,
    },
    /// 按 Universe 表逐个路由（节目编辑器的工程级路由）：每个 Universe 可发往多个端口，
    /// 远端编号可重映射，sACN 可单播 / 组播并指定优先级。
    #[serde(rename_all = "camelCase")]
    Routed {
        /// 按 `universe` 升序、不重复的路由表（见 [`DispatchTarget::normalized`]）。
        universes: Vec<RoutedUniverse>,
        /// 多 Universe 帧同步。
        #[serde(default)]
        sync: OutputSync,
    },
}

/// 端口的寻址方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortMode {
    /// 单播到 `ip`。
    Unicast,
    /// 广播到 `ip`（例如 `255.255.255.255` 或子网定向广播）。
    Broadcast,
    /// sACN 组播：地址由远端 Universe 决定（`239.255.hi.lo`），忽略 `ip`。
    Multicast,
}

/// Universe 的一个输出端口。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedPort {
    /// 协议。
    pub protocol: ForwardProtocol,
    /// 寻址方式。
    pub mode: PortMode,
    /// 目标 IP（组播时忽略）。
    #[serde(default)]
    pub ip: String,
    /// 目标端口。
    pub port: u16,
    /// 远端 Universe：Art-Net 为 15 位 Port-Address（0~32767），sACN 为 1~63999。
    pub remote_universe: u16,
    /// sACN 优先级（0~200），省略为 100。
    #[serde(default)]
    pub priority: Option<u8>,
    /// 是否启用。
    pub enabled: bool,
}

impl RoutedPort {
    /// 实际发送的目标 IP：组播时由远端 Universe 计算。
    ///
    /// # Returns
    ///
    /// IP 文本。
    #[must_use]
    pub fn target_ip(&self) -> String {
        match self.mode {
            PortMode::Multicast => artnet_net::sacn::multicast_addr(self.remote_universe).to_string(),
            _ => self.ip.trim().to_owned(),
        }
    }
}

/// 一个 Universe 的路由。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedUniverse {
    /// 工程内的 Universe 编号。
    pub universe: u16,
    /// 输出端口。
    #[serde(default)]
    pub ports: Vec<RoutedPort>,
}

/// 多 Universe 帧同步设置。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSync {
    /// 每帧所有 ArtDmx 发完后向用到的 Art-Net 端点各发一个 ArtSync。
    #[serde(default)]
    pub art_sync: bool,
    /// sACN 同步 Universe（1~63999）；数据包带上该同步地址，每帧末尾发送同步包。
    #[serde(default)]
    pub sacn_sync_universe: Option<u16>,
}

/// 路由表校验失败的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    /// 远端 Universe 超出协议允许的范围（Art-Net 0~32767，sACN 1~63999）。
    RemoteUniverse {
        /// 工程内的 Universe。
        universe: u16,
    },
    /// 单播 / 广播端口的 IP 不是合法的 IPv4 地址。
    BadIp {
        /// 工程内的 Universe。
        universe: u16,
    },
    /// 组播只适用于 sACN。
    MulticastArtNet {
        /// 工程内的 Universe。
        universe: u16,
    },
    /// sACN 同步 Universe 超出 1~63999。
    SyncUniverse,
}

impl DispatchTarget {
    /// 规整并校验路由目标：路由表按 Universe 升序去重（同一 Universe 的端口合并），
    /// 优先级夹到 0~200，并检查远端编号、IP 与寻址方式。其它目标原样返回。
    ///
    /// # Returns
    ///
    /// 规整后的目标。
    ///
    /// # Errors
    ///
    /// 路由表里任一启用端口不合法、或同步 Universe 越界时返回 [`RouteError`]。
    pub fn normalized(self) -> Result<Self, RouteError> {
        let Self::Routed { universes, sync } = self else {
            return Ok(self);
        };
        if sync.sacn_sync_universe.is_some_and(|u| !(1..=63_999).contains(&u)) {
            return Err(RouteError::SyncUniverse);
        }
        let mut merged: std::collections::BTreeMap<u16, Vec<RoutedPort>> = std::collections::BTreeMap::new();
        for u in universes {
            for mut p in u.ports {
                if !p.enabled {
                    continue;
                }
                let ok_remote = match p.protocol {
                    ForwardProtocol::ArtNet => p.remote_universe <= 0x7FFF,
                    ForwardProtocol::Sacn => (1..=63_999).contains(&p.remote_universe),
                };
                if !ok_remote {
                    return Err(RouteError::RemoteUniverse { universe: u.universe });
                }
                match p.mode {
                    PortMode::Multicast if p.protocol == ForwardProtocol::ArtNet => {
                        return Err(RouteError::MulticastArtNet { universe: u.universe });
                    }
                    PortMode::Multicast => {}
                    PortMode::Unicast | PortMode::Broadcast => {
                        if p.ip.trim().parse::<std::net::Ipv4Addr>().is_err() {
                            return Err(RouteError::BadIp { universe: u.universe });
                        }
                    }
                }
                p.priority = p.priority.map(|v| v.min(200));
                merged.entry(u.universe).or_default().push(p);
            }
        }
        Ok(Self::Routed {
            universes: merged
                .into_iter()
                .map(|(universe, ports)| RoutedUniverse { universe, ports })
                .collect(),
            sync,
        })
    }

    /// 帧同步设置（只有路由目标有）。
    ///
    /// # Returns
    ///
    /// 路由目标的同步设置；其它目标为 `None`。
    #[must_use]
    pub fn sync(&self) -> Option<OutputSync> {
        match self {
            Self::Routed { sync, .. } => Some(*sync),
            _ => None,
        }
    }

    /// 路由目标里启用的端口总数。
    ///
    /// # Returns
    ///
    /// 路由目标的端口数；其它目标为 `None`。
    #[must_use]
    pub fn routed_ports(&self) -> Option<usize> {
        match self {
            Self::Routed { universes, .. } => Some(universes.iter().map(|u| u.ports.len()).sum()),
            _ => None,
        }
    }
}

/// 发送所需的共享上下文（分发器与延迟队列 worker 共用）。
#[derive(Clone)]
pub(crate) struct SendCtx {
    /// 发送器槽位。
    pub(crate) sender: SenderSlot,
    /// 发送器健康度。
    pub(crate) health: Arc<SenderHealth>,
    /// 输出统计。
    pub(crate) stats: Arc<OutputStats>,
}

/// 分发器的共享状态。
struct Shared {
    /// 转发表（唯一真相）。写者持此锁完成"修改 + 重新编译 + 发布"，保证编译结果与之一致。
    table: Mutex<ForwardingTable>,
    /// 编译后的转发表（热路径无锁读取）。
    compiled: ArcSwap<CompiledRoutes>,
    /// sACN 总开关：关闭时不产出任何 sACN 发送任务。与运行时的接收循环共享同一个标志。
    sacn_enabled: Arc<AtomicBool>,
    /// 发送上下文。
    ctx: SendCtx,
    /// 延迟发送队列。
    delay: DelayQueue,
    /// 最近一次使用的直发端点（回放直发时每帧复用，免去重复分配与 IP 解析）。
    direct: ArcSwapOption<Endpoint>,
    /// 路由端点缓存。
    routed: Mutex<FxHashMap<RoutedKey, Arc<Endpoint>>>,
}

/// 路由端点缓存键：`(是否 sACN, IP, 端口, 优先级)`。
type RoutedKey = (bool, String, u16, u8);

/// 路由目标端点 id 的前缀。
pub const ROUTED_PREFIX: &str = "routed:";

/// 输出分发器（可克隆，内部共享转发表 / 编译路由 / 限速状态 / 发送器 / 延迟队列）。
#[derive(Clone)]
pub struct Dispatcher {
    inner: Arc<Shared>,
}

impl Dispatcher {
    /// 以转发表与发送器槽位构造分发器（sACN 默认开启；运行时按配置显式设置）。
    ///
    /// # Arguments
    ///
    /// * `table` - 初始转发表；之后经 [`Dispatcher::set_table`] 修改。
    /// * `sender` - 与运行时、发送器监督任务共享的发送器槽位；为空时发送被静默忽略。
    ///
    /// # Returns
    ///
    /// 新的 [`Dispatcher`]。可在 tokio 运行时之外构造（延迟队列 worker 在首次需要时才启动）。
    #[must_use]
    pub fn with_table(table: ForwardingTable, sender: SenderSlot) -> Self {
        let stats = OutputStats::new();
        let compiled = CompiledRoutes::compile(&table, true, &stats);
        Self {
            inner: Arc::new(Shared {
                table: Mutex::new(table),
                compiled: ArcSwap::from_pointee(compiled),
                sacn_enabled: Arc::new(AtomicBool::new(true)),
                ctx: SendCtx {
                    sender,
                    health: SenderHealth::new(),
                    stats,
                },
                delay: DelayQueue::default(),
                direct: ArcSwapOption::empty(),
                routed: Mutex::new(FxHashMap::default()),
            }),
        }
    }

    /// 输出统计的共享句柄（运行时据此周期性生成 `engine:output` 事件）。
    ///
    /// # Returns
    ///
    /// 与本分发器（及其克隆）共享的 [`OutputStats`]。
    #[must_use]
    pub fn output_stats(&self) -> Arc<OutputStats> {
        self.inner.ctx.stats.clone()
    }

    /// 发送器健康度的共享句柄（运行时据此监督并重建发送套接字）。
    ///
    /// # Returns
    ///
    /// 与本分发器（及其克隆）共享的 [`SenderHealth`]。
    #[must_use]
    pub fn health(&self) -> Arc<SenderHealth> {
        self.inner.ctx.health.clone()
    }

    /// 当前转发表的副本。
    ///
    /// # Returns
    ///
    /// 转发表的克隆。
    #[must_use]
    pub fn table(&self) -> ForwardingTable {
        lock(&self.inner.table).clone()
    }

    /// 替换转发表：重新编译路由、清空限速状态，并清除已不存在的目的地的统计。
    ///
    /// 同 id 的目的地沿用原有计数器，计数跨编辑延续。
    ///
    /// # Arguments
    ///
    /// * `table` - 新的转发表。
    pub fn set_table(&self, table: ForwardingTable) {
        {
            let mut current = lock(&self.inner.table);
            *current = table;
            let sacn = self.inner.sacn_enabled.load(Ordering::Relaxed);
            // 新的限速表：等价于旧版保存转发表后的 `reset_rate_limits`
            let compiled = CompiledRoutes::compile(&current, sacn, &self.inner.ctx.stats);
            self.inner.compiled.store(Arc::new(compiled));
        }
        self.prune_output_stats();
    }

    /// 清除转发表中已不存在的目的地的统计（[`Dispatcher::set_table`] 已自动调用）。
    ///
    /// 全局累计值保留，仅移除按目的地归属的计数，避免已删除的条目残留。
    pub fn prune_output_stats(&self) {
        let table = lock(&self.inner.table);
        let ids: FxHashSet<&str> = table.destinations.iter().map(|d| d.id.as_str()).collect();
        self.inner.ctx.stats.retain(|id| ids.contains(id));
    }

    /// 设置 sACN 输出总开关。关闭后不再产出任何 sACN 发送任务。
    ///
    /// 开关确有变化时重新编译路由（限速状态沿用，与旧版一致）。
    ///
    /// # Arguments
    ///
    /// * `enabled` - `true` 表示允许 sACN 输出。
    pub fn set_sacn_enabled(&self, enabled: bool) {
        let table = lock(&self.inner.table);
        self.inner.sacn_enabled.store(enabled, Ordering::Relaxed);
        let current = self.inner.compiled.load();
        if current.sacn_enabled() == enabled {
            return;
        }
        let next = CompiledRoutes::compile_with_limiter(
            &table,
            enabled,
            &self.inner.ctx.stats,
            current.limiter.clone(),
        );
        self.inner.compiled.store(Arc::new(next));
    }

    /// sACN 开关的共享句柄（供运行时的接收循环用同一标志丢弃迟到的 sACN 帧）。
    ///
    /// 只读使用；修改须经 [`Dispatcher::set_sacn_enabled`]，否则编译后的路由不会随之更新。
    ///
    /// # Returns
    ///
    /// 与本分发器共享的开关标志。
    #[must_use]
    pub fn sacn_gate(&self) -> Arc<AtomicBool> {
        self.inner.sacn_enabled.clone()
    }

    /// 清空限速状态（清空实时状态等场合调用；替换转发表时已自动清空）。
    pub fn reset_rate_limits(&self) {
        lock(&self.inner.compiled.load().limiter).clear();
    }

    /// 当前启用的转发目的地数量（回放走转发表时用于提示"没有可用目的地"）。
    ///
    /// sACN 关闭时，sACN 目的地不会发出任何数据，因此不计入。
    ///
    /// # Returns
    ///
    /// 转发表中实际可发送的、`enabled` 为 `true` 的目的地个数（直接读编译结果）。
    #[must_use]
    pub fn enabled_destinations(&self) -> usize {
        self.inner.compiled.load().enabled_destinations()
    }

    /// 当前编译后的转发表快照（批量处理时取一次，逐帧复用）。
    ///
    /// # Returns
    ///
    /// 编译结果的共享引用；转发表之后的修改不影响已取得的快照。
    #[must_use]
    pub fn routes(&self) -> Arc<CompiledRoutes> {
        self.inner.compiled.load_full()
    }

    /// 某源 Universe 经转发表是否至少有一条路由（直接查编译后的位图）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    ///
    /// # Returns
    ///
    /// 有路由时返回 `true`；sACN 关闭时 sACN 目的地不计入。
    #[must_use]
    pub fn has_routes(&self, universe: u16) -> bool {
        self.inner.compiled.load().has_routes(universe)
    }

    /// 为一帧数据解析发送任务（拷贝一次数据；热路径请用 [`Dispatcher::plan_into`]）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    /// * `data` - 通道数据；有任务产出时拷贝一次，由全部任务共享。
    /// * `now_ms` - 当前逻辑时间（毫秒），供限速使用。
    /// * `target` - 输出目标。
    /// * `rate_limited` - 是否应用 44Hz 限速。实时链路开启；回放的节奏由文件
    ///   时间轴决定，关闭以免丢帧。
    ///
    /// # Returns
    ///
    /// 需要发送的任务列表（可能为空）。
    #[must_use]
    pub fn plan(
        &self,
        universe: u16,
        data: &[u8],
        now_ms: u64,
        target: &DispatchTarget,
        rate_limited: bool,
    ) -> Vec<ForwardJob> {
        let mut out = Vec::new();
        let mut payload: Option<Bytes> = None;
        let make = || {
            payload
                .get_or_insert_with(|| Bytes::copy_from_slice(data))
                .clone()
        };
        match target {
            DispatchTarget::Forwarding => {
                let routes = self.inner.compiled.load();
                if routes.has_routes(universe) {
                    // 一次分配到位，免去逐条 push 的扩容
                    out.reserve_exact(routes.enabled_destinations());
                    self.plan_forwarding(&routes, universe, make, now_ms, rate_limited, &mut out);
                }
            }
            DispatchTarget::Direct { .. } | DispatchTarget::Routed { .. } => {
                self.plan_with(universe, make, now_ms, target, rate_limited, &mut out);
            }
        }
        out
    }

    /// 为一帧数据解析发送任务，追加到 `out`（不清空）。
    ///
    /// 全部任务共享 `data`（只增引用计数）；无路由时零分配。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    /// * `data` - 通道数据（单来源时由引擎零拷贝给出）。
    /// * `now_ms` - 当前逻辑时间（毫秒），供限速使用。
    /// * `target` - 输出目标。
    /// * `rate_limited` - 是否应用 44Hz 限速；被拒的帧计入输出统计的 `dropped`。
    /// * `out` - 任务输出缓冲（调用方复用以免重复分配）。
    pub fn plan_into(
        &self,
        universe: u16,
        data: Bytes,
        now_ms: u64,
        target: &DispatchTarget,
        rate_limited: bool,
        out: &mut Vec<ForwardJob>,
    ) {
        self.plan_with(universe, || data.clone(), now_ms, target, rate_limited, out);
    }

    /// 按给定的编译路由快照解析转发表路由，追加到 `out`（批量处理时避免逐帧读取快照）。
    ///
    /// # Arguments
    ///
    /// * `routes` - 由 [`Dispatcher::routes`] 取得的快照（限速状态随快照共享）。
    /// * `universe` - 源 Universe。
    /// * `data` - 通道数据，由全部任务共享。
    /// * `now_ms` - 当前逻辑时间（毫秒），供限速使用。
    /// * `rate_limited` - 是否应用 44Hz 限速。
    /// * `out` - 任务输出缓冲。
    pub fn plan_routes_into(
        &self,
        routes: &CompiledRoutes,
        universe: u16,
        data: Bytes,
        now_ms: u64,
        rate_limited: bool,
        out: &mut Vec<ForwardJob>,
    ) {
        self.plan_forwarding(routes, universe, || data.clone(), now_ms, rate_limited, out);
    }

    /// 解析的公共实现：`data` 只在真正产出任务时才被调用。
    fn plan_with(
        &self,
        universe: u16,
        mut data: impl FnMut() -> Bytes,
        now_ms: u64,
        target: &DispatchTarget,
        rate_limited: bool,
        out: &mut Vec<ForwardJob>,
    ) {
        match target {
            DispatchTarget::Forwarding => {
                let routes = self.inner.compiled.load();
                self.plan_forwarding(&routes, universe, data, now_ms, rate_limited, out);
            }
            DispatchTarget::Direct { ip, protocol, port } => {
                if *protocol == ForwardProtocol::Sacn
                    && !self.inner.sacn_enabled.load(Ordering::Relaxed)
                {
                    return;
                }
                let endpoint = self.direct_endpoint(ip, *protocol, *port);
                let allowed = !rate_limited
                    || lock(&self.inner.compiled.load().limiter).allow_direct(
                        &endpoint.id,
                        universe,
                        now_ms,
                    );
                if allowed {
                    out.push(ForwardJob {
                        endpoint,
                        target_universe: universe,
                        delay_ms: 0,
                        data: data(),
                    });
                } else {
                    self.inner.ctx.stats.record_dropped_with(None);
                }
            }
            DispatchTarget::Routed { universes, .. } => {
                let Ok(i) = universes.binary_search_by_key(&universe, |u| u.universe) else {
                    return;
                };
                let sacn_on = self.inner.sacn_enabled.load(Ordering::Relaxed);
                for port in &universes[i].ports {
                    if !port.enabled || (port.protocol == ForwardProtocol::Sacn && !sacn_on) {
                        continue;
                    }
                    out.push(ForwardJob {
                        endpoint: self.routed_endpoint(port),
                        target_universe: port.remote_universe,
                        delay_ms: 0,
                        data: data(),
                    });
                }
            }
        }
    }

    /// 路由端口的端点：按 `(协议, IP, 端口, 优先级)` 缓存，逐帧复用。
    fn routed_endpoint(&self, port: &RoutedPort) -> Arc<Endpoint> {
        let ip = port.target_ip();
        let priority = port.priority.unwrap_or(crate::routes::DEFAULT_SACN_PRIORITY);
        let key = (port.protocol == ForwardProtocol::Sacn, ip, port.port, priority);
        let mut cache = lock(&self.inner.routed);
        if let Some(e) = cache.get(&key) {
            return e.clone();
        }
        let id = format!("{ROUTED_PREFIX}{}:{}", key.1, key.2);
        let e = Arc::new(Endpoint::new(&id, port.protocol, &key.1, key.2, None).with_priority(priority));
        // 路由表很小；超出上限说明配置被反复修改，清空重建即可
        if cache.len() >= 1024 {
            cache.clear();
        }
        cache.insert(key, e.clone());
        e
    }

    /// 发送一帧（编辑器输出）：每个 `(端点, 远端 Universe)` 独立递增序列号；按同步设置给 sACN 数据包
    /// 带上同步地址，并在本帧所有数据包之后发送 ArtSync / sACN 同步包。
    ///
    /// 只处理立即发送的任务（编辑器输出不经转发表延迟）；带延迟的任务交给普通的延迟队列。
    ///
    /// # Arguments
    ///
    /// * `jobs` - 本帧的发送任务；返回时为空。
    /// * `seqs` - 序列号表（每个输出会话一份）。
    /// * `sync` - 帧同步设置；`None` 为不同步。
    pub async fn send_frame(&self, jobs: &mut Vec<ForwardJob>, seqs: &mut SequenceTable, sync: Option<OutputSync>) {
        if jobs.is_empty() {
            return;
        }
        let ctx = &self.inner.ctx;
        let sender = ctx.sender.load_full();
        let sync = sync.unwrap_or_default();
        let sacn_sync = sync.sacn_sync_universe.unwrap_or(0);
        let mut artnet_addrs: Vec<SocketAddr> = Vec::new();
        let mut sacn_unicast: Vec<SocketAddr> = Vec::new();
        let mut delay_tx: Option<UnboundedSender<Delayed>> = None;
        for job in jobs.drain(..) {
            if job.delay_ms > 0 {
                self.inner.delay.submit(ctx, &mut delay_tx, job);
                continue;
            }
            let seq = seqs.next(&job.endpoint.id, job.endpoint.protocol, job.target_universe);
            let sent = send_one_with(sender.as_deref(), ctx, &job, seq, sacn_sync, false).await;
            if let (true, Some(addr)) = (sent, job.endpoint.addr) {
                let list = match job.endpoint.protocol {
                    ForwardProtocol::ArtNet => &mut artnet_addrs,
                    ForwardProtocol::Sacn => &mut sacn_unicast,
                };
                if !list.contains(&addr) {
                    list.push(addr);
                }
            }
        }
        let Some(s) = sender.as_deref() else { return };
        if sync.art_sync {
            for addr in artnet_addrs {
                if s.send_artsync(addr).await.is_err() {
                    ctx.health.report_error();
                }
            }
        }
        if sacn_sync > 0 {
            let seq = seqs.next_sync(sacn_sync);
            // 组播组 + 单播接收端（只接单播的节点收不到组播同步包）
            let _ = s.send_sacn_sync(None, sacn_sync, seq).await;
            for addr in sacn_unicast.into_iter().filter(|a| !a.ip().is_multicast()) {
                let _ = s.send_sacn_sync(Some(addr), sacn_sync, seq).await;
            }
        }
    }

    /// 停止输出时给本会话用过的 sACN 流各发 3 次 Stream_Terminated（接收端立即释放本源，
    /// 不必等 2.5 秒超时）。
    ///
    /// # Arguments
    ///
    /// * `streams` - 用过的 `(端点, 远端 Universe)`。
    /// * `seqs` - 序列号表。
    pub async fn terminate_sacn(&self, streams: &[(Arc<Endpoint>, u16)], seqs: &mut SequenceTable) {
        let ctx = &self.inner.ctx;
        let sender = ctx.sender.load_full();
        let blank = Bytes::from_static(&[0u8; 512]);
        for _ in 0..3 {
            for (endpoint, universe) in streams {
                let job = ForwardJob { endpoint: endpoint.clone(), target_universe: *universe, delay_ms: 0, data: blank.clone() };
                let seq = seqs.next(&endpoint.id, endpoint.protocol, *universe);
                send_one_with(sender.as_deref(), ctx, &job, seq, 0, true).await;
            }
        }
    }

    /// 经转发表解析：位图判空 → 逐目的地解析 → 限速（最多加一次锁）。
    fn plan_forwarding(
        &self,
        routes: &CompiledRoutes,
        universe: u16,
        mut data: impl FnMut() -> Bytes,
        now_ms: u64,
        rate_limited: bool,
        out: &mut Vec<ForwardJob>,
    ) {
        if !routes.has_routes(universe) {
            return;
        }
        let mut limiter = rate_limited.then(|| lock(&routes.limiter));
        for d in &routes.dests {
            let Some(route) = d.resolve(universe) else {
                continue;
            };
            let allowed = limiter
                .as_mut()
                .is_none_or(|l| l.allow_slot(d.slot, route.target_universe, now_ms));
            if allowed {
                out.push(ForwardJob {
                    endpoint: d.endpoint.clone(),
                    target_universe: route.target_universe,
                    delay_ms: route.delay_ms,
                    data: data(),
                });
            } else {
                self.inner
                    .ctx
                    .stats
                    .record_dropped_with(d.endpoint.counters.as_deref());
            }
        }
    }

    /// 直发端点：与上次相同则复用缓存，否则新建并缓存。
    fn direct_endpoint(&self, ip: &str, protocol: ForwardProtocol, port: u16) -> Arc<Endpoint> {
        let cached = self.inner.direct.load();
        if let Some(e) = &*cached {
            if e.is_direct(ip, protocol, port) {
                return Arc::clone(e);
            }
        }
        let id = format!("{DIRECT_PREFIX}{ip}:{port}");
        let e = Arc::new(Endpoint::new(&id, protocol, ip, port, None));
        self.inner.direct.store(Some(e.clone()));
        e
    }

    /// 发送任务：延迟为 0 的立即发送，其余交给延迟队列在到期后发送。
    ///
    /// # Arguments
    ///
    /// * `jobs` - 由 [`Dispatcher::plan`] 生成的发送任务列表。
    pub async fn send_jobs(&self, jobs: Vec<ForwardJob>) {
        let mut jobs = jobs;
        self.send_batch(&mut jobs).await;
    }

    /// 发送并清空一批任务（保留 `jobs` 的容量供下一批复用）。
    ///
    /// 延迟为 0 的按顺序立即发送；其余交给常驻的延迟队列 worker（首次需要时在当前 tokio
    /// 运行时内启动），同一到期时刻按提交顺序发送。
    ///
    /// # Arguments
    ///
    /// * `jobs` - 待发送任务；返回时为空。
    pub async fn send_batch(&self, jobs: &mut Vec<ForwardJob>) {
        if jobs.is_empty() {
            return;
        }
        let ctx = &self.inner.ctx;
        let sender = ctx.sender.load_full();
        let mut delay_tx: Option<UnboundedSender<Delayed>> = None;
        for job in jobs.drain(..) {
            if job.delay_ms == 0 {
                send_one(sender.as_deref(), ctx, &job).await;
            } else {
                self.inner.delay.submit(ctx, &mut delay_tx, job);
            }
        }
    }

    /// 解析并发送（`plan` + `send_jobs`）。仅测试便捷封装。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    /// * `data` - 通道数据。
    /// * `now_ms` - 当前逻辑时间（毫秒），供限速使用。
    /// * `target` - 输出目标。
    /// * `rate_limited` - 是否应用 44Hz 限速。
    #[cfg(test)]
    pub async fn dispatch(
        &self,
        universe: u16,
        data: &[u8],
        now_ms: u64,
        target: &DispatchTarget,
        rate_limited: bool,
    ) {
        let jobs = self.plan(universe, data, now_ms, target, rate_limited);
        self.send_jobs(jobs).await;
    }
}

/// 执行一次发送（Art-Net 或 sACN 单播到目标），并把成败上报给健康度与输出统计。
///
/// 目标 IP 非法属于配置错误：计入输出统计的错误数，但不影响发送器健康度。
/// 发送器尚未就绪（`sender` 为 `None`）时静默忽略（发送器缺失由监督任务负责创建，不算发送失败）。
pub(crate) async fn send_one(sender: Option<&DmxSender>, ctx: &SendCtx, job: &ForwardJob) {
    send_one_with(sender, ctx, job, 0, 0, false).await;
}

/// 执行一次发送，可指定序列号、sACN 同步地址与 Stream_Terminated 标志。
///
/// # Arguments
///
/// * `sender` - 发送器；尚未就绪时静默忽略。
/// * `ctx` - 健康度与统计。
/// * `job` - 发送任务（端点带 sACN 优先级）。
/// * `sequence` - 序列号（Art-Net 的 0 表示禁用序列）。
/// * `sync_universe` - sACN 同步地址；0 为不同步。
/// * `terminated` - sACN Stream_Terminated 标志。
///
/// # Returns
///
/// 数据报成功交给套接字时为 `true`。
pub(crate) async fn send_one_with(
    sender: Option<&DmxSender>,
    ctx: &SendCtx,
    job: &ForwardJob,
    sequence: u8,
    sync_universe: u16,
    terminated: bool,
) -> bool {
    let ep = &*job.endpoint;
    let counters = ep.counters.as_deref();
    let Some(addr) = ep.addr else {
        ctx.stats
            .record_error_with(counters, &format!("目标 IP 无效: {}", ep.target_ip));
        return false;
    };
    let Some(s) = sender else { return false };
    let result = match ep.protocol {
        ForwardProtocol::ArtNet => s.send_artnet(addr, job.target_universe, sequence, &job.data).await,
        ForwardProtocol::Sacn => {
            s.send_sacn_ext(
                Some(addr),
                job.target_universe,
                sequence,
                ep.priority,
                sync_universe,
                terminated,
                &job.data,
            )
            .await
        }
    };
    match result {
        Ok(()) => {
            ctx.health.report_ok();
            ctx.stats.record_sent_with(counters);
            true
        }
        Err(e) => {
            ctx.health.report_error();
            ctx.stats.record_error_with(counters, &e.to_string());
            false
        }
    }
}

/// 输出会话的序列号表：每个 `(端点, 远端 Universe)` 独立递增。
///
/// Art-Net 的序列号 0 表示“不启用序列”，因此在 1~255 之间循环；sACN 在 0~255 之间循环。
#[derive(Debug, Default)]
pub struct SequenceTable {
    data: rustc_hash::FxHashMap<(Arc<str>, u16), u8>,
    sync: rustc_hash::FxHashMap<u16, u8>,
}

impl SequenceTable {
    /// 下一个数据包序列号。
    ///
    /// # Arguments
    ///
    /// * `endpoint` - 端点 id。
    /// * `protocol` - 协议（决定循环范围）。
    /// * `universe` - 远端 Universe。
    ///
    /// # Returns
    ///
    /// 序列号。
    pub fn next(&mut self, endpoint: &Arc<str>, protocol: ForwardProtocol, universe: u16) -> u8 {
        let entry = self.data.entry((endpoint.clone(), universe)).or_insert(0);
        *entry = match (protocol, entry.wrapping_add(1)) {
            (ForwardProtocol::ArtNet, 0) => 1,
            (_, v) => v,
        };
        *entry
    }

    /// 下一个 sACN 同步包序列号。
    ///
    /// # Arguments
    ///
    /// * `sync_universe` - 同步 Universe。
    ///
    /// # Returns
    ///
    /// 序列号。
    pub fn next_sync(&mut self, sync_universe: u16) -> u8 {
        let entry = self.sync.entry(sync_universe).or_insert(0);
        *entry = entry.wrapping_add(1);
        *entry
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::Duration;

    use arc_swap::ArcSwapOption;
    use artnet_net::artnet::{self, ArtNetPacket};
    use artnet_net::socket::DmxSender;
    use artnet_net::Bytes;
    use forwarding::{
        ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable, OverrideAction,
        UniverseOverride,
    };
    use tokio::net::UdpSocket;

    use super::{DispatchTarget, Dispatcher, ForwardJob};
    use crate::routes::Endpoint;
    use crate::sender::SenderSlot;

    fn dest(id: &str, port: u16, mode: ForwardMode) -> ForwardDestination {
        ForwardDestination {
            id: id.into(),
            name: id.into(),
            target_ip: "127.0.0.1".into(),
            protocol: ForwardProtocol::ArtNet,
            port,
            mode,
            universe_offset: 0,
            default_delay_ms: 0,
            description: String::new(),
            enabled: true,
            overrides: Vec::new(),
        }
    }

    fn dispatcher(table: ForwardingTable) -> Dispatcher {
        Dispatcher::with_table(table, SenderSlot::default())
    }

    /// 已就绪的真实 UDP 发送器槽位。
    async fn live_sender() -> SenderSlot {
        Arc::new(ArcSwapOption::new(Some(Arc::new(
            DmxSender::new([0u8; 16]).await.unwrap(),
        ))))
    }

    /// 归属目的地 `bad`、指向 `ip:port` 的任务。
    fn job_to(d: &Dispatcher, ip: &str, port: u16, universe: u16, delay_ms: u16) -> ForwardJob {
        ForwardJob {
            endpoint: Arc::new(Endpoint::new(
                "bad",
                ForwardProtocol::ArtNet,
                ip,
                port,
                d.output_stats().dest_counters("bad"),
            )),
            target_universe: universe,
            delay_ms,
            data: Bytes::from_static(&[1u8]),
        }
    }

    /// 发往一个本机 IPv4 套接字无法到达的地址族（IPv6），发送必然失败。
    fn failing_job(d: &Dispatcher) -> ForwardJob {
        job_to(d, "::1", 6454, 1, 0)
    }

    /// 从 ArtDmx 包里取出 Port-Address。
    fn port_address(buf: &[u8]) -> u16 {
        match artnet::parse(buf) {
            Some(ArtNetPacket::Dmx { port_address, .. }) => port_address,
            other => panic!("期望 ArtDmx，实际 {other:?}"),
        }
    }

    /// 连续发送失败会把发送器标记为需要重建；中间夹着成功则不会。
    #[tokio::test]
    async fn send_failures_are_reported_to_sender_health() {
        let d = Dispatcher::with_table(ForwardingTable::default(), live_sender().await);
        let health = d.health();
        assert_eq!(health.state(), crate::sender::SenderState::Ready);

        let ok_rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let ok_job = job_to(&d, "127.0.0.1", ok_rx.local_addr().unwrap().port(), 1, 0);
        for _ in 0..crate::sender::FAIL_STREAK_THRESHOLD - 1 {
            d.send_jobs(vec![failing_job(&d)]).await;
        }
        d.send_jobs(vec![ok_job]).await;
        for _ in 0..crate::sender::FAIL_STREAK_THRESHOLD - 1 {
            d.send_jobs(vec![failing_job(&d)]).await;
        }
        assert_eq!(
            health.state(),
            crate::sender::SenderState::Ready,
            "成功会打断连续失败"
        );

        d.send_jobs(vec![failing_job(&d)]).await;
        assert_eq!(health.state(), crate::sender::SenderState::Reconnecting);
    }

    /// 发送器尚未创建时发送被静默忽略，不能算作发送失败。
    #[tokio::test]
    async fn missing_sender_is_not_counted_as_a_failure() {
        let d = dispatcher(ForwardingTable::default());
        for _ in 0..crate::sender::FAIL_STREAK_THRESHOLD * 2 {
            d.send_jobs(vec![failing_job(&d)]).await;
        }
        assert_eq!(d.health().state(), crate::sender::SenderState::Ready);
    }

    /// 发送器槽位被替换后，后续发送立即使用新的发送器（无锁读取）。
    #[tokio::test]
    async fn sender_slot_swaps_are_picked_up() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let slot = SenderSlot::default();
        let d = Dispatcher::with_table(
            ForwardingTable {
                destinations: vec![dest("a", port, ForwardMode::All)],
            },
            slot.clone(),
        );
        d.dispatch(1, &[1], 0, &DispatchTarget::Forwarding, false)
            .await;
        assert_eq!(d.output_stats().snapshot().sent, 0, "发送器为空时静默忽略");

        slot.store(Some(Arc::new(DmxSender::new([0u8; 16]).await.unwrap())));
        d.dispatch(1, &[1], 0, &DispatchTarget::Forwarding, false)
            .await;
        let mut buf = [0u8; 2048];
        tokio::time::timeout(Duration::from_secs(2), rx.recv_from(&mut buf))
            .await
            .expect("应收到包")
            .unwrap();
        assert_eq!(d.output_stats().snapshot().sent, 1);
    }

    #[test]
    fn plan_applies_offset_override_and_delay() {
        let mut a = dest("a", 6454, ForwardMode::All);
        a.universe_offset = 100;
        a.default_delay_ms = 50;
        let mut b = dest("b", 6455, ForwardMode::Selected);
        b.overrides.push(UniverseOverride {
            source_universe: 3,
            action: OverrideAction::Forward,
            target_universe: Some(30),
            delay_ms: Some(7),
        });
        let d = dispatcher(ForwardingTable {
            destinations: vec![a, b],
        });

        let jobs = d.plan(3, &[1, 2, 3], 0, &DispatchTarget::Forwarding, true);
        assert_eq!(jobs.len(), 2);
        assert_eq!(
            (
                jobs[0].target_universe,
                jobs[0].delay_ms,
                jobs[0].endpoint.port
            ),
            (103, 50, 6454)
        );
        assert_eq!(
            (
                jobs[1].target_universe,
                jobs[1].delay_ms,
                jobs[1].endpoint.port
            ),
            (30, 7, 6455)
        );
        assert_eq!(jobs[0].data, vec![1, 2, 3]);
        assert_eq!(&*jobs[0].endpoint.id, "a");
        assert_eq!(&*jobs[1].endpoint.id, "b");
        assert_eq!(
            jobs[0].endpoint.addr,
            Some("127.0.0.1:6454".parse().unwrap())
        );

        // Universe 4 只命中 All 模式的目的地 a
        let jobs = d.plan(4, &[9], 1000, &DispatchTarget::Forwarding, true);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].target_universe, 104);
    }

    /// `plan_into` 与 `plan` 结果一致，且全部任务共享同一份负载（不拷贝）。
    #[test]
    fn plan_into_matches_plan_and_shares_the_payload() {
        let mut a = dest("a", 6454, ForwardMode::All);
        a.universe_offset = 10;
        let d = dispatcher(ForwardingTable {
            destinations: vec![
                a,
                dest("b", 6455, ForwardMode::All),
                dest("c", 6456, ForwardMode::All),
            ],
        });
        let data = Bytes::from(vec![7u8; 512]);
        let mut out = Vec::new();
        d.plan_into(
            5,
            data.clone(),
            0,
            &DispatchTarget::Forwarding,
            false,
            &mut out,
        );
        assert_eq!(out, d.plan(5, &data, 0, &DispatchTarget::Forwarding, false));
        assert_eq!(out.len(), 3);
        assert!(
            out.iter().all(|j| j.data.as_ptr() == data.as_ptr()),
            "多条路由共享同一个 Bytes"
        );

        // 追加而不清空
        d.plan_into(
            6,
            data.clone(),
            0,
            &DispatchTarget::Forwarding,
            false,
            &mut out,
        );
        assert_eq!(out.len(), 6);
    }

    #[test]
    fn plan_rate_limits_live_traffic_but_not_playback() {
        let d = dispatcher(ForwardingTable {
            destinations: vec![dest("a", 6454, ForwardMode::All)],
        });
        // 实时：同一目的地同一 Universe 10ms 内的第二帧被限速丢弃
        assert_eq!(
            d.plan(1, &[1], 0, &DispatchTarget::Forwarding, true).len(),
            1
        );
        assert_eq!(
            d.plan(1, &[2], 10, &DispatchTarget::Forwarding, true).len(),
            0
        );
        assert_eq!(
            d.plan(1, &[3], 30, &DispatchTarget::Forwarding, true).len(),
            1
        );
        // 回放：不限速，帧节奏由文件时间轴决定
        assert_eq!(
            d.plan(1, &[4], 31, &DispatchTarget::Forwarding, false)
                .len(),
            1
        );
        assert_eq!(
            d.plan(1, &[5], 32, &DispatchTarget::Forwarding, false)
                .len(),
            1
        );
    }

    #[test]
    fn disabled_and_unmatched_destinations_produce_no_jobs() {
        let mut off = dest("off", 6454, ForwardMode::All);
        off.enabled = false;
        let d = dispatcher(ForwardingTable {
            destinations: vec![off, dest("sel", 6454, ForwardMode::Selected)],
        });
        assert!(d
            .plan(1, &[1], 0, &DispatchTarget::Forwarding, false)
            .is_empty());
        assert!(!d.has_routes(1));
        assert_eq!(d.enabled_destinations(), 1);
    }

    #[test]
    fn direct_target_keeps_universe_and_ignores_forwarding_table() {
        let d = dispatcher(ForwardingTable::default());
        let target = DispatchTarget::Direct {
            ip: "192.168.1.50".into(),
            protocol: ForwardProtocol::Sacn,
            port: 5568,
        };
        let jobs = d.plan(7, &[1, 2], 0, &target, false);
        assert_eq!(jobs.len(), 1);
        assert_eq!(&*jobs[0].endpoint.target_ip, "192.168.1.50");
        assert_eq!(
            jobs[0].endpoint.addr,
            Some("192.168.1.50:5568".parse::<SocketAddr>().unwrap())
        );
        assert_eq!(&*jobs[0].endpoint.id, "direct:192.168.1.50:5568");
        assert!(jobs[0].endpoint.counters.is_none(), "直发目标只计全局统计");
        assert_eq!(
            (
                jobs[0].target_universe,
                jobs[0].delay_ms,
                jobs[0].endpoint.port
            ),
            (7, 0, 5568)
        );
        assert_eq!(jobs[0].endpoint.protocol, ForwardProtocol::Sacn);

        // 同一直发目标复用端点；换目标则新建
        let again = d.plan(8, &[1], 0, &target, false);
        assert!(Arc::ptr_eq(&jobs[0].endpoint, &again[0].endpoint));
        let other = DispatchTarget::Direct {
            ip: "192.168.1.51".into(),
            protocol: ForwardProtocol::Sacn,
            port: 5568,
        };
        assert_eq!(
            &*d.plan(8, &[1], 0, &other, false)[0].endpoint.target_ip,
            "192.168.1.51"
        );
    }

    /// 直发目标开启限速时按 `direct:ip:port` × Universe 独立限速，被拒计入全局 `dropped`。
    #[test]
    fn rate_limited_direct_target_is_limited_per_target_and_universe() {
        let d = dispatcher(ForwardingTable::default());
        let direct = |port| DispatchTarget::Direct {
            ip: "10.0.0.9".into(),
            protocol: ForwardProtocol::ArtNet,
            port,
        };
        assert_eq!(d.plan(1, &[1], 0, &direct(6454), true).len(), 1);
        assert_eq!(d.plan(1, &[1], 10, &direct(6454), true).len(), 0);
        assert_eq!(
            d.plan(2, &[1], 10, &direct(6454), true).len(),
            1,
            "不同 Universe 独立"
        );
        assert_eq!(
            d.plan(1, &[1], 10, &direct(6455), true).len(),
            1,
            "不同目标独立"
        );
        assert_eq!(d.plan(1, &[1], 22, &direct(6454), true).len(), 1);
        let snap = d.output_stats().snapshot();
        assert_eq!(snap.dropped, 1);
        assert!(snap.destinations.is_empty());
    }

    #[test]
    fn sacn_off_drops_sacn_routes_but_keeps_artnet() {
        let mut sacn_dest = dest("s", 5568, ForwardMode::All);
        sacn_dest.protocol = ForwardProtocol::Sacn;
        let d = dispatcher(ForwardingTable {
            destinations: vec![dest("a", 6454, ForwardMode::All), sacn_dest],
        });
        assert_eq!(
            d.plan(1, &[1], 0, &DispatchTarget::Forwarding, false).len(),
            2
        );

        d.set_sacn_enabled(false);
        let jobs = d.plan(1, &[1], 0, &DispatchTarget::Forwarding, false);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].endpoint.protocol, ForwardProtocol::ArtNet);

        // 回放直发 sACN 同样被拦截；直发 Art-Net 不受影响
        let direct = |protocol| DispatchTarget::Direct {
            ip: "10.0.0.9".into(),
            protocol,
            port: 5568,
        };
        assert!(d
            .plan(1, &[1], 0, &direct(ForwardProtocol::Sacn), false)
            .is_empty());
        assert_eq!(
            d.plan(1, &[1], 0, &direct(ForwardProtocol::ArtNet), false)
                .len(),
            1
        );

        // 关闭时 sACN 目的地不计入"可用目的地"（回放页据此提示没有可用目的地）
        assert_eq!(d.enabled_destinations(), 1);

        // 重新开启后恢复（已有的 sACN 目的地数据没有被改动）
        d.set_sacn_enabled(true);
        assert_eq!(d.enabled_destinations(), 2);
        assert_eq!(
            d.plan(1, &[1], 100, &DispatchTarget::Forwarding, false)
                .len(),
            2
        );
    }

    /// `has_routes` 跟随转发表与 sACN 开关；sACN 开关切换不清空限速状态（与旧版一致）。
    #[test]
    fn has_routes_follows_table_and_sacn_switch() {
        let mut s = dest("s", 5568, ForwardMode::Selected);
        s.protocol = ForwardProtocol::Sacn;
        s.overrides.push(UniverseOverride {
            source_universe: 9,
            action: OverrideAction::Forward,
            target_universe: None,
            delay_ms: None,
        });
        let d = dispatcher(ForwardingTable {
            destinations: vec![s],
        });
        assert!(d.has_routes(9) && !d.has_routes(8));
        assert_eq!(
            d.plan(9, &[1], 0, &DispatchTarget::Forwarding, true).len(),
            1
        );

        d.set_sacn_enabled(false);
        assert!(!d.has_routes(9), "sACN 关闭后 sACN 目的地不参与");
        d.set_sacn_enabled(true);
        assert!(d.has_routes(9));
        assert!(
            d.plan(9, &[1], 10, &DispatchTarget::Forwarding, true)
                .is_empty(),
            "切换 sACN 开关不重置限速"
        );

        d.set_table(ForwardingTable {
            destinations: vec![dest("a", 6454, ForwardMode::All)],
        });
        assert!(
            d.has_routes(8) && d.has_routes(0x7FFF) && d.has_routes(0x8000) && d.has_routes(65_535)
        );
        assert_eq!(d.table().destinations.len(), 1);
    }

    /// 替换转发表后限速状态清空，同 id 目的地的计数延续。
    #[test]
    fn set_table_resets_rate_limits_and_keeps_counters() {
        let table = ForwardingTable {
            destinations: vec![dest("a", 6454, ForwardMode::All)],
        };
        let d = dispatcher(table.clone());
        assert_eq!(
            d.plan(1, &[1], 0, &DispatchTarget::Forwarding, true).len(),
            1
        );
        assert_eq!(
            d.plan(1, &[1], 5, &DispatchTarget::Forwarding, true).len(),
            0
        );

        let mut edited = table;
        edited.destinations[0].universe_offset = 0;
        edited.destinations[0].name = "renamed".into();
        d.set_table(edited);
        assert_eq!(
            d.plan(1, &[1], 6, &DispatchTarget::Forwarding, true).len(),
            1,
            "限速已清空"
        );
        assert_eq!(
            d.plan(1, &[1], 7, &DispatchTarget::Forwarding, true).len(),
            0
        );
        let snap = d.output_stats().snapshot();
        assert_eq!(snap.destinations.len(), 1);
        assert_eq!(snap.destinations[0].dropped, 2, "计数跨编辑延续");

        // `reset_rate_limits` 同样清空
        d.reset_rate_limits();
        assert_eq!(
            d.plan(1, &[1], 8, &DispatchTarget::Forwarding, true).len(),
            1
        );
    }

    #[test]
    fn target_serde_uses_tagged_camel_case() {
        let t = DispatchTarget::Direct {
            ip: "1.2.3.4".into(),
            protocol: ForwardProtocol::ArtNet,
            port: 6454,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"direct","ip":"1.2.3.4","protocol":"artNet","port":6454}"#
        );
        assert_eq!(serde_json::from_str::<DispatchTarget>(&json).unwrap(), t);
        assert_eq!(
            serde_json::from_str::<DispatchTarget>(r#"{"kind":"forwarding"}"#).unwrap(),
            DispatchTarget::Forwarding
        );
    }

    /// 端到端：经转发表（偏移 100）发出的 Art-Net 包被本机 UDP 套接字收到，Universe 与数据正确。
    #[tokio::test]
    async fn dispatch_delivers_artdmx_over_udp() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();

        let mut a = dest("a", port, ForwardMode::All);
        a.universe_offset = 100;
        let d = Dispatcher::with_table(
            ForwardingTable {
                destinations: vec![a],
            },
            live_sender().await,
        );
        d.dispatch(5, &[10, 20, 30, 40], 0, &DispatchTarget::Forwarding, true)
            .await;

        let mut buf = [0u8; 2048];
        let (n, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv_from(&mut buf))
            .await
            .expect("2 秒内应收到包")
            .unwrap();
        match artnet::parse(&buf[..n]) {
            Some(ArtNetPacket::Dmx {
                port_address, data, ..
            }) => {
                assert_eq!(port_address, 105);
                assert_eq!(&data[..4], &[10, 20, 30, 40]);
            }
            other => panic!("期望 ArtDmx，实际 {other:?}"),
        }
    }

    /// 路由目标：远端编号重映射、一个 Universe 扇出到两个端口、序列号逐帧递增、帧末 ArtSync。
    #[tokio::test]
    async fn routed_target_remaps_fans_out_and_syncs() {
        use super::{OutputSync, PortMode, RoutedPort, RoutedUniverse, SequenceTable};
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let artnet = |remote| RoutedPort {
            protocol: ForwardProtocol::ArtNet,
            mode: PortMode::Unicast,
            ip: "127.0.0.1".into(),
            port,
            remote_universe: remote,
            priority: None,
            enabled: true,
        };
        let target = DispatchTarget::Routed {
            universes: vec![RoutedUniverse { universe: 3, ports: vec![artnet(0x0105), artnet(9)] }],
            sync: OutputSync { art_sync: true, sacn_sync_universe: None },
        }
        .normalized()
        .unwrap();
        let d = Dispatcher::with_table(ForwardingTable::default(), live_sender().await);
        assert!(d.plan(4, &[1], 0, &target, false).is_empty(), "未配置的 Universe 不输出");
        let mut seqs = SequenceTable::default();
        let mut buf = [0u8; 2048];
        for frame in 1..=2u8 {
            let mut jobs = d.plan(3, &[frame; 4], 0, &target, false);
            assert_eq!(jobs.len(), 2);
            d.send_frame(&mut jobs, &mut seqs, target.sync()).await;
            let mut got = Vec::new();
            for _ in 0..3 {
                let (n, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv_from(&mut buf))
                    .await
                    .expect("应收到 2 个 ArtDmx 与 1 个 ArtSync")
                    .unwrap();
                got.push(buf[..n].to_vec());
            }
            match artnet::parse(&got[0]) {
                Some(ArtNetPacket::Dmx { port_address, sequence, data }) => {
                    assert_eq!((port_address, sequence), (0x0105, frame));
                    assert_eq!(data[0], frame);
                }
                other => panic!("第一个包应是 ArtDmx：{other:?}"),
            }
            assert!(matches!(artnet::parse(&got[1]), Some(ArtNetPacket::Dmx { port_address: 9, .. })));
            assert_eq!(&got[2][8..10], &[0x00, 0x52], "帧末是 ArtSync");
        }
    }

    /// 路由表校验：Art-Net 组播、sACN 远端 0、非法 IP、同步 Universe 越界都被拒绝；同一 Universe 的端口合并。
    #[test]
    fn routed_target_validation() {
        use super::{OutputSync, PortMode, RouteError, RoutedPort, RoutedUniverse};
        let port = |protocol, mode, ip: &str, remote| RoutedPort {
            protocol,
            mode,
            ip: ip.into(),
            port: 6454,
            remote_universe: remote,
            priority: Some(255),
            enabled: true,
        };
        let routed = |ports: Vec<RoutedPort>| DispatchTarget::Routed {
            universes: vec![RoutedUniverse { universe: 1, ports }],
            sync: OutputSync::default(),
        };
        assert_eq!(
            routed(vec![port(ForwardProtocol::ArtNet, PortMode::Multicast, "", 1)]).normalized(),
            Err(RouteError::MulticastArtNet { universe: 1 })
        );
        assert_eq!(
            routed(vec![port(ForwardProtocol::Sacn, PortMode::Multicast, "", 0)]).normalized(),
            Err(RouteError::RemoteUniverse { universe: 1 })
        );
        assert_eq!(
            routed(vec![port(ForwardProtocol::ArtNet, PortMode::Unicast, "1.2.3", 1)]).normalized(),
            Err(RouteError::BadIp { universe: 1 })
        );
        let ok = DispatchTarget::Routed {
            universes: vec![
                RoutedUniverse { universe: 5, ports: vec![port(ForwardProtocol::Sacn, PortMode::Multicast, "", 7)] },
                RoutedUniverse { universe: 5, ports: vec![port(ForwardProtocol::ArtNet, PortMode::Broadcast, "255.255.255.255", 5)] },
                RoutedUniverse { universe: 2, ports: vec![port(ForwardProtocol::ArtNet, PortMode::Unicast, "10.0.0.1", 2)] },
            ],
            sync: OutputSync { art_sync: false, sacn_sync_universe: Some(64_000) },
        };
        assert_eq!(ok.clone().normalized(), Err(RouteError::SyncUniverse));
        let DispatchTarget::Routed { universes, .. } = (DispatchTarget::Routed {
            universes: match ok { DispatchTarget::Routed { universes, .. } => universes, _ => unreachable!() },
            sync: OutputSync::default(),
        })
        .normalized()
        .unwrap() else { unreachable!() };
        assert_eq!(universes.iter().map(|u| (u.universe, u.ports.len())).collect::<Vec<_>>(), vec![(2, 1), (5, 2)]);
        assert_eq!(universes[1].ports[0].priority, Some(200));
        assert_eq!(universes[1].ports[0].target_ip(), "239.255.0.7");
    }

    /// 序列号：Art-Net 跳过 0（0 表示禁用序列），sACN 0~255 循环；不同 Universe 独立。
    #[test]
    fn sequence_table_wraps_per_stream() {
        let mut s = super::SequenceTable::default();
        let id: Arc<str> = Arc::from("x");
        for _ in 0..255 {
            s.next(&id, ForwardProtocol::ArtNet, 1);
        }
        assert_eq!(s.next(&id, ForwardProtocol::ArtNet, 1), 1);
        assert_eq!(s.next(&id, ForwardProtocol::ArtNet, 2), 1);
        for _ in 0..255 {
            s.next(&id, ForwardProtocol::Sacn, 9);
        }
        assert_eq!(s.next(&id, ForwardProtocol::Sacn, 9), 0);
    }

    /// 延迟 > 0 的任务会在延迟之后才到达。
    #[tokio::test]
    async fn delayed_jobs_arrive_after_the_delay() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let mut a = dest("a", port, ForwardMode::All);
        a.default_delay_ms = 120;
        let d = Dispatcher::with_table(
            ForwardingTable {
                destinations: vec![a],
            },
            live_sender().await,
        );
        let start = std::time::Instant::now();
        d.dispatch(1, &[1], 0, &DispatchTarget::Forwarding, true)
            .await;
        let mut buf = [0u8; 2048];
        tokio::time::timeout(Duration::from_secs(2), rx.recv_from(&mut buf))
            .await
            .expect("应收到包")
            .unwrap();
        assert!(
            start.elapsed() >= Duration::from_millis(100),
            "{:?}",
            start.elapsed()
        );
    }

    /// 延迟队列按到期时刻发送，同一到期时刻按提交顺序；立即任务不经队列。
    #[tokio::test]
    async fn delayed_jobs_are_sent_in_due_order() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let d = Dispatcher::with_table(ForwardingTable::default(), live_sender().await);
        // (Universe, 延迟)：两条 20ms 的任务按提交顺序 2 → 4
        let plan = [(1u16, 90u16), (2, 30), (3, 60), (4, 30), (5, 0)];
        let jobs: Vec<ForwardJob> = plan
            .iter()
            .map(|&(u, delay)| job_to(&d, "127.0.0.1", port, u, delay))
            .collect();
        d.send_jobs(jobs).await;

        let mut got = Vec::new();
        let mut buf = [0u8; 2048];
        for _ in 0..plan.len() {
            let (n, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv_from(&mut buf))
                .await
                .expect("应收到全部包")
                .unwrap();
            got.push(port_address(&buf[..n]));
        }
        assert_eq!(got, vec![5, 2, 4, 3, 1]);
        assert_eq!(d.output_stats().snapshot().sent, 5);
    }

    /// 延迟队列 worker 随所在运行时退出后，下一次提交会在新的运行时里自动重启。
    #[test]
    fn delay_worker_restarts_on_a_new_runtime() {
        let rt = || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
        };
        let rx = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = rx.local_addr().unwrap().port();
        // 分发器在运行时之外构造
        let d = Dispatcher::with_table(ForwardingTable::default(), SenderSlot::default());
        let first = rt();
        first.block_on(async {
            d.inner
                .ctx
                .sender
                .store(Some(Arc::new(DmxSender::new([0u8; 16]).await.unwrap())));
        });
        rx.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut buf = [0u8; 2048];

        first.block_on(async {
            d.send_jobs(vec![job_to(&d, "127.0.0.1", port, 11, 5)])
                .await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let (n, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(port_address(&buf[..n]), 11);
        drop(first);

        let second = rt();
        // 发送器绑定在已关闭的运行时上：换一个新的
        second.block_on(async {
            d.inner
                .ctx
                .sender
                .store(Some(Arc::new(DmxSender::new([0u8; 16]).await.unwrap())));
            d.send_jobs(vec![job_to(&d, "127.0.0.1", port, 12, 5)])
                .await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let (n, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(port_address(&buf[..n]), 12);
    }

    /// 经转发表发出的包会计入全局与目的地的 `sent`，且直发目标只计入全局。
    #[tokio::test]
    async fn successful_sends_are_counted_per_destination() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let d = Dispatcher::with_table(
            ForwardingTable {
                destinations: vec![dest("a", port, ForwardMode::All)],
            },
            live_sender().await,
        );
        d.dispatch(1, &[1], 0, &DispatchTarget::Forwarding, true)
            .await;
        d.dispatch(2, &[1], 0, &DispatchTarget::Forwarding, true)
            .await;
        let direct = DispatchTarget::Direct {
            ip: "127.0.0.1".into(),
            protocol: ForwardProtocol::ArtNet,
            port,
        };
        d.dispatch(3, &[1], 0, &direct, false).await;

        let snap = d.output_stats().snapshot();
        assert_eq!(snap.sent, 3);
        assert_eq!(snap.errors, 0);
        assert_eq!(snap.destinations.len(), 1, "直发目标不单独列出");
        assert_eq!(snap.destinations[0].id, "a");
        assert_eq!(snap.destinations[0].sent, 2);
        assert!(snap.destinations[0].last_send_ago_ms.is_some());
    }

    /// 被 44Hz 限速器丢弃的帧计入 `dropped`；回放（不限速）不会产生丢弃。
    #[test]
    fn rate_limited_frames_are_counted_as_dropped() {
        let d = dispatcher(ForwardingTable {
            destinations: vec![dest("a", 6454, ForwardMode::All)],
        });
        assert_eq!(
            d.plan(1, &[1], 0, &DispatchTarget::Forwarding, true).len(),
            1
        );
        assert_eq!(
            d.plan(1, &[2], 5, &DispatchTarget::Forwarding, true).len(),
            0
        );
        assert_eq!(
            d.plan(1, &[3], 8, &DispatchTarget::Forwarding, true).len(),
            0
        );
        assert_eq!(
            d.plan(1, &[4], 9, &DispatchTarget::Forwarding, false).len(),
            1
        );

        let snap = d.output_stats().snapshot();
        assert_eq!(snap.dropped, 2);
        assert_eq!(snap.destinations[0].id, "a");
        assert_eq!(snap.destinations[0].dropped, 2);
    }

    /// 发送失败计入 `errors` 并记录原因；目标 IP 非法同样计为错误，但不影响发送器健康度。
    #[tokio::test]
    async fn failed_and_invalid_sends_are_counted_as_errors() {
        let d = Dispatcher::with_table(ForwardingTable::default(), live_sender().await);
        d.send_jobs(vec![failing_job(&d)]).await;
        let snap = d.output_stats().snapshot();
        assert_eq!(snap.errors, 1);
        assert!(snap.last_error.is_some());
        assert_eq!(snap.destinations[0].id, "bad");
        assert_eq!(snap.destinations[0].errors, 1);

        let invalid = job_to(&d, "not-an-ip", 6454, 1, 0);
        assert_eq!(invalid.endpoint.addr, None);
        d.send_jobs(vec![invalid]).await;
        let snap = d.output_stats().snapshot();
        assert_eq!(snap.errors, 2);
        assert_eq!(snap.last_error.as_deref(), Some("目标 IP 无效: not-an-ip"));
        assert_eq!(snap.destinations[0].errors, 2);
        assert_eq!(
            d.health().state(),
            crate::sender::SenderState::Ready,
            "非法 IP 不算套接字故障"
        );
    }

    /// 转发表里的非法 IP 在编译时保留"无效"标记，发送时照旧计一次错误（即使发送器尚未就绪）。
    #[tokio::test]
    async fn invalid_ip_in_table_is_counted_on_send() {
        let mut a = dest("a", 6454, ForwardMode::All);
        a.target_ip = "10.0.0".into();
        let d = dispatcher(ForwardingTable {
            destinations: vec![a],
        });
        d.dispatch(1, &[1], 0, &DispatchTarget::Forwarding, false)
            .await;
        let snap = d.output_stats().snapshot();
        assert_eq!(snap.errors, 1);
        assert_eq!(snap.last_error.as_deref(), Some("目标 IP 无效: 10.0.0"));
        assert_eq!(snap.destinations[0].id, "a");
    }

    /// 发送器尚未创建时的静默忽略不计入任何统计。
    #[tokio::test]
    async fn missing_sender_leaves_output_stats_untouched() {
        let d = dispatcher(ForwardingTable::default());
        d.send_jobs(vec![failing_job(&d)]).await;
        let snap = d.output_stats().snapshot();
        assert_eq!((snap.sent, snap.errors, snap.dropped), (0, 0, 0));
    }

    /// 转发表变更后，已删除目的地的统计被清除，全局累计保留。
    #[test]
    fn prune_drops_stats_of_removed_destinations() {
        let d = dispatcher(ForwardingTable {
            destinations: vec![
                dest("keep", 6454, ForwardMode::All),
                dest("gone", 6455, ForwardMode::All),
            ],
        });
        d.output_stats().record_sent("keep");
        d.output_stats().record_sent("gone");
        let mut table = d.table();
        table.destinations.retain(|x| x.id == "keep");
        d.set_table(table);
        let snap = d.output_stats().snapshot();
        assert_eq!(snap.sent, 2);
        assert_eq!(snap.destinations.len(), 1);
        assert_eq!(snap.destinations[0].id, "keep");
    }
}
