//! ArtRec 回放核心（纯逻辑，无 Tauri / 网络依赖）。
//!
//! - [`core`]：时间驱动的回放状态机 [`Player`]（倍速、暂停、循环、seek、保活、损坏帧容错）。
//!   所有时刻都由宿主以"墙钟微秒"传入，因此可用虚拟时间做确定性测试。
//! - [`walker`]：顺序帧遍历器，概览与曲线分析的公共基础（含损坏帧语义说明）。
//! - [`overview`]：整段节目的时间线概览（热力图数据）。
//! - [`ovw`]：概览缓存文件 `名称.artrec.ovw` 的二进制编解码（纯函数，读写文件由 `recorder` 负责）。
//! - [`series`]：通道曲线的 min/max 降采样查询。
//! - [`parallel`]：概览与曲线的并行版本（专用线程池，结果与串行逐字节一致）。
//! - [`b64`]：概览矩阵的紧凑 Base64 序列化（前端 JSON 用）。

pub mod b64;
pub mod core;
mod kernels;
pub mod overview;
pub mod ovw;
pub mod parallel;
pub mod series;
pub mod walker;

#[cfg(test)]
mod reference;
#[cfg(test)]
mod testgen;

pub use core::{
    Emission, EmissionKind, PlayState, Player, PlayerConfig, PlayerStatus, UniverseData,
    DEFAULT_KEEPALIVE_US, MAX_SPEED_MILLI, MIN_SPEED_MILLI, NORMAL_SPEED_MILLI,
};
pub use overview::{build_overview, Overview, DEFAULT_BUCKETS, OVERVIEW_VERSION};
pub use ovw::{decode_overview, encode_overview, OVW_CONTAINER_VERSION, OVW_MAGIC};
pub use parallel::{
    build_overview_parallel, channel_series_parallel, ScanError, PARALLEL_MIN_FRAMES,
};
pub use series::{channel_series, ChannelSeries, SeriesError, SeriesPoint, MAX_SERIES_CHANNELS};
pub use walker::FrameWalker;
