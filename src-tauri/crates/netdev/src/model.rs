//! 固件 HTTP 接口的数据模型（字段名与固件 JSON 的 camelCase 一致）。

use serde::{Deserialize, Serialize};

/// 播放摘要（`GET /api/status` 内嵌）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerBrief {
    /// 0 空闲 / 1 已停止 / 2 播放中 / 3 暂停。
    pub state: u8,
    /// 当前节目号，0 表示无。
    pub program_no: u16,
    /// 当前位置（毫秒）。
    pub pos_ms: u32,
    /// 总时长（毫秒）。
    pub dur_ms: u32,
}

/// 设备状态（`GET /api/status`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceStatus {
    /// 固件版本。
    pub version: String,
    /// 工作模式 0~5。
    pub work_mode: u8,
    /// 当前 IPv4。
    pub ip: String,
    /// 子网掩码。
    pub netmask: String,
    /// 网关。
    pub gateway: String,
    /// 是否由 DHCP 分配。
    pub via_dhcp: bool,
    /// 网线链路是否连通。
    pub link_up: bool,
    /// SD 卡是否已挂载。
    pub sd_mounted: bool,
    /// SD 卡总字节（未挂载时缺省）。
    pub sd_total: Option<u64>,
    /// SD 卡剩余字节（未挂载时缺省）。
    pub sd_free: Option<u64>,
    /// 播放摘要。
    pub player: PlayerBrief,
}

/// 播放器详细状态（`GET /api/player`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerStatus {
    /// 0 空闲 / 1 已停止 / 2 播放中 / 3 暂停。
    pub state: u8,
    /// 当前节目号。
    pub program_no: u16,
    /// 0 关闭 / 1 循环 / 2 连播。
    pub repeat: u8,
    /// 倍速 ×100，范围 25~200。
    pub speed_x100: u16,
    /// 当前位置（毫秒）。
    pub pos_ms: u32,
    /// 总时长（毫秒）。
    pub dur_ms: u32,
    /// 节目涉及的 universe 数。
    pub universes: u32,
    /// 已输出帧数。
    pub frames: u64,
    /// 坏帧 / 迟到帧数。
    pub bad_frames: u64,
}

/// SD 卡上的一个文件条目（`GET /files`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 文件名。
    pub name: String,
    /// 字节大小。
    #[serde(default)]
    pub size: u64,
    /// 是否为目录。
    #[serde(default)]
    pub is_dir: bool,
    /// 该文件对应的节目号（未分配为 `None`）。
    #[serde(default)]
    pub program: Option<u16>,
}

/// 节目映射条目（`GET /api/programs`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramEntry {
    /// 节目号 1~255。
    pub no: u16,
    /// 对应文件名。
    pub file: String,
    /// 文件字节数。
    #[serde(default)]
    pub size: u64,
}

/// 一条节目号分配：把 `no` 指到 `file`（`PUT /api/programs/{no}`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramAssign {
    /// 目标节目号 1~255。
    pub no: u16,
    /// 要指向的文件名。
    pub file: String,
}

/// 文件上传成功后的设备回执（`PUT /files/{name}`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UploadReceipt {
    /// 设备保存的文件名。
    pub name: String,
    /// 字节数。
    pub size: u64,
    /// 自动分配的节目号。
    pub program: Option<u16>,
}

/// 设备配置（`GET /api/config`）。
#[expect(clippy::struct_excessive_bools, reason = "与固件 JSON 一一对应，布尔字段多属正常")]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceConfig {
    /// 启用 Art-Net 输出。
    pub artnet_enabled: bool,
    /// 启用 sACN 输出。
    pub sacn_enabled: bool,
    /// 目标模式（枚举）。
    pub target_mode: u8,
    /// sACN 是否组播（0/1）。
    pub sacn_multicast: u8,
    /// sACN 优先级 0~200。
    pub sacn_priority: u8,
    /// 停止行为（枚举）。
    pub stop_behavior: u8,
    /// 保活间隔（毫秒），0~600000。
    pub keepalive_ms: u32,
    /// 源名称（1~63 字节）。
    pub source_name: String,
    /// 启用 UART DMX512 输出。
    pub uart_output_enabled: bool,
    /// 启用网络 UDP 输出（总开关）。
    pub net_output_enabled: bool,
    /// 转发订阅起始 universe。
    pub forward_uni_start: u16,
    /// 转发订阅 universe 数量。
    pub forward_uni_count: u16,
    /// 转发时是否同时接收 sACN。
    pub forward_sacn: bool,
    /// 是否使用 DHCP。
    pub dhcp: bool,
    /// 静态 IPv4。
    pub ip: String,
    /// 静态掩码。
    pub netmask: String,
    /// 静态网关。
    pub gateway: String,
    /// 主机名。
    pub hostname: String,
    /// 设备是否已配置 HTTP Token（只读）。
    pub token_set: bool,
}

/// 配置补丁：只提交改动过的字段（`PUT /api/config`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigPatch {
    /// 启用 Art-Net 输出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artnet_enabled: Option<bool>,
    /// 启用 sACN 输出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sacn_enabled: Option<bool>,
    /// 目标模式。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_mode: Option<u8>,
    /// sACN 组播（0/1）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sacn_multicast: Option<u8>,
    /// sACN 优先级。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sacn_priority: Option<u8>,
    /// 停止行为。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_behavior: Option<u8>,
    /// 保活间隔（毫秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keepalive_ms: Option<u32>,
    /// 源名称。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    /// 启用 UART 输出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uart_output_enabled: Option<bool>,
    /// 启用网络输出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_output_enabled: Option<bool>,
    /// 转发订阅起始。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forward_uni_start: Option<u16>,
    /// 转发订阅数量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forward_uni_count: Option<u16>,
    /// 转发时接收 sACN。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forward_sacn: Option<bool>,
    /// 使用 DHCP。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dhcp: Option<bool>,
    /// 静态 IPv4。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    /// 静态掩码。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub netmask: Option<String>,
    /// 静态网关。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// 主机名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    /// 只写：设置或清除（空串）HTTP Token。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_token: Option<String>,
}

/// 配置写入结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigResult {
    /// 是否成功。
    pub ok: bool,
    /// 网络相关字段变更需重启生效。
    pub net_reboot_required: bool,
}

/// 堆内存诊断。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HeapDiag {
    /// 当前空闲字节。
    pub free: u64,
    /// 历史最小空闲字节。
    pub min_free: u64,
    /// 最大可分配块（碎片指标）。
    pub largest_block: u64,
    /// PSRAM 空闲字节。
    pub psram_free: u64,
}

/// 任务诊断。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDiag {
    /// 任务名。
    pub name: String,
    /// 优先级。
    pub prio: u32,
    /// 栈历史最小剩余字节，越小越危险。
    pub stack_min: u64,
    /// 所在核（固件未启用时缺省）。
    pub core: Option<i32>,
    /// 运行计数。
    pub runtime: u64,
    /// CPU 占比千分数（缺省表示无统计）。
    pub cpu_permille: Option<u32>,
}

/// DMX UART 诊断。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DmxUartDiag {
    /// 口数。
    pub ports: u32,
    /// TX 发送超时累计，正常恒为 0。
    pub tx_timeouts: u64,
}

/// 播放诊断摘要。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerDiag {
    /// 播放状态。
    pub state: u8,
    /// 坏帧数。
    pub bad_frames: u64,
}

/// 运行期诊断（`GET /api/diag`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Diag {
    /// 堆信息。
    pub heap: HeapDiag,
    /// 任务列表。
    pub tasks: Vec<TaskDiag>,
    /// DMX UART（固件未启用时缺省）。
    pub dmx_uart: Option<DmxUartDiag>,
    /// 播放摘要。
    pub player: PlayerDiag,
}

/// OTA 状态（`GET /api/ota/status`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OtaStatus {
    /// 当前运行分区。
    pub running: String,
    /// 固件版本。
    pub version: String,
    /// 编译时间。
    pub compile_time: String,
    /// 是否待确认（未确认会在重启时回滚）。
    pub pending_verify: bool,
    /// 是否启用回滚。
    pub rollback_enabled: bool,
}

/// OTA 上传完成的回执（`POST /api/ota`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OtaReceipt {
    /// 新固件版本。
    pub new_version: String,
    /// 设备是否即将重启。
    pub rebooting: bool,
}
