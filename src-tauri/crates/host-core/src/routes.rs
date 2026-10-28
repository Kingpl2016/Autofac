//! 编译后的转发表：把 [`ForwardingTable`] 预处理成热路径友好的只读结构。
//!
//! 转发表只在用户保存或切换 sACN 开关时变化，而路由解析每秒要做上万次。编译一次即可让
//! 热路径免去加锁、字符串克隆、IP 解析与覆盖规则的线性查找：
//!
//! - 每个启用目的地预解析好 [`SocketAddr`]（IP 非法时保留原文，发送时照旧计一次错误）、
//!   `Arc<str>` 的 id、协议与该目的地的统计计数器句柄，打包成共享的 [`Endpoint`]；
//! - 覆盖规则放进 `FxHashMap<u16, _>`（同一源 Universe 有多条时与
//!   [`ForwardDestination::resolve`] 一样取第一条）；
//! - 一个覆盖 `0..=0x7FFF` 的 `has_routes` 位图，无路由的 Universe 一次位运算即可跳过；
//! - 44Hz 限速表以 `(目的地序号, 目标 Universe)` 为键，序号在编译时按 id 分配。
//!
//! 解析规则与 [`ForwardingTable::routes_for`] 完全一致（另按 sACN 开关排除 sACN 目的地），
//! 由测试在随机转发表上逐一比对保证。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use parking_lot::Mutex;

use forwarding::{
    offset_universe, ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable,
    OverrideAction, ResolvedRoute, MIN_INTERVAL_MS_44HZ,
};
use rustc_hash::FxHashMap;

use crate::output_stats::{DestCounters, OutputStats};

/// `has_routes` 位图覆盖的最大 Universe（Art-Net 15 位 Port-Address 的上限）。
///
/// 更大的 Universe（仅 sACN 可能出现）走逐目的地解析的慢路径，结果相同。
pub const BITMAP_MAX_UNIVERSE: u16 = 0x7FFF;

/// 位图的 `u64` 字数（32768 位）。
const BITMAP_WORDS: usize = (BITMAP_MAX_UNIVERSE as usize + 1) / 64;

/// sACN 默认优先级。
pub const DEFAULT_SACN_PRIORITY: u8 = 100;

/// 预解析的发送端点（编译转发表或直发目标时生成，多个发送任务经 `Arc` 共享）。
#[derive(Debug)]
pub struct Endpoint {
    /// 目的地 id（转发表条目的 id；直发目标为 `direct:ip:port`）。
    pub id: Arc<str>,
    /// 输出协议。
    pub protocol: ForwardProtocol,
    /// 目标 IP 原文（IP 非法时用于错误文案）。
    pub target_ip: Arc<str>,
    /// 目标端口。
    pub port: u16,
    /// 预解析的目标地址；`None` 表示 `target_ip` 不是合法 IP，发送时计一次错误。
    pub addr: Option<SocketAddr>,
    /// 该目的地的统计计数器；`None` 表示只计入全局统计（直发目标）。
    pub counters: Option<Arc<DestCounters>>,
    /// sACN 优先级（0~200）；Art-Net 忽略。
    pub priority: u8,
}

impl Endpoint {
    /// 构造端点并预解析目标地址。
    ///
    /// # Arguments
    ///
    /// * `id` - 目的地 id。
    /// * `protocol` - 输出协议。
    /// * `target_ip` - 目标 IP 字符串；非法或为未指定地址（`0.0.0.0`）时 `addr` 为 `None`。
    /// * `port` - 目标端口。
    /// * `counters` - 统计计数器句柄；`None` 表示只计入全局统计。
    ///
    /// # Returns
    ///
    /// 新的 [`Endpoint`]。
    #[must_use]
    pub fn new(
        id: &str,
        protocol: ForwardProtocol,
        target_ip: &str,
        port: u16,
        counters: Option<Arc<DestCounters>>,
    ) -> Self {
        Self {
            id: Arc::from(id),
            protocol,
            target_ip: Arc::from(target_ip),
            port,
            // `0.0.0.0` 是“未指定地址”，不能作为发送目标（Windows 上 sendto 报 10049）。
            // 视同非法 IP：发送时只计一次错误，不上报发送器故障，避免反复重建发送套接字。
            addr: target_ip
                .trim()
                .parse::<IpAddr>()
                .ok()
                .filter(|ip| !ip.is_unspecified())
                .map(|ip| SocketAddr::new(ip, port)),
            counters,
            priority: DEFAULT_SACN_PRIORITY,
        }
    }

    /// 设置 sACN 优先级（构造器风格）。
    ///
    /// # Arguments
    ///
    /// * `priority` - 优先级，超过 200 时被夹取。
    ///
    /// # Returns
    ///
    /// 修改后的端点。
    #[must_use]
    pub fn with_priority(mut self, priority: u8) -> Self {
        self.priority = priority.min(200);
        self
    }

    /// 是否就是给定的直发目标（直发端点缓存命中判断）。
    pub(crate) fn is_direct(&self, ip: &str, protocol: ForwardProtocol, port: u16) -> bool {
        self.counters.is_none()
            && self.protocol == protocol
            && self.port == port
            && *self.target_ip == *ip
    }
}

/// 比较 id、协议、目标与端口；计数器句柄只比较有无。
impl PartialEq for Endpoint {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.protocol == other.protocol
            && self.target_ip == other.target_ip
            && self.port == other.port
            && self.addr == other.addr
            && self.counters.is_some() == other.counters.is_some()
            && self.priority == other.priority
    }
}

impl Eq for Endpoint {}

/// 编译后的单条覆盖规则。
#[derive(Debug, Clone, Copy)]
struct CompiledOverride {
    action: OverrideAction,
    target_universe: Option<u16>,
    delay_ms: Option<u16>,
}

/// 编译后的单个目的地。
#[derive(Debug)]
pub(crate) struct CompiledDest {
    /// 共享端点（地址、id、协议、计数器）。
    pub(crate) endpoint: Arc<Endpoint>,
    /// 限速键中的目的地序号：同一 id 共用同一序号（与旧版按 id 限速的口径一致）。
    pub(crate) slot: u32,
    mode: ForwardMode,
    offset: i32,
    default_delay_ms: u16,
    /// 源 Universe → 覆盖规则（同一源 Universe 只保留第一条）。
    overrides: FxHashMap<u16, CompiledOverride>,
}

impl CompiledDest {
    /// 编译一个（已启用的）目的地。
    fn compile(d: &ForwardDestination, slot: u32, counters: Option<Arc<DestCounters>>) -> Self {
        let mut overrides = FxHashMap::default();
        for o in &d.overrides {
            // `resolve` 用 `find` 取第一条匹配，这里同样先到先得
            overrides
                .entry(o.source_universe)
                .or_insert(CompiledOverride {
                    action: o.action,
                    target_universe: o.target_universe,
                    delay_ms: o.delay_ms,
                });
        }
        Self {
            endpoint: Arc::new(Endpoint::new(
                &d.id,
                d.protocol,
                &d.target_ip,
                d.port,
                counters,
            )),
            slot,
            mode: d.mode,
            offset: d.universe_offset,
            default_delay_ms: d.default_delay_ms,
            overrides,
        }
    }

    /// 针对某源 Universe 解析转发决策（规则同 [`ForwardDestination::resolve`]）。
    #[inline]
    pub(crate) fn resolve(&self, universe: u16) -> Option<ResolvedRoute> {
        let ov = if self.overrides.is_empty() {
            None
        } else {
            self.overrides.get(&universe)
        };
        let forward = match self.mode {
            ForwardMode::All => !matches!(ov.map(|o| o.action), Some(OverrideAction::Exclude)),
            ForwardMode::Selected => matches!(ov.map(|o| o.action), Some(OverrideAction::Forward)),
        };
        if !forward {
            return None;
        }
        let target_universe = match ov.and_then(|o| o.target_universe) {
            Some(t) => t,
            None => offset_universe(universe, self.offset)?,
        };
        Some(ResolvedRoute {
            target_universe,
            delay_ms: ov.and_then(|o| o.delay_ms).unwrap_or(self.default_delay_ms),
        })
    }

    /// 把本目的地在 `0..=BITMAP_MAX_UNIVERSE` 上有路由的 Universe 并入位图。
    fn mark_routes(&self, bits: &mut [u64; BITMAP_WORDS]) {
        let in_bitmap = |u: u16| u <= BITMAP_MAX_UNIVERSE;
        match self.mode {
            ForwardMode::All => {
                // 无覆盖时：u + offset 落在 0..=65535 即有路由
                let lo = (-i64::from(self.offset)).max(0);
                let hi = (65_535 - i64::from(self.offset)).min(i64::from(BITMAP_MAX_UNIVERSE));
                if self.overrides.is_empty() {
                    set_range(bits, lo, hi);
                    return;
                }
                // 有覆盖时先算本目的地自己的位图（覆盖可能排除），再并入总位图
                let mut own = [0u64; BITMAP_WORDS];
                set_range(&mut own, lo, hi);
                for &u in self.overrides.keys().filter(|&&u| in_bitmap(u)) {
                    set_bit(&mut own, u, self.resolve(u).is_some());
                }
                for (dst, src) in bits.iter_mut().zip(own.iter()) {
                    *dst |= *src;
                }
            }
            ForwardMode::Selected => {
                for &u in self.overrides.keys().filter(|&&u| in_bitmap(u)) {
                    if self.resolve(u).is_some() {
                        set_bit(bits, u, true);
                    }
                }
            }
        }
    }
}

/// 把闭区间 `[lo, hi]`（可能为空）内的位全部置 1。
fn set_range(bits: &mut [u64; BITMAP_WORDS], lo: i64, hi: i64) {
    let (Ok(lo), Ok(hi)) = (usize::try_from(lo), usize::try_from(hi)) else {
        return;
    };
    for u in lo..=hi.min(BITMAP_WORDS * 64 - 1) {
        bits[u >> 6] |= 1 << (u & 63);
    }
}

/// 设置或清除某一位。
fn set_bit(bits: &mut [u64; BITMAP_WORDS], universe: u16, on: bool) {
    let u = usize::from(universe);
    if let Some(word) = bits.get_mut(u >> 6) {
        if on {
            *word |= 1 << (u & 63);
        } else {
            *word &= !(1 << (u & 63));
        }
    }
}

/// 44Hz 限速状态（语义同 [`forwarding::RateLimiter::allow`]，键改为无分配的定长元组）。
#[derive(Debug, Default)]
pub(crate) struct RateTable {
    /// `(目的地序号, 目标 Universe)` → 最近放行时刻（毫秒）。
    slots: FxHashMap<(u32, u16), u64>,
    /// 直发目标：`(直发 id, Universe)` → 最近放行时刻（毫秒）。只有限速的直发才会用到。
    direct: FxHashMap<(Arc<str>, u16), u64>,
}

impl RateTable {
    /// 转发表目的地：判断此刻是否放行，放行则记下时刻。
    #[inline]
    pub(crate) fn allow_slot(&mut self, slot: u32, universe: u16, now_ms: u64) -> bool {
        allow(self.slots.entry((slot, universe)), now_ms)
    }

    /// 直发目标：判断此刻是否放行，放行则记下时刻。
    pub(crate) fn allow_direct(&mut self, id: &Arc<str>, universe: u16, now_ms: u64) -> bool {
        allow(self.direct.entry((id.clone(), universe)), now_ms)
    }

    /// 清空全部限速状态。
    pub(crate) fn clear(&mut self) {
        self.slots.clear();
        self.direct.clear();
    }
}

/// 限速判定：距上次放行不足最小间隔则拒绝，否则放行并记录。
fn allow<K>(entry: std::collections::hash_map::Entry<'_, K, u64>, now_ms: u64) -> bool {
    use std::collections::hash_map::Entry;
    match entry {
        Entry::Occupied(mut e) => {
            if now_ms.saturating_sub(*e.get()) < MIN_INTERVAL_MS_44HZ {
                false
            } else {
                e.insert(now_ms);
                true
            }
        }
        Entry::Vacant(e) => {
            e.insert(now_ms);
            true
        }
    }
}

/// 编译后的转发表（不可变快照，放在 `ArcSwap` 里供热路径无锁读取）。
#[derive(Debug)]
pub struct CompiledRoutes {
    /// 参与输出的目的地（已启用；sACN 关闭时不含 sACN 目的地），保持转发表顺序。
    pub(crate) dests: Vec<CompiledDest>,
    /// `0..=BITMAP_MAX_UNIVERSE` 上"至少有一条路由"的位图。
    has_routes: Box<[u64; BITMAP_WORDS]>,
    /// 编译时的 sACN 开关。
    sacn_enabled: bool,
    /// 限速状态。转发表变更时换新（等价于清空）；仅 sACN 开关变化时沿用。
    pub(crate) limiter: Arc<Mutex<RateTable>>,
}

impl CompiledRoutes {
    /// 编译转发表（限速状态为空）。
    ///
    /// # Arguments
    ///
    /// * `table` - 转发表。
    /// * `sacn_enabled` - sACN 输出开关；为 `false` 时 sACN 目的地不参与路由。
    /// * `stats` - 输出统计；按 id 取得（必要时创建）各目的地的计数器句柄，重建时计数照常延续。
    ///
    /// # Returns
    ///
    /// 编译结果。
    #[must_use]
    pub fn compile(table: &ForwardingTable, sacn_enabled: bool, stats: &OutputStats) -> Self {
        Self::compile_with_limiter(table, sacn_enabled, stats, Arc::default())
    }

    /// 编译转发表，并沿用给定的限速状态。
    pub(crate) fn compile_with_limiter(
        table: &ForwardingTable,
        sacn_enabled: bool,
        stats: &OutputStats,
        limiter: Arc<Mutex<RateTable>>,
    ) -> Self {
        // 序号按 id 在全部启用目的地上分配（与协议无关），保证切换 sACN 开关后序号不变
        let mut slots: FxHashMap<&str, u32> = FxHashMap::default();
        let mut dests = Vec::new();
        for d in table.destinations.iter().filter(|d| d.enabled) {
            let next = u32::try_from(slots.len()).unwrap_or(u32::MAX);
            let slot = *slots.entry(d.id.as_str()).or_insert(next);
            if sacn_enabled || d.protocol != ForwardProtocol::Sacn {
                dests.push(CompiledDest::compile(d, slot, stats.dest_counters(&d.id)));
            }
        }
        let mut has_routes = Box::new([0u64; BITMAP_WORDS]);
        for d in &dests {
            d.mark_routes(&mut has_routes);
        }
        Self {
            dests,
            has_routes,
            sacn_enabled,
            limiter,
        }
    }

    /// 某源 Universe 是否至少有一条路由。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    ///
    /// # Returns
    ///
    /// 至少一个参与输出的目的地会转发它时返回 `true`。`0..=0x7FFF` 直接查位图，
    /// 更大的编号逐目的地解析（不分配）。
    #[inline]
    #[must_use]
    pub fn has_routes(&self, universe: u16) -> bool {
        if universe <= BITMAP_MAX_UNIVERSE {
            let u = usize::from(universe);
            (self.has_routes[u >> 6] >> (u & 63)) & 1 != 0
        } else {
            self.dests.iter().any(|d| d.resolve(universe).is_some())
        }
    }

    /// 参与输出的目的地数量。
    ///
    /// # Returns
    ///
    /// 已启用、且未被 sACN 开关排除的目的地个数。
    #[must_use]
    pub fn enabled_destinations(&self) -> usize {
        self.dests.len()
    }

    /// 编译时的 sACN 开关。
    ///
    /// # Returns
    ///
    /// 编译时 sACN 输出是否开启。
    #[must_use]
    pub fn sacn_enabled(&self) -> bool {
        self.sacn_enabled
    }

    /// 解析某源 Universe 的全部路由（顺序同转发表）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    ///
    /// # Returns
    ///
    /// `(端点, 解析路由)` 的迭代器，仅含需转发者；与 [`ForwardingTable::routes_for`]
    /// 去掉被 sACN 开关排除的目的地后逐项一致。
    pub fn routes(
        &self,
        universe: u16,
    ) -> impl Iterator<Item = (&Arc<Endpoint>, ResolvedRoute)> + '_ {
        self.dests
            .iter()
            .filter_map(move |d| d.resolve(universe).map(|r| (&d.endpoint, r)))
    }
}

#[cfg(test)]
mod tests {
    use forwarding::{
        ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable, OverrideAction,
        RateLimiter, UniverseOverride, MIN_INTERVAL_MS_44HZ,
    };

    use super::{CompiledRoutes, BITMAP_MAX_UNIVERSE};
    use crate::output_stats::OutputStats;

    /// 确定性 xorshift64。
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
        fn chance(&mut self, percent: u64) -> bool {
            self.below(100) < percent
        }
        fn universe(&mut self) -> u16 {
            match self.below(10) {
                // 大部分集中在小范围，保证覆盖规则经常命中
                0..=5 => self.below(64) as u16,
                6 => [0, 1, 0x7FFE, 0x7FFF, 0x8000, 0x8001, 63_999, 65_534, 65_535]
                    [self.below(9) as usize],
                7 => (0x7FF0 + self.below(32)) as u16,
                _ => self.next() as u16,
            }
        }
    }

    fn random_dest(rng: &mut Rng, i: usize) -> ForwardDestination {
        let offset = match rng.below(8) {
            0 => 0,
            1 => i32::MAX,
            2 => i32::MIN,
            3 => -(rng.below(70_000) as i32),
            4 => rng.below(70_000) as i32,
            _ => rng.below(200) as i32 - 100,
        };
        let overrides = (0..rng.below(12))
            .map(|_| UniverseOverride {
                source_universe: rng.universe(),
                action: if rng.chance(50) {
                    OverrideAction::Forward
                } else {
                    OverrideAction::Exclude
                },
                target_universe: rng.chance(40).then(|| rng.next() as u16),
                delay_ms: rng.chance(40).then(|| rng.below(2001) as u16),
            })
            .collect();
        ForwardDestination {
            // 偶尔出现重复 id（旧版按 id 共享限速与统计）
            id: if rng.chance(10) {
                "dup".into()
            } else {
                format!("d{i}")
            },
            name: format!("dest {i}"),
            target_ip: [
                "10.0.0.5",
                "192.168.1.20",
                "::1",
                "not-an-ip",
                "",
                "300.1.1.1",
            ][rng.below(6) as usize]
                .into(),
            protocol: if rng.chance(30) {
                ForwardProtocol::Sacn
            } else {
                ForwardProtocol::ArtNet
            },
            port: rng.next() as u16,
            mode: if rng.chance(50) {
                ForwardMode::All
            } else {
                ForwardMode::Selected
            },
            universe_offset: offset,
            default_delay_ms: if rng.chance(50) {
                0
            } else {
                rng.below(2001) as u16
            },
            description: String::new(),
            enabled: rng.chance(80),
            overrides,
        }
    }

    fn random_table(rng: &mut Rng) -> ForwardingTable {
        ForwardingTable {
            destinations: (0..rng.below(10) as usize)
                .map(|i| random_dest(rng, i))
                .collect(),
        }
    }

    /// 旧版口径的期望路由：`routes_for` 去掉 sACN 关闭时的 sACN 目的地。
    fn expected(
        table: &ForwardingTable,
        u: u16,
        sacn: bool,
    ) -> Vec<(String, ForwardProtocol, String, u16, u16, u16)> {
        table
            .routes_for(u)
            .into_iter()
            .filter(|(d, _)| sacn || d.protocol != ForwardProtocol::Sacn)
            .map(|(d, r)| {
                (
                    d.id.clone(),
                    d.protocol,
                    d.target_ip.clone(),
                    d.port,
                    r.target_universe,
                    r.delay_ms,
                )
            })
            .collect()
    }

    fn actual(c: &CompiledRoutes, u: u16) -> Vec<(String, ForwardProtocol, String, u16, u16, u16)> {
        c.routes(u)
            .map(|(e, r)| {
                (
                    e.id.to_string(),
                    e.protocol,
                    e.target_ip.to_string(),
                    e.port,
                    r.target_universe,
                    r.delay_ms,
                )
            })
            .collect()
    }

    /// 随机转发表 × 随机 Universe：编译结果与 `routes_for` 逐项一致，位图与逐个解析一致。
    #[test]
    fn compiled_routes_match_routes_for_on_random_tables() {
        let mut rng = Rng(0x2545_F491_4F6C_DD1D);
        // 防止测试空转：统计命中路由 / 覆盖改写目标 / 非法 IP 的次数
        let (mut routed, mut remapped, mut invalid) = (0usize, 0usize, 0usize);
        for _ in 0..400 {
            let table = random_table(&mut rng);
            let sacn = rng.chance(60);
            let c = CompiledRoutes::compile(&table, sacn, &OutputStats::default());
            let mut universes: Vec<u16> = (0..64).map(|_| rng.universe()).collect();
            universes.extend(
                table
                    .destinations
                    .iter()
                    .flat_map(|d| d.overrides.iter().map(|o| o.source_universe)),
            );
            for u in universes {
                let want = expected(&table, u, sacn);
                assert_eq!(actual(&c, u), want, "universe {u}, table {table:?}");
                assert_eq!(c.has_routes(u), !want.is_empty(), "has_routes({u})");
                routed += want.len();
                invalid += c.routes(u).filter(|(e, _)| e.addr.is_none()).count();
                remapped += table
                    .routes_for(u)
                    .iter()
                    .filter(|(d, r)| {
                        d.overrides.iter().any(|o| {
                            o.source_universe == u && o.target_universe == Some(r.target_universe)
                        })
                    })
                    .count();
            }
            let enabled = table
                .destinations
                .iter()
                .filter(|d| d.enabled && (sacn || d.protocol != ForwardProtocol::Sacn))
                .count();
            assert_eq!(c.enabled_destinations(), enabled);
        }
        assert!(
            routed > 2000 && remapped > 100 && invalid > 500,
            "{routed} {remapped} {invalid}"
        );
    }

    /// 位图在整个 `0..=0x7FFF` 上与逐个解析一致。
    #[test]
    fn bitmap_matches_brute_force_over_the_whole_range() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..12 {
            let table = random_table(&mut rng);
            let sacn = rng.chance(50);
            let c = CompiledRoutes::compile(&table, sacn, &OutputStats::default());
            let dests: Vec<&ForwardDestination> = table
                .destinations
                .iter()
                .filter(|d| sacn || d.protocol != ForwardProtocol::Sacn)
                .collect();
            for u in 0..=BITMAP_MAX_UNIVERSE {
                let want = dests.iter().any(|d| d.resolve(u).is_some());
                assert_eq!(c.has_routes(u), want, "universe {u}, table {table:?}");
            }
        }
    }

    /// 限速语义与 `RateLimiter`（按目的地 id）一致：随机转发表 × 随机帧序列逐帧比对放行结果。
    #[test]
    fn rate_table_matches_rate_limiter() {
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        for _ in 0..60 {
            let table = random_table(&mut rng);
            let c = CompiledRoutes::compile(&table, true, &OutputStats::default());
            let mut reference = RateLimiter::new();
            let mut now = 0u64;
            for _ in 0..300 {
                now += rng.below(30);
                let u = rng.below(6) as u16;
                let want: Vec<bool> = table
                    .routes_for(u)
                    .into_iter()
                    .map(|(d, r)| {
                        reference.allow(&d.id, r.target_universe, now, MIN_INTERVAL_MS_44HZ)
                    })
                    .collect();
                let mut limiter = c.limiter.lock();
                let got: Vec<bool> = c
                    .dests
                    .iter()
                    .filter_map(|d| d.resolve(u).map(|r| (d, r)))
                    .map(|(d, r)| limiter.allow_slot(d.slot, r.target_universe, now))
                    .collect();
                assert_eq!(got, want, "now {now}, universe {u}");
            }
        }
    }

    /// 切换 sACN 开关重编译时目的地序号不变（限速状态沿用时不会错位）。
    #[test]
    fn slots_are_stable_across_sacn_toggle() {
        let mut rng = Rng(7);
        for _ in 0..50 {
            let table = random_table(&mut rng);
            let stats = OutputStats::default();
            let on = CompiledRoutes::compile(&table, true, &stats);
            let off = CompiledRoutes::compile(&table, false, &stats);
            for d in &off.dests {
                let same = on
                    .dests
                    .iter()
                    .find(|x| x.endpoint.id == d.endpoint.id)
                    .unwrap();
                assert_eq!(same.slot, d.slot);
                assert!(
                    std::sync::Arc::ptr_eq(
                        same.endpoint.counters.as_ref().unwrap(),
                        d.endpoint.counters.as_ref().unwrap()
                    ),
                    "同一 id 复用同一计数器"
                );
            }
        }
    }

    #[test]
    fn invalid_ip_is_kept_as_text_without_address() {
        let table = ForwardingTable {
            destinations: vec![ForwardDestination {
                id: "x".into(),
                name: "x".into(),
                target_ip: "not-an-ip".into(),
                protocol: ForwardProtocol::ArtNet,
                port: 6454,
                mode: ForwardMode::All,
                universe_offset: 0,
                default_delay_ms: 0,
                description: String::new(),
                enabled: true,
                overrides: Vec::new(),
            }],
        };
        let c = CompiledRoutes::compile(&table, true, &OutputStats::default());
        let (e, _) = c.routes(1).next().unwrap();
        assert_eq!(e.addr, None);
        assert_eq!(&*e.target_ip, "not-an-ip");
    }
}
