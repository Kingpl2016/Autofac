//! 应用配置数据模型。
//!
//! 全部字段以 camelCase 序列化，直接作为前端 DTO 使用。默认值对齐
//! ArtNet Manager 手册《Settings》一节。

use serde::{Deserialize, Serialize};

/// 网络工作模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkMode {
    /// 单接口模式（默认）。
    Single,
    /// 多网卡模式。
    MultiNic,
}

/// 单块网卡在多网卡模式下的协议开关。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NicConfig {
    /// 接口名称或 IP。
    pub name: String,
    /// 该网卡是否接收 Art-Net。
    pub artnet_enabled: bool,
    /// 该网卡是否接收 sACN。
    pub sacn_enabled: bool,
}

/// 网络设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkSettings {
    /// 工作模式。
    pub mode: NetworkMode,
    /// 单接口模式下选中的接口（`"0.0.0.0"` 表示全部接口）。
    pub interface: String,
    /// 多网卡模式下每块网卡的配置。
    pub multi_nic: Vec<NicConfig>,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            mode: NetworkMode::Single,
            interface: "0.0.0.0".to_string(),
            multi_nic: Vec::new(),
        }
    }
}

/// 协议设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProtocolSettings {
    /// 是否接收 Art-Net。
    pub artnet_enabled: bool,
    /// Art-Net 监听端口（默认 6454）。
    pub artnet_port: u16,
    /// 是否接收 sACN。
    pub sacn_enabled: bool,
    /// sACN 监听端口（默认 5568）。
    pub sacn_port: u16,
    /// sACN 接收的 Universe 列表。
    pub sacn_universes: Vec<u16>,
}

impl Default for ProtocolSettings {
    fn default() -> Self {
        Self {
            artnet_enabled: true,
            artnet_port: 6454,
            sacn_enabled: true,
            sacn_port: 5568,
            sacn_universes: vec![1],
        }
    }
}

/// Universe 编号显示格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UniverseFormat {
    /// 十进制（从 1）。
    Decimal1,
    /// 十进制（从 0）。
    Decimal0,
    /// 十六进制。
    Hex,
    /// Art-Net（Net:Sub:Uni）。
    Artnet,
    /// ASCII。
    Ascii,
}

/// 通道编号显示格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelFormat {
    /// 十进制（从 1）。
    Decimal1,
    /// 十进制（从 0）。
    Decimal0,
    /// 十六进制。
    Hex,
}

/// 通道值显示格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueFormat {
    /// 十进制 0-255。
    Decimal,
    /// 十六进制 00-FF。
    Hex,
    /// 百分比 0-100%。
    Percent,
}

/// 显示设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DisplaySettings {
    /// 界面刷新率（fps）：15 / 30 / 60。
    pub ui_update_rate: u16,
    /// Universe 编号格式。
    pub universe_format: UniverseFormat,
    /// 通道编号格式。
    pub channel_format: ChannelFormat,
    /// 通道值格式。
    pub value_format: ValueFormat,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            ui_update_rate: 30,
            universe_format: UniverseFormat::Decimal1,
            channel_format: ChannelFormat::Decimal1,
            value_format: ValueFormat::Decimal,
        }
    }
}

/// 合并模式（复用引擎层定义，配置与引擎共用同一类型）。
pub use signal_engine::MergeMode;

/// 合并设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MergeSettings {
    /// 全局合并模式。
    pub mode: MergeMode,
    /// 源超时（毫秒），范围 1000~60000。
    pub source_timeout_ms: u32,
}

impl Default for MergeSettings {
    fn default() -> Self {
        Self {
            mode: MergeMode::Htp,
            source_timeout_ms: 2500,
        }
    }
}

/// 录制压缩方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingCompression {
    /// Zstd 压缩（默认；基准测试中体积最优）。
    Zstd,
    /// 不压缩。
    None,
}

/// 录制设置。
///
/// 整个结构带 `#[serde(default)]`：旧版本只有 `directory` 的配置文件可以继续加载，
/// 不会因为新增字段而被整体判为损坏并重置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordingSettings {
    /// 录制输出目录；空字符串表示使用默认目录（文档目录下的 `ArtNet Studio Recordings`）。
    pub directory: String,
    /// 压缩方式。
    pub compression: RecordingCompression,
    /// Zstd 压缩等级，范围 1~9。
    pub zstd_level: u8,
    /// 自动分段时长（分钟）；0 表示不分段。
    pub split_minutes: u32,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            directory: String::new(),
            compression: RecordingCompression::Zstd,
            zstd_level: 3,
            split_minutes: 0,
        }
    }
}

/// 更新通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    /// 稳定版。
    Stable,
    /// 测试版。
    Beta,
}

/// 更新设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    /// 更新通道。
    pub channel: UpdateChannel,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
        }
    }
}

/// 应用总配置。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// 网络设置。
    pub network: NetworkSettings,
    /// 协议设置。
    pub protocol: ProtocolSettings,
    /// 显示设置。
    pub display: DisplaySettings,
    /// 合并设置。
    pub merge: MergeSettings,
    /// 录制设置。
    pub recording: RecordingSettings,
    /// 更新设置。
    pub update: UpdateSettings,
}

impl AppSettings {
    /// 规范化并钳制非法取值，保证配置始终处于合法范围。
    ///
    /// - UI 刷新率回落到最接近的 15/30/60；
    /// - 源超时钳制到 1000~60000ms；
    /// - sACN Universe 去重并升序。
    pub fn normalize(&mut self) {
        self.display.ui_update_rate = match self.display.ui_update_rate {
            0..=22 => 15,
            23..=45 => 30,
            _ => 60,
        };
        self.merge.source_timeout_ms = self.merge.source_timeout_ms.clamp(1000, 60000);
        self.recording.zstd_level = self.recording.zstd_level.clamp(1, 9);
        self.recording.split_minutes = self.recording.split_minutes.min(24 * 60);
        self.protocol.sacn_universes.sort_unstable();
        self.protocol.sacn_universes.dedup();
    }
}
