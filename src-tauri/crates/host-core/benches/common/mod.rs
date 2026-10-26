//! host-core 各基准共用的转发表、数据与时间轴构造。
//!
//! 转发表 8 个目的地：6 个 `mode = all`（部分带 `universe_offset`、默认延迟、少量 Exclude 覆盖，
//! 其中 1 个为 sACN），2 个 `mode = selected`（各带 16 条 Forward 覆盖，部分指定目标 Universe / 延迟）。

// 各基准只用到其中一部分。
#![allow(dead_code)]

use forwarding::{
    ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable, OverrideAction,
    UniverseOverride,
};

/// 每个输出周期分发的 Universe 数。
pub const UNIVERSES: u16 = 256;
/// 每路 DMX 通道数。
pub const DMX_LEN: usize = 512;
/// 预生成的周期间隔个数（循环使用）。
pub const STEPS: usize = 256;
/// 周期间隔下限（毫秒）。
const STEP_MIN_MS: u64 = 18;
/// 周期间隔抖动范围（毫秒，间隔取 `STEP_MIN_MS..STEP_MIN_MS + STEP_SPAN_MS`）。
const STEP_SPAN_MS: u64 = 10;
/// 伪随机种子。
pub const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// 确定性 xorshift64 伪随机数发生器（避免引入额外依赖）。
pub struct Rng(pub u64);

impl Rng {
    /// 产出下一个 64 位伪随机数。
    ///
    /// # Returns
    ///
    /// 下一个伪随机数（种子非 0 时永不为 0）。
    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// 构造一个转发目的地。
///
/// # Arguments
///
/// * `i` - 目的地序号（决定 id、目标 IP）。
/// * `mode` - 转发模式。
/// * `protocol` - 输出协议（决定端口）。
/// * `universe_offset` - Universe 偏移。
/// * `overrides` - per-universe 覆盖规则。
///
/// # Returns
///
/// 已启用的 [`ForwardDestination`]。
fn dest(
    i: u8,
    mode: ForwardMode,
    protocol: ForwardProtocol,
    universe_offset: i32,
    overrides: Vec<UniverseOverride>,
) -> ForwardDestination {
    ForwardDestination {
        id: format!("dest-{i}"),
        name: format!("目的地 {i}"),
        target_ip: format!("10.0.1.{}", 10 + i),
        protocol,
        port: match protocol {
            ForwardProtocol::ArtNet => 6454,
            ForwardProtocol::Sacn => 5568,
        },
        mode,
        universe_offset,
        default_delay_ms: 0,
        description: String::new(),
        enabled: true,
        overrides,
    }
}

/// 一组 Forward 覆盖：`sources` 中的每个源 Universe，偶数项改写目标 Universe 并带延迟。
///
/// # Arguments
///
/// * `sources` - 被选中的源 Universe。
/// * `target_base` - 改写目标 Universe 的基数。
///
/// # Returns
///
/// 覆盖规则列表。
fn forward_overrides(
    sources: impl Iterator<Item = u16>,
    target_base: u16,
) -> Vec<UniverseOverride> {
    sources
        .enumerate()
        .map(|(k, u)| {
            let remap = k % 2 == 0;
            UniverseOverride {
                source_universe: u,
                action: OverrideAction::Forward,
                target_universe: remap.then_some(target_base + u),
                delay_ms: remap.then_some(15),
            }
        })
        .collect()
}

/// 8 个目的地的典型转发表：6 个 `all`、2 个 `selected`。
///
/// # Returns
///
/// 对 0..256 每个 Universe 都至少命中 5 个目的地的 [`ForwardingTable`]。
pub fn routed_table() -> ForwardingTable {
    let exclude: Vec<UniverseOverride> = [7u16, 63, 128, 200]
        .into_iter()
        .map(|u| UniverseOverride {
            source_universe: u,
            action: OverrideAction::Exclude,
            target_universe: None,
            delay_ms: None,
        })
        .collect();
    let mut delayed = dest(
        4,
        ForwardMode::All,
        ForwardProtocol::ArtNet,
        512,
        Vec::new(),
    );
    delayed.default_delay_ms = 40;
    ForwardingTable {
        destinations: vec![
            dest(0, ForwardMode::All, ForwardProtocol::ArtNet, 0, Vec::new()),
            dest(
                1,
                ForwardMode::All,
                ForwardProtocol::ArtNet,
                256,
                Vec::new(),
            ),
            dest(2, ForwardMode::All, ForwardProtocol::ArtNet, 0, exclude),
            // sACN Universe 从 1 开始
            dest(3, ForwardMode::All, ForwardProtocol::Sacn, 1, Vec::new()),
            delayed,
            dest(
                5,
                ForwardMode::All,
                ForwardProtocol::ArtNet,
                1024,
                Vec::new(),
            ),
            dest(
                6,
                ForwardMode::Selected,
                ForwardProtocol::ArtNet,
                0,
                forward_overrides(0..16, 2000),
            ),
            dest(
                7,
                ForwardMode::Selected,
                ForwardProtocol::ArtNet,
                100,
                forward_overrides((0..UNIVERSES).step_by(16), 3000),
            ),
        ],
    }
}

/// 8 个目的地全部为 `selected`、且只选中 1000 以上的 Universe 的转发表。
///
/// # Returns
///
/// 对 0..256 任何 Universe 都没有路由的 [`ForwardingTable`]。
pub fn unrouted_table() -> ForwardingTable {
    ForwardingTable {
        destinations: (0..8u8)
            .map(|i| {
                let base = 1000 + u16::from(i) * 16;
                dest(
                    i,
                    ForwardMode::Selected,
                    ForwardProtocol::ArtNet,
                    0,
                    forward_overrides(base..base + 16, 4000),
                )
            })
            .collect(),
    }
}

/// 预生成 256 路、每路 512 字节的通道数据（内容互不相同）。
///
/// # Arguments
///
/// * `seed` - 伪随机种子（不同来源用不同种子）。
///
/// # Returns
///
/// `data[u]` 为 Universe `u` 的通道数据。
pub fn universe_data(seed: u64) -> Vec<Vec<u8>> {
    let mut rng = Rng(seed);
    (0..UNIVERSES)
        .map(|_| (0..DMX_LEN).map(|_| rng.next_u64() as u8).collect())
        .collect()
}

/// 预生成带抖动的周期间隔。
///
/// # Returns
///
/// [`STEPS`] 个位于 `[18, 28)` 毫秒内的间隔。
pub fn jitter_steps() -> Vec<u64> {
    let mut rng = Rng(SEED ^ 0xA5A5_A5A5);
    (0..STEPS)
        .map(|_| STEP_MIN_MS + rng.next_u64() % STEP_SPAN_MS)
        .collect()
}
