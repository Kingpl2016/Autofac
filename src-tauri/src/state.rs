//! 宿主层共享状态。

use std::path::PathBuf;
use std::sync::Mutex;

use settings::AppSettings;

use crate::esp::EspHandle;
use crate::runtime::Runtime;

/// 应用全局状态：当前配置快照、持久化路径与运行时句柄。
pub struct AppState {
    /// 当前配置（内存快照，命令读写）。
    pub settings: Mutex<AppSettings>,
    /// 配置文件路径。
    pub settings_path: PathBuf,
    /// 应用运行时（信号引擎 + 设备发现 + 转发 + 录制 / 回放控制器）。
    pub runtime: Runtime,
    /// ESP32-P4 核心板连接句柄。
    pub esp: EspHandle,
}

impl AppState {
    /// 以给定配置目录构造状态，加载现有配置并创建运行时。
    ///
    /// # Arguments
    ///
    /// * `config_dir` - 应用配置目录。
    ///
    /// # Returns
    ///
    /// 已加载配置、运行时就绪（尚未 spawn）的状态。
    #[must_use]
    pub fn new(config_dir: PathBuf) -> Self {
        let settings_path = config_dir.join("settings.json");
        let names_path = config_dir.join("devices.json");
        let forwarding_path = config_dir.join("forwarding.json");
        let loaded = settings::load(&settings_path).unwrap_or_default();
        let runtime = Runtime::new(&loaded, names_path, forwarding_path);
        Self {
            settings: Mutex::new(loaded),
            settings_path,
            runtime,
            esp: EspHandle::new(),
        }
    }
}
