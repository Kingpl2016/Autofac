//! artnet-net 编解码微基准（divan，带分配计数）。
//!
//! 度量接收 / 发送热路径上单包编解码的耗时与堆分配次数（基准名沿用优化前，便于对比）：
//!
//! - `artnet::parse_dmx_512`：[`artnet::parse`] 解析一个 512 通道 ArtDmx 包
//!   （手写快速路径，仅通道数据一次拷贝）。
//! - `artnet::build_dmx_512`：[`artnet::build_dmx`] 构造一个 512 通道 ArtDmx 包（返回 `Vec`）。
//! - `artnet::build_dmx_into_512`：[`artnet::build_dmx_into`] 写入调用方缓冲（零分配）。
//! - `sacn::parse_512`：[`sacn::parse`] 解析一个 512 通道 E1.31 数据包。
//! - `sacn::build_512`：[`sacn::build`] 构造一个 512 通道 E1.31 数据包（返回 `Vec`）。
//! - `sacn::build_into_512`：[`sacn::build_into`] 写入调用方缓冲（零分配）。
//!
//! 运行：`cargo bench -p artnet-net --bench codec`。

use artnet_net::{artnet as artnet_codec, sacn as sacn_codec};
use divan::counter::BytesCount;
use divan::{black_box, Bencher};

/// 带分配计数的全局分配器：divan 据此在结果中报告每次迭代的分配次数与字节数。
#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

fn main() {
    divan::main();
}

/// 一帧 DMX 的通道数。
const CHANNELS: usize = 512;

/// 基准使用的 Art-Net Port-Address（Net 0 / SubNet 0 / Universe 1）。
const PORT_ADDRESS: u16 = 1;

/// 基准使用的 sACN Universe。
const SACN_UNIVERSE: u16 = 1;

/// 基准使用的序列号。
const SEQUENCE: u8 = 42;

/// sACN 发送者 CID（固定值，保证确定性）。
const CID: [u8; 16] = *b"artnet-net-bench";

/// 生成确定性的 512 通道测试图案（非全 0，避免过于理想化的数据）。
///
/// # Returns
///
/// 长度为 [`CHANNELS`] 的通道数据，第 `i` 通道值为 `(i * 7 + 3) mod 256`。
fn pattern() -> Vec<u8> {
    // cast_possible_truncation 已在 crate 级允许：取模后必然落在 u8 范围内。
    (0..CHANNELS).map(|i| ((i * 7 + 3) % 256) as u8).collect()
}

/// Art-Net（ArtDmx）编解码基准。
mod artnet {
    use super::{
        artnet_codec, black_box, pattern, Bencher, BytesCount, CHANNELS, PORT_ADDRESS, SEQUENCE,
    };

    /// 解析一个预先构造好的 512 通道 ArtDmx 包。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按整包字节数计。
    #[divan::bench]
    fn parse_dmx_512(bencher: Bencher) {
        let packet = artnet_codec::build_dmx(PORT_ADDRESS, SEQUENCE, &pattern());
        // 构造结果必须是可解析的 ArtDmx，否则基准毫无意义。
        assert!(
            matches!(
                artnet_codec::parse(&packet),
                Some(artnet_codec::ArtNetPacket::Dmx { ref data, .. }) if data.len() == CHANNELS
            ),
            "build_dmx 产出的包应能解析为 512 通道 ArtDmx"
        );
        bencher
            .counter(BytesCount::new(packet.len()))
            .bench(|| artnet_codec::parse(black_box(&packet)));
    }

    /// 构造一个 512 通道 ArtDmx 包。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按通道数据字节数计。
    #[divan::bench]
    fn build_dmx_512(bencher: Bencher) {
        let data = pattern();
        bencher.counter(BytesCount::new(data.len())).bench(|| {
            artnet_codec::build_dmx(
                black_box(PORT_ADDRESS),
                black_box(SEQUENCE),
                black_box(&data),
            )
        });
    }

    /// 把一个 512 通道 ArtDmx 包写入复用的栈缓冲（零分配路径）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按通道数据字节数计。
    #[divan::bench]
    fn build_dmx_into_512(bencher: Bencher) {
        let data = pattern();
        let mut out = [0u8; artnet_codec::ARTDMX_MAX_LEN];
        bencher
            .counter(BytesCount::new(data.len()))
            .bench_local(|| {
                artnet_codec::build_dmx_into(
                    black_box(PORT_ADDRESS),
                    black_box(SEQUENCE),
                    black_box(&data),
                    black_box(&mut out),
                )
            });
    }
}

/// sACN（E1.31 数据包）编解码基准。
mod sacn {
    use super::{
        black_box, pattern, sacn_codec, Bencher, BytesCount, CHANNELS, CID, SACN_UNIVERSE, SEQUENCE,
    };

    /// 基准使用的 sACN 源名称。
    const SOURCE_NAME: &str = "Art-Net Studio Bench";

    /// sACN 默认优先级。
    const PRIORITY: u8 = 100;

    /// 解析一个预先构造好的 512 通道 E1.31 数据包。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按整包字节数计。
    #[divan::bench]
    fn parse_512(bencher: Bencher) {
        let packet = sacn_codec::build(
            SACN_UNIVERSE,
            &pattern(),
            &CID,
            SOURCE_NAME,
            PRIORITY,
            SEQUENCE,
        );
        assert!(
            sacn_codec::parse(&packet).is_some_and(|p| p.data.len() == CHANNELS),
            "sacn::build 产出的包应能解析为 512 通道数据包"
        );
        bencher
            .counter(BytesCount::new(packet.len()))
            .bench(|| sacn_codec::parse(black_box(&packet)));
    }

    /// 构造一个 512 通道 E1.31 数据包。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按通道数据字节数计。
    #[divan::bench]
    fn build_512(bencher: Bencher) {
        let data = pattern();
        bencher.counter(BytesCount::new(data.len())).bench(|| {
            sacn_codec::build(
                black_box(SACN_UNIVERSE),
                black_box(&data),
                black_box(&CID),
                black_box(SOURCE_NAME),
                black_box(PRIORITY),
                black_box(SEQUENCE),
            )
        });
    }

    /// 把一个 512 通道 E1.31 数据包写入复用的栈缓冲（零分配路径）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按通道数据字节数计。
    #[divan::bench]
    fn build_into_512(bencher: Bencher) {
        let data = pattern();
        let mut out = [0u8; sacn_codec::SACN_MAX_LEN];
        bencher
            .counter(BytesCount::new(data.len()))
            .bench_local(|| {
                sacn_codec::build_into(
                    black_box(SACN_UNIVERSE),
                    black_box(&data),
                    black_box(&CID),
                    black_box(SOURCE_NAME),
                    black_box(PRIORITY),
                    black_box(SEQUENCE),
                    black_box(&mut out),
                )
            });
    }
}
