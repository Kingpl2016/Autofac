//! ArtRec 回放核心（纯逻辑，无 IO / Tauri / 网络依赖）。
//!
//! - [`core`]：时间驱动的回放状态机 [`Player`]（倍速、暂停、循环、seek、保活、损坏帧容错）。
//!   所有时刻都由宿主以"墙钟微秒"传入，因此可用虚拟时间做确定性测试。
//! - [`walker`]：顺序帧遍历器，概览与曲线分析的公共基础。
//! - [`overview`]：整段节目的时间线概览（热力图数据），可缓存到 sidecar。
//! - [`series`]：通道曲线的 min/max 降采样查询。
//! - [`b64`]：概览矩阵的紧凑 Base64 序列化。

pub mod b64;
pub mod core;
pub mod overview;
pub mod series;
pub mod walker;

pub use core::{
    Emission, EmissionKind, PlayState, Player, PlayerConfig, PlayerStatus, UniverseData,
    DEFAULT_KEEPALIVE_US, MAX_SPEED_MILLI, MIN_SPEED_MILLI, NORMAL_SPEED_MILLI,
};
pub use overview::{build_overview, Overview, DEFAULT_BUCKETS, OVERVIEW_VERSION};
pub use series::{channel_series, ChannelSeries, SeriesError, SeriesPoint, MAX_SERIES_CHANNELS};
pub use walker::FrameWalker;
