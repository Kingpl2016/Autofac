//! 核心运行时插件（含应用配置）。
//!
//! 内聚应用的实时子系统（信号引擎、设备发现、转发表、输出分发器、录制/回放控制器，见
//! [`runtime::Runtime`]）与应用配置（[`SettingsState`]）。插件在 `setup` 中加载配置、以当前
//! 配置启动接收引擎并把二者纳入管理，经 [`ArtnetCoreExt`] / [`SettingsExt`] 暴露。
//!
//! 命令位于 [`commands`]，由宿主在自己的 `invoke_handler` 注册（命令名不变）。

pub mod app_mode;
pub mod dispatch;
pub mod mode;
pub mod playback;
pub mod recording;
pub mod runtime;
pub mod sacn;
pub mod sender;
mod util;

pub use dispatch::{DispatchTarget, Dispatcher, ForwardJob};
pub use runtime::{Runtime, ScanSummary};

use std::path::PathBuf;
use std::sync::Mutex;

use settings::AppSettings;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime as TauriRuntime, State};

use crate::util::lock;

/// 插件管理的配置状态：内存快照 + 持久化路径。
pub struct SettingsState {
    settings: Mutex<AppSettings>,
    path: PathBuf,
}

/// 通过 `AppHandle`（或任意 [`Manager`]）读取当前配置快照。
pub trait SettingsExt<R: TauriRuntime> {
    /// 当前配置的副本。
    fn settings_snapshot(&self) -> AppSettings;
}

impl<R: TauriRuntime, T: Manager<R>> SettingsExt<R> for T {
    fn settings_snapshot(&self) -> AppSettings {
        lock(&self.state::<SettingsState>().settings).clone()
    }
}

/// 通过 `AppHandle`（或任意 [`Manager`]）访问核心运行时。
pub trait ArtnetCoreExt<R: TauriRuntime> {
    /// 托管的核心运行时状态（可 `Deref` 为 [`Runtime`]）。
    fn artnet_core(&self) -> State<'_, Runtime>;
}

impl<R: TauriRuntime, T: Manager<R>> ArtnetCoreExt<R> for T {
    fn artnet_core(&self) -> State<'_, Runtime> {
        self.state::<Runtime>()
    }
}

/// 构造核心插件：加载配置、以当前配置启动接收引擎，并把配置与运行时一并纳入管理。
///
/// # Returns
///
/// 仅注册 setup 生命周期的 [`TauriPlugin`]；命令由宿主另行注册。
#[must_use]
pub fn init<R: TauriRuntime>() -> TauriPlugin<R> {
    Builder::new("artnet-core")
        .setup(|app, _api| {
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("settings.json");
            let cfg = settings::load(&settings_path).unwrap_or_default();
            app.manage(SettingsState {
                settings: Mutex::new(cfg.clone()),
                path: settings_path,
            });

            let names_path = config_dir.join("devices.json");
            let forwarding_path = config_dir.join("forwarding.json");
            let runtime = Runtime::new(&cfg, names_path, forwarding_path);
            runtime.spawn(app.clone(), &cfg);
            app.manage(runtime);
            Ok(())
        })
        .build()
}

/// Tauri 命令：配置读写、实时信号快照、设备发现与转发表（由宿主在 `invoke_handler` 注册）。
pub mod commands {
    use netif::NetworkInterfaceDto;
    use settings::AppSettings;
    use tauri::{AppHandle, Manager, State};

    use crate::runtime::{Runtime, ScanSummary};
    use crate::util::lock;
    use crate::SettingsState;

    // ---- 配置 ----

    /// 读取当前配置快照。
    #[tauri::command]
    pub fn get_settings(state: State<'_, SettingsState>) -> AppSettings {
        lock(&state.settings).clone()
    }

    /// 保存配置：规范化后落盘、更新内存并在线应用到运行时。
    ///
    /// # Errors
    ///
    /// 写盘失败时返回错误字符串。
    #[tauri::command]
    pub fn save_settings(
        app: AppHandle,
        state: State<'_, SettingsState>,
        mut settings: AppSettings,
    ) -> Result<AppSettings, String> {
        settings.normalize();
        persist(&app, &state, &settings)?;
        Ok(settings)
    }

    /// 从 JSON 文本导入配置并保存。
    ///
    /// # Errors
    ///
    /// JSON 解析或写盘失败时返回错误字符串。
    #[tauri::command]
    pub fn import_settings(
        app: AppHandle,
        state: State<'_, SettingsState>,
        json: String,
    ) -> Result<AppSettings, String> {
        let settings = settings::from_json(&json).map_err(|e| e.to_string())?;
        persist(&app, &state, &settings)?;
        Ok(settings)
    }

    /// 将当前配置导出为 JSON 文本。
    ///
    /// # Errors
    ///
    /// 序列化失败时返回错误字符串。
    #[tauri::command]
    pub fn export_settings(state: State<'_, SettingsState>) -> Result<String, String> {
        settings::to_json(&lock(&state.settings)).map_err(|e| e.to_string())
    }

    /// 枚举本机网络接口（首项为"全部接口 0.0.0.0"）。
    #[tauri::command]
    pub fn list_network_interfaces() -> Vec<NetworkInterfaceDto> {
        netif::list_interfaces()
    }

    /// 落盘 + 更新内存快照 + 在线应用到运行时。
    fn persist(
        app: &AppHandle,
        state: &State<'_, SettingsState>,
        settings: &AppSettings,
    ) -> Result<(), String> {
        settings::save(&state.path, settings).map_err(|e| e.to_string())?;
        *lock(&state.settings) = settings.clone();
        // 运行时在 host-core 的 setup 中已先行 manage。
        app.state::<Runtime>().apply_settings(settings);
        Ok(())
    }

    // ---- 实时信号 / 发现 / 转发 ----

    /// 读取当前全部活跃 Universe 快照。
    #[tauri::command]
    pub fn get_universe_snapshot(
        state: State<'_, Runtime>,
    ) -> Vec<signal_engine::UniverseSnapshot> {
        state.snapshot()
    }

    /// 设置前端正在查看的 Universe 列表（决定推送哪些通道数据）。
    #[tauri::command]
    pub fn set_viewed_universes(state: State<'_, Runtime>, universes: Vec<u16>) {
        state.set_viewed(universes);
    }

    /// 当前来源（按 IP 聚合）统计，供录制来源选择器初始渲染。
    #[tauri::command]
    pub fn get_source_stats(state: State<'_, Runtime>) -> Vec<signal_engine::SourceStat> {
        state.source_stats()
    }

    /// 读取当前全部已发现设备。
    #[tauri::command]
    pub fn get_devices(state: State<'_, Runtime>) -> Vec<discovery::Device> {
        state.devices()
    }

    /// 发起一次主动网络扫描（向各网卡子网广播 ArtPoll 并等待回复）。
    ///
    /// # Errors
    ///
    /// Art-Net 未启用（`artnet_disabled`）、已有扫描在进行（`scan_in_progress`）
    /// 或发送全部失败时返回错误字符串。
    #[tauri::command]
    pub async fn scan_network(state: State<'_, Runtime>) -> Result<ScanSummary, String> {
        state.scan_network().await
    }

    /// 清除所有离线设备记录（自定义名保留）。
    #[tauri::command]
    pub fn clear_offline_devices(state: State<'_, Runtime>) -> Vec<discovery::Device> {
        state.clear_offline_devices()
    }

    /// 为设备设置自定义名并持久化。
    #[tauri::command]
    pub fn set_device_name(state: State<'_, Runtime>, ip: String, name: String) {
        state.set_device_name(&ip, name);
    }

    /// 读取当前转发表。
    #[tauri::command]
    pub fn get_forwarding(state: State<'_, Runtime>) -> forwarding::ForwardingTable {
        state.forwarding()
    }

    /// 保存转发表（替换并持久化）。
    #[tauri::command]
    pub fn save_forwarding(state: State<'_, Runtime>, table: forwarding::ForwardingTable) {
        state.save_forwarding(table);
    }
}
