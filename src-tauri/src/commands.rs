//! Tauri 命令：设置读写、导入导出与网络接口枚举。
//!
//! 命令只做"提取 → 调用领域 → 返回 DTO"；领域逻辑位于 `settings` crate。

use tauri::State;

use settings::AppSettings;

use crate::netif::{self, NetworkInterfaceDto};
use crate::state::AppState;
use crate::util::lock;

/// 读取当前配置快照。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 当前内存中的配置。
///
/// # Errors
///
/// 状态锁中毒时返回错误字符串。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(lock(&state.settings).clone())
}

/// 保存配置：规范化后更新内存并持久化到磁盘。
///
/// # Arguments
///
/// * `state` - 应用状态。
/// * `settings` - 前端提交的新配置。
///
/// # Returns
///
/// 规范化后的最终配置（便于前端回填）。
///
/// # Errors
///
/// 锁中毒或写盘失败时返回错误字符串。
#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.normalize();
    persist_and_apply(&state, &settings)?;
    Ok(settings)
}

/// 持久化配置到磁盘、应用到运行时并更新内存快照。
///
/// `save_settings` 与 `import_settings` 的公共落地路径。
fn persist_and_apply(state: &State<'_, AppState>, settings: &AppSettings) -> Result<(), String> {
    settings::save(&state.settings_path, settings).map_err(|e| e.to_string())?;
    state.runtime.apply_settings(settings);
    *lock(&state.settings) = settings.clone();
    Ok(())
}

/// 从 JSON 文本导入配置并保存。
///
/// # Arguments
///
/// * `state` - 应用状态。
/// * `json` - 配置 JSON 文本。
///
/// # Returns
///
/// 导入并规范化后的配置。
///
/// # Errors
///
/// JSON 解析或写盘失败时返回错误字符串。
#[tauri::command]
pub fn import_settings(
    state: State<'_, AppState>,
    json: String,
) -> Result<AppSettings, String> {
    let settings = settings::from_json(&json).map_err(|e| e.to_string())?;
    persist_and_apply(&state, &settings)?;
    Ok(settings)
}

/// 将当前配置导出为 JSON 文本。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 美化后的配置 JSON 文本。
///
/// # Errors
///
/// 锁中毒或序列化失败时返回错误字符串。
#[tauri::command]
pub fn export_settings(state: State<'_, AppState>) -> Result<String, String> {
    settings::to_json(&lock(&state.settings)).map_err(|e| e.to_string())
}

/// 枚举本机网络接口。
///
/// # Returns
///
/// IPv4 接口列表（首项为"全部接口 0.0.0.0"）。
#[tauri::command]
pub fn list_network_interfaces() -> Vec<NetworkInterfaceDto> {
    netif::list_interfaces()
}

/// 读取当前全部活跃 Universe 快照。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 活跃 Universe 快照列表。
#[tauri::command]
pub fn get_universe_snapshot(
    state: State<'_, AppState>,
) -> Vec<signal_engine::UniverseSnapshot> {
    state.runtime.snapshot()
}

/// 设置前端正在查看的 Universe 列表（决定推送哪些通道数据）。
///
/// # Arguments
///
/// * `state` - 应用状态。
/// * `universes` - 被查看的 Universe 列表。
#[tauri::command]
pub fn set_viewed_universes(state: State<'_, AppState>, universes: Vec<u16>) {
    state.runtime.set_viewed(universes);
}

/// 读取当前全部已发现设备。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 设备列表（按 IP 升序）。
#[tauri::command]
pub fn get_devices(state: State<'_, AppState>) -> Vec<discovery::Device> {
    state.runtime.devices()
}

/// 发起一次主动网络扫描（向各网卡子网广播 ArtPoll 并等待回复）。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 扫描摘要（发送数、响应节点数等）。
///
/// # Errors
///
/// Art-Net 未启用（`artnet_disabled`）、已有扫描在进行（`scan_in_progress`）
/// 或发送全部失败时返回错误字符串。
#[tauri::command]
pub async fn scan_network(
    state: State<'_, AppState>,
) -> Result<crate::runtime::ScanSummary, String> {
    state.runtime.scan_network().await
}

/// 清除所有离线设备记录（自定义名保留）。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 清理后的设备列表。
#[tauri::command]
pub fn clear_offline_devices(state: State<'_, AppState>) -> Vec<discovery::Device> {
    state.runtime.clear_offline_devices()
}

/// 为设备设置自定义名并持久化。
///
/// # Arguments
///
/// * `state` - 应用状态。
/// * `ip` - 目标设备 IP 字符串。
/// * `name` - 自定义名（空清除）。
#[tauri::command]
pub fn set_device_name(state: State<'_, AppState>, ip: String, name: String) {
    state.runtime.set_device_name(&ip, name);
}

/// 读取当前转发表。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 转发目的地集合。
#[tauri::command]
pub fn get_forwarding(state: State<'_, AppState>) -> forwarding::ForwardingTable {
    state.runtime.forwarding()
}

/// 保存转发表（替换并持久化）。
///
/// # Arguments
///
/// * `state` - 应用状态。
/// * `table` - 新的转发表。
#[tauri::command]
pub fn save_forwarding(state: State<'_, AppState>, table: forwarding::ForwardingTable) {
    state.runtime.save_forwarding(table);
}
