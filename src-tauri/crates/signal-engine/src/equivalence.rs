//! 新合并 / 冲突计数 / 引擎实现与改动前参照实现的等价性随机测试（仅测试构建）。
//!
//! 随机数使用自带的 xorshift64（固定种子，结果确定、可复现），不引入额外依赖。

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Instant;

use artnet_net::{Bytes, DmxFrame, Protocol};

use crate::merge::{merge, merge_into, MergeMode, MergeResult, SourceView};
use crate::SignalEngine;

/// 改动前的 `merge` / `htp` / `ltp` / `count_conflicts`，原样复制作为参照。
mod reference {
    use crate::merge::{MergeMode, MergeResult, SourceView};

    pub(super) fn merge(sources: &[SourceView<'_>], mode: MergeMode) -> MergeResult {
        let width = sources.iter().map(|s| s.data.len()).max().unwrap_or(0);
        let conflict_channels = count_conflicts(sources, width);

        let data = match mode {
            MergeMode::Htp => htp(sources.iter(), width),
            MergeMode::Ltp => ltp(sources, width),
            MergeMode::Priority => {
                // 仅最高优先级的源参与 HTP，平级回落。直接按优先级过滤迭代，
                // 避免为中间集合额外分配 `Vec<SourceView>`。
                let top = sources.iter().map(|s| s.priority).max().unwrap_or(0);
                htp(sources.iter().filter(|s| s.priority == top), width)
            }
        };

        MergeResult {
            data,
            conflict_channels,
            source_count: sources.len(),
        }
    }

    /// 逐通道取最大（HTP）。接受迭代器以便 Priority 过滤复用而不额外分配。
    fn htp<'a, 'b: 'a>(sources: impl Iterator<Item = &'a SourceView<'b>>, width: usize) -> Vec<u8> {
        let mut out = vec![0u8; width];
        for s in sources {
            // 无分支逐元素取 max，zip 自动按较短长度（源宽度 ≤ 输出宽度）收敛，
            // 便于编译器向量化。
            for (slot, &v) in out.iter_mut().zip(s.data.iter()) {
                *slot = (*slot).max(v);
            }
        }
        out
    }

    fn ltp(sources: &[SourceView<'_>], width: usize) -> Vec<u8> {
        let mut idx: Vec<usize> = (0..sources.len()).collect();
        // 按 (last_seen_ms, order) 升序：最新者排后，最后覆盖
        idx.sort_by_key(|&i| (sources[i].last_seen_ms, sources[i].order));
        let mut out = vec![0u8; width];
        for &i in &idx {
            for (c, &v) in sources[i].data.iter().enumerate() {
                out[c] = v;
            }
        }
        out
    }

    fn count_conflicts(sources: &[SourceView<'_>], width: usize) -> usize {
        if sources.len() < 2 {
            return 0;
        }
        let mut count = 0;
        for c in 0..width {
            let mut first: Option<u8> = None;
            let mut covering = 0usize;
            let mut differ = false;
            for s in sources {
                if let Some(&v) = s.data.get(c) {
                    covering += 1;
                    match first {
                        None => first = Some(v),
                        Some(f) if f != v => differ = true,
                        _ => {}
                    }
                }
            }
            if covering >= 2 && differ {
                count += 1;
            }
        }
        count
    }
}

/// 三种合并模式。
const MODES: [MergeMode; 3] = [MergeMode::Htp, MergeMode::Ltp, MergeMode::Priority];

/// 确定性 xorshift64 伪随机数发生器。
struct XorShift(u64);

impl XorShift {
    fn new(seed: u64) -> Self {
        // 状态不能为 0
        Self(seed | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// `[0, n)` 内的随机数（`n > 0`）。
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// `[lo, hi]` 内的随机数。
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }

    /// 以 `num / den` 的概率返回 `true`。
    fn chance(&mut self, num: usize, den: usize) -> bool {
        self.below(den) < num
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }
}

/// 随机宽度：偏向满宽 512 与极窄宽度，覆盖“窄源只覆盖自己通道”的边界。
fn random_width(rng: &mut XorShift, min: usize) -> usize {
    match rng.below(4) {
        0 | 1 => 512,
        2 => rng.range(min.max(1), 512),
        _ => rng.range(min, 8),
    }
}

/// 随机通道数据：取值域随机（2 / 3 / 256 种取值），小取值域制造大量“取值相同”的重叠；
/// 有一定概率以 `base` 为底只改少数通道，制造“几乎一致”的来源。
fn random_data(rng: &mut XorShift, width: usize, base: Option<&[u8]>) -> Vec<u8> {
    let alphabet = rng.pick(&[2usize, 3, 256]);
    let mut data: Vec<u8> = (0..width).map(|_| rng.below(alphabet) as u8).collect();
    if let Some(base) = base.filter(|_| rng.chance(1, 3)) {
        for (d, &b) in data.iter_mut().zip(base) {
            *d = b;
        }
        for _ in 0..rng.range(0, 3) {
            if width > 0 {
                let c = rng.below(width);
                data[c] = data[c].wrapping_add(1);
            }
        }
    }
    data
}

#[test]
fn merge_matches_reference_on_random_inputs() {
    let mut rng = XorShift::new(0x9E37_79B9_7F4A_7C15);
    for case in 0..6000 {
        let n = rng.range(1, 4);
        let mut datas: Vec<Vec<u8>> = Vec::with_capacity(n);
        for _ in 0..n {
            // 偶尔出现 0 宽来源（超出题设的额外边界）
            let width = if rng.chance(1, 50) {
                0
            } else {
                random_width(&mut rng, 1)
            };
            let data = random_data(&mut rng, width, datas.last().map(Vec::as_slice));
            datas.push(data);
        }
        // 小取值域的优先级 / 时间 / 到达序：大量平级，覆盖 Priority 回落与 LTP 稳定排序
        let views: Vec<SourceView<'_>> = datas
            .iter()
            .map(|d| SourceView {
                data: d,
                priority: rng.pick(&[50u8, 100, 100, 200]),
                last_seen_ms: rng.below(4) as u64,
                order: rng.below(3) as u64,
            })
            .collect();
        for mode in MODES {
            let expected = reference::merge(&views, mode);
            let actual = merge(&views, mode);
            assert_eq!(actual, expected, "case {case} mode {mode:?}");

            // 引擎复用的是“脏”缓冲：merge_into 必须完整覆盖 [..width]
            let mut dirty = [0xA5u8; 512];
            let width = merge_into(&views, mode, &mut dirty);
            assert_eq!(width, expected.data.len(), "case {case} mode {mode:?}");
            assert_eq!(
                &dirty[..width],
                expected.data.as_slice(),
                "case {case} mode {mode:?}"
            );
        }
    }
}

#[test]
fn merge_matches_reference_on_empty_input() {
    for mode in MODES {
        assert_eq!(merge(&[], mode), reference::merge(&[], mode));
    }
}

/// 影子模型中的一个来源。
#[derive(Debug, Clone)]
struct ShadowSource {
    ip: IpAddr,
    data: Vec<u8>,
    last_seen_ms: u64,
    order: u64,
    packets: u64,
}

/// 影子模型中的一个 Universe。
#[derive(Debug, Clone, Default)]
struct ShadowUniverse {
    sources: Vec<ShadowSource>,
    protocol: Option<Protocol>,
    total_packets: u64,
}

impl ShadowUniverse {
    /// 用参照实现从当前全部来源重新合并。
    fn reference_merge(&self, mode: MergeMode) -> MergeResult {
        let views: Vec<SourceView<'_>> = self
            .sources
            .iter()
            .map(|s| SourceView {
                data: &s.data,
                priority: 100,
                last_seen_ms: s.last_seen_ms,
                order: s.order,
            })
            .collect();
        reference::merge(&views, mode)
    }
}

/// 独立于引擎实现的影子模型（只依据公开语义推演）。
struct Shadow {
    universes: BTreeMap<u16, ShadowUniverse>,
    mode: MergeMode,
    order: u64,
    total_packets: u64,
}

/// 引擎级随机测试的候选来源：`None` 表示帧不带源地址（回落 `0.0.0.0`）。
const SOURCE_POOL: [Option<IpAddr>; 6] = [
    Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))),
    Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 10))),
    Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))),
    Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))),
    Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
    None,
];

/// 引擎级随机测试的候选 Universe（少量编号以制造多来源）。
const UNIVERSE_POOL: [u16; 5] = [0, 1, 2, 3, 32767];

/// 源超时（毫秒）。
const TIMEOUT_MS: u64 = 300;

/// 随机摄取一帧，同步更新影子模型。
fn step_ingest(
    rng: &mut XorShift,
    eng: &mut SignalEngine,
    shadow: &mut Shadow,
    now_ms: u64,
) -> u16 {
    let universe = rng.pick(&UNIVERSE_POOL);
    let source = rng.pick(&SOURCE_POOL);
    let protocol = if rng.chance(1, 4) {
        Protocol::Sacn
    } else {
        Protocol::ArtNet
    };
    let width = random_width(rng, 1);
    let base = shadow
        .universes
        .get(&universe)
        .and_then(|u| u.sources.first())
        .map(|s| s.data.clone());
    let data = random_data(rng, width, base.as_deref());

    eng.ingest(
        &DmxFrame {
            protocol,
            universe,
            data: Bytes::from(data.clone()),
            source,
            sequence: 0,
            received_at: Instant::now(),
        },
        now_ms,
    );

    shadow.order += 1;
    shadow.total_packets += 1;
    let ip = source.unwrap_or_else(crate::unknown_source);
    let u = shadow.universes.entry(universe).or_default();
    u.protocol = Some(protocol);
    u.total_packets += 1;
    if let Some(s) = u.sources.iter_mut().find(|s| s.ip == ip) {
        s.data = data;
        s.last_seen_ms = now_ms;
        s.order = shadow.order;
        s.packets += 1;
    } else {
        u.sources.push(ShadowSource {
            ip,
            data,
            last_seen_ms: now_ms,
            order: shadow.order,
            packets: 1,
        });
    }
    universe
}

/// 剔除超时来源，同步更新影子模型并核对剔除数。
fn step_prune(eng: &mut SignalEngine, shadow: &mut Shadow, now_ms: u64) {
    let mut expected = 0;
    for u in shadow.universes.values_mut() {
        let before = u.sources.len();
        u.sources
            .retain(|s| now_ms.saturating_sub(s.last_seen_ms) <= TIMEOUT_MS);
        expected += before - u.sources.len();
    }
    shadow.universes.retain(|_, u| !u.sources.is_empty());
    assert_eq!(eng.prune(now_ms), expected, "prune 剔除数");
}

/// 核对引擎全部可观测状态与影子模型 + 参照实现一致，并检查数据代号。
///
/// `observed` 记录每个 Universe 上一次观测到的 `(代号, 合并数据)`；Universe 被移除后保留记录，
/// 以检查重建后的代号同样满足“数据变化则代号变化”。
///
/// 返回本次核对中“多来源且存在冲突”的 Universe 数，供调用方确认随机场景确实覆盖了合并路径。
fn check(
    eng: &SignalEngine,
    shadow: &Shadow,
    observed: &mut BTreeMap<u16, (u64, Vec<u8>)>,
    step: usize,
) -> usize {
    let mut conflicted = 0;
    assert_eq!(
        eng.active_universe_count(),
        shadow.universes.len(),
        "step {step}"
    );
    assert_eq!(eng.total_packets(), shadow.total_packets, "step {step}");
    for &u in &UNIVERSE_POOL {
        if !shadow.universes.contains_key(&u) {
            assert_eq!(eng.merged(u), None, "step {step} universe {u}");
            assert_eq!(eng.data_gen(u), None, "step {step} universe {u}");
        }
    }

    let snapshot = eng.snapshot();
    assert_eq!(snapshot.len(), shadow.universes.len(), "step {step}");
    let mut buf = [0u8; 512];
    for (snap, (&universe, su)) in snapshot.iter().zip(&shadow.universes) {
        let ctx = format!("step {step} universe {universe} mode {:?}", shadow.mode);
        let expected = su.reference_merge(shadow.mode);

        // 合并结果：四种读取方式一致
        assert_eq!(
            eng.merged(universe),
            Some(expected.data.as_slice()),
            "{ctx}"
        );
        assert_eq!(
            eng.merged_output(universe).as_ref(),
            Some(&expected.data),
            "{ctx}"
        );
        assert_eq!(
            eng.merged_bytes(universe).as_deref(),
            Some(expected.data.as_slice()),
            "{ctx}"
        );
        assert_eq!(
            eng.merged_into(universe, &mut buf),
            Some(expected.data.len()),
            "{ctx}"
        );
        assert_eq!(
            &buf[..expected.data.len()],
            expected.data.as_slice(),
            "{ctx}"
        );

        // 快照：冲突 / 活跃通道与参照一致，来源按 IP 数值序
        assert_eq!(snap.universe, universe, "{ctx}");
        assert_eq!(snap.protocol, su.protocol, "{ctx}");
        assert_eq!(snap.conflict_channels, expected.conflict_channels, "{ctx}");
        let active = expected.data.iter().filter(|&&v| v > 0).count();
        assert_eq!(snap.active_channels, active, "{ctx}");
        assert_eq!(snap.source_count, su.sources.len(), "{ctx}");
        assert_eq!(snap.total_packets, su.total_packets, "{ctx}");
        let mut sorted = su.sources.clone();
        sorted.sort_by_key(|s| s.ip);
        let ips: Vec<String> = sorted.iter().map(|s| s.ip.to_string()).collect();
        assert_eq!(snap.source_ips, ips, "{ctx}");
        let got: Vec<(String, IpAddr, u64)> = snap
            .sources
            .iter()
            .map(|s| (s.ip.clone(), s.addr, s.packets))
            .collect();
        let want: Vec<(String, IpAddr, u64)> = sorted
            .iter()
            .map(|s| (s.ip.to_string(), s.ip, s.packets))
            .collect();
        assert_eq!(got, want, "{ctx}");

        // 数据代号：合并结果变化时一定变化
        let data_gen = eng.data_gen(universe).unwrap();
        if let Some((prev_gen, prev_data)) = observed.get(&universe)
            && *prev_data != expected.data {
                assert_ne!(data_gen, *prev_gen, "{ctx}: 合并结果变了但代号未变");
            }
        observed.insert(universe, (data_gen, expected.data));
        if su.sources.len() >= 2 && expected.conflict_channels > 0 {
            conflicted += 1;
        }
    }
    conflicted
}

/// 以给定种子跑一轮引擎级随机交错操作。
fn run_engine_scenario(seed: u64, steps: usize) {
    let mut rng = XorShift::new(seed);
    let mut eng = SignalEngine::new(MergeMode::Htp, TIMEOUT_MS);
    let mut shadow = Shadow {
        universes: BTreeMap::new(),
        mode: MergeMode::Htp,
        order: 0,
        total_packets: 0,
    };
    let mut observed = BTreeMap::new();
    let mut now_ms = 0u64;
    // 覆盖度统计：各模式下核对到的“多来源且有冲突”的 Universe 次数
    let mut conflicted_by_mode = [0usize; 3];
    for step in 0..steps {
        // 时间推进：多数帧同毫秒或相近，偶尔大跨度以触发超时
        now_ms += if rng.chance(1, 20) {
            rng.range(200, 600) as u64
        } else {
            rng.below(30) as u64
        };
        match rng.below(100) {
            0..=79 => {
                let universe = step_ingest(&mut rng, &mut eng, &mut shadow, now_ms);
                let before = observed.get(&universe).map(|(g, _)| *g);
                let after = eng.data_gen(universe);
                assert!(
                    after.is_some() && after != before,
                    "step {step}: ingest 必然更新代号"
                );
            }
            80..=88 => step_prune(&mut eng, &mut shadow, now_ms),
            89..=96 => {
                let mode = rng.pick(&MODES);
                eng.set_mode(mode);
                shadow.mode = mode;
            }
            97 | 98 => {
                let protocol = rng.pick(&[Protocol::ArtNet, Protocol::Sacn]);
                let before = shadow.universes.len();
                shadow.universes.retain(|_, u| u.protocol != Some(protocol));
                assert_eq!(
                    eng.purge_protocol(protocol),
                    before - shadow.universes.len(),
                    "step {step}"
                );
            }
            _ => {
                assert_eq!(eng.clear(), shadow.universes.len(), "step {step}");
                shadow.universes.clear();
            }
        }
        let conflicted = check(&eng, &shadow, &mut observed, step);
        let slot = MODES.iter().position(|&m| m == shadow.mode).unwrap();
        conflicted_by_mode[slot] += conflicted;
    }
    // 防止随机场景退化成“几乎都是单来源”而让等价性断言形同虚设
    for (mode, &n) in MODES.iter().zip(&conflicted_by_mode) {
        assert!(
            n >= 100,
            "seed {seed:#x} 模式 {mode:?} 只覆盖到 {n} 次多来源冲突"
        );
    }
}

#[test]
fn engine_matches_reference_under_random_interleaving() {
    for seed in [0x1234_5678_9ABC_DEF1, 0x0BAD_C0DE_DEAD_BEEF, 42] {
        run_engine_scenario(seed, 3000);
    }
}
