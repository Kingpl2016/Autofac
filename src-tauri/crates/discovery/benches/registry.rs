//! discovery 设备注册表微基准（divan，带分配计数）。
//!
//! 构造 64 台设备的注册表作为“改动前”的基线：
//!
//! - 32 台 Art-Net 节点：每台通过两次 [`DeviceRegistry::upsert_artnet`]（bind 1 / bind 2，
//!   各 4 个输出口）合并成 8 个端口，带短名 / 长名 / MAC / 固件 / NodeReport 等字段；
//! - 32 个被动源：通过 [`DeviceRegistry::upsert_source`] 加入（Art-Net / sACN 交替）；
//! - 每 4 台设备中有 1 台带用户自定义名。
//!
//! 基准：
//!
//! - `list_64`：[`DeviceRegistry::list`] 排序并克隆全部设备。
//! - `mark_stale_offline_64`：[`DeviceRegistry::mark_stale_offline`]（约 4 成设备超时）。
//! - `upsert_source_64`：对 64 个 IP 各 `upsert_source` 一次（模拟 ticker 被动发现）。
//! - `list_json_64`：`serde_json::to_string(&list)` 的耗时；字节数以 [`BytesCount`]
//!   报告，并在进入 divan 前用 `eprintln!` 打印。
//! - `passive_round_unchanged_64`：宿主 10Hz 被动发现一轮在“无实质变化”时的成本
//!   （64 次 `upsert_source` + `mark_stale_offline` + [`DeviceRegistry::version`]）；
//!   版本未变就不再 `list()` / 序列化。
//!
//! 运行：`cargo bench -p discovery --bench registry`。

use std::net::{IpAddr, Ipv4Addr};

use artnet_net::artnet::{NodePort, PollReplyInfo, PortDirection};
use artnet_net::Protocol;
use discovery::{Device, DeviceRegistry};
use divan::counter::{BytesCount, ItemsCount};
use divan::{black_box, Bencher};

/// 带分配计数的全局分配器：divan 据此在结果中报告每次迭代的分配次数与字节数。
#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

fn main() {
    // 基线体积：在基准开始前打印，避免与 divan 的表格输出交织。
    let list = registry_64().list();
    eprintln!(
        "== 设备列表 JSON 体积 ==\nlist_64 ({} 台设备)  {} 字节",
        list.len(),
        to_json(&list).len()
    );
    divan::main();
}

/// 设备总数。
const DEVICES: u8 = 64;

/// 其中通过 ArtPollReply 发现的 Art-Net 节点数（其余为被动源）。
const ARTNET_NODES: u8 = 32;

/// 每个 bind 上报的端口数。
const PORTS_PER_BIND: u8 = 4;

/// 相邻设备最后活动时间的间隔（毫秒）：第 `i` 台设备的 `last_seen_ms = i * 200`。
const SEEN_STEP_MS: u64 = 200;

/// `mark_stale_offline` 使用的当前逻辑时间（毫秒）。
const NOW_MS: u64 = 10_000;

/// 离线判定阈值（毫秒）：`last_seen_ms < 5000` 的设备（约 4 成）会被标记离线。
const STALE_TIMEOUT_MS: u64 = 5_000;

/// 第 `i` 台设备的 IP（`192.168.1.1` 起）。
///
/// # Arguments
///
/// * `i` - 设备序号（`0..DEVICES`）。
///
/// # Returns
///
/// 设备 IPv4 地址。
fn device_ip(i: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(192, 168, 1, i + 1))
}

/// 第 `i` 台设备的最后活动时间。
///
/// # Arguments
///
/// * `i` - 设备序号。
///
/// # Returns
///
/// 逻辑时间（毫秒）。
fn seen_at(i: u8) -> u64 {
    u64::from(i) * SEEN_STEP_MS
}

/// 第 `i` 台被动源的协议：偶数 Art-Net、奇数 sACN。
///
/// # Arguments
///
/// * `i` - 设备序号。
///
/// # Returns
///
/// 来源协议。
fn passive_protocol(i: u8) -> Protocol {
    if i.is_multiple_of(2) {
        Protocol::ArtNet
    } else {
        Protocol::Sacn
    }
}

/// 构造第 `i` 台 Art-Net 节点某个 bind 的 ArtPollReply 投影。
///
/// # Arguments
///
/// * `i` - 设备序号。
/// * `bind` - bind 序号（`1` 或 `2`）。
///
/// # Returns
///
/// 带 4 个输出口的 [`PollReplyInfo`]；两个 bind 合并后共 8 个端口。
fn poll_reply(i: u8, bind: u8) -> PollReplyInfo {
    let base_universe = u16::from(i) * 8 + u16::from(bind - 1) * u16::from(PORTS_PER_BIND);
    PollReplyInfo {
        ip: [192, 168, 1, i + 1],
        short_name: format!("Node {i:02}"),
        long_name: format!("Art-Net Studio Bench Node {i:02} (8 port)"),
        mac: [0x02, 0x00, 0x5E, 0x10, bind, i],
        num_ports: u16::from(PORTS_PER_BIND),
        version: [1, 23],
        oem: 0x1234,
        esta_code: 0x4C58,
        style: 0,
        node_report: "#0001 [0042] Power On Tests successful".to_string(),
        bind_index: bind,
        ports: (0..PORTS_PER_BIND)
            .map(|p| NodePort {
                index: p,
                direction: PortDirection::Output,
                universe: base_universe + u16::from(p),
                active: true,
            })
            .collect(),
    }
}

/// 构造 64 台设备的注册表（32 台 8 口 Art-Net 节点 + 32 个被动源，1/4 带自定义名）。
///
/// # Returns
///
/// 就绪的 [`DeviceRegistry`]。
fn registry_64() -> DeviceRegistry {
    let mut reg = DeviceRegistry::new();
    for i in 0..DEVICES {
        if i.is_multiple_of(4) {
            reg.set_custom_name(device_ip(i), format!("舞台设备 {i:02}"));
        }
    }
    for i in 0..ARTNET_NODES {
        reg.upsert_artnet(&poll_reply(i, 1), seen_at(i));
        reg.upsert_artnet(&poll_reply(i, 2), seen_at(i));
    }
    for i in ARTNET_NODES..DEVICES {
        reg.upsert_source(device_ip(i), passive_protocol(i), seen_at(i));
    }
    reg
}

/// 序列化设备列表为 JSON。
///
/// # Arguments
///
/// * `list` - 设备列表。
///
/// # Returns
///
/// JSON 文本。
///
/// # Panics
///
/// 序列化失败时 panic（设备只含数字 / 字符串 / 枚举，不会失败）。
fn to_json(list: &[Device]) -> String {
    serde_json::to_string(list).expect("设备列表只含数字、字符串与枚举，序列化不会失败")
}

/// `list()`：按 IP 排序并克隆全部 64 台设备。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按设备数计。
#[divan::bench]
fn list_64(bencher: Bencher) {
    let reg = registry_64();
    bencher
        .counter(ItemsCount::new(DEVICES))
        .bench_local(|| black_box(&reg).list());
}

/// `mark_stale_offline`：遍历 64 台设备按超时标记离线。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按设备数计。
#[divan::bench]
fn mark_stale_offline_64(bencher: Bencher) {
    let mut reg = registry_64();
    bencher
        .counter(ItemsCount::new(DEVICES))
        .bench_local(|| reg.mark_stale_offline(black_box(NOW_MS), black_box(STALE_TIMEOUT_MS)));
}

/// 对 64 个已知 IP 各 `upsert_source` 一次（模拟 ticker 被动发现的一轮）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按设备数计。
#[divan::bench]
fn upsert_source_64(bencher: Bencher) {
    let mut reg = registry_64();
    let sources: Vec<(IpAddr, Protocol)> = (0..DEVICES)
        .map(|i| (device_ip(i), passive_protocol(i)))
        .collect();
    bencher.counter(ItemsCount::new(DEVICES)).bench_local(|| {
        for &(ip, protocol) in black_box(&sources) {
            reg.upsert_source(ip, protocol, NOW_MS);
        }
    });
}

/// `serde_json::to_string(&list)`：64 台设备列表的 JSON 序列化。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按 JSON 输出字节数计。
#[divan::bench]
fn list_json_64(bencher: Bencher) {
    let list = registry_64().list();
    let len = to_json(&list).len();
    bencher
        .counter(BytesCount::new(len))
        .bench_local(|| serde_json::to_string(black_box(&list)));
}

/// 被动发现一轮且无实质变化：64 次 `upsert_source` + 离线判定 + 读版本号。
///
/// 全部设备保持在线（`last_seen_ms` 随轮次推进），所以版本号不变、宿主不会 `list()`。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按设备数计。
#[divan::bench]
fn passive_round_unchanged_64(bencher: Bencher) {
    let mut reg = registry_64();
    let sources: Vec<(IpAddr, Protocol)> = (0..DEVICES)
        .map(|i| (device_ip(i), passive_protocol(i)))
        .collect();
    let mut now_ms = NOW_MS;
    // 先让全部设备在线一次，之后每轮只刷新 last_seen
    for &(ip, protocol) in &sources {
        reg.upsert_source(ip, protocol, now_ms);
    }
    bencher.counter(ItemsCount::new(DEVICES)).bench_local(|| {
        now_ms += 100;
        for &(ip, protocol) in black_box(&sources) {
            reg.upsert_source(ip, protocol, now_ms);
        }
        reg.mark_stale_offline(now_ms, STALE_TIMEOUT_MS);
        black_box(reg.version())
    });
}
