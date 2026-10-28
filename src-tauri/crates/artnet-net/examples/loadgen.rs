//! Art-Net / sACN 压测发包程序（仅依赖 std 与本 crate 的编码函数）。
//!
//! 以固定帧率向目标地址连续发送 ArtDmx 或 E1.31 数据包，用于在真实网络栈上
//! 给接收管线施压并记录“改动前”的基线：
//!
//! - 每个 tick 依次发完全部 Universe；`--sources 2` 时用两个本地 UDP 套接字
//!   （两个不同源端口）各发一遍同一批 Universe，模拟双来源 HTP 合并。
//! - 通道数据为确定性三角波：`tri(tick + 通道号 + universe * 7 + 来源序号 * 64)`，
//!   第二来源相位错开 64，使 HTP 合并与冲突统计都有实际工作量。
//! - 节拍按绝对截止时间推进（不累计漂移），等待采用“剩余 > 3ms 时
//!   `sleep(剩余 - 2ms)`，否则自旋”的混合策略；落后超过 1 个 tick 时跳过追帧并计数。
//! - 每秒打印一行实时统计，结束（到时或 Ctrl+C）时打印汇总。
//!
//! 用法示例（在 `src-tauri` 目录下）：
//!
//! ```text
//! cargo run --release -p artnet-net --example loadgen -- --universes 256 --hz 44
//! cargo run --release -p artnet-net --example loadgen -- --sources 2 --seconds 30
//! cargo run --release -p artnet-net --example loadgen -- --protocol sacn --target 192.168.1.20:5568
//! ```

use std::net::{SocketAddr, UdpSocket};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use artnet_net::artnet::{self, ARTNET_PORT};
use artnet_net::sacn::{self, SACN_PORT};

/// 一帧 DMX 的通道数。
const CHANNELS: usize = 512;

/// Art-Net 15 位 Port-Address 的最大值。
const ARTNET_MAX_UNIVERSE: u32 = 0x7FFF;

/// sACN 合法 Universe 的最小值（0 为保留值）。
const SACN_MIN_UNIVERSE: u16 = 1;

/// sACN 合法 Universe 的最大值。
const SACN_MAX_UNIVERSE: u32 = 63_999;

/// sACN 默认优先级。
const SACN_PRIORITY: u8 = 100;

/// sACN 源名称。
const SACN_SOURCE_NAME: &str = "Art-Net Studio loadgen";

/// 最多支持的本地来源（UDP 套接字）数。
const MAX_SOURCES: u8 = 2;

/// 距截止时间超过该值时才 `sleep`，否则自旋。
const SLEEP_THRESHOLD: Duration = Duration::from_millis(3);

/// `sleep` 时为唤醒误差预留的余量（提前醒来后自旋补足）。
const SLEEP_MARGIN: Duration = Duration::from_millis(2);

/// 实时统计的打印间隔。
const REPORT_INTERVAL: Duration = Duration::from_secs(1);

/// 进程级停止标志：Ctrl+C 处理器置位，主循环轮询。
static STOP: AtomicBool = AtomicBool::new(false);

/// 发包协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireProtocol {
    /// Art-Net 4（ArtDmx）。
    ArtNet,
    /// sACN（E1.31 数据包）。
    Sacn,
}

impl WireProtocol {
    /// 协议的命令行标识。
    ///
    /// # Returns
    ///
    /// `"artnet"` 或 `"sacn"`。
    fn as_str(self) -> &'static str {
        match self {
            Self::ArtNet => "artnet",
            Self::Sacn => "sacn",
        }
    }
}

/// 压测配置（由命令行解析得到）。
#[derive(Debug, Clone, PartialEq)]
struct Config {
    /// 目标地址。
    target: SocketAddr,
    /// 每个 tick 发送的 Universe 数（≥1）。
    universes: u16,
    /// 帧率（Hz，有限正数）。
    hz: f64,
    /// 本地来源（UDP 套接字）数：`1` 或 `2`。
    sources: u8,
    /// 运行时长（秒）；`0` 表示一直运行直到 Ctrl+C。
    seconds: u64,
    /// 发包协议。
    protocol: WireProtocol,
    /// 起始 Universe（Art-Net 为 Port-Address，sACN 为 E1.31 Universe）。
    start_universe: u16,
}

/// 一次压测的汇总结果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Summary {
    /// 成功发出的包数。
    packets_sent: u64,
    /// `send_to` 失败次数。
    send_errors: u64,
    /// 实际发送过的 tick 数。
    ticks_sent: u64,
    /// 因落后超过 1 个 tick 而跳过（不追帧）的 tick 数。
    skipped_ticks: u64,
    /// 实际运行时长。
    elapsed: Duration,
}

/// 命令行用法说明。
const USAGE: &str = "\
用法：loadgen [选项]

选项：
  --target <ip:port>       目标地址（默认 127.0.0.1:6454；sACN 默认 127.0.0.1:5568）
  --universes <n>          每 tick 发送的 Universe 数（默认 256）
  --hz <f>                 帧率 Hz（默认 44）
  --sources <1|2>          本地来源数；2 表示两个 UDP 套接字发同一批 Universe（默认 1）
  --seconds <n>            运行秒数，0 表示一直运行、Ctrl+C 退出（默认 0）
  --protocol <artnet|sacn> 协议（默认 artnet）
  --start-universe <n>     起始 Universe（默认 artnet 为 0、sacn 为 1）
  -h, --help               显示本帮助";

fn main() -> ExitCode {
    let cfg = match parse_args(std::env::args().skip(1)) {
        Ok(Some(cfg)) => cfg,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(msg) => {
            eprintln!("参数错误：{msg}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    if !install_ctrl_c_handler() {
        eprintln!("警告：无法安装 Ctrl+C 处理器，中断时将不会打印汇总");
    }

    let last_universe = u32::from(cfg.start_universe) + u32::from(cfg.universes) - 1;
    println!(
        "loadgen：{} → {}，Universe {}..={}（{} 个），{} Hz，来源 {}，时长 {}",
        cfg.protocol.as_str(),
        cfg.target,
        cfg.start_universe,
        last_universe,
        cfg.universes,
        cfg.hz,
        cfg.sources,
        if cfg.seconds == 0 {
            "不限（Ctrl+C 结束）".to_string()
        } else {
            format!("{} 秒", cfg.seconds)
        },
    );
    println!(
        "目标包速率 {:.1} 包/秒",
        f64::from(cfg.universes) * f64::from(cfg.sources) * cfg.hz
    );

    match run(&cfg, &STOP) {
        Ok(summary) => {
            print_summary(&summary);
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("发包失败：{err}");
            ExitCode::FAILURE
        }
    }
}

/// 解析命令行参数。
///
/// # Arguments
///
/// * `args` - 不含程序名的参数序列。
///
/// # Returns
///
/// `Ok(Some(cfg))` 为解析成功；`Ok(None)` 表示用户请求了 `--help`。
///
/// # Errors
///
/// 遇到未知选项、缺少取值、取值无法解析或越界（如 Universe 超出协议范围）时返回
/// 描述原因的中文错误信息。
fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Option<Config>, String> {
    let mut target: Option<SocketAddr> = None;
    let mut universes: u16 = 256;
    let mut hz: f64 = 44.0;
    let mut sources: u8 = 1;
    let mut seconds: u64 = 0;
    let mut protocol = WireProtocol::ArtNet;
    let mut start_universe: Option<u16> = None;

    let mut it = args.into_iter();
    while let Some(flag) = it.next() {
        if flag == "-h" || flag == "--help" {
            return Ok(None);
        }
        let mut value = || it.next().ok_or_else(|| format!("选项 {flag} 缺少取值"));
        match flag.as_str() {
            "--target" => target = Some(parse_value(&flag, &value()?)?),
            "--universes" => universes = parse_value(&flag, &value()?)?,
            "--hz" => hz = parse_value(&flag, &value()?)?,
            "--sources" => sources = parse_value(&flag, &value()?)?,
            "--seconds" => seconds = parse_value(&flag, &value()?)?,
            "--start-universe" => start_universe = Some(parse_value(&flag, &value()?)?),
            "--protocol" => {
                protocol = match value()?.to_ascii_lowercase().as_str() {
                    "artnet" | "art-net" => WireProtocol::ArtNet,
                    "sacn" | "e1.31" => WireProtocol::Sacn,
                    other => return Err(format!("未知协议 {other}（可选 artnet / sacn）")),
                };
            }
            other => return Err(format!("未知选项 {other}")),
        }
    }

    if universes == 0 {
        return Err("--universes 必须 ≥ 1".to_string());
    }
    if !(hz.is_finite() && hz > 0.0) {
        return Err(format!("--hz 必须是正数，实际 {hz}"));
    }
    if !(1..=MAX_SOURCES).contains(&sources) {
        return Err(format!("--sources 只支持 1 或 2，实际 {sources}"));
    }

    let (default_port, default_start, max_universe) = match protocol {
        WireProtocol::ArtNet => (ARTNET_PORT, 0, ARTNET_MAX_UNIVERSE),
        WireProtocol::Sacn => (SACN_PORT, SACN_MIN_UNIVERSE, SACN_MAX_UNIVERSE),
    };
    let start_universe = start_universe.unwrap_or(default_start);
    if protocol == WireProtocol::Sacn && start_universe < SACN_MIN_UNIVERSE {
        return Err("sACN 的 Universe 从 1 开始，--start-universe 不能为 0".to_string());
    }
    let last = u32::from(start_universe) + u32::from(universes) - 1;
    if last > max_universe {
        return Err(format!(
            "Universe 范围 {start_universe}..={last} 超出 {} 上限 {max_universe}",
            protocol.as_str()
        ));
    }

    let target = target.unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], default_port)));
    Ok(Some(Config {
        target,
        universes,
        hz,
        sources,
        seconds,
        protocol,
        start_universe,
    }))
}

/// 解析单个选项的取值。
///
/// # Arguments
///
/// * `flag` - 选项名（仅用于错误信息）。
/// * `raw` - 原始取值文本。
///
/// # Returns
///
/// 解析出的值。
///
/// # Errors
///
/// `raw` 无法解析为 `T` 时返回包含选项名与原始文本的错误信息。
fn parse_value<T: std::str::FromStr>(flag: &str, raw: &str) -> Result<T, String> {
    raw.parse()
        .map_err(|_| format!("选项 {flag} 的取值 {raw:?} 无法解析"))
}

/// 按配置持续发包，直到到达 `cfg.seconds` 或 `stop` 被置位。
///
/// # Arguments
///
/// * `cfg` - 压测配置。
/// * `stop` - 外部停止标志；置为 `true` 后最迟一个 tick 内返回。
///
/// # Returns
///
/// 本次运行的 [`Summary`]（包数、错误数、tick 与跳过 tick 数、实际时长）。
///
/// # Errors
///
/// 绑定本地 UDP 套接字或开启广播失败时返回对应的 I/O 错误；单包发送失败只计入
/// `send_errors`，不会中止运行。
fn run(cfg: &Config, stop: &AtomicBool) -> std::io::Result<Summary> {
    let sockets = (0..cfg.sources)
        .map(|_| {
            let sock = UdpSocket::bind(("0.0.0.0", 0))?;
            // 允许向广播地址（如 2.255.255.255）压测。
            sock.set_broadcast(true)?;
            Ok(sock)
        })
        .collect::<std::io::Result<Vec<_>>>()?;

    let period = Duration::from_secs_f64(1.0 / cfg.hz);
    let start = Instant::now();
    let end = (cfg.seconds > 0).then(|| start + Duration::from_secs(cfg.seconds));
    let mut summary = Summary::default();
    let mut reporter = Reporter::new(start);
    let mut channels = [0u8; CHANNELS];
    let mut tick: u64 = 0;

    loop {
        if stop.load(Ordering::Relaxed) || end.is_some_and(|e| Instant::now() >= e) {
            break;
        }

        send_tick(&sockets, cfg, tick, &mut channels, &mut summary);
        summary.ticks_sent += 1;
        tick += 1;

        // 按绝对截止时间推进：第 n 个 tick 的截止时刻固定为 start + n / hz，不累计漂移。
        let mut deadline = start + tick_offset(tick, cfg.hz);
        let now = Instant::now();
        if now > deadline + period {
            // 落后超过 1 个 tick：不追帧，直接跳到最近一个已过期的截止时刻。
            let missed = whole_ticks(now - deadline, period);
            tick += missed;
            summary.skipped_ticks += missed;
            deadline = start + tick_offset(tick, cfg.hz);
        }

        reporter.maybe_print(now, &summary);
        wait_until(deadline, stop);
    }

    summary.elapsed = start.elapsed();
    Ok(summary)
}

/// 发送一个 tick：依次发完全部 Universe，每个来源各一遍。
///
/// # Arguments
///
/// * `sockets` - 本地来源套接字（每个代表一个来源）。
/// * `cfg` - 压测配置。
/// * `tick` - 当前 tick 序号（决定图案相位与序列号）。
/// * `channels` - 复用的通道缓冲（避免每包分配）。
/// * `summary` - 累计统计，就地更新包数与错误数。
fn send_tick(
    sockets: &[UdpSocket],
    cfg: &Config,
    tick: u64,
    channels: &mut [u8; CHANNELS],
    summary: &mut Summary,
) {
    // Art-Net / sACN 序列号 1..=255 循环（0 表示不启用序列）。
    let sequence = (tick % 255) as u8 + 1;
    for offset in 0..cfg.universes {
        let universe = cfg.start_universe + offset;
        for (source, sock) in (0u8..).zip(sockets) {
            fill_pattern(channels, tick, universe, source);
            let packet = match cfg.protocol {
                WireProtocol::ArtNet => artnet::build_dmx(universe, sequence, channels),
                WireProtocol::Sacn => sacn::build(
                    universe,
                    channels,
                    &source_cid(source),
                    SACN_SOURCE_NAME,
                    SACN_PRIORITY,
                    sequence,
                ),
            };
            match sock.send_to(&packet, cfg.target) {
                Ok(_) => summary.packets_sent += 1,
                Err(_) => summary.send_errors += 1,
            }
        }
    }
}

/// 生成某来源的 sACN CID（每个来源固定且互不相同）。
///
/// # Arguments
///
/// * `source` - 来源序号（从 0 起）。
///
/// # Returns
///
/// 16 字节 CID，末字节为来源序号。
fn source_cid(source: u8) -> [u8; 16] {
    let mut cid = *b"loadgen-src-cid\0";
    cid[15] = source;
    cid
}

/// 用确定性三角波填充一帧通道数据。
///
/// # Arguments
///
/// * `channels` - 待填充的通道缓冲。
/// * `tick` - 当前 tick 序号。
/// * `universe` - Universe 编号。
/// * `source` - 来源序号（第二来源相位错开 64）。
fn fill_pattern(channels: &mut [u8; CHANNELS], tick: u64, universe: u16, source: u8) {
    let base = tick
        .wrapping_add(u64::from(universe) * 7)
        .wrapping_add(u64::from(source) * 64);
    for (ch, slot) in (0u64..).zip(channels.iter_mut()) {
        *slot = triangle(base.wrapping_add(ch));
    }
}

/// 周期 510 的三角波：0 → 255 → 1 → 0 …
///
/// # Arguments
///
/// * `x` - 相位。
///
/// # Returns
///
/// 0~255 的通道值。
fn triangle(x: u64) -> u8 {
    let v = x % 510;
    // v ≤ 255 时直接取值，否则镜像回落；两种情况都落在 u8 范围内。
    (if v <= 255 { v } else { 510 - v }) as u8
}

/// 第 `tick` 个截止时刻相对起点的偏移。
///
/// # Arguments
///
/// * `tick` - tick 序号。
/// * `hz` - 帧率（Hz，正数）。
///
/// # Returns
///
/// `tick / hz` 秒。
// tick 远小于 2^53，转 f64 不丢精度
fn tick_offset(tick: u64, hz: f64) -> Duration {
    Duration::from_secs_f64(tick as f64 / hz)
}

/// 计算 `lag` 中包含多少个完整的 `period`。
///
/// # Arguments
///
/// * `lag` - 落后时长。
/// * `period` - tick 周期（非零）。
///
/// # Returns
///
/// 完整周期数（向下取整，溢出时饱和）。
fn whole_ticks(lag: Duration, period: Duration) -> u64 {
    u64::try_from(lag.as_nanos() / period.as_nanos().max(1)).unwrap_or(u64::MAX)
}

/// 混合等待到 `deadline`：剩余 > 3ms 时 `sleep(剩余 - 2ms)`，否则自旋。
///
/// Windows 默认计时器精度约 15.6ms，单纯 `sleep` 会让节拍严重抖动；提前醒来后
/// 用 [`std::hint::spin_loop`] 自旋补足，可把误差压到亚毫秒级。
///
/// # Arguments
///
/// * `deadline` - 目标时刻。
/// * `stop` - 停止标志；置位后立即返回。
fn wait_until(deadline: Instant, stop: &AtomicBool) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let remaining = deadline - now;
        if remaining > SLEEP_THRESHOLD {
            thread::sleep(remaining.saturating_sub(SLEEP_MARGIN));
        } else {
            std::hint::spin_loop();
        }
    }
}

/// 计数在时长内的平均每秒速率。
///
/// # Arguments
///
/// * `count` - 计数。
/// * `elapsed` - 时长。
///
/// # Returns
///
/// 每秒速率；时长为 0 时返回 `0.0`。
// 包数远小于 2^53，转 f64 不丢精度
fn per_second(count: u64, elapsed: Duration) -> f64 {
    let secs = elapsed.as_secs_f64();
    if secs > 0.0 {
        count as f64 / secs
    } else {
        0.0
    }
}

/// 每秒打印一行实时统计。
struct Reporter {
    /// 运行起点。
    start: Instant,
    /// 上次打印的时刻。
    last_at: Instant,
    /// 上次打印时的累计包数。
    last_packets: u64,
}

impl Reporter {
    /// 以运行起点创建打印器。
    ///
    /// # Arguments
    ///
    /// * `start` - 运行起点。
    ///
    /// # Returns
    ///
    /// 尚未打印过的 [`Reporter`]。
    fn new(start: Instant) -> Self {
        Self {
            start,
            last_at: start,
            last_packets: 0,
        }
    }

    /// 距上次打印满 1 秒时打印一行：实际包速率、累计包数、跳过 tick 数、发送错误数。
    ///
    /// # Arguments
    ///
    /// * `now` - 当前时刻。
    /// * `summary` - 当前累计统计。
    fn maybe_print(&mut self, now: Instant, summary: &Summary) {
        let since = now.saturating_duration_since(self.last_at);
        if since < REPORT_INTERVAL {
            return;
        }
        let rate = per_second(summary.packets_sent - self.last_packets, since);
        println!(
            "[{:>6.1}s] 速率 {rate:>9.1} 包/秒 | 累计 {:>10} 包 | 跳过 tick {:>5} | 发送错误 {:>5}",
            now.saturating_duration_since(self.start).as_secs_f64(),
            summary.packets_sent,
            summary.skipped_ticks,
            summary.send_errors,
        );
        self.last_at = now;
        self.last_packets = summary.packets_sent;
    }
}

/// 打印结束汇总。
///
/// # Arguments
///
/// * `summary` - 本次运行的汇总结果。
fn print_summary(summary: &Summary) {
    println!("==== loadgen 汇总 ====");
    println!("运行时长   {:.3} s", summary.elapsed.as_secs_f64());
    println!(
        "tick       已发送 {}，跳过 {}",
        summary.ticks_sent, summary.skipped_ticks
    );
    println!(
        "包数       {}（平均 {:.1} 包/秒）",
        summary.packets_sent,
        per_second(summary.packets_sent, summary.elapsed)
    );
    println!("发送错误   {}", summary.send_errors);
}

/// 安装 Ctrl+C 处理器：首次 Ctrl+C 置位 [`STOP`] 以便打印汇总后退出，
/// 再次 Ctrl+C 交还系统默认处理（立即结束进程）。
///
/// # Returns
///
/// 安装成功返回 `true`。
#[cfg(windows)]
fn install_ctrl_c_handler() -> bool {
    /// 控制台控制事件回调。
    ///
    /// # Arguments
    ///
    /// * `_ctrl_type` - 事件类型（Ctrl+C / Ctrl+Break / 关闭等，一律视为停止请求）。
    ///
    /// # Returns
    ///
    /// `1`（TRUE）表示已处理；`0` 交给下一个（默认）处理器结束进程。
    extern "system" fn on_ctrl(_ctrl_type: u32) -> i32 {
        i32::from(!STOP.swap(true, Ordering::SeqCst))
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    // SAFETY: `on_ctrl` 签名符合 PHANDLER_ROUTINE（stdcall/system ABI、DWORD 参数、
    // BOOL 返回），且只操作原子变量，可在系统创建的回调线程中安全执行。
    unsafe { SetConsoleCtrlHandler(Some(on_ctrl), 1) != 0 }
}

/// 安装 Ctrl+C（SIGINT）处理器：置位 [`STOP`] 以便打印汇总后退出。
///
/// # Returns
///
/// 安装成功返回 `true`。
#[cfg(unix)]
fn install_ctrl_c_handler() -> bool {
    use std::ffi::c_int;

    /// POSIX `SIGINT` 信号编号。
    const SIGINT: c_int = 2;
    /// `signal()` 失败时的返回值 `SIG_ERR`（即 `(sighandler_t)-1`）。
    const SIG_ERR: usize = usize::MAX;

    /// SIGINT 回调：只写原子变量（异步信号安全）。
    ///
    /// # Arguments
    ///
    /// * `_signum` - 信号编号。
    extern "C" fn on_sigint(_signum: c_int) {
        STOP.store(true, Ordering::SeqCst);
    }

    unsafe extern "C" {
        fn signal(signum: c_int, handler: extern "C" fn(c_int)) -> usize;
    }

    // SAFETY: `on_sigint` 符合 `sighandler_t` 的 C ABI，且只执行异步信号安全的原子写入。
    unsafe { signal(SIGINT, on_sigint) != SIG_ERR }
}

/// 其它平台不支持安装 Ctrl+C 处理器。
///
/// # Returns
///
/// 总是 `false`。
#[cfg(not(any(windows, unix)))]
fn install_ctrl_c_handler() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::net::UdpSocket;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use artnet_net::artnet::{self, ArtNetPacket};

    use super::{parse_args, run, triangle, Config, WireProtocol, CHANNELS};

    /// 回环自测：4 个 Universe × 44Hz 发 1 秒，接收端计数与发送计数一致且均为 ArtDmx。
    #[test]
    fn loopback_artnet_counts_match_and_parse_as_dmx() {
        let receiver = UdpSocket::bind(("127.0.0.1", 0)).expect("绑定回环接收套接字");
        receiver
            .set_read_timeout(Some(Duration::from_millis(50)))
            .expect("设置接收超时");
        let target = receiver.local_addr().expect("读取接收端口");

        let done = Arc::new(AtomicBool::new(false));
        let rx_done = Arc::clone(&done);
        let rx = thread::spawn(move || {
            let mut buf = [0u8; 2048];
            let mut recv_count = 0u64;
            let mut dmx_ok = 0u64;
            let mut universes = BTreeSet::new();
            loop {
                match receiver.recv_from(&mut buf) {
                    Ok((n, _)) => {
                        recv_count += 1;
                        if let Some(ArtNetPacket::Dmx {
                            port_address, data, ..
                        }) = artnet::parse(&buf[..n])
                            && data.len() == CHANNELS {
                                dmx_ok += 1;
                                universes.insert(port_address);
                            }
                    }
                    // 发送端已结束且一次超时内再无数据：视为已排空。
                    Err(_) if rx_done.load(Ordering::SeqCst) => break,
                    Err(_) => {}
                }
            }
            (recv_count, dmx_ok, universes)
        });

        let cfg = Config {
            target,
            universes: 4,
            hz: 44.0,
            sources: 1,
            seconds: 1,
            protocol: WireProtocol::ArtNet,
            start_universe: 0,
        };
        let stop = AtomicBool::new(false);
        let summary = run(&cfg, &stop).expect("回环发包");
        // 给接收线程留出排空时间后再通知结束。
        thread::sleep(Duration::from_millis(200));
        done.store(true, Ordering::SeqCst);
        let (recv_count, dmx_ok, universes) = rx.join().expect("接收线程不应 panic");

        assert_eq!(summary.send_errors, 0, "回环发送不应失败");
        assert!(summary.ticks_sent > 0, "至少应发送一个 tick");
        assert_eq!(
            summary.packets_sent,
            summary.ticks_sent * 4,
            "每 tick 发 4 包"
        );
        assert_eq!(recv_count, summary.packets_sent, "接收计数应与发送计数一致");
        assert_eq!(dmx_ok, recv_count, "每个包都应解析为 512 通道 ArtDmx");
        assert_eq!(universes, (0u16..4).collect::<BTreeSet<_>>());
    }

    #[test]
    fn defaults_follow_protocol() {
        let cfg = parse_args(Vec::<String>::new())
            .expect("空参数合法")
            .expect("非 help");
        assert_eq!(cfg.target.port(), 6454);
        assert_eq!(cfg.universes, 256);
        assert_eq!(cfg.sources, 1);
        assert_eq!(cfg.start_universe, 0);

        let args = ["--protocol", "sacn"].map(String::from);
        let cfg = parse_args(args).expect("合法").expect("非 help");
        assert_eq!(cfg.protocol, WireProtocol::Sacn);
        assert_eq!(cfg.target.port(), 5568);
        assert_eq!(cfg.start_universe, 1, "sACN 的 Universe 0 为保留值");
    }

    #[test]
    fn rejects_invalid_arguments() {
        let bad: [&[&str]; 5] = [
            &["--sources", "3"],
            &["--hz", "0"],
            &["--universes"],
            &["--start-universe", "32767", "--universes", "2"],
            &["--bogus"],
        ];
        for args in bad {
            let args = args.iter().map(|s| (*s).to_string());
            assert!(parse_args(args).is_err());
        }
        assert_eq!(parse_args(["-h".to_string()]), Ok(None));
    }

    #[test]
    fn triangle_wave_is_continuous_and_bounded() {
        assert_eq!(triangle(0), 0);
        assert_eq!(triangle(255), 255);
        assert_eq!(triangle(256), 254);
        assert_eq!(triangle(509), 1);
        assert_eq!(triangle(510), 0);
        for x in 0..2000u64 {
            let d = i16::from(triangle(x + 1)) - i16::from(triangle(x));
            assert!(d.abs() <= 1, "相邻相位最多相差 1");
        }
    }
}
